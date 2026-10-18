// `harness gate enable --runtime codex`: puts back the hook units that
// `gate disable --runtime codex` neutralised, from the live
// `harness.gate-disable-codex.*.json` snapshot beside the config (another
// config's snapshot is skipped and named; several live ones for this config
// are handled newest first by `createdAt`, one per run, the rest in
// `remaining`). A snapshot that can no longer be applied is retired as
// `*.restored.json` or `*.superseded.json`; otherwise it is applied, with
// `--force` needed when the config was edited since and the restore does not
// rebuild the pre-disable bytes. A backup is written before every rewrite.
// Why and how: docs/okf/gate-kill-switch.md (Codex section).

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

function readBlock(
  text: string,
  configPath: string,
  namedPath: string | null,
): ReturnType<typeof readCodexManagedHookUnits> {
  try {
    return readCodexManagedHookUnits(text, configPath);
  } catch (err) {
    throw toGateError(err, (m) => new GateEnableError(m), namedPath);
  }
}

/** Ids of the block's neutralised units; none when the config has no block. */
function disabledIds(text: string, configPath: string, namedPath: string | null): string[] {
  return readBlock(text, configPath, namedPath)?.units.filter((u) => u.disabled).map((u) => u.id) ?? [];
}

export function codexGateEnable(opts: CodexGateEnableOptions = {}): CodexGateEnableResult {
  const { requestedPath, configPath, namedPath } = resolveCodexConfig(opts, (m) => new GateEnableError(m));
  const { own, foreign: skippedForeign } = readLiveCodexSnapshots(
    requestedPath,
    (m) => new GateEnableError(m),
    namedPath,
  );
  const live = own[0];

  let original: string;
  try {
    original = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (live === undefined) return { mode: "no-snapshots", configPath: requestedPath, stillDisabled: [], skippedForeign };
      throw new GateEnableError(
        `Codex config not found: ${requestedPath}; cannot restore into a missing target. ${codexSnapshotExits(live, namedPath)}`,
      );
    }
    throw new GateEnableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }
  if (live === undefined) {
    return {
      mode: "no-snapshots",
      configPath: requestedPath,
      stillDisabled: disabledIds(original, configPath, namedPath),
      skippedForeign,
    };
  }

  const { snapshot } = live;
  const currentSha = sha256Hex(original);
  const units = readBlock(original, configPath, namedPath)?.units ?? null;
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
    const plan = planCodexRestore(original, units, configPath, live, namedPath);
    if (!plan.ok) throw new GateEnableError(plan.reason);
    const counts: Record<string, number> = {};
    for (const unit of plan.restored) counts[unit.event] = (counts[unit.event] ?? 0) + 1;
    try {
      assertCodexHookEditInvariant(original, plan.text, configPath, { direction: "restore", counts });
    } catch (err) {
      throw toGateError(err, (m) => new GateEnableError(m), namedPath);
    }
    // An edited config is restored without --force only when the restore
    // provably rebuilds the pre-disable bytes (a crashed merge, a unit put
    // back by hand). An unedited one must rebuild them, --force or not.
    const exact = currentSha === snapshot.configAfterSha256;
    const proven = sha256Hex(plan.text) === snapshot.configBeforeSha256;
    if (exact && !proven) {
      throw new GateEnableError(
        `the snapshot ${live.path} does not rebuild the config it was taken from (the restored text does not ` +
          `match its recorded pre-disable sha); refusing to write. The config is untouched. ${codexSnapshotExits(live, namedPath)}`,
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
    stillDisabled: disabledIds(current, configPath, namedPath),
    skippedForeign,
    retired,
    remaining: own.slice(1).map((l) => l.path),
    missing,
    snapshotPath: retired?.to ?? live.path,
  };
  if (backup === undefined) return { ...base, mode: "already-restored" };
  return { ...base, mode: "restored", backupPath: backup, restoredCount, skippedEnabled: skipped };
}
