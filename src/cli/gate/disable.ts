// `harness gate disable` — operator escape hatch for hard-blocking hooks.
//
// Reads the operator's `~/.claude/settings.json` (or `--settings <path>`),
// finds hook groups whose `matcher` substring-matches the supplied
// `--matcher`, removes them, writes a snapshot of the removed groups to
// `<settings-dir>/harness.gate-disable.<ISO>.json`, backs up the original
// to `<settings.json>.bak.<ISO>`, and atomically rewrites settings.json
// without the matching groups.
//
// With NO `--matcher`, this verb is a pure listing — it prints the
// candidate groups and exits without writing. That's the no-args
// "what would be removed" probe the task spec calls out.
//
// Refuses to operate on a settings.json that isn't a JSON object so
// a malformed file is surfaced rather than silently overwritten with
// something "cleaner".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import {
  backupPath,
  type GateDisableSnapshot,
  type RemovedGroup,
  sha256Hex,
  SNAPSHOT_VERSION,
  snapshotPath,
} from "./snapshot.js";

const DEFAULT_SETTINGS_REL = path.join(".claude", "settings.json");

export interface GateDisableOptions {
  /** `~/.claude/settings.json` override (test injection / non-default install). */
  settingsPath?: string;
  /**
   * Test-injectable home dir; falls back to `os.homedir()` when computing
   * the default settings.json path. Ignored when `settingsPath` is set.
   */
  homeDir?: string;
  /**
   * Matcher pattern. When present, hook groups whose `matcher` field
   * substring-matches this string are removed (literal substring, not
   * regex — operators block-paste the exact matcher they see in the
   * gate's deny message, which is what we want to match against). When
   * absent, the call is a dry-run listing.
   */
  matcher?: string;
  /** Override "now" for deterministic timestamps in tests. */
  now?: Date;
}

export interface GateDisableCandidate {
  event: string;
  index: number;
  matcher: string | null;
  /** Compact one-line description of the group's commands, for the listing UI. */
  description: string;
}

export type GateDisableResult =
  | {
      mode: "list";
      settingsPath: string;
      candidates: GateDisableCandidate[];
    }
  | {
      mode: "remove";
      settingsPath: string;
      backupPath: string;
      snapshotPath: string;
      removed: RemovedGroup[];
    };

export class GateDisableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateDisableError";
  }
}

function resolveSettingsPath(opts: GateDisableOptions): string {
  if (typeof opts.settingsPath === "string" && opts.settingsPath.length > 0) {
    return opts.settingsPath;
  }
  const home = opts.homeDir ?? os.homedir();
  return path.join(home, DEFAULT_SETTINGS_REL);
}

interface ParsedSettings {
  raw: string;
  obj: Record<string, unknown>;
  /** `hooks` block, or null when the file has no `hooks` key. */
  hooks: Record<string, unknown[]> | null;
}

function readSettings(settingsPath: string): ParsedSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GateDisableError(
        `settings file not found: ${settingsPath} — nothing to disable`,
      );
    }
    throw new GateDisableError(`cannot read ${settingsPath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GateDisableError(
      `${settingsPath} is not valid JSON (${(err as Error).message}); refusing to operate. ` +
        `Fix the file by hand or restore from a backup before re-running.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GateDisableError(`${settingsPath} is not a JSON object; refusing to operate.`);
  }
  const obj = parsed as Record<string, unknown>;
  const rawHooks = obj["hooks"];
  if (rawHooks === undefined) {
    return { raw, obj, hooks: null };
  }
  if (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks)) {
    throw new GateDisableError(
      `${settingsPath} \`hooks\` field is not an object; refusing to operate.`,
    );
  }
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(rawHooks)) {
    if (!Array.isArray(groups)) {
      throw new GateDisableError(
        `${settingsPath} \`hooks.${event}\` is not an array; refusing to operate.`,
      );
    }
    hooks[event] = groups;
  }
  return { raw, obj, hooks };
}

function summarizeGroup(group: unknown): string {
  if (group === null || typeof group !== "object" || Array.isArray(group)) {
    return "<malformed group>";
  }
  const obj = group as Record<string, unknown>;
  const inner = Array.isArray(obj["hooks"]) ? (obj["hooks"] as unknown[]) : [];
  const cmds: string[] = [];
  for (const h of inner) {
    if (h !== null && typeof h === "object" && !Array.isArray(h)) {
      const cmd = (h as Record<string, unknown>)["command"];
      if (typeof cmd === "string") cmds.push(cmd);
    }
  }
  if (cmds.length === 0) return "<no commands>";
  // Truncate aggressively — operators reading the list want to scan
  // matchers, not full command paths.
  return cmds.map((c) => (c.length > 80 ? `${c.slice(0, 77)}...` : c)).join("; ");
}

function groupMatcher(group: unknown): string | null {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return null;
  const m = (group as Record<string, unknown>)["matcher"];
  return typeof m === "string" ? m : null;
}

function collectCandidates(hooks: Record<string, unknown[]>): GateDisableCandidate[] {
  const out: GateDisableCandidate[] = [];
  for (const event of Object.keys(hooks).sort()) {
    const groups = hooks[event] ?? [];
    groups.forEach((group, index) => {
      out.push({
        event,
        index,
        matcher: groupMatcher(group),
        description: summarizeGroup(group),
      });
    });
  }
  return out;
}

function matcherMatches(group: unknown, pattern: string): boolean {
  const m = groupMatcher(group);
  if (m === null) return false;
  // Substring match. Operators copy/paste the exact `matcher` string from
  // settings.json or from the gate's deny output (e.g. "Edit|Write|Bash"),
  // and a literal substring match is the principle of least surprise.
  // A future iteration can add a `--regex` mode if real-world usage shows
  // demand for it.
  return m.includes(pattern);
}

export function gateDisable(opts: GateDisableOptions = {}): GateDisableResult {
  const settingsPath = resolveSettingsPath(opts);
  const parsed = readSettings(settingsPath);
  const hooks = parsed.hooks ?? {};
  const allCandidates = collectCandidates(hooks);

  if (typeof opts.matcher !== "string" || opts.matcher.length === 0) {
    return { mode: "list", settingsPath, candidates: allCandidates };
  }

  const matcherPattern = opts.matcher;
  const removed: RemovedGroup[] = [];
  const keptHooks: Record<string, unknown[]> = {};
  for (const event of Object.keys(hooks).sort()) {
    const groups = hooks[event] ?? [];
    const kept: unknown[] = [];
    groups.forEach((group, index) => {
      if (matcherMatches(group, matcherPattern)) {
        removed.push({ event, index, group });
      } else {
        kept.push(group);
      }
    });
    if (kept.length > 0) keptHooks[event] = kept;
  }

  if (removed.length === 0) {
    throw new GateDisableError(
      `no hook groups matched matcher substring ${JSON.stringify(matcherPattern)} in ${settingsPath}. ` +
        `Run \`harness gate disable\` (no args) to list the available candidates.`,
    );
  }

  const beforeSha = sha256Hex(parsed.raw);
  const now = opts.now ?? new Date();
  const backup = backupPath(settingsPath, now);
  const snapPath = snapshotPath(settingsPath, now);

  // Backup BEFORE we touch the live file. If the backup write fails we
  // bail without having mutated anything.
  atomicWriteFile(backup, parsed.raw);

  const newObj: Record<string, unknown> = { ...parsed.obj };
  if (Object.keys(keptHooks).length === 0) {
    // Preserve the operator's choice to omit the key when there are no
    // kept hooks: dropping it entirely keeps re-applies clean rather
    // than emitting `"hooks": {}`.
    delete newObj["hooks"];
  } else {
    newObj["hooks"] = keptHooks;
  }
  const newSettings = `${JSON.stringify(newObj, null, 2)}\n`;
  const afterSha = sha256Hex(newSettings);

  const snapshot: GateDisableSnapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: now.toISOString(),
    settingsPath,
    settingsBackupPath: backup,
    settingsBeforeSha256: beforeSha,
    settingsAfterSha256: afterSha,
    filter: { matcher: matcherPattern },
    removed,
  };

  // Snapshot lands BEFORE the live settings.json rewrite: the snapshot
  // is the operator's reversibility insurance, so we don't want to be
  // left in a "settings.json mutated but snapshot missing" state if the
  // process dies between the two writes.
  atomicWriteFile(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  atomicWriteFile(settingsPath, newSettings);

  return {
    mode: "remove",
    settingsPath,
    backupPath: backup,
    snapshotPath: snapPath,
    removed,
  };
}
