// Snapshot file format + path helpers for `harness uninstall --apply`.
//
// Sibling of `src/cli/gate/snapshot.ts`. A snapshot captures one
// uninstall invocation: which hook groups and which `mcpServers` entries
// were removed from `~/.claude/settings.json`, the sha256 of settings.json
// before/after, and the path the original was backed up to. Reading the
// snapshot is enough to manually reverse the uninstall (or to drive a
// future `harness reinstall` verb).
//
// The format mirrors `GateDisableSnapshot` shape but lives in its own
// file: the two verbs have different scopes (gate-disable is matcher-
// driven; uninstall is harness-ownership-driven) and storing them in the
// same snapshot stream would mean every reader has to disambiguate via
// `filter` or a discriminator. Cheaper to keep separate.

import * as crypto from "node:crypto";
import * as path from "node:path";

export const SNAPSHOT_BASENAME_PREFIX = "harness.uninstall.";
export const SNAPSHOT_BASENAME_SUFFIX = ".json";
export const BACKUP_INFIX = ".bak.uninstall.";
export const SNAPSHOT_VERSION = 1 as const;

export interface RemovedHookGroup {
  /** Hook event the group lived under, e.g. "PreToolUse". */
  event: string;
  /** Position inside `hooks[event][]` at the time of removal. */
  index: number;
  /** Literal JSON value of the removed group; preserved verbatim. */
  group: unknown;
}

export interface RemovedMcpServer {
  /** Server name (the `mcpServers` map key). */
  name: string;
  /** Literal JSON value of the removed server spec; preserved verbatim. */
  spec: unknown;
}

export interface UninstallSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** ISO-8601 UTC timestamp of the uninstall call. */
  createdAt: string;
  /** Absolute path to the settings.json that was mutated. */
  settingsPath: string;
  /** Absolute path the pre-mutation copy was written to. */
  settingsBackupPath: string;
  /** SHA-256 of settings.json content BEFORE the removal. */
  settingsBeforeSha256: string;
  /** SHA-256 of settings.json content AFTER the removal. */
  settingsAfterSha256: string;
  /** Removed hook groups, sorted by event then ascending index. */
  removedHookGroups: RemovedHookGroup[];
  /** Removed mcpServers entries, sorted by name. */
  removedMcpServers: RemovedMcpServer[];
  /** Paths of harness-owned files unlinked from disk. */
  removedFiles: string[];
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Build the snapshot file path for `settingsPath` at `now`. */
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
  return `${settingsPath}${BACKUP_INFIX}${stamp}`;
}
