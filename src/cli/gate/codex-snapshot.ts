// Snapshot file format and shared path handling for `harness gate disable
// --runtime codex` / `harness gate enable --runtime codex`.
//
// A Codex snapshot records one `gate disable --runtime codex` call: the hook
// units removed from the harness-managed block of the Codex config, with
// their exact text and offsets in the config as it was before the removal,
// plus the sha256 of the config before and after. It lives beside the Codex
// config under its own file prefix and carries `version: 2` and
// `target: "codex"`, so a Claude settings snapshot (version 1, no target)
// can never be restored into TOML and a Codex snapshot can never be read as
// a settings.json one (`readSnapshot` rejects version 2).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CodexInstallRefusalError,
  defaultCodexConfigPath,
  resolveConfigSymlink,
} from "../apply/install-codex-config.js";
import { SNAPSHOT_BASENAME_SUFFIX, snapshotFieldProblem } from "./snapshot.js";

export const CODEX_SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable-codex.";
export const CODEX_SNAPSHOT_VERSION = 2 as const;
export const CODEX_SNAPSHOT_TARGET = "codex" as const;

export interface CodexRemovedUnit {
  event: string;
  /** Position of the unit among the units of its event, at removal time. */
  eventIndex: number;
  /** Position of the unit among all units of the block, at removal time. */
  ordinal: number;
  id: string;
  matcher: string | null;
  /** Offsets of the slab `[start, end)` in the config BEFORE the removal. */
  start: number;
  end: number;
  /** The slab text, verbatim (`text.length === end - start`). */
  text: string;
}

export interface CodexGateSnapshot {
  version: typeof CODEX_SNAPSHOT_VERSION;
  target: typeof CODEX_SNAPSHOT_TARGET;
  createdAt: string;
  /** Absolute path as requested (the symlink when the config is one). */
  configPath: string;
  /** Absolute path the pre-mutation copy was written to. */
  configBackupPath: string;
  configBeforeSha256: string;
  configAfterSha256: string;
  filter: { matcher?: string };
  /** Removed units in ascending offset order. */
  removed: CodexRemovedUnit[];
}

export interface ResolvedCodexConfig {
  /** The requested path, absolute. Snapshots and backups sit beside it. */
  requestedPath: string;
  /** The regular file read and written (the symlink's target when linked). */
  configPath: string;
}

/** Resolves `--config` (or the default `~/.codex/config.toml`) the way the
 * installer does: a symlinked config is edited at its resolved target. The
 * symlink refusals (dangling, not a regular file) surface as `makeError`. */
export function resolveCodexConfig(
  opts: { configPath?: string | undefined; homeDir?: string | undefined },
  makeError: (message: string) => Error,
): ResolvedCodexConfig {
  const requestedPath = path.resolve(
    typeof opts.configPath === "string" && opts.configPath.length > 0
      ? opts.configPath
      : defaultCodexConfigPath(opts.homeDir),
  );
  try {
    return { requestedPath, configPath: resolveConfigSymlink(requestedPath) };
  } catch (err) {
    throw err instanceof CodexInstallRefusalError ? makeError(err.message) : err;
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/:/g, "-");
}

export function codexSnapshotPath(requestedPath: string, now: Date): string {
  return path.join(
    path.dirname(requestedPath),
    `${CODEX_SNAPSHOT_BASENAME_PREFIX}${stamp(now)}${SNAPSHOT_BASENAME_SUFFIX}`,
  );
}

export interface CodexSnapshotReadOk {
  ok: true;
  snapshot: CodexGateSnapshot;
}

export interface CodexSnapshotReadErr {
  ok: false;
  reason: string;
}

function isRemovedUnit(value: unknown): value is CodexRemovedUnit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u["event"] === "string" &&
    typeof u["id"] === "string" &&
    (u["matcher"] === null || typeof u["matcher"] === "string") &&
    Number.isInteger(u["eventIndex"]) &&
    Number.isInteger(u["ordinal"]) &&
    Number.isInteger(u["start"]) &&
    Number.isInteger(u["end"]) &&
    typeof u["text"] === "string" &&
    (u["end"] as number) - (u["start"] as number) === u["text"].length &&
    (u["start"] as number) >= 0
  );
}

/** Parses a Codex snapshot. Anything that is not a version-2 snapshot with
 * `target: "codex"` is refused, so a Claude snapshot renamed into place is
 * never restored into a TOML file. */
export function readCodexSnapshot(filePath: string): CodexSnapshotReadOk | CodexSnapshotReadErr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `cannot read snapshot ${filePath}: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `snapshot ${filePath} is not a JSON object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["version"] !== CODEX_SNAPSHOT_VERSION || obj["target"] !== CODEX_SNAPSHOT_TARGET) {
    return {
      ok: false,
      reason:
        `snapshot ${filePath} is not a Codex gate snapshot (expected version ${CODEX_SNAPSHOT_VERSION} ` +
        `with target ${JSON.stringify(CODEX_SNAPSHOT_TARGET)}, got version ${JSON.stringify(obj["version"])} ` +
        `with target ${JSON.stringify(obj["target"] ?? null)})`,
    };
  }
  const problem = snapshotFieldProblem(filePath, obj, [
    "createdAt",
    "configPath",
    "configBackupPath",
    "configBeforeSha256",
    "configAfterSha256",
  ]);
  if (problem !== null) return { ok: false, reason: problem };
  const removed = obj["removed"];
  if (!Array.isArray(removed) || removed.length === 0 || !removed.every(isRemovedUnit)) {
    return { ok: false, reason: `snapshot ${filePath} has a malformed "removed" list` };
  }
  return { ok: true, snapshot: obj as unknown as CodexGateSnapshot };
}
