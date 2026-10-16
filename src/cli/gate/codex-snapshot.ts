// Snapshot file format and shared path handling for `harness gate disable
// --runtime codex` / `harness gate enable --runtime codex`.
//
// `gate disable --runtime codex` does not delete a hook unit: it neutralises
// it in place, replacing the unit's `hooks = [...]` line with `hooks = []`.
// Codex keys a user hook's trust and enabled state by its position in the
// event's array, and an empty group takes its position without registering
// a handler, so every other hook keeps its trust. A Codex snapshot records
// the neutralised units: per unit its identity and the verbatim original
// `hooks = [...]` line, plus the sha256 of the config before the first
// disable and after the latest one. At most one snapshot per config is live:
// a later disable merges its units into it. It lives beside the Codex config
// under its own file prefix and carries `version: 3` and `target: "codex"`,
// so a Claude settings snapshot (version 1, no target) can never be restored
// into TOML and a Codex snapshot can never be read as a settings.json one
// (`readSnapshot` rejects version 3). Once `gate enable` has applied a
// snapshot, or found it applied or superseded, it renames the file to
// `*.restored.json` or `*.superseded.json`, and so does a `gate disable` that
// finds the live snapshot spent: the file stays for audit,
// `listCodexSnapshots` never offers it again.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CodexInstallRefusalError,
  defaultCodexConfigPath,
  latestCodexInstallBackup,
  resolveConfigSymlink,
} from "../apply/install-codex-config.js";
import { listSnapshots, SNAPSHOT_BASENAME_SUFFIX, snapshotFieldProblem } from "./snapshot.js";

export const CODEX_SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable-codex.";
/** Why `gate enable --runtime codex` retired a snapshot: it was applied or
 * found already applied (`restored`), or its units were brought back by
 * something else since it was taken, such as a re-install (`superseded`). */
export type CodexSnapshotRetirement = "restored" | "superseded";
const RETIRED_SUFFIXES: readonly string[] = [".restored", ".superseded"].map((s) => `${s}${SNAPSHOT_BASENAME_SUFFIX}`);
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

/** One later `gate disable` merged into a live snapshot, kept for audit. */
export interface CodexSnapshotMerge {
  createdAt: string;
  matcher: string;
  /** The pre-merge copy of the config that disable wrote. */
  configBackupPath: string;
}

export interface CodexGateSnapshot {
  version: typeof CODEX_SNAPSHOT_VERSION;
  target: typeof CODEX_SNAPSHOT_TARGET;
  createdAt: string;
  /** Absolute path as requested (the symlink when the config is one). */
  configPath: string;
  /** Absolute path the pre-mutation copy was written to. */
  configBackupPath: string;
  /** The config before the first disable this snapshot covers. */
  configBeforeSha256: string;
  /** The config after the latest disable merged into this snapshot. */
  configAfterSha256: string;
  filter: { matcher?: string };
  /** The neutralised units in block order, merged over every disable since the snapshot was created. */
  neutralised: CodexDisabledUnit[];
  /** Later disables merged into this snapshot, oldest first (absent when there were none). */
  merges?: CodexSnapshotMerge[];
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

/** The name a snapshot is renamed to once retired. The file stays for audit;
 * `listCodexSnapshots` never offers it again. */
export function retiredCodexSnapshotPath(snapPath: string, why: CodexSnapshotRetirement): string {
  return `${snapPath.slice(0, snapPath.length - SNAPSHOT_BASENAME_SUFFIX.length)}.${why}${SNAPSHOT_BASENAME_SUFFIX}`;
}

/** The snapshot a call retired: `from` was renamed to `to`. */
export interface CodexRetiredSnapshot {
  from: string;
  to: string;
  why: CodexSnapshotRetirement;
  /** For an install-superseded snapshot: the installer backup that dates the install. */
  installBackup?: string;
}

/** Renames a live snapshot to its retired name and returns that name; the
 * file stays for audit. A rename failure surfaces as the fs error. */
export function retireCodexSnapshot(snapPath: string, why: CodexSnapshotRetirement): string {
  const to = retiredCodexSnapshotPath(snapPath, why);
  fs.renameSync(snapPath, to);
  return to;
}

/** The installer's newest write of the config, read from its backups beside
 * the requested path (and beside the resolved target, where an install
 * through the target's own path leaves them). */
export function latestInstall(requestedPath: string, configPath: string): { ms: number; path: string } | null {
  const found = [requestedPath, configPath].map(latestCodexInstallBackup).filter((t) => t !== null);
  return found.reduce<{ ms: number; path: string } | null>((a, b) => (a === null || b.ms > a.ms ? b : a), null);
}

/** Whether a live snapshot is spent, i.e. `gate enable` would only retire it
 * without writing: an install re-rendered the block after it was taken (its
 * hooks lines may be outdated), the config already matches its pre-disable
 * sha, or none of its units is disabled any more. The last case counts only
 * when every unit it names is still in the block: a unit deleted by hand is
 * neither enabled nor restorable, so the snapshot stays live and `missing`
 * names it. `units` is null when the config has no managed block. */
export function spentCodexSnapshot(
  snapshot: CodexGateSnapshot,
  currentSha: string,
  units: ReadonlyArray<{ id: string; disabled: boolean }> | null,
  install: { ms: number; path: string } | null,
): { retire: { why: CodexSnapshotRetirement; installBackup?: string } | null; missing: string[] } {
  if (install !== null && install.ms > Date.parse(snapshot.createdAt)) {
    return { retire: { why: "superseded", installBackup: install.path }, missing: [] };
  }
  if (currentSha === snapshot.configBeforeSha256) return { retire: { why: "restored" }, missing: [] };
  const ids = snapshot.neutralised.map((u) => u.id);
  if (units !== null && !units.some((u) => u.disabled && ids.includes(u.id))) {
    const missing = ids.filter((id) => !units.some((u) => u.id === id));
    return { retire: missing.length === 0 ? { why: "superseded" } : null, missing };
  }
  return { retire: null, missing: [] };
}

/** The Codex snapshots beside a config that are still live (not retired). */
export function listCodexSnapshots(dir: string): string[] {
  return listSnapshots(dir, CODEX_SNAPSHOT_BASENAME_PREFIX).filter(
    (p) => !RETIRED_SUFFIXES.some((suffix) => p.endsWith(suffix)),
  );
}

export interface LoadedCodexSnapshot {
  path: string;
  snapshot: CodexGateSnapshot;
}

/** The live snapshots beside a config, split into those taken for it, newest
 * first by their recorded `createdAt` (equal times by file name, newest name
 * first; never by file mtime, which a directory copy reorders), and the
 * paths of those taken for another config. An unreadable one refuses via
 * `makeError`. */
export function readLiveCodexSnapshots(
  requestedPath: string,
  makeError: (message: string) => Error,
): { own: LoadedCodexSnapshot[]; foreign: string[] } {
  const own: LoadedCodexSnapshot[] = [];
  const foreign: string[] = [];
  for (const snapPath of listCodexSnapshots(path.dirname(requestedPath))) {
    const read = readCodexSnapshot(snapPath);
    if (!read.ok) {
      throw makeError(
        `${read.reason.replace(/\.$/, "")}. A live Codex snapshot beside ${requestedPath} that harness cannot read blocks the gate: ` +
          `move ${snapPath} aside (rename it out of this directory) and run the command again.`,
      );
    }
    if (read.snapshot.configPath === requestedPath) own.push({ path: snapPath, snapshot: read.snapshot });
    else foreign.push(snapPath);
  }
  const time = (l: LoadedCodexSnapshot): number => Date.parse(l.snapshot.createdAt);
  own.sort((a, b) => time(b) - time(a) || (a.path < b.path ? 1 : -1));
  return { own, foreign };
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

function isMerge(value: unknown): value is CodexSnapshotMerge {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return typeof m["createdAt"] === "string" && typeof m["matcher"] === "string" && typeof m["configBackupPath"] === "string";
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
  // Several live snapshots (an earlier build kept one per disable) are ordered by this time, never by file mtime.
  if (Number.isNaN(Date.parse(obj["createdAt"] as string))) {
    return { ok: false, reason: `snapshot ${filePath} has a "createdAt" that is not a timestamp` };
  }
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
  const merges = obj["merges"];
  if (merges !== undefined && !(Array.isArray(merges) && merges.every(isMerge))) {
    return { ok: false, reason: `snapshot ${filePath} has a malformed "merges" list` };
  }
  return { ok: true, snapshot: obj as unknown as CodexGateSnapshot };
}
