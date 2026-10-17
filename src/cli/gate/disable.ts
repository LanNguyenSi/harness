// `harness gate disable` — operator escape hatch for hard-blocking hooks.
//
// Reads the operator's `~/.claude/settings.json` (or `--settings <path>`),
// finds hook groups whose `matcher` substring-matches the supplied
// `--matcher`, removes them, writes a snapshot of the removed groups to
// `<settings-dir>/harness.gate-disable.<ISO>.json`, backs up the original
// to `<settings.json>.bak.<ISO>`, and atomically rewrites settings.json
// without the matching groups. There is one live snapshot per settings.json:
// when one already exists and the file is exactly the state it left, the
// newly removed groups are merged into it (and the backup of this call is
// added to its audit trail) instead of starting a second one, so a single
// `gate enable` brings every removed group back. A live snapshot that is
// spent (the file is back at its pre-disable state, or holds every group it
// names unchanged) is retired first and a fresh one is started; a live
// snapshot the file has drifted from while a group is still missing, or is
// there only with other content, makes this verb refuse, writing nothing but
// the retire of the spent snapshots it walked past, and points at
// `gate enable --force`. A settings.json that is itself a symlink is written
// through: the link stays a link, and the backup and snapshot sit beside the
// file it leads to (`resolveSettingsEntry`).
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
  changedLabel,
  type GateDisableSnapshot,
  groupCommands,
  listLiveSnapshots,
  type LiveSnapshot,
  missingLabel,
  planRestore,
  type RemovedGroup,
  resolveSettingsEntry,
  retireSnapshot,
  settingsFlag,
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
      /** True when the groups were merged into an already live snapshot. */
      merged: boolean;
      /** Spent snapshots this call retired, under their retired names. */
      retired: string[];
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
  const cmds = groupCommands(group);
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
  // Every write goes to the file itself: a settings.json that is a symlink
  // (dotfiles) stays a symlink, and its backup and snapshot sit beside the
  // file it leads to, where an enable through either spelling looks.
  const entry = resolveSettingsEntry(settingsPath);
  const backup = backupPath(entry, now);

  const found = listLiveSnapshots(settingsPath);
  if (!found.ok) {
    throw new GateDisableError(
      `${found.reason}. A live snapshot beside ${settingsPath} that cannot be read would be left out of this ` +
        `disable; nothing was changed. Move ${found.path} aside (or rename it to *.restored.json once its groups ` +
        `are back; if it names groups that are still removed, put them back by hand first, the snapshot's ` +
        `settingsBackupPath names the file as it was before the disable) and run this again.`,
    );
  }
  const { target, spent } = chooseSnapshot(found.live, parsed, beforeSha, settingsPath);
  const step =
    target === undefined ? 0 : Math.max(...target.snapshot.removed.map((r) => r.step ?? 0), 0) + 1;
  const stepped: RemovedGroup[] = removed.map((r) => ({ ...r, step }));
  const snapPath = target?.path ?? snapshotPath(entry, now);
  const retired = retireSpent(spent, settingsPath);

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

  // A merge keeps the original pre-disable state (sha, backup, filter) and
  // moves only the post-disable sha forward; the snapshot is upgraded to the
  // current version because the stepped positions are not readable by a
  // release that only knows version 1.
  const snapshot: GateDisableSnapshot =
    target === undefined
      ? {
          version: SNAPSHOT_VERSION,
          createdAt: now.toISOString(),
          settingsPath: path.resolve(entry),
          settingsBackupPath: path.resolve(backup),
          settingsBeforeSha256: beforeSha,
          settingsAfterSha256: afterSha,
          filter: { matcher: matcherPattern },
          removed: stepped,
        }
      : {
          ...target.snapshot,
          version: SNAPSHOT_VERSION,
          settingsAfterSha256: afterSha,
          removed: [...target.snapshot.removed, ...stepped],
          merges: [
            ...(target.snapshot.merges ?? []),
            {
              step,
              createdAt: now.toISOString(),
              matcher: matcherPattern,
              settingsBackupPath: path.resolve(backup),
            },
          ],
        };

  // Snapshot lands BEFORE the live settings.json rewrite: the snapshot
  // is the operator's reversibility insurance, so we don't want to be
  // left in a "settings.json mutated but snapshot missing" state if the
  // process dies between the two writes.
  const priorSnapshot = target === undefined ? undefined : fs.readFileSync(target.path, "utf8");
  atomicWriteFile(snapPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  try {
    atomicWriteFile(entry, newSettings);
  } catch (err) {
    if (priorSnapshot !== undefined) {
      // The merged snapshot now describes a removal that never happened to
      // the file. Put the live snapshot back to what it was; if that fails
      // too, `gate enable` still restores it, because it leaves a group the
      // file still holds unchanged alone, and the operator is told so.
      try {
        atomicWriteFile(snapPath, priorSnapshot);
      } catch (rollbackErr) {
        throw new GateDisableError(
          `cannot write ${settingsPath}: ${(err as Error).message}; and the snapshot ${snapPath}, already merged, ` +
            `could not be put back (${(rollbackErr as Error).message}). ${settingsPath} still holds the groups this ` +
            `disable meant to remove. Run \`harness gate enable ${settingsFlag(settingsPath)}\` to put back what the earlier ` +
            `disables removed (add --force if it refuses; a group the file still holds is left alone), then run ` +
            `this disable again.`,
        );
      }
    }
    throw err;
  }

  return {
    mode: "remove",
    settingsPath,
    backupPath: backup,
    snapshotPath: snapPath,
    removed,
    merged: target !== undefined,
    retired,
  };
}

/**
 * Retires the spent snapshots a disable walked past, returning their retired
 * names. A failed rename stops the disable before it writes anything, naming
 * the snapshot and the way out instead of a bare errno.
 */
function retireSpent(spent: LiveSnapshot[], settingsPath: string): string[] {
  return spent.map((l) => {
    try {
      return retireSnapshot(l.path);
    } catch (err) {
      throw new GateDisableError(
        `the live gate snapshot ${l.path} is spent (${settingsPath} holds every group it names, enable would only ` +
          `retire it) but cannot be retired (${(err as Error).message}). Move it out of the directory by hand (or ` +
          `rename it to *.restored.json) and run this again. ${settingsPath} was not changed.`,
      );
    }
  });
}

/**
 * Which live snapshot a new disable joins, and which spent ones it retires
 * first. Newest first, for each live snapshot:
 * - the file is exactly the state it left (post-disable sha): join it;
 * - the file already holds every group it names unchanged, which includes
 *   being back at its pre-disable state: it is spent, `gate enable` would
 *   only retire it, so retire it here and look at the next older one;
 * - otherwise the file has drifted while a group is still missing, or is
 *   there only with other content (which may be another hook sharing the
 *   matcher): retire the spent snapshots walked past, so the way out stays
 *   `gate enable --force` and this disable again, then refuse before
 *   writing anything else.
 * No live snapshot left to join means a fresh snapshot.
 */
function chooseSnapshot(
  live: LiveSnapshot[],
  parsed: ParsedSettings,
  beforeSha: string,
  settingsPath: string,
): { target: LiveSnapshot | undefined; spent: LiveSnapshot[] } {
  const spent: LiveSnapshot[] = [];
  for (const candidate of live) {
    const snap = candidate.snapshot;
    if (snap.settingsAfterSha256 === beforeSha) return { target: candidate, spent };
    const plan = planRestore(parsed.hooks ?? {}, snap);
    if (plan.restored.length === 0 && plan.changed.length === 0) {
      spent.push(candidate);
      continue;
    }
    const retired = retireSpent(spent, settingsPath);
    const problems = [
      ...(plan.restored.length > 0
        ? [
            `${plan.restored.length} hook group(s) it removed are still missing ` +
              `(${plan.restored.map(missingLabel).join("; ")})`,
          ]
        : []),
      ...(plan.changed.length > 0
        ? [
            `${plan.changed.length} hook group(s) of the file have the event and matcher of one it removed but other ` +
              `content, so they do not count as back (${plan.changed.map(changedLabel).join("; ")})`,
          ]
        : []),
    ];
    // A group that only shares the matcher may be another hook: --force takes
    // it for the snapshot's and leaves the snapshot's out, so the refusal also
    // names the way that puts the snapshot's group back instead.
    const wayOut =
      plan.changed.length > 0
        ? `If the file's group stands in for the snapshot's, run \`harness gate enable --force ${settingsFlag(settingsPath)}\`: ` +
          `it takes it as back (the snapshot's group is not put back), puts the missing groups back and keeps every ` +
          `other edit. Otherwise make the file hold the snapshot's group (${snap.settingsBackupPath} has it) and run ` +
          `\`harness gate enable ${settingsFlag(settingsPath)}\`. Then run this again.`
        : `Run \`harness gate enable --force ${settingsFlag(settingsPath)}\`: it puts the missing groups back, leaves a group ` +
          `that is already there alone and keeps every other edit. Then run this again.`;
    throw new GateDisableError(
      `${settingsPath} is not the state the live snapshot ${candidate.path} left, and ${problems.join("; ")}; ` +
        `merging this disable into it would lose track of them. ` +
        (retired.length > 0
          ? `Retired the spent snapshot(s) walked past first (${retired.join(", ")}); nothing else was changed. `
          : `Nothing was changed. `) +
        wayOut,
    );
  }
  return { target: undefined, spent };
}
