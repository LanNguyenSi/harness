import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectMemory } from "../../probes/memory.js";
import {
  RealMcpProbe,
  probeAll,
  type McpProbe,
  type McpProbeResult,
} from "../../probes/mcp.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import {
  countCodexDiagnostics,
  runCodexTargetChecks,
  type RunCodexCheckOptions,
} from "./codex.js";
import {
  isDoctorTarget,
  KNOWN_DOCTOR_TARGETS,
  type CliEntryReport,
  type DoctorReport,
  type DoctorTarget,
  type HookEntryReport,
  type ManifestSection,
  type PolicyEntryReport,
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

function compareVersions(a: string, b: string): number {
  const aa = a.split(".").map((n) => Number.parseInt(n, 10));
  const bb = b.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const ai = aa[i] ?? 0;
    const bi = bb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
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

function checkHooks(manifest: Manifest, home: string): HookEntryReport[] {
  return manifest.hooks.map((hook) => {
    const blockingLabel = hook.blocking === false ? "false" : hook.blocking;
    const first = hook.command.trim().split(/\s+/)[0] ?? "";
    if (!path.isAbsolute(first) && first !== HOME_PLACEHOLDER && !first.startsWith("~/")) {
      return {
        name: hook.name,
        event: hook.event,
        blocking: blockingLabel,
        status: "ok",
      };
    }
    const resolved = expandHome(first, home);
    if (!fs.existsSync(resolved)) {
      return {
        name: hook.name,
        event: hook.event,
        blocking: blockingLabel,
        status: "error",
        message: `path does not exist: ${resolved}`,
      };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return {
        name: hook.name,
        event: hook.event,
        blocking: blockingLabel,
        status: "error",
        message: `not a regular file: ${resolved}`,
      };
    }
    if (!isExecutable(resolved)) {
      return {
        name: hook.name,
        event: hook.event,
        blocking: blockingLabel,
        status: "error",
        message: `not executable: ${resolved}`,
      };
    }
    return {
      name: hook.name,
      event: hook.event,
      blocking: blockingLabel,
      status: "ok",
    };
  });
}

function buildPolicies(manifest: Manifest): PolicyEntryReport[] {
  return manifest.policies.map((p) => ({
    name: p.name,
    schemaValid: true,
    caveat: "schema valid; last-evaluated tracking ships in Phase 4",
  }));
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
  errorCount += report.tools.skillsRequiredMissing.length;
  for (const h of report.hooks) {
    if (h.status === "error") errorCount++;
    else if (h.status === "warn") warningCount++;
  }
  if (report.memory.routerExecutable && !report.memory.routerExecutable.exists) errorCount++;
  if (!report.memory.routerExecutable) warningCount++;
  for (const d of report.memory.directories) {
    if (!d.exists) warningCount++;
  }
  if (report.memory.staleMemories.length > 0) warningCount++;
  if (report.codexTarget) {
    const codexCounts = countCodexDiagnostics(report.codexTarget);
    errorCount += codexCounts.errorCount;
    warningCount += codexCounts.warningCount;
  }
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
  const skills = checkSkills(manifest, home);
  const tools: ToolsSection = {
    mcp: mcpResults,
    cli,
    skillsEnabled: skills.enabled,
    skillsRequiredMissing: skills.missing,
  };

  const memory = inspectMemory(manifest, {
    homeDir: home,
    project: opts.project,
    now: opts.now,
  });

  const hooks = checkHooks(manifest, home);
  const policies = buildPolicies(manifest);
  const workflows = buildWorkflows(manifest);
  const manifestSec = manifestSection(manifest);

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
    workflows,
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
