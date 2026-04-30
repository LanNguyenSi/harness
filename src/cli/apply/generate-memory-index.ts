// Generate `harness.generated/MEMORY.md`: the index that lists every memory
// file the router would surface, derived from `memory.directories[]`. Memory
// markdown files themselves stay user-owned (per ROADMAP non-goals); only
// the index is generated.
//
// Output format mirrors the canonical hand-curated MEMORY.md convention:
//
//   - [Name](filename.md) — description
//
// Empty directories produce a header-only output; missing or unreadable
// frontmatter surfaces in the `warnings[]` array on the result so the
// caller (Phase 3 #4 `harness apply`) can render a doctor-style report
// without aborting.
//
// Frontmatter shape mirrors agent-memory's `MemoryFrontmatter`: `name` and
// `type` are required (matches the canonical loader at
// `agent-memory/packages/memory-router/src/memory/loader.ts`, which rejects
// on `!fm.name || !fm.type`). `description` is recommended (its absence is
// a warning but not a hard skip). `topics` and other fields are not
// surfaced in the index.
//
// `name` and `description` are passed through verbatim into the markdown
// output. The user authors their own frontmatter, so we trust it; no
// escaping is performed for `[`, `]`, `(`, `)`, or backticks. A maliciously
// crafted `name` would produce broken markdown but not security issues
// (the index is read by humans and by tools that already accept arbitrary
// markdown).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Manifest } from "../../schema/index.js";

export interface MemoryIndexEntry {
  name: string;
  description: string;
  basename: string;
  directory: string;
}

export interface GenerateMemoryIndexResult {
  content: string;
  entries: MemoryIndexEntry[];
  warnings: string[];
}

export interface GenerateMemoryIndexOptions {
  homeDir?: string;
  projectName?: string;
}

// Mirror the canonical loader's regex (CRLF-tolerant) so files saved on
// Windows or by editors that normalise to CRLF parse identically here.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function expandHome(p: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function resolveDirPath(
  dirPath: string,
  opts: GenerateMemoryIndexOptions,
): string | null {
  let resolved = expandHome(dirPath, opts.homeDir);
  if (resolved.includes("{project}")) {
    if (!opts.projectName) return null;
    resolved = resolved.split("{project}").join(opts.projectName);
  }
  return resolved;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  // tolerated/ignored:
  topics?: unknown;
  severity?: unknown;
  triggers?: unknown;
  verify?: unknown;
}

function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as ParsedFrontmatter;
}

function readEntry(
  directory: string,
  basename: string,
  warnings: string[],
): MemoryIndexEntry | null {
  const fullPath = path.join(directory, basename);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, "utf8");
  } catch {
    warnings.push(`${fullPath}: unreadable`);
    return null;
  }
  const fm = parseFrontmatter(content);
  if (!fm) {
    warnings.push(`${fullPath}: no frontmatter or malformed YAML`);
    return null;
  }
  if (typeof fm.name !== "string" || fm.name.length === 0) {
    warnings.push(`${fullPath}: frontmatter missing required \`name\` field`);
    return null;
  }
  if (typeof fm.type !== "string" || fm.type.length === 0) {
    // Matches the canonical loader's strict requirement; a memory missing
    // `type` is rejected by the router at runtime and would advertise a
    // memory the index promises but the router won't surface.
    warnings.push(`${fullPath}: frontmatter missing required \`type\` field`);
    return null;
  }

  const description =
    typeof fm.description === "string" ? fm.description : "";
  if (description.length === 0) {
    warnings.push(`${fullPath}: frontmatter missing \`description\` (entry kept, hook empty)`);
  }

  return { name: fm.name, description, basename, directory };
}

function listMarkdownFiles(directory: string, warnings: string[]): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    warnings.push(`${directory}: directory not readable, skipped`);
    return [];
  }
  return dirents
    .filter(
      (d) =>
        d.isFile() &&
        d.name.endsWith(".md") &&
        // Skip the curated MEMORY.md itself: in the canonical layout it has
        // no frontmatter and exists as a hand-written sibling to the entries.
        // Excluding it here avoids a spurious "no frontmatter" warning and
        // self-reference in multi-dir aggregation.
        d.name !== "MEMORY.md",
    )
    .map((d) => d.name)
    .sort();
}

export function generateMemoryIndex(
  manifest: Manifest,
  opts: GenerateMemoryIndexOptions = {},
): GenerateMemoryIndexResult {
  const warnings: string[] = [];
  const entries: MemoryIndexEntry[] = [];

  for (const dir of manifest.memory.directories) {
    const resolved = resolveDirPath(dir.path, opts);
    if (resolved === null) continue; // {project}-placeholder without projectName context
    const files = listMarkdownFiles(resolved, warnings);
    for (const file of files) {
      const entry = readEntry(resolved, file, warnings);
      if (entry !== null) entries.push(entry);
    }
  }

  // Surface basename collisions across directories: the index uses
  // basename as the link target, so two entries with the same basename
  // resolve to the same path and one becomes unclickable. This is a
  // documentation gap, not a hard error — the entries are still kept.
  const basenameCounts = new Map<string, number>();
  for (const e of entries) {
    basenameCounts.set(e.basename, (basenameCounts.get(e.basename) ?? 0) + 1);
  }
  for (const [base, count] of basenameCounts) {
    if (count > 1) {
      warnings.push(
        `basename collision across memory directories: \`${base}\` appears ${count} times — only one link target resolves`,
      );
    }
  }

  entries.sort((a, b) => {
    // Stable sort by (name, basename, directory) so tie-breaking is
    // deterministic across directories holding files with the same name.
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.basename !== b.basename) return a.basename < b.basename ? -1 : 1;
    return a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0;
  });

  const lines: string[] = [];
  for (const e of entries) {
    if (e.description.length > 0) {
      lines.push(`- [${e.name}](${e.basename}) — ${e.description}`);
    } else {
      lines.push(`- [${e.name}](${e.basename})`);
    }
  }
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";

  return { content, entries, warnings };
}
