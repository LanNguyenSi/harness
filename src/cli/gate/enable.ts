// `harness gate enable` — restore the most recent `gate disable` snapshot.
//
// Reads the newest `harness.gate-disable.*.json` next to settings.json,
// merges its `removed[]` groups back into `hooks[event][]` at their
// original indices, and atomically rewrites settings.json. Refuses if
// settings.json has been edited since the snapshot was taken (the
// recorded `settingsAfterSha256` no longer matches the on-disk content)
// unless `--force` is passed, so a hand-edit between disable and enable
// is not silently overwritten. Idempotent on an already-restored file
// (the snapshot's `settingsBeforeSha256` matches the current sha →
// nothing to do).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  type GateDisableSnapshot,
  listSnapshots,
  readSnapshot,
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
   * enable; silent overwrite would lose their changes).
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
      snapshotPath: string;
    }
  | {
      mode: "restored";
      settingsPath: string;
      snapshotPath: string;
      restoredCount: number;
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

function reinsertRemoved(
  hooks: Record<string, unknown[]>,
  snapshot: GateDisableSnapshot,
): number {
  // Sort removed entries by event, then by ascending index, so we splice
  // them back in growing order — that way an earlier insertion never
  // shifts a later insertion's target index past the array end.
  const sorted = [...snapshot.removed].sort((a, b) => {
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
  const settingsDir = path.dirname(settingsPath);

  const snapshotPaths = listSnapshots(settingsDir);
  if (snapshotPaths.length === 0) {
    return { mode: "no-snapshots", settingsPath };
  }
  const latest = snapshotPaths[0]!;
  const readResult = readSnapshot(latest);
  if (!readResult.ok) {
    throw new GateEnableError(readResult.reason);
  }
  const snapshot = readResult.snapshot;

  const current = readCurrentSettings(settingsPath);
  const currentSha = sha256Hex(current.raw);

  if (currentSha === snapshot.settingsBeforeSha256) {
    // The current file already matches the pre-disable state: nothing
    // to restore. Idempotent return.
    return { mode: "already-restored", settingsPath, snapshotPath: latest };
  }

  if (currentSha !== snapshot.settingsAfterSha256 && !opts.force) {
    throw new GateEnableError(
      `settings.json has been edited since the snapshot was taken (current sha ${currentSha.slice(0, 12)}…, ` +
        `snapshot's post-disable sha ${snapshot.settingsAfterSha256.slice(0, 12)}…). ` +
        `Re-running would overwrite those edits. Inspect the diff against ` +
        `${snapshot.settingsBackupPath}, then pass --force to restore anyway.`,
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

  return { mode: "restored", settingsPath, snapshotPath: latest, restoredCount };
}

/** Test-helper: re-export for the test suite to inspect snapshot pickup. */
export { listSnapshots };
