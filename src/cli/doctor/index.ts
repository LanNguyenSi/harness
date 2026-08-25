import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareNumericVersions } from "../../io/version-compare.js";
import { resolveGeneratedDir } from "../../io/generated-dir.js";
import { inspectMemory } from "../../probes/memory.js";
import {
  RealMcpProbe,
  probeAll,
  type McpProbe,
  type McpProbeResult,
} from "../../probes/mcp.js";
import type { Manifest, McpServer, Policy } from "../../schema/index.js";
import {
  EVIDENCE_LEDGER_DB_ENV,
  GROUNDING_MCP_SERVER_NAME,
} from "../apply/generate-settings.js";
import { parsePackSource } from "../../policy-packs/source.js";
import { resolveBuiltin } from "../../policy-packs/registry.js";
import { expandPolicyPacks } from "../../policy-packs/index.js";
import { checkPolicyPackConfigs } from "../../policy-packs/config-check.js";
import { checkPolicyPackVersions } from "../../policy-packs/version-check.js";
import { checkPolicyPackUxDrift } from "../../policy-packs/ux-drift-check.js";
import { DEFAULT_RUNTIME } from "../../policy-packs/runtime.js";
import {
  checkHookBudgetLedgerMargin,
  checkPolicyRiskWithoutEnvScope,
  checkSolutionAcceptanceKnobIgnored,
  checkSolutionAcceptanceProducer,
  checkTemplatePolicyDrift,
  createDefaultGitIgnoreProbe,
  type GitIgnoreProbe,
} from "../validate/checks.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import {
  countCodexDiagnostics,
  findOnPath,
  runCodexTargetChecks,
  type RunCodexCheckOptions,
} from "./codex.js";
import {
  countOpencodeDiagnostics,
  runOpencodeTargetChecks,
  type RunOpencodeCheckOptions,
} from "./opencode.js";
import { checkNpmBinPath, type NpmExec } from "./npm-bin-path.js";
import { scanForRogueLedgers, type RogueLedgerScanOptions } from "./rogue-ledger.js";
import { buildClaudeMcpRegistration } from "./claude-mcp.js";
import { checkUnderstandingModeEnvDivergence } from "./understanding-mode-env.js";
import {
  runDoctorToolchainParity,
  type RunDoctorToolchainParityOptions,
} from "./toolchain-parity.js";
import type { ClaudeMcpExec } from "../../io/claude-mcp.js";
import {
  isDoctorTarget,
  KNOWN_DOCTOR_TARGETS,
  type CliEntryReport,
  type DoctorReport,
  type DoctorTarget,
  type HookBudgetLedgerMarginSection,
  type HookEntryReport,
  type ManifestSection,
  type McpVersionReport,
  type PolicyEntryReport,
  type PolicyPackHookVersionGapReport,
  type PolicyPackUnresolved,
  type PolicyPacksSection,
  type RiskGateSection,
  type TemplateDriftSection,
  type ToolsSection,
} from "./types.js";

export interface DoctorOptions extends LoaderOptions {
  shallow?: boolean;
  mcpProbe?: McpProbe;
  pathEnv?: string;
  versionProbe?: (cmd: readonly string[]) => string | null;
  now?: Date;
  homeOverride?: string;
  /**
   * Phase 6 #6 follow-up: when set to `codex`, run the harness-side
   * codex adapter health checks in addition to the default suite.
   * Future runtimes plug in here without restructuring the surface.
   * Restricted to targets that have a wired adapter-health module
   * (today: `codex`); see `KNOWN_DOCTOR_TARGETS`.
   */
  target?: DoctorTarget;
  /** Test-injection knobs forwarded to the codex target evaluator. */
  codexCheckOptions?: Partial<RunCodexCheckOptions>;
  /** Test-injection knobs forwarded to the opencode target evaluator. */
  opencodeCheckOptions?: Partial<RunOpencodeCheckOptions>;
  /**
   * Test-injection knobs for the rogue-ledger scan. `homeDir` and `cwd`
   * default to the runtime values resolved inside `doctor`; tests
   * usually override both plus `fsInterface`.
   */
  rogueLedgerScanOptions?: Partial<RogueLedgerScanOptions>;
  /**
   * Test-injection knob for the npm global-bin PATH check (task
   * 4ddd78ed). Tests fake the `npm prefix -g` invocation by passing a
   * stub that returns specific stdout / exit codes; production omits
   * this and the real `npm` is spawned.
   */
  npmBinExec?: NpmExec;
  /**
   * Test-injection knob for the solution-acceptance knob-ignored check
   * (task 24f6ceb9). Defaults to a real `git check-ignore` probe against
   * the process cwd; `shallow` runs degrade it to `() => null` (no spawn),
   * mirroring how the version probe degrades. An explicit probe wins over
   * `shallow` so tests can exercise the check without paying for spawns.
   */
  gitIgnoreProbe?: GitIgnoreProbe;
  /**
   * Test-injection knob for the claude-code MCP registration check (task
   * init-mcp-wiring-claude-code/T-003). Tests fake the `claude mcp list`
   * spawn the same way `npmBinExec`/`gitIgnoreProbe` fake theirs;
   * production omits this and the real `claude` CLI is spawned. The live
   * call itself is additionally gated on `!shallow` and at least one
   * enabled `tools.mcp[]` entry — see `buildClaudeMcpRegistration`.
   */
  claudeMcpExec?: ClaudeMcpExec;
  /**
   * Test-injection knob for env-dependent checks: the dead settings.json
   * `mcpServers` block lookup (honors `CLAUDE_CONFIG_DIR`), and the
   * understanding-gate mode env/config divergence advisory (task
   * 24abdecb, reads `UNDERSTANDING_GATE_MODE`). Defaults to
   * `process.env`; tests inject `{}` (or specific values) to stay
   * hermetic against the operator's real env.
   */
  envOverride?: NodeJS.ProcessEnv;
  /**
   * Test-injection knobs for the toolchain-parity comparison (task
   * 13919613). Mirrors `codexCheckOptions`/`opencodeCheckOptions`: tests
   * inject `runNodeVersion`/`runNpmGlobals`/`readOwKitVersion`/
   * `readMcpServerNames` to fake the reused session-start Collector
   * without a real spawn (see the hermetic-spawn-guard doc on those
   * collectors); production omits this and the real collectors run,
   * gated the same way `--shallow` gates every other live-spawn check.
   */
  toolchainParityOptions?: Partial<RunDoctorToolchainParityOptions>;
}

export { isDoctorTarget, KNOWN_DOCTOR_TARGETS };

const HOME_PLACEHOLDER = "~";

function expandHome(p: string, home: string): string {
  if (p === HOME_PLACEHOLDER) return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH-shadow diagnosis (task 7f8fb4bc): a declared binary that resolves
 * to "not found" might still exist under the resolved npm global bin dir
 * (`npm prefix -g` + `/bin`), just not on the operator's PATH — the
 * nvm-drift footgun the `npmGlobalBin` check (task 4ddd78ed) already
 * detects independently. When that is the case, name the directory and
 * tell the operator to add it, instead of leaving "not found" as the only
 * signal (which reads as "not installed" and sends operators down the
 * wrong remediation path — reinstalling a package that is already there).
 * Returns undefined when `binaryToken` is already an absolute path (PATH
 * is not the resolution mechanism for those) or when no candidate file
 * exists under `npmBinDir`.
 */
function pathShadowHint(binaryToken: string, npmBinDir: string | undefined): string | undefined {
  if (!npmBinDir || !binaryToken || path.isAbsolute(binaryToken)) return undefined;
  const candidate = path.join(npmBinDir, path.basename(binaryToken));
  if (fs.existsSync(candidate) && isExecutable(candidate)) {
    return `found at ${candidate} but that directory is not on PATH — add it: export PATH="${npmBinDir}:$PATH"`;
  }
  return undefined;
}

function checkCli(manifest: Manifest, opts: DoctorOptions, npmBinDir: string | undefined): CliEntryReport[] {
  const out: CliEntryReport[] = [];
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const versionProbe = opts.versionProbe ?? (() => null);
  for (const cli of manifest.tools.cli) {
    const resolved = findOnPath(cli.binary, pathEnv, isExecutable);
    if (!resolved) {
      const hint = pathShadowHint(cli.binary, npmBinDir);
      out.push({
        name: cli.name,
        status: cli.required ? "error" : "warn",
        message: cli.required
          ? `required binary not found: ${cli.binary}`
          : `binary not found on PATH: ${cli.binary}`,
        ...(hint !== undefined ? { pathHint: hint } : {}),
      });
      continue;
    }
    if (!cli.min_version) {
      out.push({ name: cli.name, status: "ok", message: "(no min_version configured)" });
      continue;
    }
    const versionCmd = cli.version_command ?? [resolved, "--version"];
    const stdout = versionProbe(versionCmd);
    if (stdout === null) {
      out.push({
        name: cli.name,
        status: "warn",
        message: `version probe failed for ${versionCmd.join(" ")}`,
      });
      continue;
    }
    const m = stdout.match(/(\d+(?:\.\d+){0,3})/);
    if (!m || !m[1]) {
      out.push({
        name: cli.name,
        status: "warn",
        message: `could not parse a version from "${stdout.trim()}"`,
      });
      continue;
    }
    const actual = m[1];
    const cmp = compareVersions(actual, cli.min_version);
    if (cmp < 0) {
      out.push({
        name: cli.name,
        status: "error",
        message: `installed v${actual} < required ${cli.min_version}`,
      });
    } else {
      out.push({
        name: cli.name,
        status: "ok",
        message: `v${actual} ≥ ${cli.min_version}`,
      });
    }
  }
  return out;
}

/**
 * Resolve the binary token from an MCP server's `command` shape. The
 * schema permits either a single string or a non-empty string[]. For
 * version probing we only need the first token — the rest are args.
 */
function mcpBinary(command: string | string[]): string {
  if (Array.isArray(command)) return command[0] ?? "";
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Mirrors `checkCli` for `tools.mcp[]`. Skipped silently when the entry
 * has no `min_version` (the common case, preserves the v1 manifest
 * contract). Below threshold emits a `warn`, not `error`: a stale MCP
 * still functions; the warning is the drift signal the operator needs
 * to decide whether to `npm i -g <pkg>@latest`.
 */
function checkMcpVersions(manifest: Manifest, opts: DoctorOptions): McpVersionReport[] {
  const out: McpVersionReport[] = [];
  const versionProbe = opts.versionProbe ?? (() => null);
  for (const mcp of manifest.tools.mcp) {
    if (!mcp.min_version) continue;
    if (mcp.enabled === false) continue;
    const binary = mcpBinary(mcp.command);
    if (!binary) {
      out.push({
        name: mcp.name,
        status: "warn",
        message: "command has no resolvable binary token",
      });
      continue;
    }
    const versionCmd = mcp.version_command ?? [binary, "--version"];
    const stdout = versionProbe(versionCmd);
    if (stdout === null) {
      out.push({
        name: mcp.name,
        status: "warn",
        message: `version probe failed for ${versionCmd.join(" ")}`,
      });
      continue;
    }
    const m = stdout.match(/(\d+(?:\.\d+){0,3})/);
    if (!m || !m[1]) {
      out.push({
        name: mcp.name,
        status: "warn",
        message: `could not parse a version from "${stdout.trim()}"`,
      });
      continue;
    }
    const actual = m[1];
    const cmp = compareVersions(actual, mcp.min_version);
    if (cmp < 0) {
      out.push({
        name: mcp.name,
        status: "warn",
        message: `outdated: installed v${actual} < required ${mcp.min_version}`,
      });
    } else {
      out.push({
        name: mcp.name,
        status: "ok",
        message: `v${actual} ≥ ${mcp.min_version}`,
      });
    }
  }
  return out;
}

// `compareVersions` aliases the shared helper to avoid renaming every
// existing call site in this file.
const compareVersions = compareNumericVersions;

/** One unresolved `tools.mcp[]` / `tools.cli[]` binary from `checkBinResolution`. */
export interface BinResolutionIssue {
  kind: "mcp" | "cli";
  name: string;
  binary: string;
  message: string;
  /** PATH-shadow remediation, see `pathShadowHint`. */
  pathHint?: string;
}

export interface BinResolutionReport {
  issues: BinResolutionIssue[];
  errorCount: number;
}

export interface CheckBinResolutionOptions {
  pathEnv?: string;
  npmBinExec?: NpmExec;
}

/**
 * Lightweight, spawn-free bin-resolution check for `tools.mcp[]` /
 * `tools.cli[]` (task 7f8fb4bc). Resolves each declared, enabled MCP
 * binary and each REQUIRED CLI binary against PATH — the same rule
 * `checkCli` and `doctor`'s MCP decoration use — WITHOUT the live
 * health-verb spawn `doctor()` does for MCP servers. `harness init` uses
 * this at the end of a fresh write so an unresolvable binary (including
 * the PATH-shadow case: installed, but under a dir not on PATH) surfaces
 * immediately, without the cost or side effects of actually starting
 * every declared MCP server just to write a manifest.
 *
 * Optional CLI tools are intentionally excluded — mirroring `checkCli`'s
 * warn-not-error treatment, an unresolved optional binary is not the
 * "fresh install fails loudly" case this check exists for.
 */
export async function checkBinResolution(
  manifest: Manifest,
  opts: CheckBinResolutionOptions = {},
): Promise<BinResolutionReport> {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const npmGlobalBin = await checkNpmBinPath({
    ...(opts.npmBinExec !== undefined ? { exec: opts.npmBinExec } : {}),
    pathEnv,
  });
  const npmBinDir = npmGlobalBin.binDir !== "" ? npmGlobalBin.binDir : undefined;

  const issues: BinResolutionIssue[] = [];
  for (const mcp of manifest.tools.mcp) {
    if (mcp.enabled === false) continue;
    const binary = mcpBinary(mcp.command);
    if (!binary || findOnPath(binary, pathEnv, isExecutable)) continue;
    const hint = pathShadowHint(binary, npmBinDir);
    issues.push({
      kind: "mcp",
      name: mcp.name,
      binary,
      message: `binary not found on PATH: ${binary}`,
      ...(hint !== undefined ? { pathHint: hint } : {}),
    });
  }
  for (const cli of manifest.tools.cli) {
    if (!cli.required || findOnPath(cli.binary, pathEnv, isExecutable)) continue;
    const hint = pathShadowHint(cli.binary, npmBinDir);
    issues.push({
      kind: "cli",
      name: cli.name,
      binary: cli.binary,
      message: `required binary not found: ${cli.binary}`,
      ...(hint !== undefined ? { pathHint: hint } : {}),
    });
  }
  return { issues, errorCount: issues.length };
}

/** Render `checkBinResolution`'s issues as human-readable lines for the `init` tail. */
export function formatBinResolutionIssues(report: BinResolutionReport): string[] {
  if (report.issues.length === 0) return [];
  const out = ["", "Unresolved binaries (harness doctor bin-resolution check):"];
  for (const issue of report.issues) {
    out.push(`  ✗ [${issue.kind}] ${issue.name}  ${issue.message}`);
    if (issue.pathHint) out.push(`      ${issue.pathHint}`);
  }
  return out;
}

function checkSkills(manifest: Manifest, home: string): { enabled: string[]; missing: string[] } {
  const enabled = manifest.tools.skills.enabled;
  const required = manifest.tools.skills.required ?? [];
  const missing: string[] = [];
  for (const skill of required) {
    let found = false;
    for (const dir of manifest.tools.skills.source_dirs) {
      const candidate = path.join(expandHome(dir, home), skill, "SKILL.md");
      if (fs.existsSync(candidate)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(skill);
  }
  return { enabled, missing };
}

function checkHookVersion(
  hook: Manifest["hooks"][number],
  versionProbe: (cmd: readonly string[]) => string | null,
): HookEntryReport["version"] | undefined {
  // The schema enforces min_version + version_command both present; this
  // is the safety belt that lets the runtime stay narrowly typed without
  // re-asserting it.
  if (!hook.min_version || !hook.version_command) return undefined;
  const stdout = versionProbe(hook.version_command);
  if (stdout === null) {
    return {
      status: "warn",
      kind: "probe_failed",
      actualVersion: null,
      message: `version probe failed for ${hook.version_command.join(" ")}`,
    };
  }
  const m = stdout.match(/(\d+(?:\.\d+){0,3})/);
  if (!m || !m[1]) {
    return {
      status: "warn",
      kind: "parse_failed",
      actualVersion: null,
      message: `could not parse a version from "${stdout.trim()}"`,
    };
  }
  const actual = m[1];
  const cmp = compareVersions(actual, hook.min_version);
  return cmp < 0
    ? {
        status: "warn",
        kind: "below_floor",
        actualVersion: actual,
        message: `outdated: installed v${actual} < required ${hook.min_version}`,
      }
    : { status: "ok", message: `v${actual} ≥ ${hook.min_version}` };
}

/**
 * Hook-level `min_version` floor on policy-pack-expanded hooks (task
 * ab634898). `checkHooks` above only walks `manifest.hooks[]`, but the
 * hooks Claude Code actually runs also include whatever
 * `expandPolicyPacks` contributes, e.g. understanding-before-execution's
 * UserPromptSubmit/Stop hooks, floored at understanding-gate 0.5.0
 * (see `src/policy-packs/builtin/understanding-before-execution.ts`).
 * Those pack-expanded hooks never reached `checkHookVersion`, so an
 * operator on an older understanding-gate saw a clean doctor report
 * even though the pause wiring (or the Understanding Report's 10th
 * section) was silently degraded below the declared floor.
 *
 * Reuses `checkHookVersion` verbatim so the warning wording matches the
 * manifest-hook case exactly. `versionProbe` is wrapped with a
 * per-command cache so two hooks that share one `version_command` (the
 * common case: user-prompt-submit and stop both probe
 * `understanding-gate --version`) spawn the underlying binary once, not
 * twice. Only below-floor / probe-failed / parse-failed results are
 * returned; a hook at or above its floor produces nothing, mirroring
 * the pack-level floor's "green ones produce nothing" contract
 * (`checkPolicyPackVersions`). Always warn, never error: the pack still
 * runs in degraded mode rather than failing outright.
 *
 * The runtime passed to `expandPolicyPacks` is derived from
 * `opts.target` the same way `--target codex` / `--target opencode`
 * already select their own doctor modules, falling back to
 * `DEFAULT_RUNTIME` ("claude-code") when no target is given. `DoctorTarget`
 * has no "claude-code" member (see its doc comment in `types.ts`), so
 * every value it can hold ("codex" | "opencode") is already a valid
 * `Runtime`.
 */
/**
 * Wraps a version probe with a per-full-argv cache, keyed on
 * `JSON.stringify(cmd)` so two commands sharing only `cmd[0]` (e.g.
 * `["understanding-gate", "--version"]` vs. `["understanding-gate",
 * "--check"]`) are never conflated into the same cache slot; only a
 * byte-identical argv array is deduped. Exported standalone (task
 * ab634898 fix round 1) so this caching contract has its own focused
 * unit test independent of any particular pack's hook shape.
 */
export function memoizeVersionProbe(
  probe: (cmd: readonly string[]) => string | null,
): (cmd: readonly string[]) => string | null {
  const cache = new Map<string, string | null>();
  return (cmd: readonly string[]): string | null => {
    const key = JSON.stringify(cmd);
    if (!cache.has(key)) cache.set(key, probe(cmd));
    return cache.get(key) ?? null;
  };
}

function checkPolicyPackHookVersions(
  manifest: Manifest,
  versionProbe: (cmd: readonly string[]) => string | null,
  target: DoctorTarget | undefined,
): PolicyPackHookVersionGapReport[] {
  const runtime = target ?? DEFAULT_RUNTIME;
  const expansion = expandPolicyPacks(manifest, runtime);
  const dedupedProbe = memoizeVersionProbe(versionProbe);
  const gaps: PolicyPackHookVersionGapReport[] = [];
  for (const hook of expansion.hooks) {
    const version = checkHookVersion(hook, dedupedProbe);
    if (version && version.status === "warn" && hook.min_version && version.kind) {
      gaps.push({
        name: hook.name,
        event: hook.event,
        declaredMinVersion: hook.min_version,
        kind: version.kind,
        actualVersion: version.actualVersion ?? null,
        versionCommand: hook.version_command ?? [],
        message: version.message,
      });
    }
  }
  return gaps;
}

function checkHooks(
  manifest: Manifest,
  home: string,
  opts: Pick<DoctorOptions, "versionProbe">,
): HookEntryReport[] {
  const versionProbe = opts.versionProbe ?? (() => null);
  return manifest.hooks.map((hook) => {
    const blockingLabel = hook.blocking === false ? "false" : hook.blocking;
    const version = checkHookVersion(hook, versionProbe);
    const first = hook.command.trim().split(/\s+/)[0] ?? "";
    const base = (extra: Partial<HookEntryReport>): HookEntryReport => ({
      name: hook.name,
      event: hook.event,
      blocking: blockingLabel,
      ...(version ? { version } : {}),
      ...extra,
    } as HookEntryReport);
    if (!path.isAbsolute(first) && first !== HOME_PLACEHOLDER && !first.startsWith("~/")) {
      return base({ status: "ok" });
    }
    const resolved = expandHome(first, home);
    if (!fs.existsSync(resolved)) {
      return base({ status: "error", message: `path does not exist: ${resolved}` });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return base({ status: "error", message: `not a regular file: ${resolved}` });
    }
    if (!isExecutable(resolved)) {
      return base({ status: "error", message: `not executable: ${resolved}` });
    }
    return base({ status: "ok" });
  });
}

/** The literal prefix of a ledger tag — the part before the first `:`. */
function ledgerTagPrefix(ledgerTag: string): string {
  const colon = ledgerTag.indexOf(":");
  return colon === -1 ? ledgerTag : ledgerTag.slice(0, colon);
}

/**
 * Does any manifest hook plausibly *produce* `prefix`-tagged ledger
 * entries? The policy's own consumer hook (`policy.hook`) is excluded:
 * a gate that reads the tag cannot also be what satisfies it.
 *
 * "Plausibly produces" is a coarse substring match of the tag prefix
 * against the hook command — a producer is typically a SessionStart
 * runner like `agent-preflight` whose command names the domain. The
 * match is prefix-granular by necessity: the command is an opaque
 * shell string, and the full `preflight:${BRANCH}` tag never appears
 * in it literally. So the signal is asymmetric. "No producer found"
 * is reliable. "Producer found" is a heuristic that can give false
 * reassurance: a hook producing `preflight:${REPO}` will mask a
 * `preflight:${BRANCH}` gap, and a once-per-session producer will mask
 * a `within: 10m` window it cannot actually keep fresh. This check is
 * therefore a floor (it catches the total-absence case), not a proof
 * of satisfiability.
 */
function hasProducerHook(manifest: Manifest, policy: Policy, prefix: string): boolean {
  // An empty prefix (a leading-colon tag like `:foo`) would
  // substring-match every hook command. Treat it as "no producer
  // identifiable" so the gap is surfaced rather than silently
  // suppressed by a vacuous match.
  if (prefix === "") return false;
  return manifest.hooks.some(
    (h) => h.name !== policy.hook && h.command.includes(prefix),
  );
}

function buildPolicies(manifest: Manifest): PolicyEntryReport[] {
  return manifest.policies.map((p) => {
    const report: PolicyEntryReport = {
      name: p.name,
      schemaValid: true,
      caveat: "schema valid; last-evaluated tracking ships in Phase 4",
    };
    // Producer-gap check (task ce50df99): a `block` policy whose
    // required tag carries a `within` freshness window cannot stay
    // satisfied by a one-time action — it needs a recurring producer.
    // If no manifest hook produces the tag, the gate silently walls
    // off whatever it triggers on (the founding-incident lockout:
    // `preflight-before-investigation` blocking every `git status`).
    // Policies without `within` only need the tag to exist once, which
    // the normal review / PR workflow supplies, so they are not
    // flagged.
    //
    // Refinement (task f97e152f): a non-empty `producers:` array on
    // the policy itself is the schema's way of declaring the recovery
    // path. For example `dogfood-before-release` deliberately wants
    // the operator to record a manual smoke summary; an automatic
    // SessionStart producer would defeat the gate's purpose. When that
    // documented producer exists the warning would be a false positive
    // and is suppressed. The check still fires when both kinds are
    // absent. The `length === 0` clause is defensive: the schema
    // already enforces `producers: .min(1).optional()`, so a defined
    // array is guaranteed non-empty for any manifest that loaded.
    if (
      p.enforcement === "block" &&
      // operator_only: true (task 2cc73f55) policies declare no
      // requires: at all — there is no ledger_tag/within to go stale, so
      // there is nothing for a producer to keep fresh.
      p.requires !== undefined &&
      p.requires.within !== undefined &&
      (p.producers === undefined || p.producers.length === 0)
    ) {
      const prefix = ledgerTagPrefix(p.requires.ledger_tag);
      if (!hasProducerHook(manifest, p, prefix)) {
        report.producerGap = {
          ledgerTag: p.requires.ledger_tag,
          within: p.requires.within,
        };
      }
    }
    return report;
  });
}

/**
 * Declared-but-not-live policy pack check. `expandPolicyPacks` silently
 * skips a pack whose `source:` token is unrecognised or whose builtin
 * `name:` doesn't resolve in the registry — its hooks never reach
 * `settings.json`, so the operator's gate is inert. Surface each gap
 * as a doctor error so the misconfig is impossible to miss.
 *
 * Skipped (`enabled: false`) packs are NOT checked: they're not
 * expected to be live, and flagging them would flood the report.
 */
/**
 * Sentinel "cannot tell" probe: shallow runs answer every ignoredness
 * question with `null` instead of spawning `git check-ignore`. Exported
 * (with the resolver below) so a test can pin the no-spawn contract by
 * identity instead of mocking `node:child_process`.
 */
export const NULL_GIT_IGNORE_PROBE: GitIgnoreProbe = () => null;

/**
 * Probe resolution order: an explicit (test) probe always wins; `shallow`
 * degrades to the no-spawn sentinel, mirroring how the npm-bin probe and
 * MCP probes degrade; otherwise the real `git check-ignore` probe runs
 * against the process cwd.
 */
export function resolveGitIgnoreProbe(
  opts: Pick<DoctorOptions, "gitIgnoreProbe" | "shallow">,
): GitIgnoreProbe {
  if (opts.gitIgnoreProbe) return opts.gitIgnoreProbe;
  if (opts.shallow) return NULL_GIT_IGNORE_PROBE;
  return createDefaultGitIgnoreProbe();
}

function buildPolicyPacks(
  manifest: Manifest,
  versionProbe: (cmd: readonly string[]) => string | null,
  gitIgnoreProbe: GitIgnoreProbe,
): PolicyPacksSection {
  const unresolved: PolicyPackUnresolved[] = [];
  for (const pack of manifest.policy_packs) {
    if (!pack.enabled) continue;
    const sourceParsed = parsePackSource(pack.source);
    if (sourceParsed.kind === "unknown") {
      unresolved.push({
        name: pack.name,
        reason: "unknown_source",
        source: pack.source,
        detail: `source ${JSON.stringify(pack.source)} is not recognised (only "builtin" resolves in v1)`,
      });
      continue;
    }
    const resolved = resolveBuiltin(pack, DEFAULT_RUNTIME);
    if (!resolved) {
      unresolved.push({
        name: pack.name,
        reason: "unknown_builtin_name",
        source: pack.source,
        detail: `not a known builtin pack name (see docs/policy-packs/ for supported names)`,
      });
    }
  }
  const configIssues = checkPolicyPackConfigs(manifest).map((issue) => ({
    name: issue.packName,
    configPath: issue.configPath,
    message: issue.message,
  }));
  const versionGaps = checkPolicyPackVersions(manifest, versionProbe).map(
    (gap) => ({
      name: gap.packName,
      declaredMinVersion: gap.declaredMinVersion,
      actualVersion: gap.actualVersion,
      message: gap.message,
    }),
  );
  const uxDrift = checkPolicyPackUxDrift(manifest).map((drift) => ({
    name: drift.packName,
    fields: drift.fields,
    message: drift.message,
  }));
  // Same array as the producer check on purpose: countDiagnostics and the
  // renderers already tally / print `solutionAcceptance` by severity, so
  // the knob-ignored warning (task 24f6ceb9) inherits doctor parity with
  // `harness validate` for free — the #308 pattern.
  const solutionAcceptance = [
    ...checkSolutionAcceptanceProducer(manifest),
    ...checkSolutionAcceptanceKnobIgnored(manifest, gitIgnoreProbe),
  ];
  return { unresolved, configIssues, versionGaps, uxDrift, solutionAcceptance };
}

function buildWorkflows(manifest: Manifest): import("./types.js").WorkflowsSectionReport {
  const entries = manifest.workflows.map((wf) => {
    const review = wf.steps.find((s) => s.kind === "review_subagent");
    const merge = wf.steps.find((s) => s.kind === "merge");
    return {
      name: wf.name,
      steps: wf.steps.length,
      reviewSpawn: review?.kind === "review_subagent" ? review.spawn : null,
      reviewTemplate:
        review?.kind === "review_subagent" ? (review.template ?? null) : null,
      mergeGate: merge?.kind === "merge" ? merge.gate : null,
      taskLabels: wf.when.task_label ?? [],
    };
  });
  return {
    declared: manifest.workflows.length,
    templates: Object.keys(manifest.review_templates).length,
    entries,
  };
}

/**
 * Phase 7 #6 — Risk Gate wiring health. Counts the three Risk Gate
 * surfaces and flags the misconfigurations that make the gate inert or
 * silently fail-closed. Pure: manifest in, section out, no I/O.
 */
function buildRiskGate(manifest: Manifest): RiskGateSection {
  const classifiers = manifest.risk.classifiers.length;
  const resolvers = manifest.environments.resolvers.length;
  const whenPolicies = manifest.policies.filter(
    (p) => p.when !== undefined,
  ).length;
  const warnings: string[] = [];
  if (whenPolicies > 0 && classifiers === 0) {
    warnings.push(
      `${whenPolicies} policy(ies) declare \`when:\` but no \`risk.classifiers[]\` are declared; ` +
        `every action classifies as unclassified, so \`risk.*\` clauses match fail-closed ("unknown is not safe")`,
    );
  }
  if (whenPolicies > 0 && resolvers === 0) {
    warnings.push(
      `${whenPolicies} policy(ies) declare \`when:\` but no \`environments.resolvers[]\` are declared; ` +
        `every action resolves to environment \`unknown\``,
    );
  }
  if (whenPolicies === 0 && (classifiers > 0 || resolvers > 0)) {
    warnings.push(
      "risk classifiers / environment resolvers are declared but no policy consumes them via `when:` — the Risk Gate is inert",
    );
  }
  // Risk-clause policies that forgot to scope via `environment.name`.
  // Delegate to the shared validate check so doctor and `harness validate`
  // stay in parity (same logic, same clauses, same thresholds). The check
  // covers risk.severity_at_least, risk.category_in, AND action.reversible:
  // all three clauses fail-closed to matched=true on an unclassified action
  // per `runtime/when-eval.ts`. Map each Diagnostic message into a warning
  // string, mirroring the checkSolutionAcceptanceProducer pattern above.
  for (const diag of checkPolicyRiskWithoutEnvScope(manifest)) {
    warnings.push(diag.message);
  }
  return { classifiers, resolvers, whenPolicies, warnings };
}

/**
 * Template-policy drift (task adf037c1): shipped operator_only security
 * policies missing from an aged installed manifest. Delegates to the
 * shared validate check so `harness doctor` and `harness validate` stay
 * in parity. Each Diagnostic is a missing kill-switch defense and maps to
 * errorCount (see countDiagnostics), the doctor-convention signal that a
 * dogfood/CI run should fail until the manifest is caught up or the name
 * is explicitly acknowledged under doctor.ignore_template_drift.
 */
function buildTemplateDrift(manifest: Manifest): TemplateDriftSection {
  const diags = checkTemplatePolicyDrift(manifest);
  return {
    errors: diags.filter((d) => d.severity === "error").map((d) => d.message),
    warnings: diags.filter((d) => d.severity === "warning").map((d) => d.message),
  };
}

/**
 * Hook-budget-vs-ledger-timeout margin (task d20a7e0c). Delegates to the
 * shared validate check so `harness doctor` and `harness validate` stay
 * in parity, mirroring `buildTemplateDrift` immediately above.
 * `checkHookBudgetLedgerMargin` only ever emits `error`-severity
 * diagnostics (an under-budgeted blocking hook is always a real
 * fail-open gap, never a stylistic warning), so every message maps
 * straight to `errors`.
 */
function buildHookBudgetLedgerMargin(manifest: Manifest): HookBudgetLedgerMarginSection {
  return { errors: checkHookBudgetLedgerMargin(manifest).map((d) => d.message) };
}

/**
 * Grounding wiring health (task 129e1b94). Only meaningful when an enabled
 * `grounding-mcp` entry exists — callers skip the section otherwise. Checks:
 *   1. The evidence-ledger path (the value `harness apply` projects as
 *      `EVIDENCE_LEDGER_DB`) is writable, or creatable under its nearest
 *      existing ancestor — an unwritable path means grounding-mcp cannot
 *      persist evidence and every ledger-backed gate degrades.
 *   2. An operator env override that diverges from
 *      `grounding.evidence_ledger.path` is surfaced: the override wins at
 *      apply time, so a stale override silently defeats the manifest value.
 */
function buildGrounding(
  manifest: Manifest,
  server: McpServer,
  home: string,
): import("./types.js").GroundingSection {
  const declaredPath = manifest.grounding.evidence_ledger.path;
  const declaredExpanded = expandHome(declaredPath, home);
  const warnings: string[] = [];

  // Empty/whitespace "overrides" are treated as absent, matching apply's
  // projection guard: such a value would point the ledger at "" and the
  // projection replaces it with the manifest path anyway.
  const rawOverride = server.env?.[EVIDENCE_LEDGER_DB_ENV];
  const envOverride =
    rawOverride !== undefined && rawOverride.trim().length > 0
      ? rawOverride
      : null;
  const overrideExpanded =
    envOverride !== null ? expandHome(envOverride, home) : null;
  // The override is what apply preserves, so it is the EFFECTIVE path —
  // check writability against it, not against the shadowed manifest value.
  const ledgerPath = overrideExpanded ?? declaredExpanded;
  if (overrideExpanded !== null && overrideExpanded !== declaredExpanded) {
    warnings.push(
      `tools.mcp.grounding-mcp.env.${EVIDENCE_LEDGER_DB_ENV} ("${envOverride}") ` +
        `overrides grounding.evidence_ledger.path ("${declaredPath}"); the env wins at apply, ` +
        `so align the two or drop the env so the manifest value applies`,
    );
  }

  let ledgerPathWritable = true;
  try {
    if (fs.existsSync(ledgerPath)) {
      fs.accessSync(ledgerPath, fs.constants.W_OK);
    } else {
      let dir = path.dirname(ledgerPath);
      while (!fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      fs.accessSync(dir, fs.constants.W_OK);
    }
  } catch {
    ledgerPathWritable = false;
    warnings.push(
      `evidence-ledger path ${ledgerPath} is not writable (and not creatable) — ` +
        `grounding-mcp cannot persist evidence; warn policies degrade non-blocking, ` +
        `block/require_approval policies DENY matching events (deny-degraded) while ` +
        `their evidence is unreadable (risk.degraded_fail_posture: fail_open restores ` +
        `the availability-first behaviour)`,
    );
  }

  return { ledgerPath, ledgerPathWritable, envOverride, warnings };
}

function manifestSection(manifest: Manifest): ManifestSection {
  const topLevelKeys = [
    "grounding",
    "tools",
    "memory",
    "hooks",
    "policies",
    "workflows",
    "review_templates",
  ];
  const present = topLevelKeys.filter(
    (k) => (manifest as Record<string, unknown>)[k] !== undefined,
  ).length;
  // Note: a corrupt manifest never reaches this point; loadManifest exits
  // EX_NOINPUT (66) before doctor() returns. The previous syntaxValid /
  // schemaValid flags were therefore tautologically true and have been
  // dropped. The exit-66-on-load path is the canonical signal.
  return {
    topLevelKeysPresent: present,
    warnings: [],
  };
}

function countDiagnostics(report: Omit<DoctorReport, "errorCount" | "warningCount">): {
  errorCount: number;
  warningCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  warningCount += report.manifest.warnings.length;
  for (const m of report.tools.mcp) {
    if (m.outcome.kind === "error") errorCount++;
    // Clean-exit-without-response: doctor still cannot probe the server,
    // so it counts toward the error tally even though the rendered line
    // does not say "FAILED". Keeps the summary number truthful.
    else if (m.outcome.kind === "no-response") errorCount++;
  }
  for (const c of report.tools.cli) {
    if (c.status === "error") errorCount++;
    else if (c.status === "warn") warningCount++;
  }
  for (const v of report.tools.mcpVersions) {
    if (v.status === "error") errorCount++;
    else if (v.status === "warn") warningCount++;
  }
  errorCount += report.tools.skillsRequiredMissing.length;
  for (const h of report.hooks) {
    if (h.status === "error") errorCount++;
    else if (h.status === "warn") warningCount++;
    if (h.version?.status === "warn") warningCount++;
  }
  for (const p of report.policies) {
    if (p.producerGap) warningCount++;
  }
  errorCount += report.policyPacks.unresolved.length;
  errorCount += report.policyPacks.configIssues.length;
  // Pack-level min_version gaps are warn-not-error: the pack still
  // functions in degraded mode; only features gated on the newer
  // release are lost. Parallel to the hook-level version probe's
  // `status: warn`.
  warningCount += report.policyPacks.versionGaps.length;
  // Hook-level min_version gaps on pack-expanded hooks (task ab634898):
  // always warn-not-error, mirroring both the pack-level floor above
  // and the manifest-declared hook floor in the `report.hooks` loop.
  warningCount += report.policyPackHookVersions.length;
  // Ux/producers drift is always warn: the pack still functions with the
  // stale wording, the operator is just missing a wording improvement.
  // Fix is opt-in (`harness pack reseed <name>`), so this never escalates
  // to an error the way an unresolved pack or a rejected config value does.
  warningCount += report.policyPacks.uxDrift.length;
  for (const d of report.policyPacks.solutionAcceptance) {
    if (d.severity === "error") errorCount++;
    else if (d.severity === "warning") warningCount++;
  }
  warningCount += report.riskGate.warnings.length;
  // Template-policy drift: each missing-or-downgraded shipped operator_only
  // security policy is a real defense gap → errorCount; stale opt-out
  // entries are warn-only (task adf037c1).
  errorCount += report.templateDrift.errors.length;
  warningCount += report.templateDrift.warnings.length;
  // Hook-budget-vs-ledger-timeout margin (task d20a7e0c): every entry is
  // a real fail-open gap, mirroring templateDrift.errors immediately
  // above.
  errorCount += report.hookBudgetLedgerMargin.errors.length;
  if (report.grounding !== undefined) {
    warningCount += report.grounding.warnings.length;
  }
  if (report.claudeMcp !== undefined) {
    for (const e of report.claudeMcp.entries) {
      if (e.status === "error") errorCount++;
      else if (e.status === "warn") warningCount++;
    }
    warningCount += report.claudeMcp.warnings.length;
  }
  if (report.npmGlobalBin?.status === "warn") warningCount++;
  // Toolchain-parity drift (task 13919613): advisory-only, ALWAYS a
  // warning, never an error — a machine running a different Node/OW-Kit/
  // npm-global/MCP-set than a peer is a real drift signal worth flagging,
  // but never a hard failure the way a broken MCP server or a missing
  // required CLI is. `"skipped"` (--shallow) and `"no-peers"` (nothing to
  // compare yet) are informational states and contribute nothing here.
  if (report.toolchainParity) {
    for (const p of report.toolchainParity.peers) {
      if (p.status === "drift") warningCount++;
    }
  }
  // Understanding-gate mode env/config divergence (task 24abdecb):
  // always advisory, never an error — see understanding-mode-env.ts.
  if (report.understandingModeEnv) warningCount++;
  if (report.memory.routerExecutable && !report.memory.routerExecutable.exists) errorCount++;
  if (!report.memory.routerExecutable) warningCount++;
  if (report.memory.routerVersion?.status === "warn") warningCount++;
  for (const d of report.memory.directories) {
    if (!d.exists) warningCount++;
  }
  if (report.memory.staleMemories.length > 0) warningCount++;
  if (report.codexTarget) {
    const codexCounts = countCodexDiagnostics(report.codexTarget);
    errorCount += codexCounts.errorCount;
    warningCount += codexCounts.warningCount;
  }
  if (report.opencodeTarget) {
    const opencodeCounts = countOpencodeDiagnostics(report.opencodeTarget);
    errorCount += opencodeCounts.errorCount;
    warningCount += opencodeCounts.warningCount;
  }
  warningCount += report.rogueLedgerDbs.length;
  return { errorCount, warningCount };
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const { manifest, resolved } = loadManifest(opts);
  const home = opts.homeOverride ?? opts.homeDir ?? os.homedir();
  const probe = opts.mcpProbe ?? new RealMcpProbe();

  // Resolved ahead of the MCP / CLI checks (moved up from its previous
  // spot near the end of this function) so both can use it for the
  // PATH-shadow hint (task 7f8fb4bc). Shallow mode still skips the real
  // `npm prefix -g` spawn.
  const npmGlobalBin = opts.shallow
    ? undefined
    : await checkNpmBinPath({
        ...(opts.npmBinExec !== undefined ? { exec: opts.npmBinExec } : {}),
        ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
      });
  const npmBinDir = npmGlobalBin && npmGlobalBin.binDir !== "" ? npmGlobalBin.binDir : undefined;

  const mcpResults: McpProbeResult[] = opts.shallow
    ? manifest.tools.mcp.map((s) => ({
        name: s.name,
        outcome:
          s.enabled === false
            ? { kind: "disabled" }
            : s.health
              ? { kind: "healthy", latencyMs: 0 }
              : { kind: "missing-verb" },
      }))
    : await probeAll(
        manifest.tools.mcp.filter((s) => s.enabled !== false),
        probe,
      ).then((live) => {
        const map = new Map(live.map((r) => [r.name, r]));
        return manifest.tools.mcp.map(
          (s) =>
            map.get(s.name) ?? {
              name: s.name,
              outcome: { kind: "disabled" } as const,
            },
        );
      });

  // ENOENT-specific MCP failures get the same PATH-shadow diagnosis as
  // CLI tools below: the declared binary may simply be installed
  // somewhere not on PATH rather than genuinely missing.
  for (const r of mcpResults) {
    if (r.outcome.kind === "error" && r.outcome.enoent) {
      const server = manifest.tools.mcp.find((s) => s.name === r.name);
      const binary = server ? mcpBinary(server.command) : "";
      const hint = pathShadowHint(binary, npmBinDir);
      if (hint !== undefined) r.outcome.pathHint = hint;
    }
  }

  const cli = checkCli(manifest, opts, npmBinDir);
  const mcpVersions = checkMcpVersions(manifest, opts);
  const skills = checkSkills(manifest, home);
  const tools: ToolsSection = {
    mcp: mcpResults,
    mcpVersions,
    cli,
    skillsEnabled: skills.enabled,
    skillsRequiredMissing: skills.missing,
  };

  const memory = inspectMemory(manifest, {
    homeDir: home,
    project: opts.project,
    now: opts.now,
    ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    ...(opts.versionProbe !== undefined ? { versionProbe: opts.versionProbe } : {}),
  });

  const hooks = checkHooks(manifest, home, opts);
  const policies = buildPolicies(manifest);
  const policyPacksVersionProbe = opts.versionProbe ?? (() => null);
  const policyPacks = buildPolicyPacks(
    manifest,
    policyPacksVersionProbe,
    resolveGitIgnoreProbe(opts),
  );
  const policyPackHookVersions = checkPolicyPackHookVersions(
    manifest,
    policyPacksVersionProbe,
    opts.target,
  );
  const workflows = buildWorkflows(manifest);
  const riskGate = buildRiskGate(manifest);
  const templateDrift = buildTemplateDrift(manifest);
  const hookBudgetLedgerMargin = buildHookBudgetLedgerMargin(manifest);
  const groundingServer =
    manifest.tools.mcp.find(
      (m) => m.name === GROUNDING_MCP_SERVER_NAME && m.enabled !== false,
    ) ?? null;
  const grounding =
    groundingServer !== null
      ? buildGrounding(manifest, groundingServer, home)
      : undefined;
  // Claude Code MCP registration health (task
  // init-mcp-wiring-claude-code/T-003). Gated purely on tools.mcp[]
  // non-empty (see claude-mcp.ts's module header for why there's no
  // further runtime-scoped gate); the live `claude mcp list` spawn
  // inside buildClaudeMcpRegistration additionally self-gates on
  // `!shallow` and at least one ENABLED entry.
  //
  // generatedDir resolved the same way apply.ts / interactive.ts resolve
  // it (review round H1, Finding 2) so buildClaudeMcpRegistration's
  // desired projection carries SOLUTION_VERDICT_SIGNING_KEY too.
  const generatedDir = resolveGeneratedDir({
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    manifestPath: resolved.base,
    userHome: home,
  });
  const claudeMcp =
    manifest.tools.mcp.length > 0
      ? await buildClaudeMcpRegistration(manifest, {
          home,
          generatedDir,
          shallow: !!opts.shallow,
          ...(opts.claudeMcpExec !== undefined ? { claudeMcpExec: opts.claudeMcpExec } : {}),
          ...(opts.envOverride !== undefined ? { env: opts.envOverride } : {}),
        })
      : undefined;
  const understandingModeEnv = checkUnderstandingModeEnvDivergence(
    manifest,
    opts.envOverride ?? process.env,
  );
  // Toolchain-parity on-demand comparison (task 13919613). Gated purely on
  // `toolchain_parity.enabled` — mirrors `grounding`'s "only when the
  // feature is actually in use" gating, so a manifest that never opted
  // into the SessionStart companion sees no section at all here either.
  const toolchainParity = manifest.toolchain_parity.enabled
    ? await runDoctorToolchainParity(manifest, {
        shallow: !!opts.shallow,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...opts.toolchainParityOptions,
      })
    : undefined;
  const manifestSec = manifestSection(manifest);

  const rogueLedgerDbs = scanForRogueLedgers({
    homeDir: opts.rogueLedgerScanOptions?.homeDir ?? home,
    cwd: opts.rogueLedgerScanOptions?.cwd ?? process.cwd(),
    ...(opts.rogueLedgerScanOptions?.fsInterface !== undefined
      ? { fsInterface: opts.rogueLedgerScanOptions.fsInterface }
      : {}),
  });

  const partial: Omit<DoctorReport, "errorCount" | "warningCount"> = {
    manifestPath: resolved.base,
    manifestVersion: manifest.version,
    project: opts.project ?? null,
    shallow: !!opts.shallow,
    manifest: manifestSec,
    tools,
    memory,
    hooks,
    policies,
    policyPacks,
    policyPackHookVersions,
    workflows,
    riskGate,
    templateDrift,
    hookBudgetLedgerMargin,
    ...(grounding !== undefined ? { grounding } : {}),
    ...(claudeMcp !== undefined ? { claudeMcp } : {}),
    ...(toolchainParity !== undefined ? { toolchainParity } : {}),
    rogueLedgerDbs,
    ...(npmGlobalBin !== undefined ? { npmGlobalBin } : {}),
    ...(understandingModeEnv !== undefined ? { understandingModeEnv } : {}),
  };
  if (opts.target === "codex") {
    const manifestDir = path.dirname(resolved.base);
    const codexOpts: RunCodexCheckOptions = {
      manifestDir,
      ...(opts.codexCheckOptions ?? {}),
    };
    if (codexOpts.pathEnv === undefined && opts.pathEnv !== undefined) {
      codexOpts.pathEnv = opts.pathEnv;
    }
    partial.codexTarget = runCodexTargetChecks(manifest, codexOpts);
  }
  if (opts.target === "opencode") {
    const manifestDir = path.dirname(resolved.base);
    const opencodeOpts: RunOpencodeCheckOptions = {
      manifestDir,
      ...(opts.opencodeCheckOptions ?? {}),
    };
    if (opencodeOpts.pathEnv === undefined && opts.pathEnv !== undefined) {
      opencodeOpts.pathEnv = opts.pathEnv;
    }
    partial.opencodeTarget = runOpencodeTargetChecks(manifest, opencodeOpts);
  }
  const counts = countDiagnostics(partial);
  return { ...partial, ...counts };
}

export { format } from "./format.js";
export type * from "./types.js";
