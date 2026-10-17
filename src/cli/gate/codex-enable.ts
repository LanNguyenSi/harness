// `harness gate enable --runtime codex`: put back the hook units that
// `harness gate disable --runtime codex` neutralised.
//
// Reads the live `harness.gate-disable-codex.*.json` snapshot beside the
// config (a Claude `harness.gate-disable.*.json` snapshot is never
// considered). At most one is live per config: every disable merges into it.
// Another config's snapshot is skipped and named with the `--config` that
// restores it; a snapshot recorded under another spelling of this config's
// own directory entry (case or normalization on a folding filesystem) is this
// config's own. An earlier build kept one
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
// unit that is back already (present once and not neutralised, whatever its
// event or matcher: its current line is never overwritten) and restores the
// rest, found by id in the block as it is now. If that rebuilds the
// pre-disable bytes exactly (a crashed merge, a unit put back by hand) it is
// applied without `--force`; otherwise enable refuses unless `--force`, which
// applies it anyway and keeps every other edit. A unit that is missing, listed
// twice, or still neutralised under another event or matcher cannot be
// restored by either: that refusal comes first and names the ways out
// (re-install, the backup, or moving the snapshot aside), never `--force`.
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
  codexSnapshotExits,
  type CodexRetiredSnapshot,
  type ForeignCodexSnapshot,
  latestInstall,
  planCodexRestore,
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
  /** Live snapshots beside the config that were taken for another config
   * (another file, or the same file under a name harness cannot prove is its own). */
  skippedForeign: ForeignCodexSnapshot[];
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
        `Codex config not found: ${requestedPath}; cannot restore into a missing target. ${codexSnapshotExits(live)}`,
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
    // The restore skips a unit that is back already and never overwrites a
    // live line. Every check that would also stop --force runs first, so the
    // edited-since refusal names --force only when --force would write.
    const plan = planCodexRestore(original, units, configPath, live);
    if (!plan.ok) throw new GateEnableError(plan.reason);
    const counts: Record<string, number> = {};
    for (const unit of plan.restored) counts[unit.event] = (counts[unit.event] ?? 0) + 1;
    try {
      assertCodexHookEditInvariant(original, plan.text, configPath, { direction: "restore", counts });
    } catch (err) {
      throw toGateError(err, (m) => new GateEnableError(m));
    }
    // An edited config is restored without --force only when the restore
    // provably rebuilds the pre-disable bytes (a crashed merge, a unit put
    // back by hand). An unedited one must rebuild them, --force or not.
    const exact = currentSha === snapshot.configAfterSha256;
    const proven = sha256Hex(plan.text) === snapshot.configBeforeSha256;
    if (exact && !proven) {
      throw new GateEnableError(
        `the snapshot ${live.path} does not rebuild the config it was taken from (the restored text does not ` +
          `match its recorded pre-disable sha); refusing to write. The config is untouched. ${codexSnapshotExits(live)}`,
      );
    }
    if (!exact && !proven && !opts.force) {
      throw new GateEnableError(
        `the Codex config has been edited since the snapshot was taken (${live.path}; current sha ` +
          `${currentSha.slice(0, 12)}..., snapshot's post-disable sha ${snapshot.configAfterSha256.slice(0, 12)}...). ` +
          `Inspect the diff against ${snapshot.configBackupPath}. --force restores every unit the snapshot names that is ` +
          "still neutralised (found by id), leaves a unit that is enabled again as it is, keeps every other edit " +
          "and retires the snapshot.",
      );
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
    const done = backup !== undefined ? `restored ${restoredCount} hook unit(s) into ${requestedPath}, but ` : "";
    const to = retireCodexSnapshot(live.path, retire.why, (m) => new GateEnableError(m), done);
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
