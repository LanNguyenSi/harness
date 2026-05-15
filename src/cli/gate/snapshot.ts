// Snapshot file format + I/O for `harness gate disable` / `harness gate enable`.
//
// A snapshot is the on-disk record of one `gate disable` invocation. It
// captures (a) which hook groups were removed and where they came from,
// (b) the SHA-256 of `settings.json` immediately before and after the
// removal, and (c) the path the original was backed up to. `gate enable`
// reads the newest snapshot in the settings directory, refuses to restore
// over a settings.json the operator has edited since (`--force` overrides),
// and writes the removed groups back into place.
//
// The format is intentionally narrow: no compression, no transform, just
// the literal JSON groups as they were read out of settings.json.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable.";
export const SNAPSHOT_BASENAME_SUFFIX = ".json";
export const SNAPSHOT_VERSION = 1 as const;

export interface RemovedGroup {
  /** Hook event the group lived under, e.g. "PreToolUse". */
  event: string;
  /** Position of the group inside `hooks[event][]` at the time of removal. */
  index: number;
  /** The literal JSON value of the removed group; preserved verbatim. */
  group: unknown;
}

export interface GateDisableSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** ISO-8601 UTC timestamp of the disable call. */
  createdAt: string;
  /** Absolute path to the settings.json that was mutated. */
  settingsPath: string;
  /** Absolute path the pre-mutation copy was written to. */
  settingsBackupPath: string;
  /**
   * SHA-256 of `settings.json` content BEFORE the removal. `gate enable`
   * compares the live settings.json sha against this to detect operator
   * edits since the disable; a mismatch refuses unless `--force`.
   */
  settingsBeforeSha256: string;
  /** SHA-256 of `settings.json` content AFTER the removal. */
  settingsAfterSha256: string;
  /** The filter the operator applied — recorded for the audit trail. */
  filter: {
    matcher?: string;
    event?: string;
  };
  /** Groups removed, in stable order (sorted by event then ascending index). */
  removed: RemovedGroup[];
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Build the snapshot file path for `settingsPath` at `now`. ISO timestamps
 * use `-` in place of `:` so the filename is portable across filesystems
 * (Windows reject `:` in basenames).
 */
export function snapshotPath(settingsPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/:/g, "-");
  return path.join(
    path.dirname(settingsPath),
    `${SNAPSHOT_BASENAME_PREFIX}${stamp}${SNAPSHOT_BASENAME_SUFFIX}`,
  );
}

/** Build the settings-backup file path for `settingsPath` at `now`. */
export function backupPath(settingsPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/:/g, "-");
  return `${settingsPath}.bak.${stamp}`;
}

/**
 * Return all gate-disable snapshot paths in `settingsDir`, newest-first
 * by mtime. Missing directory returns []. Any file that isn't a valid
 * snapshot is silently skipped — `gate enable` re-parses the candidates
 * and surfaces format errors at that point.
 */
export function listSnapshots(settingsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(settingsDir);
  } catch {
    return [];
  }
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_BASENAME_PREFIX)) continue;
    if (!name.endsWith(SNAPSHOT_BASENAME_SUFFIX)) continue;
    const full = path.join(settingsDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      candidates.push({ filePath: full, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.map((c) => c.filePath);
}

export interface SnapshotReadOk {
  ok: true;
  snapshot: GateDisableSnapshot;
}

export interface SnapshotReadErr {
  ok: false;
  reason: string;
}

/**
 * Parse a snapshot file. Validates structural shape only — the body's
 * `removed[].group` payload is opaque (preserved verbatim from
 * settings.json) and not re-validated against a hook schema.
 */
export function readSnapshot(filePath: string): SnapshotReadOk | SnapshotReadErr {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read snapshot ${filePath}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `snapshot ${filePath} is not valid JSON: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `snapshot ${filePath} is not a JSON object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["version"] !== SNAPSHOT_VERSION) {
    return {
      ok: false,
      reason: `snapshot ${filePath} has unsupported version ${JSON.stringify(obj["version"])}; expected ${SNAPSHOT_VERSION}`,
    };
  }
  for (const field of [
    "createdAt",
    "settingsPath",
    "settingsBackupPath",
    "settingsBeforeSha256",
    "settingsAfterSha256",
  ]) {
    if (typeof obj[field] !== "string") {
      return { ok: false, reason: `snapshot ${filePath} is missing string field "${field}"` };
    }
  }
  if (typeof obj["filter"] !== "object" || obj["filter"] === null) {
    return { ok: false, reason: `snapshot ${filePath} is missing object field "filter"` };
  }
  if (!Array.isArray(obj["removed"])) {
    return { ok: false, reason: `snapshot ${filePath} is missing array field "removed"` };
  }
  return { ok: true, snapshot: obj as unknown as GateDisableSnapshot };
}
