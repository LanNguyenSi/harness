// `harness gate enable --runtime codex` — restore the newest Codex gate
// snapshot into the Codex config.
//
// Reads the newest `harness.gate-disable-codex.*.json` beside the config (a
// Claude `harness.gate-disable.*.json` snapshot is never considered), and
// puts the removed hook units back. When the config still has the exact
// content the disable wrote (its sha256 equals the snapshot's post-disable
// sha), the units go back at their recorded offsets and the result must hash
// to the recorded pre-disable sha, so the restore is byte-identical. When the
// config was edited since, enable refuses unless `--force`; a forced restore
// re-reads the managed block and re-inserts each unit at its recorded
// position among the block's units. A backup of the config is written before
// every rewrite, with the config's own mode.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertCodexHookEditInvariant,
  CodexInstallRefusalError,
  existingFileMode,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  CODEX_SNAPSHOT_BASENAME_PREFIX,
  type CodexGateSnapshot,
  readCodexSnapshot,
  resolveCodexConfig,
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

export type CodexGateEnableResult =
  | { mode: "no-snapshots"; configPath: string }
  | { mode: "already-restored"; configPath: string; snapshotPath: string }
  | {
      mode: "restored";
      configPath: string;
      snapshotPath: string;
      backupPath: string;
      restoredCount: number;
    };

/** The before-state rebuilt from the after-state at the recorded offsets. */
function reinsertAtOffsets(after: string, snapshot: CodexGateSnapshot): string {
  const removed = [...snapshot.removed].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  let gone = 0;
  for (const unit of removed) {
    const at = unit.start - gone;
    out += after.slice(cursor, at) + unit.text;
    cursor = at;
    gone += unit.end - unit.start;
  }
  return out + after.slice(cursor);
}

/** A forced restore: each unit goes back at its recorded position among the
 * units of the block as it is now, separated from its neighbours by a blank
 * line like the generated block. */
function reinsertByOrdinal(current: string, configPath: string, snapshot: CodexGateSnapshot): string {
  let block: ReturnType<typeof readCodexManagedHookUnits>;
  try {
    block = readCodexManagedHookUnits(current, configPath);
  } catch (err) {
    throw err instanceof CodexInstallRefusalError ? new GateEnableError(err.message) : err;
  }
  if (block === null) {
    throw new GateEnableError(
      `${configPath} has no harness-managed Codex hook block any more; cannot restore units into it. ` +
        "Run `harness apply --runtime codex --install` to write the block.",
    );
  }
  const present = new Set(block.units.map((u) => u.id));
  const duplicate = snapshot.removed.find((u) => present.has(u.id));
  if (duplicate !== undefined) {
    throw new GateEnableError(
      `the hook unit ${JSON.stringify(duplicate.id)} from the snapshot is already in the block of ${configPath}; ` +
        "restoring it again would run it twice. The config is untouched.",
    );
  }
  // The block's units as they are now, as whole lines; the removed ones go
  // back at their recorded position among them, a blank line apart.
  const bodies = block.units.map((u) => `${current.slice(u.start, u.end).trimEnd()}\n`);
  for (const unit of [...snapshot.removed].sort((a, b) => a.ordinal - b.ordinal)) {
    bodies.splice(Math.min(unit.ordinal, bodies.length), 0, `${unit.text.trimEnd()}\n`);
  }
  const unitsStart = block.units[0]?.start ?? block.endMarkerStart;
  return current.slice(0, unitsStart) + bodies.join("\n") + current.slice(block.endMarkerStart);
}

export function codexGateEnable(opts: CodexGateEnableOptions = {}): CodexGateEnableResult {
  const { requestedPath, configPath } = resolveCodexConfig(opts, (m) => new GateEnableError(m));

  const snapshotPaths = listSnapshots(path.dirname(requestedPath), CODEX_SNAPSHOT_BASENAME_PREFIX);
  if (snapshotPaths.length === 0) {
    return { mode: "no-snapshots", configPath: requestedPath };
  }
  const latest = snapshotPaths[0]!;
  const read = readCodexSnapshot(latest);
  if (!read.ok) throw new GateEnableError(read.reason);
  const snapshot = read.snapshot;
  if (snapshot.configPath !== requestedPath) {
    throw new GateEnableError(
      `the newest Codex gate snapshot ${latest} was taken for ${snapshot.configPath}, not ${requestedPath}; ` +
        "pass the matching --config, or move the snapshot away.",
    );
  }

  let current: string;
  try {
    current = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateEnableError(
        `Codex config not found: ${requestedPath} — cannot restore into a missing target`,
      );
    }
    throw new GateEnableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }
  const currentSha = sha256Hex(current);
  if (currentSha === snapshot.configBeforeSha256) {
    return { mode: "already-restored", configPath: requestedPath, snapshotPath: latest };
  }
  const exact = currentSha === snapshot.configAfterSha256;
  if (!exact && !opts.force) {
    throw new GateEnableError(
      `the Codex config has been edited since the snapshot was taken (current sha ${currentSha.slice(0, 12)}…, ` +
        `snapshot's post-disable sha ${snapshot.configAfterSha256.slice(0, 12)}…). ` +
        `Re-running would overwrite those edits. Inspect the diff against ` +
        `${snapshot.configBackupPath}, then pass --force to restore anyway.`,
    );
  }

  const next = exact
    ? reinsertAtOffsets(current, snapshot)
    : reinsertByOrdinal(current, configPath, snapshot);
  if (exact && sha256Hex(next) !== snapshot.configBeforeSha256) {
    throw new GateEnableError(
      `the snapshot ${latest} does not rebuild the config it was taken from (the restored text does not ` +
        "match its recorded pre-disable sha); refusing to write. The config is untouched.",
    );
  }

  const deltas: Record<string, number> = {};
  for (const unit of snapshot.removed) deltas[unit.event] = (deltas[unit.event] ?? 0) + 1;
  try {
    assertCodexHookEditInvariant(current, next, configPath, deltas);
  } catch (err) {
    throw err instanceof CodexInstallRefusalError ? new GateEnableError(err.message) : err;
  }

  const mode = existingFileMode(configPath);
  const backup = backupPath(requestedPath, opts.now ?? new Date());
  atomicWriteFile(backup, current, { mode });
  atomicWriteFile(configPath, next, { mode });
  return {
    mode: "restored",
    configPath: requestedPath,
    snapshotPath: latest,
    backupPath: backup,
    restoredCount: snapshot.removed.length,
  };
}
