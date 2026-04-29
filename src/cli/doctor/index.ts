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
import type {
  CliEntryReport,
  DoctorReport,
  HookEntryReport,
  ManifestSection,
  PolicyEntryReport,
  ToolsSection,
} from "./types.js";

export interface DoctorOptions extends LoaderOptions {
  shallow?: boolean;
  mcpProbe?: McpProbe;
  pathEnv?: string;
  versionProbe?: (cmd: string[]) => string | null;
  now?: Date;
  homeOverride?: string;
}

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

function manifestSection(manifest: Manifest): ManifestSection {
  const required = ["version"];
  const present = required.every((k) => k in (manifest as Record<string, unknown>));
  const warnings: string[] = [];
  manifest.hooks.forEach((h, i) => {
    if (h.budget_ms === 30000) {
      warnings.push(`hooks[${i}].budget_ms unset, defaulting to 30000`);
    }
  });
  return {
    syntaxValid: true,
    schemaValid: present,
    topLevelKeysPresent: 5,
    warnings,
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
  }
  for (const c of report.tools.cli) {
    if (c.status === "error") errorCount++;
    else if (c.status === "warn") warningCount++;
  }
  if (report.tools.skillsRequiredMissing.length > 0) errorCount++;
  for (const h of report.hooks) {
    if (h.status === "error") errorCount++;
    else if (h.status === "warn") warningCount++;
  }
  if (report.memory.routerExecutable && !report.memory.routerExecutable.exists) errorCount++;
  for (const d of report.memory.directories) {
    if (!d.exists) warningCount++;
  }
  if (report.memory.staleMemories.length > 0) warningCount++;
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
  };
  const counts = countDiagnostics(partial);
  return { ...partial, ...counts };
}

export { format } from "./format.js";
export type * from "./types.js";
