// `harness gate enable`: restore the live `gate disable` snapshot.
//
// There is one live `harness.gate-disable.*.json` per settings.json (a
// second disable merges into it). Enable puts every removed group back at
// its recorded index and atomically rewrites settings.json, then retires the
// snapshot (renamed to `*.restored.json`, kept for audit, never applied
// again). A group the file already holds unchanged is never spliced in a
// second time. A group with the same event and matcher but other content may
// be another hook that shares the matcher, so enable refuses while there is
// one and names both groups' commands; `--force` takes it as back. When
// settings.json has been edited since the snapshot was taken (the recorded
// `settingsAfterSha256` no longer matches the on-disk content), the groups
// that are still missing are put back only if that gives exactly the
// pre-disable file (what a crash between the two disable writes leaves
// behind); otherwise enable refuses, and `--force` puts them back into the
// file as it is and keeps the edits. A file that already matches the
// pre-disable state, or already holds every group unchanged, has nothing to
// restore: the snapshot is retired. A directory holding several live
// snapshots (version 1 releases left one per disable) is handled one
// snapshot per call, newest first; the result names the ones still live, and
// the live snapshots of other settings files beside it, so the caller can
// refuse an all-clear.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  changedLabel,
  type ForeignSnapshot,
  groupLabel,
  listLiveSnapshots,
  planRestore,
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
   * from the snapshot's recorded post-disable sha and putting the missing
   * groups back would not give the pre-disable file. Without it, that case
   * refuses (the operator edited the file between disable and enable).
   * Every group that is still missing is spliced into the file as it is, one
   * that is already there unchanged is left alone and reported, and the
   * edits stay. A group with the same event and matcher but other content is
   * taken as back (not spliced in) and reported with both groups' commands.
   */
  force?: boolean;
}

export type GateEnableResult =
  | {
      mode: "no-snapshots";
      settingsPath: string;
      /** Live snapshots beside the file that name another settings file; their groups are not restored. */
      foreign: ForeignSnapshot[];
    }
  | {
      mode: "already-restored";
      settingsPath: string;
      /** The snapshot under its retired name. */
      snapshotPath: string;
      /** Snapshots still live after this call (version 1 leftovers), newest first. */
      remaining: string[];
      foreign: ForeignSnapshot[];
      /** Groups the file already held unchanged, left alone. Empty when the file matched the pre-disable state. */
      alreadyBack: string[];
      /** `--force` only: groups of the file taken as back for a snapshot group with the same event and matcher, with both groups' commands. */
      accepted: string[];
    }
  | {
      mode: "restored";
      settingsPath: string;
      /** The snapshot under its retired name. */
      snapshotPath: string;
      restoredCount: number;
      /** Snapshots still live after this call (version 1 leftovers), newest first. */
      remaining: string[];
      foreign: ForeignSnapshot[];
      /** Groups the file already held unchanged, left alone instead of spliced in a second time. */
      alreadyBack: string[];
      /** `--force` only: groups of the file taken as back for a snapshot group with the same event and matcher, with both groups' commands. */
      accepted: string[];
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
        `settings file not found: ${settingsPath}; cannot restore into a missing target`,
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

export function gateEnable(opts: GateEnableOptions = {}): GateEnableResult {
  const settingsPath = resolveSettingsPath(opts);

  const found = listLiveSnapshots(settingsPath);
  if (!found.ok) {
    throw new GateEnableError(
      `${found.reason}. Nothing was restored: a live snapshot that cannot be read may name groups still removed ` +
        `from ${settingsPath}. Move ${found.path} aside (or rename it to *.restored.json once its groups are back) ` +
        `and run \`harness gate enable\` again.`,
    );
  }
  const foreign = found.skippedForeign;
  const [newest, ...older] = found.live;
  if (newest === undefined) {
    return { mode: "no-snapshots", settingsPath, foreign };
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
      snapshotPath: retireApplied(newest.path, settingsPath, 0),
      remaining,
      foreign,
      alreadyBack: [],
      accepted: [],
    };
  }

  const plan = planRestore(current.hooks, snapshot);
  const alreadyBack = plan.alreadyBack.map((r) => groupLabel(r.event, r.group));
  const accepted = plan.changed.map(changedLabel);
  if (accepted.length > 0 && !opts.force) {
    // A group with the matcher of the gate's but other content may be another
    // hook entirely: taking it for the gate's would leave the gate off.
    throw new GateEnableError(
      `${settingsPath} holds ${accepted.length} hook group(s) with the event and matcher of a group the snapshot ` +
        `${newest.path} removed but with other content (${accepted.join("; ")}). Such a group may be another hook ` +
        `that shares the matcher, so it does not count as back.` +
        (plan.restored.length > 0
          ? ` ${plan.restored.length} more hook group(s) it removed are missing ` +
            `(${plan.restored.map((r) => groupLabel(r.event, r.group)).join("; ")}).`
          : "") +
        ` Nothing was changed and the snapshot stays live. If the file's group stands in for the snapshot's, run ` +
        `\`harness gate enable --force\`: it takes it as back (the snapshot's group is not put back), puts the ` +
        `missing groups back and keeps every other edit. Otherwise make the file hold the snapshot's group ` +
        `(${snapshot.settingsBackupPath} has it) and run \`harness gate enable\` again.`,
    );
  }
  if (plan.restored.length === 0) {
    // Every group the snapshot names is back in the file (by hand, or an
    // apply re-rendered it): the snapshot is spent whatever else was edited.
    return {
      mode: "already-restored",
      settingsPath,
      snapshotPath: retireApplied(newest.path, settingsPath, 0),
      remaining,
      foreign,
      alreadyBack,
      accepted,
    };
  }

  const newObj: Record<string, unknown> = { ...current.obj };
  if (Object.keys(plan.hooks).length === 0) {
    delete newObj["hooks"];
  } else {
    newObj["hooks"] = plan.hooks;
  }
  const newSettings = `${JSON.stringify(newObj, null, 2)}\n`;

  // The file is not the state the snapshot left, and the groups still missing
  // do not add up to the pre-disable file: an edit would be written over
  // without the operator having seen it.
  if (
    currentSha !== snapshot.settingsAfterSha256 &&
    sha256Hex(newSettings) !== snapshot.settingsBeforeSha256 &&
    !opts.force
  ) {
    throw new GateEnableError(
      `settings.json has been edited since the snapshot was taken (current sha ${currentSha.slice(0, 12)}..., ` +
        `snapshot's post-disable sha ${snapshot.settingsAfterSha256.slice(0, 12)}...), and ` +
        `${plan.restored.length} hook group(s) it removed are still missing ` +
        `(${plan.restored.map((r) => groupLabel(r.event, r.group)).join("; ")}). Nothing was changed and the ` +
        `snapshot ${newest.path} stays live. Inspect the diff against ${snapshot.settingsBackupPath}, then run ` +
        `\`harness gate enable --force\`: it puts the missing groups back, leaves a group that is already ` +
        `there alone and keeps every other edit.`,
    );
  }

  atomicWriteFile(settingsPath, newSettings);

  return {
    mode: "restored",
    settingsPath,
    snapshotPath: retireApplied(newest.path, settingsPath, plan.restored.length),
    restoredCount: plan.restored.length,
    remaining,
    foreign,
    alreadyBack,
    accepted,
  };
}

/**
 * Retires the snapshot this call applied (or found applied). A failed rename
 * is reported with what was done and the way out instead of a bare errno: a
 * snapshot left live is harmless (the next enable finds its groups back and
 * retires it), but the operator must know it is still there.
 */
function retireApplied(snapPath: string, settingsPath: string, restoredCount: number): string {
  try {
    return retireSnapshot(snapPath);
  } catch (err) {
    throw new GateEnableError(
      `${restoredCount > 0 ? `restored ${restoredCount} hook group(s) into ${settingsPath}` : `${settingsPath} needed no write`}, ` +
        `but cannot retire the snapshot ${snapPath} (${(err as Error).message}). Move it out of the directory by ` +
        `hand (or rename it to *.restored.json) so it is never applied again.`,
    );
  }
}
