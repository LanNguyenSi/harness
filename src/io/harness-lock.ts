// `harness.lock` writer + reader. See ARCHITECTURE.md §7 (the `harness.lock`
// bullet and the "Drift handling on `apply`" subsection).
//
// Lock format is line-oriented JSON (NDJSON) for diff-friendliness:
//   {"kind":"asset","path":"…","sha256":"…"}
//   {"kind":"memory-dir","path":"…","sha256":"…","file_count":N}
//
// Tool-asset files (hook scripts, MCP entrypoints, skill SKILL.md, memory
// router binary) get one entry per file. Memory directories under
// memory.directories[] are aggregated Merkle-style: the directory's hash is
//   sha256(L), where L = `<basename>:<hex-sha256-of-content>` joined with a
//   single `\n` between entries, sorted ascending by basename, no trailing
//   newline. Empty directories hash to sha256("").
// A new memory file or a content change produces exactly one diff line per
// affected directory.
//
// A path that is not there (ENOENT, ENOTDIR) is silently omitted from the
// lock: a manifest may name an asset that has not been installed yet. Any
// other stat or read failure (EACCES, EPERM, ELOOP, ...) on an asset, a skill
// SKILL.md candidate or a memory directory (or a file inside one) also
// leaves the entry out, but is reported as a warning naming the path and the
// error code, so the missing entry (and the drift detection that goes with
// it) is not silent. `buildLockEntriesWithWarnings` returns those warnings;
// every `harness apply` that reaches the lock build prints them until the path
// is readable (a dry run or an apply refused earlier builds no lock). The lock format carries no marker for such a
// path: an older release's `parseLock` rejects an unknown entry kind, so the
// warning is the only signal. A memory directory holding one unreadable file
// is left out as a whole, since its hash would otherwise cover a partial view.
//
// Limit: this skip-and-warn covers paths that are not in the lock yet. A file
// that is already in harness.lock and later becomes unreadable still stops
// `apply` in the drift check (`computeDrift` reads it and throws, exit 70);
// that case is not handled here.
//
// `mcp[]` and `memory.router` entries with `enabled: false` are skipped: per
// ARCHITECTURE §3, disabled MCP entries are removed from the generated
// runtime config, so locking their assets would tie apply-time drift checks
// to assets the user has explicitly opted out of.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome } from "./expand-home.js";
import type { Manifest } from "../schema/index.js";
import { atomicWriteFile } from "./atomic-write.js";
import { isValidProjectName } from "./project-name.js";

export interface AssetEntry {
  kind: "asset";
  path: string;
  sha256: string;
}

export interface MemoryDirEntry {
  kind: "memory-dir";
  path: string;
  sha256: string;
  file_count: number;
}

// `target` records the on-disk file `harness apply --target <path>` last
// wrote (raw or merged). Drift-checked the same way as `asset` entries:
// sha256 of the bytes vs the recorded sha. Lives separately from `asset`
// so `validate --check-lock` and the diff/since-apply machinery can
// distinguish "user-managed settings.json that harness wired into" from
// "manifest-referenced hook script".
export interface TargetEntry {
  kind: "target";
  path: string;
  sha256: string;
}

export type LockEntry = AssetEntry | MemoryDirEntry | TargetEntry;

export const LOCK_BASENAME = "harness.lock";

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function computeAssetEntry(absolutePath: string): AssetEntry {
  const buf = fs.readFileSync(absolutePath);
  return { kind: "asset", path: absolutePath, sha256: sha256Hex(buf) };
}

export function computeMemoryDirEntry(absoluteDirPath: string): MemoryDirEntry {
  // Top-level .md files only; non-recursive. Symlinks are skipped via
  // withFileTypes.isFile() (which lstats), so a symlink-to-passwd named
  // *.md cannot leak external content into the lock.
  const dirents = fs.readdirSync(absoluteDirPath, { withFileTypes: true });
  const files = dirents
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name)
    .sort();
  const lines = files.map((f) => {
    const buf = fs.readFileSync(path.join(absoluteDirPath, f));
    return `${f}:${sha256Hex(buf)}`;
  });
  return {
    kind: "memory-dir",
    path: absoluteDirPath,
    sha256: sha256Hex(lines.join("\n")),
    file_count: files.length,
  };
}

function sortKey(e: LockEntry): string {
  return `${e.kind}\0${e.path}`;
}

function byteCompare(a: string, b: string): number {
  // Locale-independent byte order. localeCompare would give different
  // results across locales (e.g. de_DE may collate ä before/after b
  // depending on the strength), which would make harness.lock non-portable
  // across machines once a hook script with a non-ASCII basename appears.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeLock(entries: LockEntry[]): string {
  const sorted = [...entries].sort((a, b) => byteCompare(sortKey(a), sortKey(b)));
  if (sorted.length === 0) return "";
  return `${sorted.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export function parseLock(content: string): LockEntry[] {
  const out: LockEntry[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`malformed ${LOCK_BASENAME} entry: ${line}`);
    }
    if (!isLockEntry(parsed)) {
      throw new Error(`malformed ${LOCK_BASENAME} entry: ${line}`);
    }
    out.push(parsed);
  }
  return out;
}

function isLockEntry(x: unknown): x is LockEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  if (e.kind === "asset" || e.kind === "target") {
    return typeof e.path === "string" && typeof e.sha256 === "string";
  }
  if (e.kind === "memory-dir") {
    return (
      typeof e.path === "string" &&
      typeof e.sha256 === "string" &&
      typeof e.file_count === "number"
    );
  }
  return false;
}

export function writeLock(lockPath: string, entries: LockEntry[]): void {
  atomicWriteFile(lockPath, serializeLock(entries));
}

export function readLock(lockPath: string): LockEntry[] | null {
  if (!fs.existsSync(lockPath)) return null;
  return parseLock(fs.readFileSync(lockPath, "utf8"));
}

export type DriftReason = "missing" | "modified";

export interface DriftedAsset {
  entry: LockEntry;
  reason: DriftReason;
  currentSha?: string;
}

export function computeDrift(entries: LockEntry[]): DriftedAsset[] {
  const drifted: DriftedAsset[] = [];
  for (const e of entries) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(e.path);
    } catch {
      drifted.push({ entry: e, reason: "missing" });
      continue;
    }
    if (e.kind === "asset" || e.kind === "target") {
      if (!stat.isFile()) {
        drifted.push({ entry: e, reason: "missing" });
        continue;
      }
      const current = computeAssetEntry(e.path);
      if (current.sha256 !== e.sha256) {
        drifted.push({ entry: e, reason: "modified", currentSha: current.sha256 });
      }
    } else {
      if (!stat.isDirectory()) {
        drifted.push({ entry: e, reason: "missing" });
        continue;
      }
      const current = computeMemoryDirEntry(e.path);
      if (current.sha256 !== e.sha256) {
        drifted.push({ entry: e, reason: "modified", currentSha: current.sha256 });
      }
    }
  }
  return drifted;
}

export interface BuildLockOptions {
  homeDir?: string;
  projectName?: string;
}

// Interpreter binaries that often appear as the first argv of an MCP or
// router command. They are environmental concerns (the user's runtime), not
// harness-managed assets. Locking the system Node binary would cause spurious
// drift on every Node minor-version bump.
const KNOWN_INTERPRETERS = new Set([
  "node",
  "npx",
  "python",
  "python3",
  "bash",
  "sh",
  "tsx",
  "deno",
  "bun",
]);

function isInterpreter(token: string): boolean {
  return KNOWN_INTERPRETERS.has(path.basename(token));
}

// ENOENT / ENOTDIR: the path is simply not there. Everything else is a path
// that exists (or may exist) but cannot be examined.
function isAbsentError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code !== "" ? code : "UNKNOWN";
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function warnUnreadable(warnings: string[], p: string, err: unknown): void {
  pushWarning(
    warnings,
    `${LOCK_BASENAME}: cannot read ${p} (${errorCode(err)}); it is not drift-checked until readable`,
  );
}

export function collectManifestAssetPaths(
  manifest: Manifest,
  opts: BuildLockOptions = {},
  warnings: string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (p: string) => {
    if (isInterpreter(p)) return;
    const expanded = expandHome(p, opts.homeDir);
    if (!path.isAbsolute(expanded)) return;
    if (isInterpreter(expanded)) return;
    let isFile = false;
    try {
      isFile = fs.statSync(expanded).isFile();
    } catch (err) {
      if (!isAbsentError(err)) warnUnreadable(warnings, expanded, err);
      return;
    }
    if (!isFile) return;
    if (seen.has(expanded)) return;
    seen.add(expanded);
    out.push(expanded);
  };

  for (const h of manifest.hooks) {
    const tok = h.command.trim().split(/\s+/)[0];
    if (tok) consider(tok);
  }

  for (const m of manifest.tools.mcp) {
    if (m.enabled === false) continue;
    const args = Array.isArray(m.command) ? m.command : m.command.split(/\s+/);
    for (const a of args) consider(a);
  }

  if (manifest.memory.router && manifest.memory.router.enabled !== false) {
    for (const a of manifest.memory.router.command) consider(a);
  }

  for (const skillName of manifest.tools.skills.enabled) {
    for (const dir of manifest.tools.skills.source_dirs) {
      const candidate = path.join(expandHome(dir, opts.homeDir), skillName, "SKILL.md");
      try {
        if (fs.statSync(candidate).isFile()) {
          consider(candidate);
          break;
        }
      } catch (err) {
        // try next source_dir; a candidate that exists but cannot be
        // examined is reported rather than skipped silently.
        if (!isAbsentError(err)) warnUnreadable(warnings, candidate, err);
      }
    }
  }

  return out;
}

export interface BuildLockResult {
  entries: LockEntry[];
  /** One line per path that could not be read and so is not in `entries`. */
  warnings: string[];
}

export function buildLockEntries(
  manifest: Manifest,
  opts: BuildLockOptions = {},
): LockEntry[] {
  return buildLockEntriesWithWarnings(manifest, opts).entries;
}

export function buildLockEntriesWithWarnings(
  manifest: Manifest,
  opts: BuildLockOptions = {},
): BuildLockResult {
  const entries: LockEntry[] = [];
  const warnings: string[] = [];

  for (const absPath of collectManifestAssetPaths(manifest, opts, warnings)) {
    try {
      entries.push(computeAssetEntry(absPath));
    } catch (err) {
      // Listed by stat but unreadable (a mode-000 file): without this catch
      // the read error would abort the whole apply.
      if (!isAbsentError(err)) warnUnreadable(warnings, absPath, err);
    }
  }

  for (const dir of manifest.memory.directories) {
    let resolved = expandHome(dir.path, opts.homeDir);
    if (resolved.includes("{project}")) {
      // Same guard `resolvePaths` (`src/cli/loader.ts`) and
      // `substituteProject` (`src/probes/memory.ts`) apply at their own
      // `{project}` sinks (task e904f25a): an `opts.projectName` that
      // fails `isValidProjectName` (`..`, a path separator, a control
      // character) is treated exactly like no project name at all. The
      // templated directory's entry is skipped rather than the raw,
      // unvalidated value being interpolated into the path this
      // function stats and locks; `harness.lock` and `harness diff
      // --since-apply`'s drift list never carry it (task b5e6ccb0).
      if (!opts.projectName || !isValidProjectName(opts.projectName)) continue;
      resolved = resolved.split("{project}").join(opts.projectName);
    }
    let isDir = false;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch (err) {
      // a missing dir is skipped silently; any other failure is reported
      if (!isAbsentError(err)) warnUnreadable(warnings, resolved, err);
    }
    if (!isDir) continue;
    try {
      entries.push(computeMemoryDirEntry(resolved));
    } catch (err) {
      const failed = (err as NodeJS.ErrnoException).path;
      const insideDir = typeof failed === "string" && failed !== resolved;
      // The directory itself vanishing is "not there"; a file that vanishes
      // inside it leaves the directory hash unsound, so that one is named.
      if (isAbsentError(err) && !insideDir) continue;
      if (insideDir) {
        pushWarning(
          warnings,
          `${LOCK_BASENAME}: cannot read ${failed} (${errorCode(err)}); memory directory ${resolved} is not drift-checked until readable`,
        );
      } else {
        warnUnreadable(warnings, resolved, err);
      }
    }
  }

  return { entries, warnings };
}
