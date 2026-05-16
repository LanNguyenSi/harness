// Per-profile npm dependency declarations + detection + install for the
// interactive init wizard.
//
// Why this module exists: the wizard's templates reference binaries
// (`memory-router-user-prompt-submit`, `grounding-mcp`, `agent-tasks-
// mcp-bridge`, `understanding-gate-claude-hook`, etc.) that must be on
// PATH for the resulting manifest to pass `harness doctor`. Before this
// module, the wizard wrote a manifest and walked away, leaving the
// operator to discover the missing binaries via doctor errors. Now the
// wizard surfaces the expected packages, detects which are present,
// asks for permission, and runs `npm i -g` for the missing ones.
//
// Failure model: install errors abort the wizard before the manifest is
// written, surfacing the npm output verbatim. The operator fixes their
// npm setup (sudo / nvm / network) and re-runs `harness init`. We
// deliberately do NOT auto-sudo or guess at fallbacks — the user
// approved this trade-off explicitly (2026-05-13).

import { spawn } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import * as path from "node:path";

import type { ProfileChoice } from "./interactive.js";

/**
 * One required binary that must end up on PATH for a given profile's
 * manifest to pass `harness doctor`. `binary` is the executable name we
 * resolve through PATH; `npmPackage` is the package we install if the
 * binary is missing. A single npm package can ship several binaries —
 * we list them all so that a partial install still reads as "complete"
 * for whichever binaries we depend on (e.g. understanding-gate ships
 * three hook adapters; the manifest only wires two of them).
 */
export interface ProfileDependency {
  binary: string;
  npmPackage: string;
  /** Short label rendered in the wizard's dependency table. */
  description: string;
}

export const PROFILE_DEPENDENCIES: Record<Exclude<ProfileChoice, "custom">, ProfileDependency[]> = {
  solo: [
    {
      binary: "memory-router-user-prompt-submit",
      npmPackage: "@lannguyensi/memory-router",
      description: "memory router (UserPromptSubmit hook)",
    },
    {
      binary: "understanding-gate-claude-hook",
      npmPackage: "@lannguyensi/understanding-gate",
      description: "understanding gate (UserPromptSubmit injector)",
    },
    {
      binary: "understanding-gate-claude-stop",
      npmPackage: "@lannguyensi/understanding-gate",
      description: "understanding gate (Stop capture)",
    },
  ],
  team: [
    // Inherits everything from solo; the wizard concats these lists.
    {
      binary: "agent-tasks-mcp-bridge",
      npmPackage: "@agent-tasks/mcp-bridge",
      description: "agent-tasks MCP bridge",
    },
    {
      binary: "grounding-mcp",
      npmPackage: "@lannguyensi/grounding-mcp",
      description: "grounding-mcp MCP server",
    },
  ],
  // Full inherits everything from Solo + Team, and adds:
  // - the SessionStart preflight producer: the `git-preflight` hook
  //   shells out to `agent-preflight` (`preflight` binary) to write
  //   `preflight:${REPO}` to the ledger, which is what the
  //   `preflight-before-*` policies match.
  // - the codebase-oracle MCP server: a RAG index over the operator's
  //   local repos that other agents can query via `oracle_search` /
  //   `oracle_query` instead of grepping. The Full template wires it
  //   in via `command: [codebase-oracle, mcp]`; that bin is shipped by
  //   the scoped npm package `@lannguyensi/codebase-oracle` (the
  //   unscoped `codebase-oracle` on the registry is an unrelated CLI).
  full: [
    {
      binary: "preflight",
      npmPackage: "@lannguyensi/agent-preflight",
      description: "agent-preflight (SessionStart preflight producer)",
    },
    {
      binary: "codebase-oracle",
      npmPackage: "@lannguyensi/codebase-oracle",
      description: "codebase-oracle (RAG MCP server)",
    },
  ],
};

/**
 * Resolve the full dep list for a profile, including transitive
 * profile deps. Solo is the base; team adds on top; full adds on top
 * of team. Each binary is listed at most once even when several
 * manifest entries reference the same npm package.
 */
export function dependenciesForProfile(profile: Exclude<ProfileChoice, "custom">): ProfileDependency[] {
  const chain: ProfileDependency[] = [];
  const seen = new Set<string>();
  const layers: Exclude<ProfileChoice, "custom">[] =
    profile === "solo" ? ["solo"] : profile === "team" ? ["solo", "team"] : ["solo", "team", "full"];
  for (const layer of layers) {
    for (const dep of PROFILE_DEPENDENCIES[layer]) {
      if (seen.has(dep.binary)) continue;
      seen.add(dep.binary);
      chain.push(dep);
    }
  }
  return chain;
}

export interface DependencyStatus {
  dep: ProfileDependency;
  installed: boolean;
  resolvedPath?: string;
}

export interface DependencyCheckResult {
  statuses: DependencyStatus[];
  missingPackages: string[];
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(binary: string, pathEnv: string): string | null {
  if (binary.includes(path.sep)) {
    return existsSync(binary) && isExecutable(binary) ? binary : null;
  }
  for (const seg of pathEnv.split(path.delimiter)) {
    if (!seg) continue;
    const candidate = path.join(seg, binary);
    if (existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface CheckOptions {
  /** Override `process.env.PATH` for tests. */
  pathEnv?: string;
}

/**
 * For a given profile, resolve which dependencies are already on PATH
 * and which npm packages need installing. The returned `missingPackages`
 * list is de-duplicated and ready to splice into a single
 * `npm i -g <pkg1> <pkg2>` call.
 */
export function checkDependencies(
  profile: Exclude<ProfileChoice, "custom">,
  opts: CheckOptions = {},
): DependencyCheckResult {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const statuses: DependencyStatus[] = [];
  const missingPackages = new Set<string>();
  for (const dep of dependenciesForProfile(profile)) {
    const resolved = findOnPath(dep.binary, pathEnv);
    if (resolved) {
      statuses.push({ dep, installed: true, resolvedPath: resolved });
    } else {
      statuses.push({ dep, installed: false });
      missingPackages.add(dep.npmPackage);
    }
  }
  return { statuses, missingPackages: [...missingPackages] };
}

/**
 * Render the dependency table the wizard shows to the operator. Pure
 * function so tests can lock the surface text without spawning a
 * subprocess.
 */
export function formatDependencyTable(profile: ProfileChoice, result: DependencyCheckResult): string {
  const lines: string[] = [];
  lines.push(`Profile "${profile}" depends on these binaries:`);
  for (const status of result.statuses) {
    const mark = status.installed ? "✓" : "✗";
    const where = status.installed
      ? `(already installed)`
      : `→ ${status.dep.npmPackage}`;
    lines.push(`  ${mark} ${status.dep.binary.padEnd(36)} ${where}`);
  }
  if (result.missingPackages.length === 0) {
    lines.push("All required binaries are already on PATH.");
  }
  return lines.join("\n");
}

export interface InstallOptions {
  /** Test-injectable child-process runner. Defaults to a real `npm i -g` spawn. */
  spawn?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
}

export interface InstallResult {
  ok: boolean;
  attempted: string[];
  /** Stderr text from the failed npm process (empty on success). */
  stderr: string;
  /** Exit code from npm (0 on success). */
  exitCode: number;
}

function realSpawn(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      // Mirror npm progress to the operator's terminal — they want to
      // see the install happening.
      process.stderr.write(text);
    });
    child.on("error", (err) => {
      resolve({ code: 1, stderr: `${stderr}\n${(err as Error).message}` });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/**
 * Install a list of npm packages globally. Empty list short-circuits
 * to a successful no-op. Operator-facing output streams through stderr
 * during the run, the structured result is returned to the wizard so
 * it can decide whether to abort.
 */
export async function installPackagesGlobally(
  packages: string[],
  opts: InstallOptions = {},
): Promise<InstallResult> {
  if (packages.length === 0) {
    return { ok: true, attempted: [], stderr: "", exitCode: 0 };
  }
  const run = opts.spawn ?? realSpawn;
  const { code, stderr } = await run("npm", ["i", "-g", ...packages]);
  return {
    ok: code === 0,
    attempted: [...packages],
    stderr,
    exitCode: code,
  };
}
