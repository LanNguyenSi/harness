// `harness gate enable` — restore the live `gate disable` snapshot.
//
// There is one live `harness.gate-disable.*.json` per settings.json (a
// second disable merges into it). Enable puts every removed group back at
// its recorded index and atomically rewrites settings.json, then retires the
// snapshot (renamed to `*.restored.json`, kept for audit, never applied
// again). Refuses if settings.json has been edited since the snapshot was
// taken (the recorded `settingsAfterSha256` no longer matches the on-disk
// content) unless `--force` is passed, which splices the snapshot's groups
// into the file as it is and keeps the edits; a group that is already in the
// file is never spliced in a second time. A file that already matches the
// pre-disable state has nothing to restore: the snapshot is retired. A
// directory holding several live snapshots (version 1 releases left one per
// disable) is handled one snapshot per call, newest first; the result names
// the ones still live so the caller can refuse an all-clear.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  type GateDisableSnapshot,
  listLiveSnapshots,
  retireSnapshot,
  sha256Hex,
} from "./snapshot.js";

const DEFAULT_SETTINGS_REL = path.join(".claude", "settings.json");

export interface GateEnableOptions {
  /** `~/.claude/settings.json` override. */
  settingsPath?: string;
  /** Override the home dir used to compute the default settings path. */
  homeDir?: string;
  /**
   * `--force`: restore even when the on-disk settings.json sha differs
   * from the snapshot's recorded post-disable sha. Without it, a
   * mismatch refuses (the operator edited the file between disable and
   * enable; silent overwrite would lose their changes). The snapshot's
   * groups are spliced into the file as it is; the edits stay.
   */
  force?: boolean;
}

export type GateEnableResult =
  | {
      mode: "no-snapshots";
      settingsPath: string;
    }
  | {
      mode: "already-restored";
      settingsPath: string;
      /** The snapshot under its retired name. */
      snapshotPath: string;
      /** Snapshots still live after this call (version 1 leftovers), newest first. */
      remaining: string[];
    }
  | {
      mode: "restored";
      settingsPath: string;
      /** The snapshot under its retired name. */
      snapshotPath: string;
      restoredCount: number;
      /** Snapshots still live after this call (version 1 leftovers), newest first. */
      remaining: string[];
    };

export class GateEnableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateEnableError";
  }
}

function resolveSettingsPath(opts: GateEnableOptions): string {
  if (typeof opts.settingsPath === "string" && opts.settingsPath.length > 0) {
    return opts.settingsPath;
  }
  const home = opts.homeDir ?? os.homedir();
  return path.join(home, DEFAULT_SETTINGS_REL);
}

interface CurrentSettings {
  raw: string;
  obj: Record<string, unknown>;
  hooks: Record<string, unknown[]>;
}

function readCurrentSettings(settingsPath: string): CurrentSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateEnableError(
        `settings file not found: ${settingsPath} — cannot restore into a missing target`,
      );
    }
    throw new GateEnableError(`cannot read ${settingsPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GateEnableError(
      `${settingsPath} is not valid JSON (${(err as Error).message}); refusing to operate.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GateEnableError(`${settingsPath} is not a JSON object; refusing to operate.`);
  }
  const obj = parsed as Record<string, unknown>;
  const rawHooks = obj["hooks"];
  let hooks: Record<string, unknown[]> = {};
  if (rawHooks !== undefined) {
    if (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
      throw new GateEnableError(`${settingsPath} \`hooks\` field is not an object.`);
    }
    for (const [event, groups] of Object.entries(rawHooks)) {
      if (!Array.isArray(groups)) {
        throw new GateEnableError(
          `${settingsPath} \`hooks.${event}\` is not an array; refusing to operate.`,
        );
      }
      hooks[event] = groups.slice();
    }
  }
  return { raw, obj, hooks };
}

function groupLabel(event: string, group: unknown): string {
  const matcher =
    group !== null && typeof group === "object" && !Array.isArray(group)
      ? (group as Record<string, unknown>)["matcher"]
      : undefined;
  return `${event} matcher=${JSON.stringify(typeof matcher === "string" ? matcher : null)}`;
}

function reinsertRemoved(
  hooks: Record<string, unknown[]>,
  snapshot: GateDisableSnapshot,
): number {
  // Each removal step recorded its indices against the array as it stood just
  // before that step, so the steps are undone newest first, and inside a step
  // by event and ascending index: an earlier insertion never shifts a later
  // insertion's target index past the array end.
  const sorted = [...snapshot.removed].sort((a, b) => {
    const stepA = a.step ?? 0;
    const stepB = b.step ?? 0;
    if (stepA !== stepB) return stepB - stepA;
    if (a.event !== b.event) return a.event < b.event ? -1 : 1;
    return a.index - b.index;
  });
  let inserted = 0;
  for (const entry of sorted) {
    const arr = hooks[entry.event] ?? [];
    const idx = Math.min(entry.index, arr.length);
    arr.splice(idx, 0, entry.group);
    hooks[entry.event] = arr;
    inserted += 1;
  }
  return inserted;
}

export function gateEnable(opts: GateEnableOptions = {}): GateEnableResult {
  const settingsPath = resolveSettingsPath(opts);

  const found = listLiveSnapshots(settingsPath);
  if (!found.ok) {
    throw new GateEnableError(found.reason);
  }
  const [newest, ...older] = found.live;
  if (newest === undefined) {
    return { mode: "no-snapshots", settingsPath };
  }
  const snapshot = newest.snapshot;
  const remaining = older.map((l) => l.path);

  const current = readCurrentSettings(settingsPath);
  const currentSha = sha256Hex(current.raw);

  if (currentSha === snapshot.settingsBeforeSha256) {
    // The current file already matches the pre-disable state: nothing to
    // restore. The snapshot is spent, so retire it and never offer it again.
    return {
      mode: "already-restored",
      settingsPath,
      snapshotPath: retireSnapshot(newest.path),
      remaining,
    };
  }

  if (currentSha !== snapshot.settingsAfterSha256 && !opts.force) {
    throw new GateEnableError(
      `settings.json has been edited since the snapshot was taken (current sha ${currentSha.slice(0, 12)}…, ` +
        `snapshot's post-disable sha ${snapshot.settingsAfterSha256.slice(0, 12)}…). ` +
        `Re-running would overwrite those edits. Inspect the diff against ` +
        `${snapshot.settingsBackupPath}, then pass --force to restore anyway.`,
    );
  }

  // A group the file already holds would be spliced in a second time. The
  // file is then not the state the snapshot expects; refuse and let the
  // operator look at it.
  const present = snapshot.removed.filter((r) =>
    (current.hooks[r.event] ?? []).some((g) => isDeepStrictEqual(g, r.group)),
  );
  if (present.length > 0) {
    throw new GateEnableError(
      `settings.json already holds ${present.length} hook group(s) the snapshot would restore ` +
        `(${present.map((r) => groupLabel(r.event, r.group)).join("; ")}); restoring would duplicate them. ` +
        `Inspect the diff against ${snapshot.settingsBackupPath}; nothing was changed and the snapshot ` +
        `${newest.path} stays live.`,
    );
  }

  const restoredCount = reinsertRemoved(current.hooks, snapshot);

  const newObj: Record<string, unknown> = { ...current.obj };
  if (Object.keys(current.hooks).length === 0) {
    delete newObj["hooks"];
  } else {
    newObj["hooks"] = current.hooks;
  }
  const newSettings = `${JSON.stringify(newObj, null, 2)}\n`;
  atomicWriteFile(settingsPath, newSettings);

  return {
    mode: "restored",
    settingsPath,
    snapshotPath: retireSnapshot(newest.path),
    restoredCount,
    remaining,
  };
}
