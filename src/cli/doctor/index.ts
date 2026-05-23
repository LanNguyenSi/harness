import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareNumericVersions } from "../../io/version-compare.js";
import { inspectMemory } from "../../probes/memory.js";
import {
  RealMcpProbe,
  probeAll,
  type McpProbe,
  type McpProbeResult,
} from "../../probes/mcp.js";
import type { Manifest, Policy } from "../../schema/index.js";
import { parsePackSource } from "../../policy-packs/source.js";
import { resolveBuiltin } from "../../policy-packs/registry.js";
import { DEFAULT_RUNTIME } from "../../policy-packs/runtime.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import {
  countCodexDiagnostics,
  runCodexTargetChecks,
  type RunCodexCheckOptions,
} from "./codex.js";
import { checkNpmBinPath, type NpmExec } from "./npm-bin-path.js";
import { scanForRogueLedgers, type RogueLedgerScanOptions } from "./rogue-ledger.js";
import {
  isDoctorTarget,
  KNOWN_DOCTOR_TARGETS,
  type CliEntryReport,
  type DoctorReport,
  type DoctorTarget,
  type HookEntryReport,
  type ManifestSection,
  type McpVersionReport,
  type PolicyEntryReport,
  type PolicyPackUnresolved,
  type PolicyPacksSection,
  type RiskGateSection,
  type ToolsSection,
} from "./types.js";

export interface DoctorOptions extends LoaderOptions {
  shallow?: boolean;
  mcpProbe?: McpProbe;
  pathEnv?: string;
  versionProbe?: (cmd: string[]) => string | null;
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

function checkCli(manifest: Manifest, opts: DoctorOptions): CliEntryReport[] {
  const out: CliEntryReport[] = [];
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const versionProbe = opts.versionProbe ?? (() => null);
  for (const cli of manifest.tools.cli) {
    let resolved: string | null;
    if (path.isAbsolute(cli.binary)) {
      resolved = fs.existsSync(cli.binary) && isExecutable(cli.binary) ? cli.binary : null;
    } else {
      resolved = null;
      for (const seg of pathEnv.split(path.delimiter)) {
        if (!seg) continue;
        const candidate = path.join(seg, cli.binary);
        if (fs.existsSync(candidate) && isExecutable(candidate)) {
          resolved = candidate;
          break;
        }
      }
    }
    if (!resolved) {
      out.push({
        name: cli.name,
        status: cli.required ? "error" : "warn",
        message: cli.required
          ? `required binary not found: ${cli.binary}`
          : `binary not found on PATH: ${cli.binary}`,
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
  versionProbe: (cmd: string[]) => string | null,
): HookEntryReport["version"] | undefined {
  // The schema enforces min_version + version_command both present; this
  // is the safety belt that lets the runtime stay narrowly typed without
  // re-asserting it.
  if (!hook.min_version || !hook.version_command) return undefined;
  const stdout = versionProbe(hook.version_command);
  if (stdout === null) {
    return {
      status: "warn",
      message: `version probe failed for ${hook.version_command.join(" ")}`,
    };
  }
  const m = stdout.match(/(\d+(?:\.\d+){0,3})/);
  if (!m || !m[1]) {
    return {
      status: "warn",
      message: `could not parse a version from "${stdout.trim()}"`,
    };
  }
  const actual = m[1];
  const cmp = compareVersions(actual, hook.min_version);
  return cmp < 0
    ? { status: "warn", message: `outdated: installed v${actual} < required ${hook.min_version}` }
    : { status: "ok", message: `v${actual} ≥ ${hook.min_version}` };
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
function buildPolicyPacks(manifest: Manifest): PolicyPacksSection {
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
  return { unresolved };
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
  return { classifiers, resolvers, whenPolicies, warnings };
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
  warningCount += report.riskGate.warnings.length;
  if (report.npmGlobalBin?.status === "warn") warningCount++;
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
  warningCount += report.rogueLedgerDbs.length;
  return { errorCount, warningCount };
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const { manifest, resolved } = loadManifest(opts);
  const home = opts.homeOverride ?? opts.homeDir ?? os.homedir();
  const probe = opts.mcpProbe ?? new RealMcpProbe();

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

  const cli = checkCli(manifest, opts);
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
  const policyPacks = buildPolicyPacks(manifest);
  const workflows = buildWorkflows(manifest);
  const riskGate = buildRiskGate(manifest);
  const manifestSec = manifestSection(manifest);

  const rogueLedgerDbs = scanForRogueLedgers({
    homeDir: opts.rogueLedgerScanOptions?.homeDir ?? home,
    cwd: opts.rogueLedgerScanOptions?.cwd ?? process.cwd(),
    ...(opts.rogueLedgerScanOptions?.fsInterface !== undefined
      ? { fsInterface: opts.rogueLedgerScanOptions.fsInterface }
      : {}),
  });

  // Shallow mode skips real spawns: the npm-bin probe shells out to
  // `npm prefix -g` which costs ~30ms and breaks the shallow timing
  // budget. Mirrors how MCP probes degrade above.
  const npmGlobalBin = opts.shallow
    ? undefined
    : await checkNpmBinPath({
        ...(opts.npmBinExec !== undefined ? { exec: opts.npmBinExec } : {}),
        ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
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
    workflows,
    riskGate,
    rogueLedgerDbs,
    ...(npmGlobalBin !== undefined ? { npmGlobalBin } : {}),
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
  const counts = countDiagnostics(partial);
  return { ...partial, ...counts };
}

export { format } from "./format.js";
export type * from "./types.js";
