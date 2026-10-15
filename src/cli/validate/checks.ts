import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkPolicyPackConfigs, checkPolicyPackSources } from "../../policy-packs/index.js";
import { expandHome } from "../../io/expand-home.js";
import { parseProbedVersion, compareVersionFloor } from "../../io/version-compare.js";
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
  const versionProbe = opts.versionProbe;

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
    // The CLI deliberately supplies no probe: only callers opting into one
    // may execute manifest-named version programs through this check.
    if (!versionProbe) {
      diags.push({
        severity: "warning",
        path: `tools.cli[${cli.name}].min_version`,
        message: "version floor not checked without a version probe; run `harness doctor` to check installed versions",
      });
      return;
    }
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
    // parseProbedVersion + compareVersionFloor (task db44ab46, extending
    // the hooks[] prerelease rule to validate's tools.cli[] check): a
    // release candidate of the required binary (e.g. "1.2.3-rc.1") must
    // not satisfy an equal-numeric min_version floor. See
    // docs/decisions/2026-09-08-preflight-floors.md.
    const parsed = parseProbedVersion(stdout);
    if (!parsed) {
      diags.push({
        severity: "warning",
        path: `tools.cli[${cli.name}].min_version`,
        message: `could not parse a version from "${stdout.trim()}"`,
      });
      return;
    }
    const { version: actual, isPrerelease, token } = parsed;
    if (compareVersionFloor(actual, isPrerelease, cli.min_version) < 0) {
      diags.push({
        severity: "error",
        path: `tools.cli[${cli.name}].min_version`,
        message: `installed version ${token} is less than required ${cli.min_version}`,
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
  if (!manifest.policies.some((policy) => policy.requires !== undefined)) return [];
  const wired = manifest.tools.mcp.some((m) => m.name === "grounding-mcp");
  if (wired) return [];
  // This only applies to policies that consume `requires:` evidence.
  // Tier-aware wording since task f1aea826: this is the LAST surface
  // before an operator ships a manifest whose evidence-consuming
  // block/require_approval policies will hard-deny every matching event
  // (deny-degraded), the inverse of the pre-0.45 silent non-blocking
  // fallback this message used to describe. operator_only policies deny
  // without a ledger query and need no grounding-mcp provider.
  return [
    {
      severity: "warning",
      path: "policies",
      message:
        "evidence-consuming policies declared but grounding-mcp not wired: warn policies degrade non-blocking (warn-degraded), but block/require_approval policies will DENY every matching event (deny-degraded) until the producer is wired — see docs/okf/gate-fail-posture-matrix.md",
    },
  ];
}

// Self-attestation disclosure (task 43b107f2, harness-review-2026-07-01).
// The generic `requires:`/`ledger_tag` engine matches substrings in ledger
// content that the GATED AGENT can write directly via
// `mcp__grounding-mcp__ledger_add` — whoever can write the ledger can open
// the gate. The two builtin packs were hardened to filesystem markers after
// exactly this class of self-approval bug (docs/CLI.md, branch-protection),
// but a custom block-policy is only as strong as its evidence producer.
//
// Heuristic: warn only when a `block` policy declares NO `producers:` at
// all — the evidence source is then undocumented and the operator has made
// no visible trust decision. A declared producer, even an agent-executable
// `mcp`/`bash` one, IS the schema's way of stating the intended evidence
// flow (same philosophy as the doctor producer-gap refinement, task
// f97e152f): the full/team templates deliberately ship mcp-producer
// process-gates whose purpose is forcing a review-subagent step, and
// warning on every one of them would train operators to ignore warnings.
// What an agent-executable producer MEANS for the trust model (advisory
// against the gated agent) is taught by the tripwire in
// docs/writing-custom-policies.md, which the producer docs link to.
export function checkPolicySelfAttestation(manifest: Manifest): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (let i = 0; i < manifest.policies.length; i++) {
    const p = manifest.policies[i];
    // block-only on purpose: a require_approval policy unblocks through an
    // operator approval, an ask-semantics flow that exists independent of
    // producers:, so absence of producers there does not mean the evidence
    // source is undocumented.
    if (p === undefined || p.enforcement !== "block") continue;
    // operator_only: true (task 2cc73f55) is the schema-level unconditional
    // operator-only deny: no requires:, so there is no self-satisfiable
    // evidence source to leave undocumented, and no producers: array could
    // ever name a legitimate one (an unconditional deny is never satisfied
    // from inside the session, by design). Correct-by-construction: skip
    // both this warning and the --strict error it would become.
    if (p.operator_only === true) continue;
    if (p.producers !== undefined && p.producers.length > 0) continue;
    diags.push({
      severity: "warning",
      path: `policies[${i}]`,
      message:
        `policy "${p.name}" blocks on requires.ledger_tag but declares no ` +
        `producers: — the evidence source is undocumented, and the tag is ` +
        `satisfied by ANY ledger writer, including the gated agent itself ` +
        `via mcp__grounding-mcp__ledger_add (advisory against the agent ` +
        `it gates). Declare a producers: entry naming the intended evidence ` +
        `flow — an ask-kind producer for operator-in-the-loop approval ` +
        `(alongside the mcp recovery producer the schema requires), or an ` +
        `agent recipe if the gate is a deliberate process gate. See ` +
        `docs/writing-custom-policies.md ("The trust model").`,
    });
  }
  return diags;
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
// validate Diagnostics so typo'd keys (`protected_brnches`) and bad
// values (`protected_branches: "master"`) fail loud at lint time. Runs
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

// `policies[].trigger.path_match` is declared by the schema but nothing
// reads it (no policy engine remains in harness, and the former one matched
// on `match`, `bash_match` and `input_match` only), so a policy that sets
// it would, if it were evaluated, fire on every call its other trigger
// fields match, wider than its author meant.
// The schema keeps ACCEPTING the key on purpose: every hook loads the
// manifest, and a parse failure there makes the branch-protection hook
// refuse every edit, so rejecting at parse time would lock a machine out
// the moment it carries one. Reporting it as a validate ERROR surfaces it
// at lint time without that risk. Hook-level `hooks[].path_match` is a
// different field (documentation for a filter the referenced script must
// enforce itself) and is not checked here.
export function checkPolicyTriggerPathMatch(manifest: Manifest): Diagnostic[] {
  return manifest.policies.flatMap((p, i): Diagnostic[] =>
    p.trigger.path_match === undefined
      ? []
      : [
          {
            severity: "error",
            path: `policies[${i}].trigger.path_match`,
            message:
              `policy "${p.name}" sets trigger.path_match, which harness does not evaluate: ` +
              `the policy would fire on every call its other trigger fields match. ` +
              `Remove it and narrow the policy with trigger.match, trigger.bash_match ` +
              `or trigger.input_match; a hook-level path_match (hooks[].path_match) is ` +
              `documentation only, so the hook's script must filter on the path itself.`,
          },
        ],
  );
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
    ...checkPolicyPacks(manifest),
    ...checkPolicyPackConfigsAsDiagnostics(manifest),
    ...checkPolicySelfAttestation(manifest),
    ...checkPolicyTriggerPathMatch(manifest),
  ];
}

export const __testables = {
  expandHome,
  isRootedPath,
  firstToken,
  resolveOnPath,
  DEFAULT_RUNTIME_BUILTINS,
};
