// `harness gate enable --runtime codex`: put back the hook units that
// `harness gate disable --runtime codex` neutralised.
//
// Reads the live `harness.gate-disable-codex.*.json` snapshots beside the
// config (a Claude `harness.gate-disable.*.json` snapshot is never
// considered), keeps those taken for this config (another config's are
// skipped and named) and walks them by their recorded `createdAt`, newest
// first. Before a snapshot is considered for a restore it may be retired:
// renamed to `*.restored.json` when the config already matches its
// pre-disable sha, or to `*.superseded.json` when an install rewrote the
// config after it was taken (the installer's `<config>.harness-backup-<ts>`
// dates that write; an install re-renders every unit, so the snapshot's
// hooks lines may be outdated) or when none of its units is disabled any
// more. A retired snapshot stays on disk for audit and is never offered
// again, so a neutralised unit can never get an outdated line back from an
// old snapshot whose post-disable bytes happen to match.
//
// The first snapshot left is applied when the config's sha equals its
// post-disable sha: each unit it names gets its original `hooks = [...]`
// line back, and the result must hash to its pre-disable sha, so the restore
// is byte-identical. When the config was edited since, enable refuses unless
// `--force`; a forced restore swaps only the snapshot's hooks lines back
// into the units it names, found by id in the block as it is now, keeps
// every other edit, and refuses when a unit is missing, was changed (another
// event or matcher) or is not neutralised (it would run twice). After a
// snapshot is applied, an older one follows in the same run only when it
// matches the file as it now stands byte for byte and was taken earlier (the
// chain), so two disables need one enable, and `--force` applies one
// snapshot per run. Every applied snapshot is retired as restored. Units
// still disabled at the end are reported in `stillDisabled`, and snapshots
// that still name one in `unapplied`: enable never reports an all-clear
// while one remains. A backup of the config is written before every
// rewrite, with the config's own mode.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertCodexHookEditInvariant,
  existingFileMode,
  latestCodexInstallBackupMs,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  type CodexGateSnapshot,
  type CodexSnapshotRetirement,
  listCodexSnapshots,
  readCodexSnapshot,
  resolveCodexConfig,
  retiredCodexSnapshotPath,
  toGateError,
} from "./codex-snapshot.js";
import { GateEnableError } from "./enable.js";
import { backupPath, sha256Hex } from "./snapshot.js";

export interface CodexGateEnableOptions {
  configPath?: string;
  homeDir?: string;
  /** Restore even when the config was edited since the snapshot. */
  force?: boolean;
  now?: Date;
}

interface EnableBase {
  configPath: string;
  /** Ids of the block's units that are still neutralised after this call. */
  stillDisabled: string[];
  /** Live snapshots beside the config that were taken for another config. */
  skippedForeign: string[];
}

/** A snapshot this call retired: `from` was renamed to `to`. */
export interface CodexRetiredSnapshot {
  from: string;
  to: string;
  why: CodexSnapshotRetirement;
}

interface WalkBase extends EnableBase {
  retired: CodexRetiredSnapshot[];
  /** Snapshots left live that still name a disabled unit: they no longer
   * match the config byte for byte (a forced enable applies the newest). */
  unapplied: string[];
}

export type CodexGateEnableResult =
  | (EnableBase & { mode: "no-snapshots" })
  | (WalkBase & {
      mode: "already-restored";
      /** The newest snapshot considered, under its retired name. */
      snapshotPath: string;
    })
  | (WalkBase & {
      mode: "restored";
      /** The first snapshot applied (the newest), under its retired name. */
      snapshotPath: string;
      /** Every snapshot applied, newest first, under their retired names. */
      snapshotPaths: string[];
      backupPath: string;
      restoredCount: number;
    });

interface LoadedSnapshot {
  path: string;
  snapshot: CodexGateSnapshot;
  createdMs: number;
}

/** Newest `createdAt` first; equal times by file name, newest name first. */
function newestFirst(a: LoadedSnapshot, b: LoadedSnapshot): number {
  if (a.createdMs !== b.createdMs) return b.createdMs - a.createdMs;
  return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
}

/** The newest install write of the config, read from the installer's
 * backups beside the requested path (and beside the resolved target, where
 * an install through the target's own path leaves them). */
function latestInstallMs(requestedPath: string, configPath: string): number | null {
  const times = [requestedPath, configPath].map(latestCodexInstallBackupMs).filter((t) => t !== null);
  return times.length === 0 ? null : Math.max(...times);
}

function readBlock(text: string, configPath: string): ReturnType<typeof readCodexManagedHookUnits> {
  try {
    return readCodexManagedHookUnits(text, configPath);
  } catch (err) {
    throw toGateError(err, (m) => new GateEnableError(m));
  }
}

/** Ids of the block's neutralised units, or null when the config has no block. */
function disabledIdsOrNull(text: string, configPath: string): string[] | null {
  const block = readBlock(text, configPath);
  return block === null ? null : block.units.filter((u) => u.disabled).map((u) => u.id);
}

type RestorePlan = { ok: true; text: string } | { ok: false; reason: string };

/** The config with each unit of the snapshot given its original `hooks` line
 * back. The unit is found by id in the block as it is now and must still be
 * the same event and matcher, and neutralised. */
function planRestore(current: string, configPath: string, snapshot: CodexGateSnapshot): RestorePlan {
  const block = readBlock(current, configPath);
  if (block === null) {
    return {
      ok: false,
      reason:
        `${configPath} has no harness-managed Codex hook block any more; cannot restore units into it. ` +
        "Run `harness apply --runtime codex --install` to write the block.",
    };
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const wanted of snapshot.neutralised) {
    const found = block.units.filter((u) => u.id === wanted.id);
    const unit = found.length === 1 ? found[0]! : undefined;
    if (unit === undefined || unit.event !== wanted.event || unit.matcher !== wanted.matcher) {
      return {
        ok: false,
        reason:
          `the hook unit ${JSON.stringify(wanted.id)} from the snapshot is not in the block of ${configPath} ` +
          "as it was (missing, listed twice, or changed event or matcher); cannot restore it. The config is untouched.",
      };
    }
    if (!unit.disabled) {
      return {
        ok: false,
        reason:
          `the hook unit ${JSON.stringify(wanted.id)} from the snapshot is not disabled in the block of ` +
          `${configPath} (already enabled, or re-rendered by an install); restoring it again could run it twice. ` +
          "The config is untouched.",
      };
    }
    edits.push({ start: unit.hooksStart, end: unit.hooksEnd, text: wanted.hooksText });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += current.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { ok: true, text: out + current.slice(cursor) };
}

export function codexGateEnable(opts: CodexGateEnableOptions = {}): CodexGateEnableResult {
  const { requestedPath, configPath } = resolveCodexConfig(opts, (m) => new GateEnableError(m));

  // Every live snapshot is read first: the walk filters them by config and
  // orders them by their own recorded time, not by file mtime (a copy of the
  // directory without -p reorders mtimes).
  const own: LoadedSnapshot[] = [];
  const skippedForeign: string[] = [];
  for (const snapPath of listCodexSnapshots(path.dirname(requestedPath))) {
    const read = readCodexSnapshot(snapPath);
    if (!read.ok) throw new GateEnableError(read.reason);
    if (read.snapshot.configPath !== requestedPath) {
      skippedForeign.push(snapPath);
      continue;
    }
    own.push({ path: snapPath, snapshot: read.snapshot, createdMs: Date.parse(read.snapshot.createdAt) });
  }
  own.sort(newestFirst);

  let original: string;
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (own.length === 0) return { mode: "no-snapshots", configPath: requestedPath, stillDisabled: [], skippedForeign };
      throw new GateEnableError(
        `Codex config not found: ${requestedPath}; cannot restore into a missing target`,
      );
    }
    throw new GateEnableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }
  if (own.length === 0) {
    return {
      mode: "no-snapshots",
      configPath: requestedPath,
      stillDisabled: disabledIdsOrNull(original, configPath) ?? [],
      skippedForeign,
    };
  }

  const installedMs = latestInstallMs(requestedPath, configPath);
  let current = original;
  const applied: LoadedSnapshot[] = [];
  const retire: Array<{ from: string; why: CodexSnapshotRetirement }> = [];
  const unapplied: string[] = [];
  let restoredCount = 0;
  for (const loaded of own) {
    const snapshot = loaded.snapshot;
    // A re-install after the snapshot re-rendered every unit it names: its
    // hooks lines may be outdated, so it is never applied again.
    if (installedMs !== null && installedMs > loaded.createdMs) {
      retire.push({ from: loaded.path, why: "superseded" });
      continue;
    }
    const currentSha = sha256Hex(current);
    if (currentSha === snapshot.configBeforeSha256) {
      retire.push({ from: loaded.path, why: "restored" });
      continue;
    }
    const disabledNow = disabledIdsOrNull(current, configPath);
    if (disabledNow !== null && !snapshot.neutralised.some((u) => disabledNow.includes(u.id))) {
      // None of its units is disabled any more: something else enabled them.
      retire.push({ from: loaded.path, why: "superseded" });
      continue;
    }
    const exact = currentSha === snapshot.configAfterSha256;
    const last = applied[applied.length - 1];
    if (unapplied.length > 0 || (last !== undefined && !(exact && loaded.createdMs < last.createdMs))) {
      // The chain: after a snapshot is applied, another follows only when it
      // matches the file as it now stands byte for byte and was taken
      // earlier. Once the walk stops here, no older snapshot is applied.
      unapplied.push(loaded.path);
      continue;
    }
    if (!exact && !opts.force) {
      throw new GateEnableError(
        `the Codex config has been edited since the snapshot was taken (${loaded.path}; current sha ` +
          `${currentSha.slice(0, 12)}..., snapshot's post-disable sha ${snapshot.configAfterSha256.slice(0, 12)}...). ` +
          `Inspect the diff against ${snapshot.configBackupPath}. --force swaps only this snapshot's hooks ` +
          "lines back into the units it names (found by id) and keeps every other edit.",
      );
    }

    const plan = planRestore(current, configPath, snapshot);
    if (!plan.ok) throw new GateEnableError(plan.reason);
    if (exact && sha256Hex(plan.text) !== snapshot.configBeforeSha256) {
      throw new GateEnableError(
        `the snapshot ${loaded.path} does not rebuild the config it was taken from (the restored text does not ` +
          "match its recorded pre-disable sha); refusing to write. The config is untouched.",
      );
    }
    const counts: Record<string, number> = {};
    for (const unit of snapshot.neutralised) counts[unit.event] = (counts[unit.event] ?? 0) + 1;
    try {
      assertCodexHookEditInvariant(current, plan.text, configPath, { direction: "restore", counts });
    } catch (err) {
      throw toGateError(err, (m) => new GateEnableError(m));
    }
    current = plan.text;
    applied.push(loaded);
    retire.push({ from: loaded.path, why: "restored" });
    restoredCount += snapshot.neutralised.length;
  }

  const stillDisabled = disabledIdsOrNull(current, configPath) ?? [];
  let backup: string | undefined;
  if (applied.length > 0) {
    const mode = existingFileMode(configPath);
    backup = backupPath(requestedPath, opts.now ?? new Date());
    atomicWriteFile(backup, original, { mode });
    atomicWriteFile(configPath, current, { mode });
  }
  // Retired only after the config write: a crash in between leaves a
  // snapshot the file already matches (or whose units are all enabled after
  // a forced restore), which the next enable retires.
  const retired: CodexRetiredSnapshot[] = retire.map(({ from, why }) => {
    const to = retiredCodexSnapshotPath(from, why);
    try {
      fs.renameSync(from, to);
    } catch (err) {
      throw new GateEnableError(
        `${applied.length > 0 ? `restored ${restoredCount} hook unit(s) into ${requestedPath}, but ` : ""}` +
          `cannot retire the snapshot ${from} (rename to ${to}: ${(err as Error).message}); ` +
          "move it out of the directory by hand so it is never applied again.",
      );
    }
    return { from, to, why };
  });
  const renamed = (p: string): string => retired.find((r) => r.from === p)?.to ?? p;
  const base = { configPath: requestedPath, stillDisabled, skippedForeign, retired, unapplied };
  if (backup === undefined) return { ...base, mode: "already-restored", snapshotPath: renamed(own[0]!.path) };
  return {
    ...base,
    mode: "restored",
    snapshotPath: renamed(applied[0]!.path),
    snapshotPaths: applied.map((a) => renamed(a.path)),
    backupPath: backup,
    restoredCount,
  };
}
