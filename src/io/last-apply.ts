// `.last-apply` tracker — records what harness wrote on the previous `apply`,
// so the three-state comparator (see `three-state.ts`) can tell drift apart
// from "no changes needed".
//
// Lives at `<generatedDir>/.last-apply`. Format is JSON:
//   { files: { <relPath>: { sha256, content } } }
// Atomic writes via `atomic-write.ts` (Phase 2 #1 contract).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

export interface LastApplyFileEntry {
  sha256: string;
  content: string;
}

// Per-memory-directory snapshot. Stores the directory's Merkle hash plus
// the per-file hashes that produced it, so `harness diff --since-apply
// --memory-detail` (Phase 3 #5) can attribute drift to specific files
// without re-walking the lock. Kept on `.last-apply` and not on
// `harness.lock` to keep the lock small + signal-rich.
export interface MemoryDirSnapshot {
  sha256: string;
  fileHashes: Record<string, string>;
}

export interface LastApplyRecord {
  files: Record<string, LastApplyFileEntry>;
  // Optional snapshot of the effective manifest used at the previous apply.
  // Used by `harness apply` to compute restart hints against the current
  // manifest. Stored as JSON-serialised text so restart-hint comparison can
  // re-parse without YAML-roundtrip noise. Older records (Phase 3 #1
  // baseline) may omit this field; readers MUST tolerate the omission.
  manifest?: LastApplyFileEntry;
  // Optional per-memory-dir per-file snapshot. Phase 3 #5 reads it for
  // `--memory-detail`. Older records may omit; readers MUST tolerate.
  memoryDirs?: Record<string, MemoryDirSnapshot>;
}

export const LAST_APPLY_BASENAME = ".last-apply";

export function lastApplyPath(generatedDir: string): string {
  return path.join(generatedDir, LAST_APPLY_BASENAME);
}

export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildLastApply(files: Record<string, string>): LastApplyRecord {
  const out: LastApplyRecord = { files: {} };
  for (const [relPath, content] of Object.entries(files)) {
    out.files[relPath] = { sha256: sha256Hex(content), content };
  }
  return out;
}

export function writeLastApply(generatedDir: string, record: LastApplyRecord): void {
  const target = lastApplyPath(generatedDir);
  // Stable key order so re-applying produces byte-identical .last-apply when
  // nothing changed (helps `diff --since-apply` and code-review noise).
  const sorted: LastApplyRecord = { files: {} };
  for (const key of Object.keys(record.files).sort()) {
    const entry = record.files[key];
    if (entry !== undefined) sorted.files[key] = entry;
  }
  if (record.manifest !== undefined) sorted.manifest = record.manifest;
  if (record.memoryDirs !== undefined) {
    const sortedDirs: Record<string, MemoryDirSnapshot> = {};
    for (const dirKey of Object.keys(record.memoryDirs).sort()) {
      const snap = record.memoryDirs[dirKey];
      if (snap === undefined) continue;
      const sortedHashes: Record<string, string> = {};
      for (const fileKey of Object.keys(snap.fileHashes).sort()) {
        const h = snap.fileHashes[fileKey];
        if (h !== undefined) sortedHashes[fileKey] = h;
      }
      sortedDirs[dirKey] = { sha256: snap.sha256, fileHashes: sortedHashes };
    }
    sorted.memoryDirs = sortedDirs;
  }
  atomicWriteFile(target, `${JSON.stringify(sorted, null, 2)}\n`);
}

export function readLastApply(generatedDir: string): LastApplyRecord | null {
  const target = lastApplyPath(generatedDir);
  if (!fs.existsSync(target)) return null;
  const raw = fs.readFileSync(target, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isLastApplyRecord(parsed)) {
    throw new Error(`malformed ${LAST_APPLY_BASENAME}: missing or invalid "files" map`);
  }
  return parsed;
}

// Recomputes content sha256 for each file in a record, returning the list of
// relPaths whose stored sha disagrees. An empty list means the record is
// internally consistent. Used by callers that want to defend against on-disk
// corruption of the .last-apply file before treating it as authoritative.
export function verifyLastApplyIntegrity(record: LastApplyRecord): string[] {
  const mismatched: string[] = [];
  for (const [relPath, entry] of Object.entries(record.files)) {
    if (sha256Hex(entry.content) !== entry.sha256) {
      mismatched.push(relPath);
    }
  }
  return mismatched;
}

function isFileEntry(v: unknown): v is LastApplyFileEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as { sha256?: unknown; content?: unknown };
  return typeof e.sha256 === "string" && typeof e.content === "string";
}

function isMemoryDirSnapshot(v: unknown): v is MemoryDirSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as { sha256?: unknown; fileHashes?: unknown };
  if (typeof s.sha256 !== "string") return false;
  if (!s.fileHashes || typeof s.fileHashes !== "object") return false;
  for (const h of Object.values(s.fileHashes as Record<string, unknown>)) {
    if (typeof h !== "string") return false;
  }
  return true;
}

function isLastApplyRecord(x: unknown): x is LastApplyRecord {
  if (!x || typeof x !== "object") return false;
  const obj = x as { files?: unknown; manifest?: unknown; memoryDirs?: unknown };
  if (!obj.files || typeof obj.files !== "object") return false;
  for (const v of Object.values(obj.files as Record<string, unknown>)) {
    if (!isFileEntry(v)) return false;
  }
  // Optional manifest snapshot: tolerate omission; reject malformed shape.
  if (obj.manifest !== undefined && !isFileEntry(obj.manifest)) return false;
  if (obj.memoryDirs !== undefined) {
    if (typeof obj.memoryDirs !== "object" || obj.memoryDirs === null) return false;
    for (const v of Object.values(obj.memoryDirs as Record<string, unknown>)) {
      if (!isMemoryDirSnapshot(v)) return false;
    }
  }
  return true;
}
