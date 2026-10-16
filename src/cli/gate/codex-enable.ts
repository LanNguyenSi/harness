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
// Otherwise the snapshot is applied when the config's sha equals its
// post-disable sha: each unit it names gets its original `hooks = [...]`
// line back, and the result must hash to its pre-disable sha, so the restore
// is byte-identical. When the config was edited since, enable refuses unless
// `--force`; a forced restore swaps only the snapshot's hooks lines back
// into the units it names, found by id in the block as it is now, keeps
// every other edit, and refuses when a unit is missing, was changed (another
// event or matcher) or is not neutralised (it would run twice). The applied
// snapshot is retired as restored. Units still disabled at the end are
// reported in `stillDisabled`, other live snapshots in `remaining`, and units
// the snapshot names that were deleted from the block in `missing` (that
// snapshot stays live): enable never reports an all-clear while one remains.
// A backup of the config is written before every rewrite, with the config's
// own mode.

import * as fs from "node:fs";
import {
  assertCodexHookEditInvariant,
  existingFileMode,
  latestCodexInstallBackup,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  type CodexGateSnapshot,
  type CodexSnapshotRetirement,
  readLiveCodexSnapshots,
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

/** The snapshot this call retired: `from` was renamed to `to`. */
export interface CodexRetiredSnapshot {
  from: string;
  to: string;
  why: CodexSnapshotRetirement;
  /** For an install-superseded snapshot: the installer backup that dates the install. */
  installBackup?: string;
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
  | (SnapshotBase & { mode: "restored"; backupPath: string; restoredCount: number });

/** The installer's newest write of the config, read from its backups beside
 * the requested path (and beside the resolved target, where an install
 * through the target's own path leaves them). */
function latestInstall(requestedPath: string, configPath: string): { ms: number; path: string } | null {
  const found = [requestedPath, configPath].map(latestCodexInstallBackup).filter((t) => t !== null);
  return found.reduce<{ ms: number; path: string } | null>((a, b) => (a === null || b.ms > a.ms ? b : a), null);
}

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
  const install = latestInstall(requestedPath, configPath);
  const currentSha = sha256Hex(original);
  const units = readBlock(original, configPath)?.units ?? null;
  const ids = snapshot.neutralised.map((u) => u.id);
  const missing: string[] = [];
  let retire: { why: CodexSnapshotRetirement; installBackup?: string } | null = null;
  let current = original;
  let backup: string | undefined;
  if (install !== null && install.ms > Date.parse(snapshot.createdAt)) {
    // A re-install after the snapshot re-rendered every unit it names: its
    // hooks lines may be outdated, so it is never applied.
    retire = { why: "superseded", installBackup: install.path };
  } else if (currentSha === snapshot.configBeforeSha256) {
    retire = { why: "restored" };
  } else if (units !== null && !units.some((u) => u.disabled && ids.includes(u.id))) {
    // None of its units is disabled any more. Retired as enabled again only
    // when every unit it names is still in the block: a unit deleted by hand
    // is neither enabled nor restorable, so the snapshot stays live and the
    // unit is reported.
    missing.push(...ids.filter((id) => !units.some((u) => u.id === id)));
    if (missing.length === 0) retire = { why: "superseded" };
  } else {
    const exact = currentSha === snapshot.configAfterSha256;
    if (!exact && !opts.force) {
      throw new GateEnableError(
        `the Codex config has been edited since the snapshot was taken (${live.path}; current sha ` +
          `${currentSha.slice(0, 12)}..., snapshot's post-disable sha ${snapshot.configAfterSha256.slice(0, 12)}...). ` +
          `Inspect the diff against ${snapshot.configBackupPath}. --force swaps only this snapshot's hooks ` +
          "lines back into the units it names (found by id) and keeps every other edit.",
      );
    }
    const plan = planRestore(original, configPath, snapshot);
    if (!plan.ok) throw new GateEnableError(plan.reason);
    if (exact && sha256Hex(plan.text) !== snapshot.configBeforeSha256) {
      throw new GateEnableError(
        `the snapshot ${live.path} does not rebuild the config it was taken from (the restored text does not ` +
          "match its recorded pre-disable sha); refusing to write. The config is untouched.",
      );
    }
    const counts: Record<string, number> = {};
    for (const unit of snapshot.neutralised) counts[unit.event] = (counts[unit.event] ?? 0) + 1;
    try {
      assertCodexHookEditInvariant(original, plan.text, configPath, { direction: "restore", counts });
    } catch (err) {
      throw toGateError(err, (m) => new GateEnableError(m));
    }
    current = plan.text;
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
    const to = retiredCodexSnapshotPath(live.path, retire.why);
    try {
      fs.renameSync(live.path, to);
    } catch (err) {
      throw new GateEnableError(
        `${backup !== undefined ? `restored ${ids.length} hook unit(s) into ${requestedPath}, but ` : ""}` +
          `cannot retire the snapshot ${live.path} (rename to ${to}: ${(err as Error).message}); ` +
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
  return { ...base, mode: "restored", backupPath: backup, restoredCount: ids.length };
}
