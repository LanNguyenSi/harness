import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Manifest } from "../schema/index.js";

export interface StaleMemory {
  path: string;
  lastTouched: Date;
  ageDays: number;
}

export interface MemoryReport {
  /**
   * `unresolved: true` marks an entry that still contains a placeholder
   * (e.g. `{project}`) because no project context was provided to the
   * probe. The doctor renders these as informational notes instead of
   * "missing", since the real directory only exists per-project.
   */
  directories: Array<{ path: string; scope: string; exists: boolean; unresolved?: boolean }>;
  routerExecutable: { path: string; exists: boolean } | null;
  staleMemories: StaleMemory[];
}

export interface MemoryOptions {
  homeDir?: string;
  project?: string;
  now?: Date;
  /**
   * Override `process.env.PATH` for the router-executable lookup. Tests
   * use this to assert the bare-name-on-PATH branch without leaking the
   * host's real PATH into the assertion surface.
   */
  pathEnv?: string;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function substituteProject(p: string, project: string | undefined): string {
  if (!project) return p;
  return p.replace(/\{project\}/g, project);
}

function findMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stack: string[] = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  return out;
}

export function inspectMemory(manifest: Manifest, opts: MemoryOptions = {}): MemoryReport {
  const home = opts.homeDir ?? os.homedir();
  const now = opts.now ?? new Date();
  const stalenessDays = manifest.memory.retention.staleness_days;
  const cutoffMs = now.getTime() - stalenessDays * 86400000;

  const directories: MemoryReport["directories"] = manifest.memory.directories.map((d) => {
    const substituted = substituteProject(d.path, opts.project);
    const expanded = expandHome(substituted, home);
    const unresolved = expanded.includes("{project}");
    return {
      path: expanded,
      scope: d.scope,
      // An entry with an unresolved placeholder is a pattern, not a
      // concrete path; existence is not meaningful and the doctor
      // should not flag it as missing.
      exists: unresolved ? true : fs.existsSync(expanded),
      ...(unresolved ? { unresolved: true } : {}),
    };
  });

  let routerExecutable: MemoryReport["routerExecutable"] = null;
  if (manifest.memory.router) {
    const cmd = manifest.memory.router.command;
    // For `[node, /abs/script.js]` shapes the original cmd[0]="node" is
    // useless: the meaningful executable is the script path. Prefer the
    // first absolute / tilde-prefixed argument, then fall back to the
    // first arg that is not an interpreter wrapper. Without this guard
    // the PATH walk below would happily resolve "node" / "npx" / "bun"
    // and report the router as installed even when the actual script is
    // missing.
    const isWrapper = (s: string): boolean =>
      s === "node" || s === "npx" || s === "bun" || s === "deno" || s === "ts-node" || s === "tsx";
    const scriptPath =
      cmd.find((arg) => path.isAbsolute(arg) || arg.startsWith("~/")) ??
      cmd.find((arg) => !isWrapper(arg)) ??
      cmd[0];
    if (scriptPath) {
      // Two shapes are supported in the manifest: an absolute or
      // tilde-prefixed file path (legacy, `node /abs/router.js`) and a
      // bare bin name on PATH (current, `memory-router-user-prompt-submit`).
      // For the bare-name case we replicate the PATH walk that the
      // doctor uses for `tools.cli` entries so a published bin counts
      // as "found".
      if (path.isAbsolute(scriptPath) || scriptPath.startsWith("~/")) {
        const candidate = expandHome(scriptPath, home);
        routerExecutable = { path: candidate, exists: fs.existsSync(candidate) };
      } else {
        const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
        let resolved: string | null = null;
        for (const seg of pathEnv.split(path.delimiter)) {
          if (!seg) continue;
          const candidate = path.join(seg, scriptPath);
          if (fs.existsSync(candidate)) {
            resolved = candidate;
            break;
          }
        }
        routerExecutable = resolved
          ? { path: resolved, exists: true }
          : { path: scriptPath, exists: false };
      }
    }
  }

  const staleMemories: StaleMemory[] = [];
  for (const dir of directories) {
    if (!dir.exists) continue;
    for (const file of findMarkdownFiles(dir.path)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) {
        staleMemories.push({
          path: file,
          lastTouched: stat.mtime,
          ageDays: Math.floor((now.getTime() - stat.mtimeMs) / 86400000),
        });
      }
    }
  }
  staleMemories.sort((a, b) => a.lastTouched.getTime() - b.lastTouched.getTime());

  return { directories, routerExecutable, staleMemories };
}
