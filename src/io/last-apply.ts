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

export interface LastApplyRecord {
  files: Record<string, LastApplyFileEntry>;
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

function isLastApplyRecord(x: unknown): x is LastApplyRecord {
  if (!x || typeof x !== "object") return false;
  const files = (x as { files?: unknown }).files;
  if (!files || typeof files !== "object") return false;
  for (const v of Object.values(files as Record<string, unknown>)) {
    if (!v || typeof v !== "object") return false;
    const e = v as { sha256?: unknown; content?: unknown };
    if (typeof e.sha256 !== "string" || typeof e.content !== "string") return false;
  }
  return true;
}
