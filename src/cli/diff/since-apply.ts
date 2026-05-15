// `harness diff --since-apply [--memory-detail]`. Read-only.
//
// Sources:
//   - `<homeDir>/harness.generated/.last-apply` (Phase 3 #1, extended in #4
//     and #5): generated-file content + manifest snapshot + per-memory-dir
//     per-file index.
//   - `<manifestDir>/harness.lock` (Phase 3 #1): asset SHAs + memory-dir
//     Merkle aggregates.
//   - On-disk current state: `harness.generated/<file>` + every locked
//     asset path + memory dirs.
//
// Three sections in the output:
//   `# Generated files`     unified diff per generated file (last-apply ↔ on-disk)
//   `# Asset drift`         per-asset SHA mismatch summary (lock ↔ on-disk)
//   `# Memory directories`  per-dir Merkle drift; --memory-detail expands
//                           to per-file added / removed / modified.
//
// Exit code:
//   0 → no drift across all sections
//   1 → at least one section reported drift (so CI can branch)

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOCK_BASENAME,
  computeMemoryDirEntry,
  readLock,
  type LockEntry,
} from "../../io/harness-lock.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import {
  LAST_APPLY_BASENAME,
  readLastApply,
  type LastApplyRecord,
  type MemoryDirSnapshot,
} from "../../io/last-apply.js";
import { unifiedDiff } from "../../io/patch.js";
import { EX_NOINPUT, HarnessExitError } from "../exit-codes.js";

export interface SinceApplyOptions {
  configPath?: string;
  homeDir?: string;
  memoryDetail?: boolean;
  json?: boolean;
}

export interface FileDriftEntry {
  basename: string;
  diff: string;
}

export interface AssetDriftEntry {
  path: string;
  reason: "missing" | "modified";
  expectedSha: string;
  currentSha?: string;
}

export type MemoryFileChange =
  | { kind: "added"; basename: string; sha256: string }
  | { kind: "removed"; basename: string; previousSha256: string }
  | { kind: "modified"; basename: string; previousSha256: string; sha256: string };

export interface MemoryDirDriftEntry {
  path: string;
  reason: "missing" | "modified";
  /** Populated when --memory-detail is set and the directory is reachable. */
  files?: MemoryFileChange[];
}

export interface SinceApplyResult {
  hasDrift: boolean;
  files: FileDriftEntry[];
  assets: AssetDriftEntry[];
  memories: MemoryDirDriftEntry[];
  /** Diagnostic warnings (non-fatal); surfaced to stderr by the CLI. */
  warnings: string[];
  /** Human-readable formatted report. */
  output: string;
  /** Structured payload (also serialised when --json is set). */
  json: {
    files: FileDriftEntry[];
    assets: AssetDriftEntry[];
    memories: MemoryDirDriftEntry[];
  };
}

function defaultHome(opts: SinceApplyOptions): string {
  return opts.homeDir ?? path.join(os.homedir(), ".claude");
}

function resolveManifestPath(opts: SinceApplyOptions): string {
  if (opts.configPath) return path.resolve(opts.configPath);
  return path.join(defaultHome(opts), "harness.yaml");
}

function sha256OfBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readOnDisk(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function diffGeneratedFiles(
  lastApply: LastApplyRecord,
  generatedDir: string,
): FileDriftEntry[] {
  const out: FileDriftEntry[] = [];
  for (const basename of Object.keys(lastApply.files).sort()) {
    const recorded = lastApply.files[basename];
    if (recorded === undefined) continue;
    const onDisk = readOnDisk(path.join(generatedDir, basename));
    if (onDisk === recorded.content) continue;
    out.push({
      basename,
      diff: unifiedDiff({
        fileName: basename,
        oldText: recorded.content,
        newText: onDisk ?? "",
        oldHeader: "last-apply",
        newHeader: "on-disk",
      }),
    });
  }
  return out;
}

function diffAssets(lockEntries: LockEntry[]): AssetDriftEntry[] {
  const out: AssetDriftEntry[] = [];
  for (const e of lockEntries) {
    if (e.kind !== "asset" && e.kind !== "target") continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(e.path);
    } catch {
      out.push({ path: e.path, reason: "missing", expectedSha: e.sha256 });
      continue;
    }
    const currentSha = sha256OfBuffer(buf);
    if (currentSha !== e.sha256) {
      out.push({
        path: e.path,
        reason: "modified",
        expectedSha: e.sha256,
        currentSha,
      });
    }
  }
  return out;
}

function diffMemoryDirs(
  lockEntries: LockEntry[],
  lastApply: LastApplyRecord | null,
  memoryDetail: boolean,
  warnings: string[],
): MemoryDirDriftEntry[] {
  const out: MemoryDirDriftEntry[] = [];
  for (const e of lockEntries) {
    if (e.kind !== "memory-dir") continue;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(e.path);
    } catch {
      out.push({ path: e.path, reason: "missing" });
      continue;
    }
    if (!stat.isDirectory()) {
      out.push({ path: e.path, reason: "missing" });
      continue;
    }
    let current: ReturnType<typeof computeMemoryDirEntry>;
    try {
      current = computeMemoryDirEntry(e.path);
    } catch {
      // Treat read failure as missing rather than crashing the whole
      // diff. Matches the stat-failure branch above (TOCTOU-safe).
      out.push({ path: e.path, reason: "missing" });
      continue;
    }
    if (current.sha256 === e.sha256) continue;
    const entry: MemoryDirDriftEntry = { path: e.path, reason: "modified" };
    if (memoryDetail) {
      const snapshot = lastApply?.memoryDirs?.[e.path];
      if (snapshot === undefined) {
        // .last-apply was written before Phase 3 #5's schema extension.
        // Without a per-file index, --memory-detail can't say what changed
        // without reporting every file as "added". Skip the per-file
        // expansion and tell the user how to enable it.
        warnings.push(
          `${e.path}: no per-file index recorded (pre-Phase-3-#5 .last-apply); re-run \`harness apply\` to enable --memory-detail`,
        );
      } else {
        entry.files = expandMemoryDetail(e.path, snapshot);
      }
    }
    out.push(entry);
  }
  return out;
}

function expandMemoryDetail(
  dirPath: string,
  snapshot: MemoryDirSnapshot | undefined,
): MemoryFileChange[] {
  const previous = snapshot?.fileHashes ?? {};
  const current: Record<string, string> = {};
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith(".md")) continue;
    current[d.name] = sha256OfBuffer(fs.readFileSync(path.join(dirPath, d.name)));
  }
  const allNames = new Set<string>([...Object.keys(previous), ...Object.keys(current)]);
  const changes: MemoryFileChange[] = [];
  for (const name of [...allNames].sort()) {
    const prevSha = previous[name];
    const curSha = current[name];
    if (prevSha === undefined && curSha !== undefined) {
      changes.push({ kind: "added", basename: name, sha256: curSha });
    } else if (prevSha !== undefined && curSha === undefined) {
      changes.push({ kind: "removed", basename: name, previousSha256: prevSha });
    } else if (prevSha !== undefined && curSha !== undefined && prevSha !== curSha) {
      changes.push({
        kind: "modified",
        basename: name,
        previousSha256: prevSha,
        sha256: curSha,
      });
    }
  }
  return changes;
}

function formatReport(result: {
  files: FileDriftEntry[];
  assets: AssetDriftEntry[];
  memories: MemoryDirDriftEntry[];
}): string {
  const lines: string[] = [];
  lines.push("# Generated files");
  if (result.files.length === 0) {
    lines.push("  no drift");
  } else {
    for (const f of result.files) {
      lines.push(f.diff.trimEnd());
    }
  }
  lines.push("");
  lines.push("# Asset drift");
  if (result.assets.length === 0) {
    lines.push("  no drift");
  } else {
    for (const a of result.assets) {
      if (a.reason === "missing") {
        lines.push(`  missing: ${a.path}`);
      } else {
        lines.push(`  modified: ${a.path}`);
        lines.push(`    expected sha256: ${a.expectedSha}`);
        lines.push(`    current  sha256: ${a.currentSha}`);
      }
    }
  }
  lines.push("");
  lines.push("# Memory directories");
  if (result.memories.length === 0) {
    lines.push("  no drift");
  } else {
    for (const m of result.memories) {
      if (m.reason === "missing") {
        lines.push(`  missing: ${m.path}`);
        continue;
      }
      lines.push(`  modified: ${m.path}`);
      if (m.files && m.files.length > 0) {
        for (const ch of m.files) {
          lines.push(`    ${ch.kind}: ${ch.basename}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function diffSinceApply(opts: SinceApplyOptions = {}): SinceApplyResult {
  const manifestPath = resolveManifestPath(opts);
  const generatedDir = resolveGeneratedDir({ homeDir: opts.homeDir, manifestPath });
  const lockPath = path.join(path.dirname(manifestPath), LOCK_BASENAME);

  const lastApply = readLastApply(generatedDir);
  if (lastApply === null) {
    throw new HarnessExitError(
      `no \`.last-apply\` found at ${path.join(generatedDir, LAST_APPLY_BASENAME)}; run \`harness apply\` first`,
      EX_NOINPUT,
    );
  }

  const lockEntries = readLock(lockPath) ?? [];

  const warnings: string[] = [];
  const files = diffGeneratedFiles(lastApply, generatedDir);
  const assets = diffAssets(lockEntries);
  const memories = diffMemoryDirs(
    lockEntries,
    lastApply,
    opts.memoryDetail ?? false,
    warnings,
  );

  const summary = { files, assets, memories };
  const hasDrift = files.length > 0 || assets.length > 0 || memories.length > 0;
  const output = formatReport(summary);
  return { ...summary, warnings, hasDrift, output, json: summary };
}

// Re-exported so Phase 3 #6 (asset-drift detection inside `apply`) can
// reuse the pure projection without depending on the CLI side.
export { diffAssets };
