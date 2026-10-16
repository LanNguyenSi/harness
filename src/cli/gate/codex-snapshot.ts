// Snapshot file format and shared path handling for `harness gate disable
// --runtime codex` / `harness gate enable --runtime codex`.
//
// `gate disable --runtime codex` does not delete a hook unit: it neutralises
// it in place, replacing the unit's `hooks = [...]` line with `hooks = []`.
// Codex keys a user hook's trust and enabled state by its position in the
// event's array, and an empty group takes its position without registering
// a handler, so every other hook keeps its trust. A Codex snapshot records
// one such call: per neutralised unit its identity and the verbatim original
// `hooks = [...]` line, plus the sha256 of the config before and after. It
// lives beside the Codex config under its own file prefix and carries
// `version: 3` and `target: "codex"`, so a Claude settings snapshot (version
// 1, no target) can never be restored into TOML and a Codex snapshot can
// never be read as a settings.json one (`readSnapshot` rejects version 3).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CodexInstallRefusalError,
  defaultCodexConfigPath,
  resolveConfigSymlink,
} from "../apply/install-codex-config.js";
import { SNAPSHOT_BASENAME_SUFFIX, snapshotFieldProblem } from "./snapshot.js";

export const CODEX_SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable-codex.";
export const CODEX_SNAPSHOT_VERSION = 3 as const;
export const CODEX_SNAPSHOT_TARGET = "codex" as const;
/** The value a neutralised unit's `hooks` line carries. */
export const CODEX_NEUTRALISED_HOOKS = "hooks = []";

export interface CodexDisabledUnit {
  event: string;
  /** Position of the unit among the units of its event in the block. */
  eventIndex: number;
  /** Position of the unit among all units of the block. */
  ordinal: number;
  id: string;
  matcher: string | null;
  /** The unit's original `hooks = [...]` line, verbatim, without its line terminator. */
  hooksText: string;
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
  /** The neutralised units in block order. */
  neutralised: CodexDisabledUnit[];
}

export interface ResolvedCodexConfig {
  /** The requested path, absolute. Snapshots and backups sit beside it. */
  requestedPath: string;
  /** The regular file read and written (the symlink's target when linked). */
  configPath: string;
}

/** Installer refusal texts are worded for `harness apply --install`. Reached
 * through the gate they would tell the operator about an install that never
 * ran, so each known phrase is mapped to the gate's own wording. */
const GATE_WORDING: ReadonlyArray<readonly [string, string]> = [
  [
    "refusing to install, because without parsing it harness cannot confirm that every table outside the harness-managed hook block would survive the install",
    "refusing to edit, because without parsing it harness cannot confirm that every table outside the harness-managed hook block would survive the edit",
  ],
  ["installing would change", "the gate edit would change"],
  ["refusing to install rather than risk", "refusing to edit rather than risk"],
  ["refusing to install, nothing was written", "refusing to edit, nothing was written"],
  ["The Codex config harness would write to", "The Codex config the gate would write to"],
  [
    "restore it from the most recent .harness-backup-* file (if one exists)",
    "restore it from the backup the gate wrote beside it (<config>.bak.<timestamp>, if one exists)",
  ],
];

/** The message of an installer refusal in the gate's wording. */
export function gateWording(message: string): string {
  let out = message;
  for (const [from, to] of GATE_WORDING) out = out.split(from).join(to);
  return out;
}

/** An installer refusal becomes the gate verb's own error type (same text in
 * the gate's wording); anything else is rethrown unchanged by the caller. */
export function toGateError(err: unknown, makeError: (message: string) => Error): unknown {
  return err instanceof CodexInstallRefusalError ? makeError(gateWording(err.message)) : err;
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
    throw toGateError(err, makeError);
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

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isDisabledUnit(value: unknown): value is CodexDisabledUnit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u["event"] === "string" &&
    typeof u["id"] === "string" &&
    (u["matcher"] === null || typeof u["matcher"] === "string") &&
    isNonNegativeInteger(u["eventIndex"]) &&
    isNonNegativeInteger(u["ordinal"]) &&
    typeof u["hooksText"] === "string" &&
    u["hooksText"].startsWith("hooks = [") &&
    !/[\r\n]/.test(u["hooksText"])
  );
}

/** Parses a Codex snapshot. Anything that is not a version-3 snapshot with
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
  if (obj["target"] === CODEX_SNAPSHOT_TARGET && obj["version"] === 2) {
    return {
      ok: false,
      reason:
        `snapshot ${filePath} is a version 2 Codex gate snapshot, written by an earlier build that ` +
        "deleted the hook unit instead of neutralising it; it cannot be restored. Re-run " +
        "`harness apply --runtime codex --install` to rewrite the block, or restore the config " +
        "from the backup beside it, then remove this snapshot.",
    };
  }
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
  const units = obj["neutralised"];
  if (!Array.isArray(units) || units.length === 0 || !units.every(isDisabledUnit)) {
    return { ok: false, reason: `snapshot ${filePath} has a malformed "neutralised" list` };
  }
  const ids = new Set(units.map((u: CodexDisabledUnit) => u.id));
  const ordinals = new Set(units.map((u: CodexDisabledUnit) => u.ordinal));
  if (ids.size !== units.length || ordinals.size !== units.length) {
    return {
      ok: false,
      reason: `snapshot ${filePath} lists the same hook unit id or block position twice in "neutralised"`,
    };
  }
  return { ok: true, snapshot: obj as unknown as CodexGateSnapshot };
}
