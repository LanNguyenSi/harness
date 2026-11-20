// Retention for the files harness leaves beside an operator-owned config:
// retired gate snapshots and dated backups. Nothing else prunes them, so a
// config directory grew by a few files per gate cycle or apply.
//
// Four families, the newest `RETENTION_KEEP` of each kept:
//
//   1. retired Claude gate snapshots   harness.gate-disable.<stamp>.(restored|superseded).json
//   2. retired Codex gate snapshots    harness.gate-disable-codex.<stamp>.(restored|superseded).json
//   3. dated settings backups          <file>.bak.<stamp>            (gate disable, harness apply)
//   4. Codex install backups           <file>.harness-backup-<stamp> (harness apply --install)
//
// (3) is one family per file whether the Claude gate, the Codex gate or
// `harness apply --target` wrote it: the three share one naming. Snapshots
// carry no file name in their own name, so (1) and (2) are counted per
// directory.
//
// Ordering key: the timestamp spelled in the file name, which is the
// writer's clock (injectable, and exact to the millisecond), not mtime: a
// restore from a backup, a copy or a `touch` moves mtime but never the
// name. Equal timestamps fall back to mtime, then to the name, so a tie
// never depends on directory order.
//
// Never deleted:
//   - a live snapshot (plain `.json`): the retired patterns end in
//     `.restored.json` or `.superseded.json`, so a live one never matches;
//   - a backup a live snapshot names (`settingsBackupPath`,
//     `configBackupPath`, and the same fields of every merge). When a live
//     snapshot in the scanned directories cannot be read, its references
//     are unknown and no backup is pruned at all;
//   - anything whose name does not match its family exactly, a symlink, or
//     anything that is not a regular file. Pruning lists the directory the
//     writer used, never resolves a path, and `unlink` removes a link itself,
//     so nothing outside that directory can be touched.
//
// Pruning is best effort: it never throws, an error becomes a warning and
// the operation that triggered it keeps its result.

import * as fs from "node:fs";
import * as path from "node:path";

/** How many of each family stay: the newest five. The recovery hints in the
 * gate and apply messages name "the most recent" backup, which stays. */
export const RETENTION_KEEP = 5;

/** The two prefixes of a live (unretired) gate snapshot: Claude, then Codex. */
export const LIVE_SNAPSHOT_PREFIXES: readonly string[] = ["harness.gate-disable.", "harness.gate-disable-codex."];

const RETIRED_SNAPSHOT_SUFFIXES: readonly string[] = [".restored.json", ".superseded.json"];

/** `2000-01-02T03-04-05.678Z`: an ISO time with `:` as `-` (gate disable, apply backups, snapshots). */
const GATE_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/;
/** `2000-01-02T03-04-05-678Z`: an ISO time with `:` and `.` as `-` (Codex install backups). */
const INSTALL_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export type DatedBackupKind = "bak" | "harness-backup";

export interface PruneOptions {
  /** How many to keep; defaults to {@link RETENTION_KEEP}. */
  keep?: number;
  /** Paths that are never removed (the file the caller just wrote or retired). */
  exclude?: readonly string[];
  /** Receives one line per problem; defaults to stderr. */
  warn?: (message: string) => void;
}

interface Candidate {
  name: string;
  stampMs: number;
  mtimeMs: number;
}

function defaultWarn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

/** A warn callback that cannot throw: pruning never fails its caller. */
function safeWarn(warn: ((message: string) => void) | undefined): (message: string) => void {
  const sink = warn ?? defaultWarn;
  return (message) => {
    try {
      sink(message);
    } catch {
      // A broken sink must not turn a best-effort prune into a failure.
    }
  };
}

function stampMs(stamp: string, re: RegExp): number | null {
  const m = re.exec(stamp);
  if (m === null) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The time in a retired snapshot's name, or null when the name is not one. */
function retiredSnapshotStamp(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const suffix = RETIRED_SNAPSHOT_SUFFIXES.find((s) => name.endsWith(s));
  if (suffix === undefined) return null;
  return stampMs(name.slice(prefix.length, name.length - suffix.length), GATE_STAMP);
}

/** The time in a dated backup's name, or null when it is not `<base>.bak.<stamp>` / `<base>.harness-backup-<stamp>`. */
function datedBackupStamp(name: string, base: string, kind: DatedBackupKind): number | null {
  const marker = kind === "bak" ? `${base}.bak.` : `${base}.harness-backup-`;
  if (!name.startsWith(marker)) return null;
  return stampMs(name.slice(marker.length), kind === "bak" ? GATE_STAMP : INSTALL_STAMP);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** `name` inside `dir`, spelled the way the directory was listed. `path.join`
 * folds `..` lexically, so for `dir` = `link/..` it would name another
 * directory than the one `readdirSync` read; concatenation leaves the
 * spelling to the kernel. */
function entryIn(dir: string, name: string): string {
  return dir.endsWith(path.sep) ? `${dir}${name}` : `${dir}${path.sep}${name}`;
}

/** The regular files of `dir` that `stampOf` accepts, newest first. A
 * symlink, a directory or anything unstat-able is left out. */
function collect(dir: string, stampOf: (name: string) => number | null, warn: (m: string) => void): Candidate[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (!isMissing(err)) warn(`cannot list ${dir} to prune old files (${describeError(err)}); nothing was removed`);
    return null;
  }
  const found: Candidate[] = [];
  for (const name of names) {
    const ms = stampOf(name);
    if (ms === null) continue;
    try {
      const st = fs.lstatSync(entryIn(dir, name));
      if (!st.isFile()) continue;
      found.push({ name, stampMs: ms, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  found.sort((a, b) => b.stampMs - a.stampMs || b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return found;
}

/** Remove what is past the newest `keep`, minus the protected names. Never throws. */
function removeBeyond(
  dir: string,
  sorted: Candidate[],
  keep: number,
  isProtected: (name: string) => boolean,
  warn: (m: string) => void,
): string[] {
  const removed: string[] = [];
  for (const c of sorted.slice(Math.max(keep, 0))) {
    if (isProtected(c.name)) continue;
    const full = entryIn(dir, c.name);
    try {
      fs.unlinkSync(full);
      removed.push(full);
    } catch (err) {
      if (!isMissing(err)) warn(`cannot remove ${full} (${describeError(err)}); it stays`);
    }
  }
  return removed;
}

function excluder(opts: PruneOptions, dir: string): (name: string) => boolean {
  const excluded = new Set((opts.exclude ?? []).map((p) => path.resolve(p)));
  return (name) => excluded.has(path.resolve(dir, name));
}

/**
 * Keep the newest `keep` retired snapshots (`<prefix><stamp>.restored.json`
 * and `.superseded.json`) in `dir`, remove the rest. A live snapshot never
 * matches. Returns the removed paths; never throws.
 */
export function pruneRetiredSnapshots(dir: string, prefix: string, opts: PruneOptions = {}): string[] {
  const warn = safeWarn(opts.warn);
  try {
    const sorted = collect(dir, (n) => retiredSnapshotStamp(n, prefix), warn);
    if (sorted === null) return [];
    return removeBeyond(dir, sorted, opts.keep ?? RETENTION_KEEP, excluder(opts, dir), warn);
  } catch (err) {
    warn(`pruning retired snapshots in ${dir} failed (${describeError(err)})`);
    return [];
  }
}

/** Backup file names the live snapshots in `dir` name, or null when one cannot be read. */
function referencedBackupNames(dir: string, warn: (m: string) => void): Set<string> | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return new Set();
    warn(`cannot list ${dir} to find the backups a live snapshot names (${describeError(err)}); no backup was removed`);
    return null;
  }
  const refs = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (!LIVE_SNAPSHOT_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (RETIRED_SNAPSHOT_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const full = entryIn(dir, name);
    // Only a regular file is read: a FIFO would block the read, and a
    // directory or a dangling link would block pruning for good. Such an
    // entry is no snapshot, and `listSnapshots` skips it the same way: it
    // `stat`s too, so a link to a regular file still counts as a live
    // snapshot here and its backups stay.
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      warn(`the live snapshot ${full} cannot be read (${describeError(err)}), so the backups it names are unknown; no backup was removed`);
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn(`the live snapshot ${full} is not a JSON object, so the backups it names are unknown; no backup was removed`);
      return null;
    }
    collectBackupFields(parsed as Record<string, unknown>, refs);
  }
  return refs;
}

function collectBackupFields(obj: Record<string, unknown>, into: Set<string>): void {
  for (const field of ["settingsBackupPath", "configBackupPath"]) {
    const v = obj[field];
    if (typeof v === "string" && v !== "") into.add(path.basename(v));
  }
  const merges = obj["merges"];
  if (Array.isArray(merges)) {
    for (const m of merges) {
      if (m !== null && typeof m === "object" && !Array.isArray(m)) collectBackupFields(m as Record<string, unknown>, into);
    }
  }
}

/**
 * Keep the newest `keep` dated backups of `filePath` (`<file>.bak.<stamp>`
 * or `<file>.harness-backup-<stamp>`, beside `filePath` itself, a symlink
 * not resolved), remove the rest. A backup a live snapshot names is never
 * removed; the snapshots beside `filePath` and, when it is a symlink, beside
 * the file it leads to are read for that. Returns the removed paths; never
 * throws.
 */
export function pruneDatedBackups(filePath: string, kind: DatedBackupKind, opts: PruneOptions = {}): string[] {
  const warn = safeWarn(opts.warn);
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const sorted = collect(dir, (n) => datedBackupStamp(n, base, kind), warn);
    if (sorted === null || sorted.length <= (opts.keep ?? RETENTION_KEEP)) return [];
    const scanDirs = new Set<string>([dir]);
    try {
      scanDirs.add(path.dirname(fs.realpathSync(filePath)));
    } catch {
      // A missing or dangling file has no second directory to scan.
    }
    const refs = new Set<string>();
    for (const d of scanDirs) {
      const found = referencedBackupNames(d, warn);
      if (found === null) return [];
      for (const n of found) refs.add(n);
    }
    const excluded = excluder(opts, dir);
    return removeBeyond(dir, sorted, opts.keep ?? RETENTION_KEEP, (n) => refs.has(n) || excluded(n), warn);
  } catch (err) {
    warn(`pruning the backups of ${filePath} failed (${describeError(err)})`);
    return [];
  }
}

/** The basename of the file a snapshot was taken for (`settingsPath` of a Claude snapshot, `configPath` of a Codex one), or null. */
export function snapshotTargetName(snapshotFile: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const recorded = typeof obj["settingsPath"] === "string" ? obj["settingsPath"] : obj["configPath"];
    if (typeof recorded !== "string") return null;
    const name = path.basename(recorded);
    return name === "" || name === "." || name === ".." ? null : name;
  } catch {
    return null;
  }
}
