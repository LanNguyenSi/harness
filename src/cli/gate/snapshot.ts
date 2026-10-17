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
// again). A removed group counts as back only when the file holds an
// unchanged copy of it; a group that merely shares its event and matcher is
// taken for it only under `--force`.
//
// The format is intentionally narrow: no compression, no transform, just
// the literal JSON groups as they were read out of settings.json.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { kernelEntry, walkLinkChain } from "./link-chain.js";
import { shellQuote } from "./shell-quote.js";

export const SNAPSHOT_BASENAME_PREFIX = "harness.gate-disable.";
export const SNAPSHOT_BASENAME_SUFFIX = ".json";
/** Written by this version. Adds `step` on every removed group and `merges`. */
export const SNAPSHOT_VERSION = 2 as const;
/** Written by releases before a second disable merged into the live snapshot; still restorable. */
export const LEGACY_SNAPSHOT_VERSION = 1 as const;
/** A retired snapshot keeps its name with this suffix instead of plain `.json`. */
export const RETIRED_SNAPSHOT_SUFFIX = ".restored.json";
/** A snapshot whose groups were carried into a snapshot at another place keeps its name with this suffix. */
export const SUPERSEDED_SNAPSHOT_SUFFIX = ".superseded.json";

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
   * file a snapshot belongs to (snapshots always sit beside their file): the
   * target must name that directory entry, see `listLiveSnapshots`.
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
 * Whether a snapshot's recorded `settingsPath` names a file: only its
 * basename tells which directory entry the snapshot belongs to, so a path
 * that has none (empty, or ending in `.` or `..`) records no target.
 */
function hasRecordedTarget(recorded: unknown): boolean {
  if (typeof recorded !== "string") return false;
  const name = path.basename(recorded);
  return name !== "" && name !== "." && name !== "..";
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
  if (!hasRecordedTarget(obj["settingsPath"])) {
    return {
      ok: false,
      reason:
        `snapshot ${filePath} has no recorded target (its "settingsPath" is missing or empty), so it cannot be ` +
        `matched to a settings file`,
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

/**
 * Retire `snapPath` as superseded (rename it, keep it for audit) and return
 * the new path: its groups were merged into a snapshot beside the file they
 * were removed from, so it is not restored and never offered again.
 */
export function supersedeSnapshot(snapPath: string): string {
  const to = `${snapPath.slice(0, -SNAPSHOT_BASENAME_SUFFIX.length)}${SUPERSEDED_SNAPSHOT_SUFFIX}`;
  fs.renameSync(snapPath, to);
  return to;
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

/** A live snapshot beside the target that was taken for another settings file. */
export interface ForeignSnapshot {
  /** The snapshot file. */
  path: string;
  /** The file it was taken for: its recorded basename in the target's directory. */
  settingsPath: string;
  /** Whether a file is at `settingsPath` now (a settings file renamed since the disable is not). */
  settingsExists: boolean;
  /** The backup its first disable wrote: the pre-disable copy of that file, the way back when the file is gone. */
  settingsBackupPath: string;
}

export type LiveSnapshotsResult =
  | {
      ok: true;
      live: LiveSnapshot[];
      /** Live snapshots beside the file that name another settings file; never read as this one's. */
      skippedForeign: ForeignSnapshot[];
    }
  | {
      ok: false;
      reason: string;
      /** The live snapshot file that could not be read. */
      path: string;
    };

/** Whether two names differ at most in letter case or Unicode normalization form. */
function foldsTo(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/**
 * Whether `recordedName`, in `dir`, is the directory entry `targetName`
 * names. The same spelling is, by definition: snapshots sit beside their
 * file and record its basename, so the name is the identity. A spelling that
 * differs only in letter case or normalization is the same entry only on a
 * filesystem that folds those (APFS by default), which `lstat` tells: both
 * names must resolve to one regular file (neither a symlink) whose link
 * count is 1, so no second name of that inode could be the one that matched.
 * Every other name is another entry (a hard link, a symlink, a renamed file):
 * restoring through it would write a new file at that name and leave the
 * recorded file as the disable left it.
 *
 * `symlinks` lets the entry be a symlink itself (a symlinked Codex config,
 * which the gate edits at its resolved target): two spellings then name one
 * entry when `lstat` gives both the same device and inode and a link count of
 * 1, as for a regular file. The Claude gate never sets it.
 */
export function namesSameEntry(
  dir: string,
  recordedName: string,
  targetName: string,
  opts: { symlinks?: boolean } = {},
): boolean {
  if (recordedName === targetName) return true;
  if (!foldsTo(recordedName, targetName)) return false;
  let recorded: fs.BigIntStats;
  let target: fs.BigIntStats;
  try {
    recorded = fs.lstatSync(path.join(dir, recordedName), { bigint: true });
    target = fs.lstatSync(path.join(dir, targetName), { bigint: true });
  } catch {
    return false;
  }
  const kind = (st: fs.BigIntStats): "file" | "link" | null =>
    st.isFile() ? "file" : opts.symlinks === true && st.isSymbolicLink() ? "link" : null;
  return (
    kind(recorded) !== null &&
    kind(recorded) === kind(target) &&
    recorded.dev === target.dev &&
    recorded.ino === target.ino &&
    recorded.nlink === 1n &&
    target.nlink === 1n
  );
}

/**
 * The spelling of `settingsPath` the gate builds every other path from: the
 * backup, the snapshot, the listing beside it, and the atomic write's temp
 * file. A spelling with a `..` segment is replaced by its directory as the
 * kernel resolves it (`kernelEntry`, which the Codex gate uses as well), so
 * no path built from it is folded into another directory; every other
 * spelling is kept as given and the paths the gate prints read the way they
 * were written.
 */
export function settingsOwnEntry(settingsPath: string): string {
  return kernelEntry(settingsPath);
}

/**
 * The file `gate disable` and `gate enable` read and write for `settingsPath`.
 * That is the path itself unless its last component is a symlink (a dotfiles
 * setup): then it is the entry the link leads to, which may sit in another
 * directory. Writing through the resolved entry keeps the link a link, and
 * the snapshots sit beside the file itself, so a disable through either
 * spelling is found by an enable through the other. Every hop of the chain is
 * resolved the way the kernel resolves it (`walkLinkChain`, the walker the
 * Codex gate uses too), so the file is the one reading through the path
 * gives, `..` in a link text included. A link whose file is gone resolves to
 * where the file would be, so the snapshots taken for it are still found; a
 * link whose text passes through a directory that is gone resolves to that
 * text as written (nothing can sit beside it). A path that is no link, and a
 * loop, resolve to the path's own entry (`settingsOwnEntry`).
 */
export function resolveSettingsEntry(settingsPath: string): string {
  const { chain, end } = walkLinkChain(settingsPath);
  if (chain.length === 1 || end === "loop") return settingsOwnEntry(settingsPath);
  // Every hop after the first is a physical directory and a name (the file's real path), unless the walk ended
  // in a directory that is gone: then it is the link text as written.
  return chain[chain.length - 1] ?? settingsPath;
}

/**
 * The identity of a file across spellings of its directory, or the path itself
 * when it cannot be resolved. The native `realpath` takes `d/..` through the
 * real location of `d`, as the listing that found the file did.
 */
function fileIdentity(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * The live (not retired) snapshots that were taken for `settingsPath`,
 * newest first by `createdAt`. Snapshots always sit beside their file, so
 * only the basename of the recorded settings path counts, never how the
 * directory was spelled when it was written (relative to some other working
 * directory, or through a symlink): a snapshot belongs to the file when the
 * target names the directory entry that basename names (`namesSameEntry`:
 * the same spelling, or another spelling of the one entry on a
 * case-insensitive filesystem). When `settingsPath` is itself a symlink
 * (`resolveSettingsEntry`), the directory of the file it leads to is searched
 * too, with the resolved entry as the target there: the snapshot of a disable
 * made through the other spelling sits beside that file. A hard link to the
 * file, a renamed file, or a snapshot found beside the file a symlink leads
 * to but recorded under the symlink's own name is another entry, so a
 * snapshot recorded for one is foreign to the other, whether or not the files
 * exist. A snapshot for another settings file in the same directory is
 * listed in `skippedForeign`, never dropped silently. A live snapshot that
 * cannot be read, or records no target, is an error: its target cannot be
 * told, so neither disable nor enable may go on as if it did not exist.
 */
export function listLiveSnapshots(settingsPath: string): LiveSnapshotsResult {
  const own = settingsOwnEntry(settingsPath);
  const resolved = resolveSettingsEntry(settingsPath);
  const places = [{ dir: path.dirname(own), name: path.basename(own) }];
  if (resolved !== own) {
    places.push({ dir: path.dirname(resolved), name: path.basename(resolved) });
  }
  const live = new Map<string, LiveSnapshot>();
  const foreign = new Map<string, ForeignSnapshot>();
  for (const { dir, name: targetName } of places) {
    for (const file of listSnapshots(dir)) {
      if (file.endsWith(RETIRED_SNAPSHOT_SUFFIX) || file.endsWith(SUPERSEDED_SNAPSHOT_SUFFIX)) continue;
      const id = fileIdentity(file);
      const read = readSnapshot(file);
      if (!read.ok) return { ok: false, reason: read.reason, path: file };
      const recordedName = path.basename(read.snapshot.settingsPath);
      if (!namesSameEntry(dir, recordedName, targetName)) {
        const recordedPath = path.join(dir, recordedName);
        foreign.set(id, {
          path: file,
          settingsPath: recordedPath,
          settingsExists: fs.existsSync(recordedPath),
          settingsBackupPath: read.snapshot.settingsBackupPath,
        });
        continue;
      }
      live.set(id, { path: file, snapshot: read.snapshot });
    }
  }
  const liveList = [...live.values()];
  liveList.sort((a, b) => {
    if (a.snapshot.createdAt !== b.snapshot.createdAt) {
      return a.snapshot.createdAt < b.snapshot.createdAt ? 1 : -1;
    }
    return a.path < b.path ? 1 : -1;
  });
  // A snapshot the other spelling's directory owns is not foreign to the file.
  const skippedForeign = [...foreign].filter(([id]) => !live.has(id)).map(([, f]) => f);
  return { ok: true, live: liveList, skippedForeign };
}

const READ_ONLY_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS"]);

/** Whether a write failed because the directory or filesystem does not allow it to be written. */
export function isReadOnlyWriteError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && READ_ONLY_CODES.has(code);
}

/**
 * What a gate refusal says first when the file a settings symlink leads to
 * cannot be written where it sits: what the link is and what refuses. EACCES
 * and EROFS come from the directory (the gate writes a temp file beside the
 * file and renames it into place); EPERM can come from the file or from the
 * directory (an immutable flag, a sticky directory), so it names both without
 * saying which. Each verb adds its own way out.
 */
export function readOnlyLinkTargetText(settingsPath: string, entry: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  const refuses =
    code === "EPERM"
      ? `the file ${entry} or the directory ${path.dirname(entry)} that holds it`
      : `the directory ${path.dirname(entry)} that holds that file`;
  return `${settingsPath} is a symlink to ${entry}, and ${refuses} cannot be written (${code}), so the gate cannot write there.`;
}

/** What a read-only refusal tells the operator to make writable: the directory, and for EPERM the file too. */
export function readOnlyWritablePlace(entry: string, err: unknown): string {
  return (err as NodeJS.ErrnoException).code === "EPERM"
    ? `${entry} and ${path.dirname(entry)}`
    : path.dirname(entry);
}

/** The command that puts a copy of the file a symlink leads to in place of the link. */
export function copyOverLinkCommand(settingsPath: string, entry: string): string {
  const copy = `${settingsPath}.copy`;
  return `cp ${shellQuote(entry)} ${shellQuote(copy)} && mv ${shellQuote(copy)} ${shellQuote(settingsPath)}`;
}

/**
 * How a command prints a `--settings` target so that it works as printed: a
 * path with a character the shell would act on (a space, a quote, `~`, `=`,
 * `%`, `$`) is single-quoted by the one quoting helper the gate shares.
 */
export function settingsFlag(settingsPath: string): string {
  return `--settings ${shellQuote(settingsPath)}`;
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

/** The `command` strings of a hook group's hooks, in order; empty for a malformed group. */
export function groupCommands(group: unknown): string[] {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return [];
  const inner = (group as Record<string, unknown>)["hooks"];
  const cmds: string[] = [];
  for (const h of Array.isArray(inner) ? inner : []) {
    if (h !== null && typeof h === "object" && !Array.isArray(h)) {
      const cmd = (h as Record<string, unknown>)["command"];
      if (typeof cmd === "string") cmds.push(cmd);
    }
  }
  return cmds;
}

function commandsText(group: unknown): string {
  const cmds = groupCommands(group);
  return cmds.length === 0 ? "no command" : cmds.map((c) => `\`${c}\``).join(", ");
}

/**
 * How a refusal names a removed group that is still missing: its event and
 * matcher plus its commands, so that when another group shares the matcher
 * the operator can tell which one is out of the file.
 */
export function missingLabel(entry: RemovedGroup): string {
  return `${groupLabel(entry.event, entry.group)} running ${commandsText(entry.group)}`;
}

/**
 * JSON with the keys of every object sorted, so two groups compare equal
 * whatever order an editor or an apply wrote their keys in.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** A snapshot entry and the group of the file with its event and matcher but other content. */
export interface ChangedGroup {
  entry: RemovedGroup;
  /** The group the file holds in its place. */
  current: unknown;
}

/** Names a changed group and the commands of both versions, so the operator can tell whether it is the gate's. */
export function changedLabel(changed: ChangedGroup): string {
  const was = commandsText(changed.entry.group);
  const now = commandsText(changed.current);
  return (
    `${groupLabel(changed.entry.event, changed.entry.group)}: the snapshot's group runs ${was}, ` +
    `the file's group runs ${now}${was === now ? " (they differ in another field)" : ""}`
  );
}

export interface RestorePlan {
  /** The hooks block with the groups that were still missing spliced back in; the input is not modified. */
  hooks: Record<string, unknown[]>;
  /** Entries spliced back in. */
  restored: RemovedGroup[];
  /**
   * Entries the file already holds unchanged (deep-equal, put back by hand
   * or by an apply). Left alone, never spliced in a second time.
   */
  alreadyBack: RemovedGroup[];
  /**
   * Entries the file holds no unchanged copy of, but a group with the same
   * event and matcher and other content. That group may be the gate's,
   * re-rendered, or another hook that happens to share the matcher, so it is
   * never taken for the entry on its own: `gate enable` and `gate disable`
   * refuse while there is one, and only `gate enable --force` accepts it as
   * back. Never spliced in.
   */
  changed: ChangedGroup[];
}

/**
 * What putting a snapshot's removed groups back into `current` would do. The
 * entries are paired with the groups of the file one to one: first every
 * entry with a deep-equal group of the same event (`alreadyBack`), then each
 * entry left over, in the order the snapshot recorded them, with the first
 * group still unpaired that has its event and matcher (`changed`). The rest
 * are spliced in at their recorded positions: each removal step recorded its
 * indices against the array as it stood just before that step, so the steps
 * are undone newest first, and inside a step by event and ascending index (an
 * earlier insertion never shifts a later insertion's target index past the
 * array end).
 */
export function planRestore(
  current: Record<string, unknown[]>,
  snapshot: GateDisableSnapshot,
): RestorePlan {
  const hooks: Record<string, unknown[]> = {};
  const unpaired = new Map<string, unknown[]>();
  for (const [event, groups] of Object.entries(current)) {
    hooks[event] = groups.slice();
    unpaired.set(event, groups.slice());
  }
  const take = (entry: RemovedGroup, same: (group: unknown) => boolean): unknown[] => {
    const pool = unpaired.get(entry.event) ?? [];
    const at = pool.findIndex(same);
    return at === -1 ? [] : pool.splice(at, 1);
  };
  const alreadyBack: RemovedGroup[] = [];
  const leftover: RemovedGroup[] = [];
  for (const entry of snapshot.removed) {
    const wanted = canonicalJson(entry.group);
    if (take(entry, (g) => canonicalJson(g) === wanted).length > 0) alreadyBack.push(entry);
    else leftover.push(entry);
  }
  const changed: ChangedGroup[] = [];
  const missing: RemovedGroup[] = [];
  for (const entry of leftover) {
    const matcher = groupMatcherOf(entry.group);
    const [match] = take(entry, (g) => groupMatcherOf(g) === matcher);
    if (match !== undefined) changed.push({ entry, current: match });
    else missing.push(entry);
  }
  const restored = missing.sort((a, b) => {
    const stepA = a.step ?? 0;
    const stepB = b.step ?? 0;
    if (stepA !== stepB) return stepB - stepA;
    if (a.event !== b.event) return a.event < b.event ? -1 : 1;
    return a.index - b.index;
  });
  for (const entry of restored) {
    const arr = hooks[entry.event] ?? [];
    arr.splice(Math.min(entry.index, arr.length), 0, entry.group);
    hooks[entry.event] = arr;
  }
  return { hooks, restored, alreadyBack, changed };
}
