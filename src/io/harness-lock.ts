// `harness.lock` writer + reader. See ARCHITECTURE.md §7 (drift handling) and
// §10/lock-file bullet, and ROADMAP "Open decisions resolved here #3".
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
// Stat errors during asset/memory-dir collection are treated as "not present"
// and silently omitted from the lock. This means a permission-denied path
// (EACCES) will not appear in the lock; that is intentional today (most stat
// failures are ENOENT in practice), but a future revision may choose to
// surface EACCES as a diagnostic.
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

export function collectManifestAssetPaths(
  manifest: Manifest,
  opts: BuildLockOptions = {},
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
    } catch {
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
      } catch {
        // try next source_dir
      }
    }
  }

  return out;
}

export function buildLockEntries(
  manifest: Manifest,
  opts: BuildLockOptions = {},
): LockEntry[] {
  const entries: LockEntry[] = [];

  for (const absPath of collectManifestAssetPaths(manifest, opts)) {
    entries.push(computeAssetEntry(absPath));
  }

  for (const dir of manifest.memory.directories) {
    let resolved = expandHome(dir.path, opts.homeDir);
    if (resolved.includes("{project}")) {
      if (!opts.projectName) continue;
      resolved = resolved.split("{project}").join(opts.projectName);
    }
    let isDir = false;
    try {
      isDir = fs.statSync(resolved).isDirectory();
    } catch {
      // skip missing dirs
    }
    if (!isDir) continue;
    entries.push(computeMemoryDirEntry(resolved));
  }

  return entries;
}
