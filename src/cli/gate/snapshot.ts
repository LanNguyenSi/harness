// Snapshot file format + I/O for `harness gate disable` / `harness gate enable`.
//
// A snapshot is the on-disk record of the `gate disable` calls made against
// one settings.json since the last restore. It captures (a) which hook groups
// were removed and where they came from, (b) the SHA-256 of `settings.json`
// before the first removal and after the latest one, and (c) the path the
// original was backed up to. There is at most ONE live snapshot per
// settings.json: a second `gate disable` merges its groups into it while the
// file is still in the state that snapshot left. `gate enable` restores that
// snapshot, refuses to restore over a settings.json the operator has edited
// since unless the result is exactly the pre-disable file (`--force`
// overrides), writes the removed groups back into place and then retires the
// snapshot (renamed to `*.restored.json`, kept for audit, never applied
// again).
//
// The format is intentionally narrow: no compression, no transform, just
// the literal JSON groups as they were read out of settings.json.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable.";
export const SNAPSHOT_BASENAME_SUFFIX = ".json";
/** Written by this version. Adds `step` on every removed group and `merges`. */
export const SNAPSHOT_VERSION = 2 as const;
/** Written by releases before a second disable merged into the live snapshot; still restorable. */
export const LEGACY_SNAPSHOT_VERSION = 1 as const;
/** A retired snapshot keeps its name with this suffix instead of plain `.json`. */
export const RETIRED_SNAPSHOT_SUFFIX = ".restored.json";

export interface RemovedGroup {
  /** Hook event the group lived under, e.g. "PreToolUse". */
  event: string;
  /**
   * Position of the group inside `hooks[event][]` just before the removal
   * step that took it out (a later merged disable records positions in the
   * already-reduced array). Restore therefore undoes the steps newest first.
   */
  index: number;
  /** Which disable call removed it: 0 for the first, 1 for the next merged one, and so on. Absent in version 1 snapshots (read as 0). */
  step?: number;
  /** The literal JSON value of the removed group; preserved verbatim. */
  group: unknown;
}

/** A later `gate disable` that was merged into a live snapshot. */
export interface SnapshotMerge {
  step: number;
  createdAt: string;
  matcher: string;
  settingsBackupPath: string;
}

export interface GateDisableSnapshot {
  version: typeof SNAPSHOT_VERSION | typeof LEGACY_SNAPSHOT_VERSION;
  /** ISO-8601 UTC timestamp of the disable call. */
  createdAt: string;
  /**
   * Absolute path to the settings.json that was mutated (snapshots written
   * by earlier releases may hold the path as it was typed, relative to a
   * working directory that is gone). Only its basename is used to tell which
   * file a snapshot belongs to: snapshots always sit beside their file.
   */
  settingsPath: string;
  /** Absolute path the pre-mutation copy was written to. */
  settingsBackupPath: string;
  /**
   * SHA-256 of `settings.json` content BEFORE the first removal. When the
   * live file already has this sha there is nothing to restore (the snapshot
   * is retired).
   */
  settingsBeforeSha256: string;
  /**
   * SHA-256 of `settings.json` content AFTER the latest removal. `gate
   * enable` compares the live settings.json sha against this to detect
   * operator edits since the disable; a mismatch refuses unless `--force`.
   */
  settingsAfterSha256: string;
  /** The filter of the first disable, recorded for the audit trail. */
  filter: {
    matcher?: string;
    event?: string;
  };
  /** Groups removed by every step, in the order they were taken out. */
  removed: RemovedGroup[];
  /** Later disables merged into this snapshot, oldest first (absent when there were none). */
  merges?: SnapshotMerge[];
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
 * and surfaces format errors at that point. `prefix` selects the snapshot
 * family: the Claude settings snapshots by default, the Codex ones when the
 * Codex gate passes its own prefix (`codex-snapshot.ts`).
 */
export function listSnapshots(
  settingsDir: string,
  prefix: string = SNAPSHOT_BASENAME_PREFIX,
): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(settingsDir);
  } catch {
    return [];
  }
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
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

/**
 * The reason a parsed snapshot lacks one of the required string fields or
 * its `filter` object, or null when it has them all. Shared by the Claude
 * and Codex snapshot readers so the two cannot drift apart.
 */
export function snapshotFieldProblem(
  filePath: string,
  obj: Record<string, unknown>,
  stringFields: string[],
): string | null {
  for (const field of stringFields) {
    if (typeof obj[field] !== "string") {
      return `snapshot ${filePath} is missing string field "${field}"`;
    }
  }
  if (typeof obj["filter"] !== "object" || obj["filter"] === null) {
    return `snapshot ${filePath} is missing object field "filter"`;
  }
  return null;
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
  if (obj["version"] !== SNAPSHOT_VERSION && obj["version"] !== LEGACY_SNAPSHOT_VERSION) {
    return {
      ok: false,
      reason:
        `snapshot ${filePath} has unsupported version ${JSON.stringify(obj["version"])}; ` +
        `expected ${LEGACY_SNAPSHOT_VERSION} or ${SNAPSHOT_VERSION}`,
    };
  }
  const problem = snapshotFieldProblem(filePath, obj, [
    "createdAt",
    "settingsPath",
    "settingsBackupPath",
    "settingsBeforeSha256",
    "settingsAfterSha256",
  ]);
  if (problem !== null) return { ok: false, reason: problem };
  if (!Array.isArray(obj["removed"])) {
    return { ok: false, reason: `snapshot ${filePath} is missing array field "removed"` };
  }
  return { ok: true, snapshot: obj as unknown as GateDisableSnapshot };
}

/** The name a snapshot is renamed to once retired. The file stays for audit. */
export function retiredSnapshotPath(snapPath: string): string {
  return `${snapPath.slice(0, -SNAPSHOT_BASENAME_SUFFIX.length)}${RETIRED_SNAPSHOT_SUFFIX}`;
}

/** Retire `snapPath` (rename it, keep it for audit) and return the new path. */
export function retireSnapshot(snapPath: string): string {
  const to = retiredSnapshotPath(snapPath);
  fs.renameSync(snapPath, to);
  return to;
}

export interface LiveSnapshot {
  path: string;
  snapshot: GateDisableSnapshot;
}

export type LiveSnapshotsResult =
  | {
      ok: true;
      live: LiveSnapshot[];
      /** Live snapshots beside the file that name another settings file; never read as this one's. */
      skippedForeign: string[];
    }
  | {
      ok: false;
      reason: string;
      /** The live snapshot file that could not be read. */
      path: string;
    };

/**
 * The live (not retired) snapshots beside `settingsPath` that were taken for
 * that file, newest first by `createdAt`. A snapshot belongs to the file when
 * the basename of its recorded settings path is the basename of
 * `settingsPath`: it sits in the same directory, so how the directory was
 * spelled when it was written (relative to some other working directory, or
 * through a symlink) must not decide. A snapshot for another settings file in
 * the same directory is listed in `skippedForeign`, never dropped silently. A
 * live snapshot that cannot be read is an error: its target cannot be told,
 * so neither disable nor enable may go on as if it did not exist.
 */
export function listLiveSnapshots(settingsPath: string): LiveSnapshotsResult {
  const targetName = path.basename(settingsPath);
  const live: LiveSnapshot[] = [];
  const skippedForeign: string[] = [];
  for (const file of listSnapshots(path.dirname(settingsPath))) {
    if (file.endsWith(RETIRED_SNAPSHOT_SUFFIX)) continue;
    const read = readSnapshot(file);
    if (!read.ok) return { ok: false, reason: read.reason, path: file };
    if (path.basename(read.snapshot.settingsPath) !== targetName) {
      skippedForeign.push(file);
      continue;
    }
    live.push({ path: file, snapshot: read.snapshot });
  }
  live.sort((a, b) => {
    if (a.snapshot.createdAt !== b.snapshot.createdAt) {
      return a.snapshot.createdAt < b.snapshot.createdAt ? 1 : -1;
    }
    return a.path < b.path ? 1 : -1;
  });
  return { ok: true, live, skippedForeign };
}

function groupMatcherOf(group: unknown): string | null {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return null;
  const m = (group as Record<string, unknown>)["matcher"];
  return typeof m === "string" ? m : null;
}

/** `PreToolUse matcher="Bash"`: how a message names a removed group. */
export function groupLabel(event: string, group: unknown): string {
  return `${event} matcher=${JSON.stringify(groupMatcherOf(group))}`;
}

export interface RestorePlan {
  /** The hooks block with the groups that were still missing spliced back in; the input is not modified. */
  hooks: Record<string, unknown[]>;
  /** Entries spliced back in. */
  restored: RemovedGroup[];
  /**
   * Entries left alone because the file already holds a group with the same
   * event and matcher (put back by hand, re-rendered by an apply, in whatever
   * form). Never spliced in a second time.
   */
  alreadyBack: RemovedGroup[];
}

/**
 * What putting a snapshot's removed groups back into `current` would do. An
 * entry is "back" when the file holds a group with its event and matcher
 * (one such group covers one entry, so two removed groups with the same
 * matcher need two in the file). The rest are spliced in at their recorded
 * positions: each removal step recorded its indices against the array as it
 * stood just before that step, so the steps are undone newest first, and
 * inside a step by event and ascending index (an earlier insertion never
 * shifts a later insertion's target index past the array end).
 */
export function planRestore(
  current: Record<string, unknown[]>,
  snapshot: GateDisableSnapshot,
): RestorePlan {
  const hooks: Record<string, unknown[]> = {};
  const present = new Map<string, number>();
  for (const [event, groups] of Object.entries(current)) {
    hooks[event] = groups.slice();
    for (const group of groups) {
      const key = JSON.stringify([event, groupMatcherOf(group)]);
      present.set(key, (present.get(key) ?? 0) + 1);
    }
  }
  const sorted = [...snapshot.removed].sort((a, b) => {
    const stepA = a.step ?? 0;
    const stepB = b.step ?? 0;
    if (stepA !== stepB) return stepB - stepA;
    if (a.event !== b.event) return a.event < b.event ? -1 : 1;
    return a.index - b.index;
  });
  const restored: RemovedGroup[] = [];
  const alreadyBack: RemovedGroup[] = [];
  for (const entry of sorted) {
    const key = JSON.stringify([entry.event, groupMatcherOf(entry.group)]);
    const count = present.get(key) ?? 0;
    if (count > 0) {
      present.set(key, count - 1);
      alreadyBack.push(entry);
      continue;
    }
    const arr = hooks[entry.event] ?? [];
    arr.splice(Math.min(entry.index, arr.length), 0, entry.group);
    hooks[entry.event] = arr;
    restored.push(entry);
  }
  return { hooks, restored, alreadyBack };
}
