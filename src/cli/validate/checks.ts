import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkPolicyPackConfigs,
  checkPolicyPackSources,
} from "../../policy-packs/index.js";
import { expandHome } from "../../runtime/expand-home.js";
import type { Manifest } from "../../schema/index.js";
import type { Diagnostic } from "./types.js";

export interface CheckOptions {
  homeDir?: string;
  pathEnv?: string;
  builtinRuntimeProbe?: () => string[];
  versionProbe?: (cmd: readonly string[]) => string | null;
}

const DEFAULT_RUNTIME_BUILTINS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Agent",
  "Skill",
  "TaskCreate",
  "Glob",
  "Grep",
];

function isRootedPath(p: string): boolean {
  return path.isAbsolute(p) || p === "~" || p.startsWith("~/");
}

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function resolveOnPath(binary: string, pathEnv: string): string | null {
  if (binary.includes(path.sep) || path.isAbsolute(binary)) return null;
  const segments = pathEnv.split(path.delimiter).filter(Boolean);
  for (const seg of segments) {
    const candidate = path.join(seg, binary);
    if (fs.existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

const SEMVER_RE = /(\d+(?:\.\d+){0,3})/;

function compareVersions(actual: string, required: string): number {
  const a = actual.split(".").map((n) => Number.parseInt(n, 10));
  const r = required.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(a.length, r.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const ri = r[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(ri)) return 0;
    if (ai > ri) return 1;
    if (ai < ri) return -1;
  }
  return 0;
}

function checkMcp(manifest: Manifest, home: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  manifest.tools.mcp.forEach((mcp) => {
    const cmdArr = Array.isArray(mcp.command) ? mcp.command : mcp.command.trim().split(/\s+/);
    const first = cmdArr[0] ?? "";
    if (!isRootedPath(first)) return;
    const resolved = expandHome(first, home);
    const stat = statOrNull(resolved);
    if (!stat) {
      diags.push({
        severity: "error",
        path: `tools.mcp[${mcp.name}].command`,
        message: `path does not exist: ${resolved}`,
      });
    }
  });
  return diags;
}

function checkCli(manifest: Manifest, opts: CheckOptions): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const versionProbe = opts.versionProbe ?? (() => null);

  manifest.tools.cli.forEach((cli) => {
    let resolved: string | null;
    if (path.isAbsolute(cli.binary)) {
      resolved = fs.existsSync(cli.binary) && isExecutable(cli.binary) ? cli.binary : null;
    } else {
      resolved = resolveOnPath(cli.binary, pathEnv);
    }
    if (!resolved) {
      diags.push({
        severity: cli.required ? "error" : "warning",
        path: `tools.cli[${cli.name}].binary`,
        message: cli.required
          ? `required binary not found: ${cli.binary}`
          : `binary not found on PATH: ${cli.binary}`,
      });
      return;
    }
    if (!cli.min_version) return;
    const versionCommand = cli.version_command ?? [resolved, "--version"];
    const stdout = versionProbe(versionCommand);
    if (stdout === null) {
      diags.push({
        severity: "warning",
        path: `tools.cli[${cli.name}].min_version`,
        message: `version probe failed for ${versionCommand.join(" ")}`,
      });
      return;
    }
    const match = stdout.match(SEMVER_RE);
    if (!match || !match[1]) {
      diags.push({
        severity: "warning",
        path: `tools.cli[${cli.name}].min_version`,
        message: `could not parse a version from "${stdout.trim()}"`,
      });
      return;
    }
    if (compareVersions(match[1], cli.min_version) < 0) {
      diags.push({
        severity: "error",
        path: `tools.cli[${cli.name}].min_version`,
        message: `installed version ${match[1]} is less than required ${cli.min_version}`,
      });
    }
  });
  return diags;
}

function checkSkills(manifest: Manifest, home: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const required = manifest.tools.skills.required ?? [];
  if (required.length === 0) return diags;
  for (const skillName of required) {
    let found = false;
    for (const dir of manifest.tools.skills.source_dirs) {
      const expanded = expandHome(dir, home);
      const candidate = path.join(expanded, skillName, "SKILL.md");
      if (fs.existsSync(candidate)) {
        found = true;
        break;
      }
    }
    if (!found) {
      diags.push({
        severity: "error",
        path: `tools.skills.required[${skillName}]`,
        message: `SKILL.md not found in any tools.skills.source_dirs entry`,
      });
    }
  }
  return diags;
}

function checkHooks(manifest: Manifest, home: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  manifest.hooks.forEach((hook) => {
    const first = firstToken(hook.command);
    if (!isRootedPath(first)) return;
    const resolved = expandHome(first, home);
    const stat = statOrNull(resolved);
    if (!stat) {
      diags.push({
        severity: "error",
        path: `hooks[${hook.name}].command`,
        message: `path does not exist: ${resolved}`,
      });
      return;
    }
    if (!stat.isFile()) {
      diags.push({
        severity: "error",
        path: `hooks[${hook.name}].command`,
        message: `not a regular file: ${resolved}`,
      });
      return;
    }
    if (!isExecutable(resolved)) {
      diags.push({
        severity: "error",
        path: `hooks[${hook.name}].command`,
        message: `not executable (chmod +x): ${resolved}`,
      });
    }
  });
  return diags;
}

function checkBuiltinDrift(manifest: Manifest, opts: CheckOptions): Diagnostic[] {
  const probe = opts.builtinRuntimeProbe ?? (() => DEFAULT_RUNTIME_BUILTINS);
  const runtime = probe();
  const known = new Set(manifest.tools.builtin.known);
  const diags: Diagnostic[] = [];
  for (const r of runtime) {
    if (!known.has(r)) {
      diags.push({
        severity: "warning",
        path: `tools.builtin.known`,
        message: `runtime advertises built-in "${r}" but the manifest does not list it`,
      });
    }
  }
  return diags;
}

export function checkPolicyGroundingMcp(manifest: Manifest): Diagnostic[] {
  if (manifest.policies.length === 0) return [];
  const wired = manifest.tools.mcp.some((m) => m.name === "grounding-mcp");
  if (wired) return [];
  return [
    {
      severity: "warning",
      path: "policies",
      message:
        "policies declared but grounding-mcp not wired: every policy will fire in degraded warn-mode at runtime; see docs/ARCHITECTURE.md §6",
    },
  ];
}

// solution-acceptance is a pure CONSUMER: it reads the verdict marker the
// grounding-mcp producer writes. Misconfigurations can silently turn the
// completion-gate into a permanent deny (a No-Op that LOOKS protective):
//   1. grounding-mcp absent from tools.mcp -> the producer (solution_evaluate)
//      is unreachable, so no verdict can ever be written -> deadlock.
//   2. grounding-mcp declares a RELATIVE SOLUTION_VERDICT_DIR -> harness now
//      projects the value into the hook command, but a relative path resolves
//      against each process's cwd, which harness cannot reconcile (the
//      producer's cwd is unknown), so producer and consumer can still diverge.
// An ABSOLUTE non-default SOLUTION_VERDICT_DIR previously also denied (harness
// did not project the env override into the hook); `harness apply` now projects
// it (see `buildExpectedFiles` in apply.ts), so the absolute case is handled
// correctly and no longer warn-worthy. Warning-to-error escalation is a tracked
// follow-up (task e3af6388, condition #1 only).
function checkSolutionAcceptanceProducer(manifest: Manifest): Diagnostic[] {
  const pack = manifest.policy_packs.find((p) => p.name === "solution-acceptance");
  if (!pack || !pack.enabled) return [];
  const grounding = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
  if (!grounding) {
    return [
      {
        severity: "warning",
        path: "policy_packs",
        message:
          "solution-acceptance is enabled but grounding-mcp is not wired under tools.mcp: the producer (solution_evaluate) is unreachable, so the completion-gate can never see a verdict and will deadlock on a permanent deny. Add grounding-mcp (>= 0.3.2) to tools.mcp.",
      },
    ];
  }
  // Condition #2: an absolute non-default SOLUTION_VERDICT_DIR is now projected
  // into the hook at apply time, so it is handled and silent. A relative
  // override cannot be reconciled (cwd divergence between producer and hook),
  // so warn only for that unfixable case.
  const env = (grounding.env ?? {}) as Record<string, unknown>;
  const dir = env["SOLUTION_VERDICT_DIR"];
  if (typeof dir === "string" && dir.trim().length > 0 && !path.isAbsolute(dir.trim())) {
    return [
      {
        severity: "warning",
        path: "tools.mcp",
        message:
          "solution-acceptance: grounding-mcp declares a relative SOLUTION_VERDICT_DIR; harness projects this value into the completion-gate hook, but a relative path resolves against each process's working directory, so the producer (grounding-mcp) and the hook can still land on different dirs and the gate would deny. Use an absolute path.",
      },
    ];
  }
  return [];
}

// Phase 6 #2: surface pack-resolution problems at lint time, not at
// `harness apply` time. Delegates to the shared `checkPolicyPackSources`
// so the apply path (which now also fails loudly on these conditions)
// stays bit-identical with validate. `enabled: false` packs are skipped
// on both sides.
function checkPolicyPacks(manifest: Manifest): Diagnostic[] {
  return checkPolicyPackSources(manifest).map((issue) => ({
    severity: "error",
    path: `policy_packs[${issue.packIndex}].${issue.field}`,
    message: issue.message,
  }));
}

// Phase 6 follow-up (task d78fb3c7): per-pack `config:` shape check.
// Each builtin pack registers a zod `configSchema` consumed via
// `checkPolicyPackConfigs`; this turns the strict-mode issues into
// validate Diagnostics so typo'd keys (`permision_profile`) and bad
// enum values (`mode: "fastConfirm"`) fail loud at lint time. Runs
// AFTER the source / name check above; an unknown pack name has no
// registered schema and would be skipped silently here even without
// the source check, but emitting both diagnostics in one run is the
// point — the operator should see every issue per `validate` invocation.
function checkPolicyPackConfigsAsDiagnostics(manifest: Manifest): Diagnostic[] {
  return checkPolicyPackConfigs(manifest).map((issue) => {
    const path =
      issue.configPath.length > 0
        ? `policy_packs[${issue.packIndex}].config.${issue.configPath}`
        : `policy_packs[${issue.packIndex}].config`;
    return {
      severity: "error",
      path,
      message: issue.message,
    };
  });
}

export function runAssetChecks(
  manifest: Manifest,
  opts: CheckOptions = {},
): Diagnostic[] {
  const home = opts.homeDir ?? os.homedir();
  return [
    ...checkMcp(manifest, home),
    ...checkCli(manifest, opts),
    ...checkSkills(manifest, home),
    ...checkHooks(manifest, home),
    ...checkBuiltinDrift(manifest, opts),
    ...checkPolicyGroundingMcp(manifest),
    ...checkSolutionAcceptanceProducer(manifest),
    ...checkPolicyPacks(manifest),
    ...checkPolicyPackConfigsAsDiagnostics(manifest),
  ];
}

export const __testables = {
  expandHome,
  isRootedPath,
  firstToken,
  compareVersions,
  resolveOnPath,
  DEFAULT_RUNTIME_BUILTINS,
};
