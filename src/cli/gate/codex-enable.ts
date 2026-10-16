// `harness gate enable --runtime codex`: put back the hook units that
// `harness gate disable --runtime codex` neutralised.
//
// Reads the `harness.gate-disable-codex.*.json` snapshots beside the config
// (a Claude `harness.gate-disable.*.json` snapshot is never considered) and
// walks them newest first. A snapshot whose post-disable sha equals the
// config's current sha is applied: each unit it names gets its original
// `hooks = [...]` line back, and the result must hash to the snapshot's
// pre-disable sha, so the restore is byte-identical. A snapshot whose
// pre-disable sha equals the current sha is already restored and skipped.
// The walk goes on to the older snapshots until no unit of the block is
// neutralised any more, so two disables need two snapshots and one enable.
// When the config was edited since a snapshot, enable refuses unless
// `--force`; a forced restore finds each unit of the snapshot by its id in
// the block as it is now and refuses when that unit is missing, was changed
// (another event or matcher) or is not neutralised (it would run twice).
// Units that no snapshot restores are reported in `stillDisabled`: enable
// never reports an all-clear while one remains. A backup of the config is
// written before every rewrite, with the config's own mode.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertCodexHookEditInvariant,
  existingFileMode,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  CODEX_SNAPSHOT_BASENAME_PREFIX,
  type CodexGateSnapshot,
  readCodexSnapshot,
  resolveCodexConfig,
  toGateError,
} from "./codex-snapshot.js";
import { GateEnableError } from "./enable.js";
import { backupPath, listSnapshots, sha256Hex } from "./snapshot.js";

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
}

export type CodexGateEnableResult =
  | (EnableBase & { mode: "no-snapshots" })
  | (EnableBase & { mode: "already-restored"; snapshotPath: string })
  | (EnableBase & {
      mode: "restored";
      /** The first snapshot applied (the newest). */
      snapshotPath: string;
      /** Every snapshot applied, newest first. */
      snapshotPaths: string[];
      backupPath: string;
      restoredCount: number;
    });

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

  const snapshotPaths = listSnapshots(path.dirname(requestedPath), CODEX_SNAPSHOT_BASENAME_PREFIX);
  let original: string;
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (snapshotPaths.length === 0) return { mode: "no-snapshots", configPath: requestedPath, stillDisabled: [] };
      throw new GateEnableError(
        `Codex config not found: ${requestedPath}; cannot restore into a missing target`,
      );
    }
    throw new GateEnableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }
  if (snapshotPaths.length === 0) {
    return { mode: "no-snapshots", configPath: requestedPath, stillDisabled: disabledIdsOrNull(original, configPath) ?? [] };
  }

  let current = original;
  const applied: string[] = [];
  let restoredCount = 0;
  for (const [i, snapPath] of snapshotPaths.entries()) {
    const disabledNow = disabledIdsOrNull(current, configPath);
    const noneDisabled = disabledNow !== null && disabledNow.length === 0;
    if (noneDisabled && i > 0) break;
    const read = readCodexSnapshot(snapPath);
    if (!read.ok) throw new GateEnableError(read.reason);
    const snapshot = read.snapshot;
    if (snapshot.configPath !== requestedPath) {
      throw new GateEnableError(
        `the Codex gate snapshot ${snapPath} was taken for ${snapshot.configPath}, not ${requestedPath}; ` +
          "pass the matching --config, or move the snapshot away.",
      );
    }
    if (noneDisabled) break;
    const currentSha = sha256Hex(current);
    if (currentSha === snapshot.configBeforeSha256) continue;
    const exact = currentSha === snapshot.configAfterSha256;
    if (!exact && !opts.force) {
      if (applied.length > 0) break;
      throw new GateEnableError(
        `the Codex config has been edited since the snapshot was taken (current sha ${currentSha.slice(0, 12)}..., ` +
          `snapshot's post-disable sha ${snapshot.configAfterSha256.slice(0, 12)}...). ` +
          `Re-running would overwrite those edits. Inspect the diff against ` +
          `${snapshot.configBackupPath}, then pass --force to restore anyway.`,
      );
    }

    const plan = planRestore(current, configPath, snapshot);
    if (!plan.ok) {
      // An older snapshot a forced walk reaches may be stale (its units were
      // restored or re-rendered long ago): skip it. The first snapshot, and
      // any exact one, refuses instead.
      if (applied.length > 0 && !exact) continue;
      throw new GateEnableError(plan.reason);
    }
    if (exact && sha256Hex(plan.text) !== snapshot.configBeforeSha256) {
      throw new GateEnableError(
        `the snapshot ${snapPath} does not rebuild the config it was taken from (the restored text does not ` +
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
    applied.push(snapPath);
    restoredCount += snapshot.neutralised.length;
  }

  const stillDisabled = disabledIdsOrNull(current, configPath) ?? [];
  if (applied.length === 0) {
    return { mode: "already-restored", configPath: requestedPath, snapshotPath: snapshotPaths[0]!, stillDisabled };
  }
  const mode = existingFileMode(configPath);
  const backup = backupPath(requestedPath, opts.now ?? new Date());
  atomicWriteFile(backup, original, { mode });
  atomicWriteFile(configPath, current, { mode });
  return {
    mode: "restored",
    configPath: requestedPath,
    snapshotPath: applied[0]!,
    snapshotPaths: applied,
    backupPath: backup,
    restoredCount,
    stillDisabled,
  };
}
