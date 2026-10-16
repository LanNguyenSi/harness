// `harness gate enable --runtime codex`: put back the hook units that
// `harness gate disable --runtime codex` neutralised.
//
// Reads the live `harness.gate-disable-codex.*.json` snapshot beside the
// config (a Claude `harness.gate-disable.*.json` snapshot is never
// considered). At most one is live per config: every disable merges into it.
// Another config's snapshot is skipped and named. An earlier build kept one
// snapshot per disable; with several live ones for this config, enable
// handles the newest by its recorded `createdAt` (never by file mtime) per
// run and names the rest in `remaining`, so the caller exits non-zero until
// none is left.
//
// The snapshot is retired first when it can no longer be applied: renamed to
// `*.restored.json` when the config already matches its pre-disable sha, or
// to `*.superseded.json` when an install rewrote the config after it was
// taken (the installer's `<config>.harness-backup-<ts>` dates that write; an
// install re-renders every unit, so the snapshot's hooks lines may be
// outdated) or when none of its units is disabled any more and every one is
// still in the block. A retired snapshot stays on disk for audit and is never
// offered again, so a neutralised unit can never get an outdated line back
// from an old snapshot whose post-disable bytes happen to match.
//
// Otherwise the snapshot is applied. When the config's sha equals its
// post-disable sha, each unit it names gets its original `hooks = [...]`
// line back and the result must hash to its pre-disable sha, so the restore
// is byte-identical. When the config was edited since, the restore skips every
// unit that is back already (present and not neutralised: its current line is
// never overwritten) and restores the rest, found by id in the block as it is
// now. If that rebuilds the pre-disable bytes exactly (a crashed merge, a unit
// put back by hand) it is applied without `--force`; otherwise enable refuses
// unless `--force`, which applies it anyway, keeps every other edit, and still
// refuses when a unit is missing or was changed (another event or matcher).
// The applied snapshot is retired as restored. Units still disabled at the end
// are reported in `stillDisabled`, units skipped as already enabled in
// `skippedEnabled`, other live snapshots in `remaining`, and units the snapshot
// names that were deleted from the block in `missing` (that snapshot stays
// live): enable never reports an all-clear while one remains. A backup of the
// config is written before every rewrite, with the config's own mode.

import * as fs from "node:fs";
import {
  assertCodexHookEditInvariant,
  existingFileMode,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  type CodexDisabledUnit,
  type CodexGateSnapshot,
  type CodexRetiredSnapshot,
  latestInstall,
  readLiveCodexSnapshots,
  resolveCodexConfig,
  retireCodexSnapshot,
  spentCodexSnapshot,
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

interface SnapshotBase extends EnableBase {
  /** The snapshot this call retired, or null when it stays live. */
  retired: CodexRetiredSnapshot | null;
  /** Other live snapshots for this config (an earlier build wrote one per
   * disable): enable handles one per run, so the caller runs it again. */
  remaining: string[];
  /** Ids of units the snapshot names that are gone from the block (deleted
   * by hand): the snapshot stays live, and enable never reports an all-clear. */
  missing: string[];
  /** The snapshot considered, under its retired name once it was retired. */
  snapshotPath: string;
}

export type CodexGateEnableResult =
  | (EnableBase & { mode: "no-snapshots" })
  | (SnapshotBase & { mode: "already-restored" })
  | (SnapshotBase & {
      mode: "restored";
      backupPath: string;
      restoredCount: number;
      /** Ids the snapshot names that were enabled again already: left as they are. */
      skippedEnabled: string[];
    });

function readBlock(text: string, configPath: string): ReturnType<typeof readCodexManagedHookUnits> {
  try {
    return readCodexManagedHookUnits(text, configPath);
  } catch (err) {
    throw toGateError(err, (m) => new GateEnableError(m));
  }
}

/** Ids of the block's neutralised units; none when the config has no block. */
function disabledIds(text: string, configPath: string): string[] {
  return readBlock(text, configPath)?.units.filter((u) => u.disabled).map((u) => u.id) ?? [];
}

type RestorePlan =
  | { ok: true; text: string; restored: CodexDisabledUnit[]; skipped: string[] }
  | { ok: false; reason: string };

/** The config with each still-neutralised unit of the snapshot given its
 * original `hooks` line back. A unit is found by id in the block as it is now
 * and must still be the same event and matcher. A unit that is present and
 * not neutralised is already back: it is skipped and named in `skipped`, its
 * current line is never overwritten. */
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
  const restored: CodexDisabledUnit[] = [];
  const skipped: string[] = [];
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
      skipped.push(wanted.id);
      continue;
    }
    edits.push({ start: unit.hooksStart, end: unit.hooksEnd, text: wanted.hooksText });
    restored.push(wanted);
  }
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += current.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { ok: true, text: out + current.slice(cursor), restored, skipped };
}

export function codexGateEnable(opts: CodexGateEnableOptions = {}): CodexGateEnableResult {
  const { requestedPath, configPath } = resolveCodexConfig(opts, (m) => new GateEnableError(m));
  const { own, foreign: skippedForeign } = readLiveCodexSnapshots(requestedPath, (m) => new GateEnableError(m));
  const live = own[0];

  let original: string;
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (live === undefined) return { mode: "no-snapshots", configPath: requestedPath, stillDisabled: [], skippedForeign };
      throw new GateEnableError(
        `Codex config not found: ${requestedPath}; cannot restore into a missing target`,
      );
    }
    throw new GateEnableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }
  if (live === undefined) {
    return {
      mode: "no-snapshots",
      configPath: requestedPath,
      stillDisabled: disabledIds(original, configPath),
      skippedForeign,
    };
  }

  const { snapshot } = live;
  const currentSha = sha256Hex(original);
  const units = readBlock(original, configPath)?.units ?? null;
  const { retire: spent, missing } = spentCodexSnapshot(
    snapshot,
    currentSha,
    units,
    latestInstall(requestedPath, configPath),
  );
  let retire = spent;
  let current = original;
  let backup: string | undefined;
  let restoredCount = 0;
  let skipped: string[] = [];
  // Nothing is applied when the snapshot only names units that were deleted from the block: it stays live.
  if (retire === null && missing.length === 0) {
    const exact = currentSha === snapshot.configAfterSha256;
    // The restore skips a unit that is back already and never overwrites a
    // live line. An edited config is restored without --force only when that
    // provably rebuilds the pre-disable bytes (a crashed merge, a unit put
    // back by hand); otherwise it refuses.
    const plan = planRestore(original, configPath, snapshot);
    const proven = plan.ok && sha256Hex(plan.text) === snapshot.configBeforeSha256;
    if (!exact && !proven && !opts.force) {
      throw new GateEnableError(
        `the Codex config has been edited since the snapshot was taken (${live.path}; current sha ` +
          `${currentSha.slice(0, 12)}..., snapshot's post-disable sha ${snapshot.configAfterSha256.slice(0, 12)}...). ` +
          `Inspect the diff against ${snapshot.configBackupPath}. --force restores every unit the snapshot names that is ` +
          "still neutralised (found by id), leaves a unit that is enabled again as it is, keeps every other edit " +
          "and retires the snapshot.",
      );
    }
    if (!plan.ok) throw new GateEnableError(plan.reason);
    if (exact && !proven) {
      throw new GateEnableError(
        `the snapshot ${live.path} does not rebuild the config it was taken from (the restored text does not ` +
          "match its recorded pre-disable sha); refusing to write. The config is untouched.",
      );
    }
    const counts: Record<string, number> = {};
    for (const unit of plan.restored) counts[unit.event] = (counts[unit.event] ?? 0) + 1;
    try {
      assertCodexHookEditInvariant(original, plan.text, configPath, { direction: "restore", counts });
    } catch (err) {
      throw toGateError(err, (m) => new GateEnableError(m));
    }
    current = plan.text;
    restoredCount = plan.restored.length;
    skipped = plan.skipped;
    retire = { why: "restored" };
    const mode = existingFileMode(configPath);
    backup = backupPath(requestedPath, opts.now ?? new Date());
    atomicWriteFile(backup, original, { mode });
    atomicWriteFile(configPath, current, { mode });
  }

  // Retired only after the config write: a crash in between leaves a
  // snapshot the file already matches (or whose units are all enabled after
  // a forced restore), which the next enable retires.
  let retired: CodexRetiredSnapshot | null = null;
  if (retire !== null) {
    let to: string;
    try {
      to = retireCodexSnapshot(live.path, retire.why);
    } catch (err) {
      throw new GateEnableError(
        `${backup !== undefined ? `restored ${restoredCount} hook unit(s) into ${requestedPath}, but ` : ""}` +
          `cannot retire the snapshot ${live.path} (${(err as Error).message}); ` +
          "move it out of the directory by hand so it is never applied again.",
      );
    }
    retired = { from: live.path, to, ...retire };
  }
  const base = {
    configPath: requestedPath,
    stillDisabled: disabledIds(current, configPath),
    skippedForeign,
    retired,
    remaining: own.slice(1).map((l) => l.path),
    missing,
    snapshotPath: retired?.to ?? live.path,
  };
  if (backup === undefined) return { ...base, mode: "already-restored" };
  return { ...base, mode: "restored", backupPath: backup, restoredCount, skippedEnabled: skipped };
}
