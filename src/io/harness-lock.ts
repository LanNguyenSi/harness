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
// sha256 of newline-joined `<basename>:<sha256(content)>` lines, sorted by
// basename. A new memory file or a content change produces exactly one diff
// line per affected directory.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

export type LockEntry = AssetEntry | MemoryDirEntry;

export const LOCK_BASENAME = "harness.lock";

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function expandHome(p: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function computeAssetEntry(absolutePath: string): AssetEntry {
  const buf = fs.readFileSync(absolutePath);
  return { kind: "asset", path: absolutePath, sha256: sha256Hex(buf) };
}

export function computeMemoryDirEntry(absoluteDirPath: string): MemoryDirEntry {
  const files = fs
    .readdirSync(absoluteDirPath)
    .filter((f) => f.endsWith(".md"))
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

export function serializeLock(entries: LockEntry[]): string {
  const sorted = [...entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  if (sorted.length === 0) return "";
  return `${sorted.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export function parseLock(content: string): LockEntry[] {
  const out: LockEntry[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = JSON.parse(line) as unknown;
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
  if (e.kind === "asset") {
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
    if (e.kind === "asset") {
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

export function collectManifestAssetPaths(
  manifest: Manifest,
  opts: BuildLockOptions = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (p: string) => {
    const expanded = expandHome(p, opts.homeDir);
    if (!path.isAbsolute(expanded)) return;
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
    const args = Array.isArray(m.command) ? m.command : m.command.split(/\s+/);
    for (const a of args) consider(a);
  }

  if (manifest.memory.router) {
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
