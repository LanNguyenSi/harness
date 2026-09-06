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
import { assertNoRealSpawnInTests } from "../../runtime/hermetic-spawn-guard.js";

import type { ProfileChoice } from "./interactive.js";
import type { CustomSelection } from "./composer.js";

/**
 * One required binary that must end up on PATH for a given profile's
 * manifest to pass `harness doctor`. `binary` is the executable name we
 * resolve through PATH; `npmPackage` is the package we install if the
 * binary is missing. A single npm package can ship several binaries —
 * we list them all so that a partial install still reads as "complete"
 * for whichever binaries we depend on (e.g. understanding-gate ships
 * three hook adapters; the manifest only wires two of them).
 *
 * `minVersion` is informational only today (rendered in the wizard's
 * dependency table next to the package name) so operators see the
 * floor a feature depends on. The wizard does NOT yet probe the
 * installed bin's version, so a stale install proceeds silently;
 * upgrade hint is on the operator. Adding actual enforcement is a
 * separate task (mirrors the MCP `min_version` doctor probe pattern
 * already wired in FULL_TEMPLATE for MCP entries).
 */
export interface ProfileDependency {
  binary: string;
  npmPackage: string;
  /** Short label rendered in the wizard's dependency table. */
  description: string;
  /** Optional floor, displayed as `pkg@x.y.z+`. Informational only. */
  minVersion?: string;
}

export const PROFILE_DEPENDENCIES: Record<Exclude<ProfileChoice, "custom">, ProfileDependency[]> = {
  solo: [
    {
      binary: "memory-router-user-prompt-submit",
      npmPackage: "@lannguyensi/memory-router",
      description: "memory router (UserPromptSubmit hook)",
      // Mirrors the FULL_TEMPLATE memory.router min_version floor (the
      // `--version` short-circuit harness doctor expects landed in 0.3.0).
      minVersion: "0.3.0",
    },
    {
      binary: "understanding-gate-claude-hook",
      npmPackage: "@lannguyensi/understanding-gate",
      description: "understanding gate (UserPromptSubmit injector)",
      // 0.4.0 added the required "Prior Art" 10th section of the
      // Understanding Report (agent-grounding PR #85, harness task
      // 798d7173). The matching hook-level floor in
      // `understanding-before-execution.ts` is also 0.4.0; pin the
      // wizard's suggested install version to the same floor so a fresh
      // install never trips the floor mid-doctor. Prior history: 0.3.1
      // was the cli-version-fix floor (agent-grounding PRs #80 + #81);
      // 0.3.0 added parser-side fast_confirm support (#78).
      minVersion: "0.4.0",
    },
    {
      binary: "understanding-gate-claude-stop",
      npmPackage: "@lannguyensi/understanding-gate",
      description: "understanding gate (Stop capture)",
      minVersion: "0.4.0",
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
  // Full inherits everything from Solo + Team, and adds the
  // SessionStart preflight producer: the `git-preflight` hook shells
  // out to `agent-preflight` (`preflight` binary) to write
  // `preflight:${REPO}` to the ledger, which is what the
  // `preflight-before-*` policies match.
  //
  // codebase-oracle (`@lannguyensi/codebase-oracle`) is intentionally
  // NOT in the Full chain. It is a useful standalone MCP for multi-repo
  // semantic search, but harness itself does not require it and the
  // setup cost (ORACLE_SCAN_ROOT + an embedding provider key + initial
  // index run) is not worth pushing on every Full-profile operator.
  // See FULL_TEMPLATE comment under `tools.mcp` for the manual wiring
  // recipe (`harness add mcp codebase-oracle --command codebase-oracle,mcp`).
  full: [
    {
      binary: "preflight",
      npmPackage: "@lannguyensi/agent-preflight",
      description: "agent-preflight (SessionStart preflight producer)",
      // Mirrors the FULL_TEMPLATE git-preflight hook's `min_version`
      // floor. 0.2.0 made secret detection git-aware and diff-scoped;
      // pre-0.2.0 installs hard-fail preflight on the normal correct
      // state (a gitignored .env with real credentials), so the
      // SessionStart producer never writes a `preflight:` tag and the
      // preflight-before-* policies stay closed forever.
      minVersion: "0.2.0",
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
  return checkDependencyList(dependenciesForProfile(profile), opts);
}

/**
 * List-based variant of `checkDependencies` for callers that compute a
 * bespoke dep set (e.g. the Custom-profile composer in task 31d2fbb5).
 * Same semantics: resolve each binary on PATH, return statuses +
 * de-duped missing packages.
 */
export function checkDependencyList(
  deps: ProfileDependency[],
  opts: CheckOptions = {},
): DependencyCheckResult {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const statuses: DependencyStatus[] = [];
  const missingPackages = new Set<string>();
  for (const dep of deps) {
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
 * Resolve the dependency list for a Custom-profile selection. Maps each
 * checkbox key to its underlying binary requirement. Used by the
 * interactive wizard's Custom branch so the dependency-check + install
 * UX is identical to the named profiles.
 */
export function dependenciesForCustom(sel: CustomSelection): ProfileDependency[] {
  const chain: ProfileDependency[] = [];
  const seen = new Set<string>();
  const push = (dep: ProfileDependency) => {
    if (seen.has(dep.binary)) return;
    seen.add(dep.binary);
    chain.push(dep);
  };
  // Pack → understanding-gate adapters (mirrors PROFILE_DEPENDENCIES.solo).
  if (sel.packs.includes("understanding-before-execution")) {
    for (const dep of PROFILE_DEPENDENCIES.solo) {
      if (dep.binary.startsWith("understanding-gate-")) push(dep);
    }
  }
  // MCPs → their bridges / bins. codebase-oracle is treated as a
  // first-class dep here even though FULL_TEMPLATE deliberately omits
  // it (the doc-table reasoning is that its setup cost is too high for
  // every Full operator). Custom is opt-in, so an operator who ticks
  // codebase-oracle has accepted that cost; we still install the bin
  // for them. The env-var requirement is surfaced as a composer warning.
  const mcpToBinary: Record<CustomSelection["mcps"][number], string> = {
    "agent-tasks": "agent-tasks-mcp-bridge",
    "grounding-mcp": "grounding-mcp",
    "memory-router": "memory-router-user-prompt-submit",
    "codebase-oracle": "codebase-oracle",
  };
  const extraDeps: ProfileDependency[] = [
    {
      binary: "codebase-oracle",
      npmPackage: "@lannguyensi/codebase-oracle",
      description: "codebase-oracle MCP server",
    },
  ];
  for (const m of sel.mcps) {
    const targetBin = mcpToBinary[m];
    const dep =
      PROFILE_DEPENDENCIES.solo.find((d) => d.binary === targetBin) ??
      PROFILE_DEPENDENCIES.team.find((d) => d.binary === targetBin) ??
      extraDeps.find((d) => d.binary === targetBin);
    if (dep) push(dep);
  }
  // grounding-mcp auto-add mirror: composeCustom auto-wires grounding-mcp
  // into tools.mcp whenever its current evidence-consuming policy selections
  // are chosen without it (see composer.ts). Mirror the exact same predicate here so
  // the dependency-install prompt also covers the binary — without it,
  // policies land in BLOCK mode with a possibly-absent producer binary,
  // causing a fail-closed deadlock the operator was never warned about.
  // The `push` helper's `seen` set prevents a double-add if grounding-mcp
  // was already processed via sel.mcps; the `!sel.mcps.includes` predicate
  // mirrors composeCustom 1:1 so compose and dep-install always agree.
  if (sel.policies.length > 0 && !sel.mcps.includes("grounding-mcp")) {
    const groundingMcpDep = PROFILE_DEPENDENCIES.team.find((d) => d.binary === "grounding-mcp");
    if (groundingMcpDep) push(groundingMcpDep);
  }
  // preflight-* policies need agent-preflight on PATH (the
  // SessionStart hook FULL_TEMPLATE wires; mirrors PROFILE_DEPENDENCIES.full).
  // Even though the Custom surface does not expose the SessionStart hook
  // yet, operators wiring the preflight gates will still want the
  // producer binary installed so a manual `harness session-start preflight`
  // invocation can populate the ledger tag.
  const wantsPreflight = sel.policies.some((p) => p.startsWith("preflight-"));
  if (wantsPreflight) {
    for (const dep of PROFILE_DEPENDENCIES.full) {
      if (dep.binary === "preflight") push(dep);
    }
  }
  return chain;
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
    // minVersion is informational only at this layer (the wizard does
    // not yet probe the installed bin's version); show it next to the
    // package name so operators see the floor a feature depends on.
    const pkgLabel = status.dep.minVersion
      ? `${status.dep.npmPackage}@${status.dep.minVersion}+`
      : status.dep.npmPackage;
    const where = status.installed
      ? `(already installed)`
      : `→ ${pkgLabel}`;
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

/**
 * Hermetic guard (task 54739002): asserts BEFORE touching
 * `child_process` that we are not running under vitest without a test
 * having injected `installSpawn`. This is the `npm i -g` install path —
 * the largest blast radius of the guarded call sites, since an
 * accidental real spawn here would actually install packages globally
 * on whatever machine runs the tests. See
 * src/runtime/hermetic-spawn-guard.ts for why and the env signal used.
 * `installPackagesGlobally` has no try/catch around this call, so the
 * thrown `HermeticSpawnViolationError` propagates directly to the
 * caller — nothing here can degrade it to a warning. Local
 * "no try/catch here" is not the actual guarantee, though: the OW guard
 * (src/cli/init/interactive.ts) proved a local absence-of-catch argument
 * isn't enough on its own — that violation had to survive a catch
 * further up the call chain. The real backstop is runInteractive's outer
 * catch (src/cli/init/interactive.ts:1297), which explicitly re-throws
 * any `HermeticSpawnViolationError` past every intermediate handler
 * between here and the wizard's top level.
 */
function realSpawn(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  assertNoRealSpawnInTests(
    "npm i -g",
    "Inject a fake `installSpawn` runner in the test instead of exercising the real spawn path.",
  );
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
