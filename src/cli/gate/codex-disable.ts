// `harness gate disable --runtime codex` — the operator's switch for a
// blocking hook in the Codex config.
//
// Reads `~/.codex/config.toml` (or `--config <path>`), finds the hook units
// of the harness-managed block (the `# BEGIN harness-managed codex hooks`
// fence that `harness apply --runtime codex --install` writes) whose
// `matcher` substring-matches `--matcher`, removes exactly those units, and
// writes a backup of the original (`<config>.bak.<ISO>`) plus a snapshot of
// the removed text (`harness.gate-disable-codex.<ISO>.json`) before the
// atomic rewrite. Text outside the fences, and every operator-authored
// table, is never touched. The block is read by the installer's own scanner
// (`readCodexManagedHookUnits`), so a duplicate BEGIN marker, a foreign table
// wedged in the block or a missing END marker refuse instead of guessing.
//
// With NO `--matcher` this verb is a pure listing, like the Claude one. A
// later `harness apply --runtime codex --install` re-renders the whole block
// and so brings the units back.

import * as fs from "node:fs";
import {
  assertCodexHookEditInvariant,
  CodexInstallRefusalError,
  existingFileMode,
  readCodexManagedHookUnits,
} from "../apply/install-codex-config.js";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { GateDisableError, type GateDisableCandidate } from "./disable.js";
import {
  CODEX_SNAPSHOT_TARGET,
  CODEX_SNAPSHOT_VERSION,
  codexSnapshotPath,
  type CodexGateSnapshot,
  type CodexRemovedUnit,
  resolveCodexConfig,
} from "./codex-snapshot.js";
import { backupPath, sha256Hex } from "./snapshot.js";

export interface CodexGateDisableOptions {
  /** `~/.codex/config.toml` override. */
  configPath?: string;
  /** Test-injectable home dir for the default config path. */
  homeDir?: string;
  /** Literal substring of a unit's `matcher`; absent means list only. */
  matcher?: string;
  now?: Date;
}

export type CodexGateDisableResult =
  | { mode: "list"; configPath: string; candidates: GateDisableCandidate[] }
  | {
      mode: "remove";
      configPath: string;
      backupPath: string;
      snapshotPath: string;
      removed: CodexRemovedUnit[];
    };

export function codexGateDisable(opts: CodexGateDisableOptions = {}): CodexGateDisableResult {
  const { requestedPath, configPath } = resolveCodexConfig(opts, (m) => new GateDisableError(m));
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateDisableError(`Codex config not found: ${requestedPath} — nothing to disable`);
    }
    throw new GateDisableError(`cannot read ${requestedPath}: ${(err as Error).message}`);
  }

  let block: ReturnType<typeof readCodexManagedHookUnits>;
  try {
    block = readCodexManagedHookUnits(text, configPath);
  } catch (err) {
    throw err instanceof CodexInstallRefusalError ? new GateDisableError(err.message) : err;
  }
  if (block === null) {
    throw new GateDisableError(
      `${requestedPath} has no harness-managed Codex hook block (no '# BEGIN harness-managed codex hooks' ` +
        `fence); nothing to disable. \`harness apply --runtime codex --install\` writes that block.`,
    );
  }

  const seen = new Map<string, number>();
  const units = block.units.map((unit, ordinal) => {
    const eventIndex = seen.get(unit.event) ?? 0;
    seen.set(unit.event, eventIndex + 1);
    return { unit, ordinal, eventIndex };
  });

  if (typeof opts.matcher !== "string" || opts.matcher.length === 0) {
    return {
      mode: "list",
      configPath: requestedPath,
      candidates: units.map(({ unit, eventIndex }) => ({
        event: unit.event,
        index: eventIndex,
        matcher: unit.matcher,
        description: unit.commands.join("; ") || unit.id,
      })),
    };
  }

  const pattern = opts.matcher;
  const matched = units.filter(({ unit }) => unit.matcher !== null && unit.matcher.includes(pattern));
  if (matched.length === 0) {
    throw new GateDisableError(
      `no hook units matched matcher substring ${JSON.stringify(pattern)} in the harness-managed block of ` +
        `${requestedPath}. Run \`harness gate disable --runtime codex\` (no --matcher) to list the available candidates.`,
    );
  }

  let next = "";
  let cursor = 0;
  for (const { unit } of matched) {
    next += text.slice(cursor, unit.start);
    cursor = unit.end;
  }
  next += text.slice(cursor);

  const deltas: Record<string, number> = {};
  for (const { unit } of matched) deltas[unit.event] = (deltas[unit.event] ?? 0) - 1;
  try {
    assertCodexHookEditInvariant(text, next, configPath, deltas);
  } catch (err) {
    throw err instanceof CodexInstallRefusalError ? new GateDisableError(err.message) : err;
  }

  const now = opts.now ?? new Date();
  const backup = backupPath(requestedPath, now);
  const snapPath = codexSnapshotPath(requestedPath, now);
  const mode = existingFileMode(configPath);
  const removed: CodexRemovedUnit[] = matched.map(({ unit, ordinal, eventIndex }) => ({
    event: unit.event,
    eventIndex,
    ordinal,
    id: unit.id,
    matcher: unit.matcher,
    start: unit.start,
    end: unit.end,
    text: text.slice(unit.start, unit.end),
  }));
  const snapshot: CodexGateSnapshot = {
    version: CODEX_SNAPSHOT_VERSION,
    target: CODEX_SNAPSHOT_TARGET,
    createdAt: now.toISOString(),
    configPath: requestedPath,
    configBackupPath: backup,
    configBeforeSha256: sha256Hex(text),
    configAfterSha256: sha256Hex(next),
    filter: { matcher: pattern },
    removed,
  };

  // Backup and snapshot land BEFORE the live rewrite, with the config's own
  // mode (it holds secrets and hook trust hashes): a crash between the writes
  // leaves the config untouched and the way back on disk.
  atomicWriteFile(backup, text, { mode });
  atomicWriteFile(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode });
  atomicWriteFile(configPath, next, { mode });

  return { mode: "remove", configPath: requestedPath, backupPath: backup, snapshotPath: snapPath, removed };
}
