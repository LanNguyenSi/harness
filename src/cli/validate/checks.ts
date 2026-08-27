import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkPolicyPackConfigs,
  checkPolicyPackSources,
  KNOWN_RUNTIMES,
  resolveBuiltin,
} from "../../policy-packs/index.js";
import { expandHome } from "../../io/expand-home.js";
import {
  extractBashMatchBoundary,
  shippedBashMatchBoundaries,
  shippedOperatorOnlyPolicyNames,
} from "../init/templates.js";
import { isPolicyInterceptCommand, requiredHookBudgetMs } from "../policy/intercept.js";
import type { Hook, Manifest } from "../../schema/index.js";
import { DEFAULT_SAFE_DELETION_ROOTS } from "../../schema/risk.js";
import {
  deriveWorkflowGatePolicies,
  findWeakGatePolicyOverlaps,
  handAuthoredPolicies,
  MERGE_BASH_MATCH,
  MERGE_MCP_MATCH,
  REVIEW_EVIDENCE_HOOK_BASH,
  REVIEW_EVIDENCE_HOOK_MCP,
  workflowRequiresMergeGate,
} from "../../runtime/workflow-policies.js";
import type { Diagnostic } from "./types.js";

export interface CheckOptions {
  homeDir?: string;
  pathEnv?: string;
  builtinRuntimeProbe?: () => string[];
  versionProbe?: (cmd: readonly string[]) => string | null;
  /**
   * Answers "is this repo-relative path git-ignored in the current working
   * directory's repository?". `null` means "cannot tell" (not a git repo,
   * git unavailable) and skips the dependent check. Injectable for tests;
   * defaults to a real `git check-ignore` probe.
   */
  gitIgnoreProbe?: GitIgnoreProbe;
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
  // Tier-aware wording since task f1aea826: this is the LAST surface
  // before an operator ships a manifest whose block/require_approval
  // policies will hard-deny every matching event (deny-degraded), the
  // inverse of the pre-0.45 silent non-blocking fallback this message
  // used to describe. The wording is pinned by a test so it cannot
  // drift from the runtime contract again (review 2026-08-08, round 2).
  return [
    {
      severity: "warning",
      path: "policies",
      message:
        "policies declared but grounding-mcp not wired: warn policies degrade non-blocking (warn-degraded), but block/require_approval policies will DENY every matching event (deny-degraded) until the producer is wired; risk.degraded_fail_posture: fail_open restores the availability-first behaviour — see docs/okf/gate-fail-posture-matrix.md",
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
// correctly and no longer warn-worthy. Condition #1 (grounding-mcp not wired)
// is an ERROR: solution-acceptance without a reachable producer deadlocks the
// completion-gate on a permanent deny, so it is a hard misconfiguration rather
// than a warning (task e3af6388). Condition #2 (a relative SOLUTION_VERDICT_DIR)
// stays a warning: it only bites on cwd divergence between producer and hook.
export function checkSolutionAcceptanceProducer(manifest: Manifest): Diagnostic[] {
  const pack = manifest.policy_packs.find((p) => p.name === "solution-acceptance");
  if (!pack || !pack.enabled) return [];
  const grounding = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
  if (!grounding) {
    return [
      {
        severity: "error",
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

// checkWorkflowGateWiring closes the exact gap deriveWorkflowGatePolicies
// (src/runtime/workflow-policies.ts) leaves deliberately open: a
// `workflows:` entry that declares a `review_subagent` step with
// `spawn: "required"` followed by a `merge` step LOOKS like an
// enforced gate, but `deriveWorkflowGatePolicies` only derives the
// runtime policy pair when BOTH `require-review-evidence` and
// `require-review-evidence-bash` are declared in `manifest.hooks[]`.
// Without them the derivation quietly returns `[]` (no policy, so no
// hook-reference error either, since there is nothing referencing a
// hook to validate against) and the merge is never actually blocked, a
// No-Op that LOOKS protective. This check makes that specific
// misconfiguration a loud `error` instead of a silent non-enforcement.
//
// F5 (review round 2): a hook declared under the RIGHT name but wired to
// the WRONG surface (a stale `match`/`bash_match` that no longer covers
// the merge tool call, or a `command` that isn't the policy-intercept
// engine — `isPolicyInterceptCommand`) is just as unenforced as a
// missing hook, but the earlier name-only check reported it as fine.
// `isMergeGateHookProperlyWired` below checks the actual trigger surface
// + command, not just presence of the name.
function isMergeGateHookProperlyWired(hook: Hook, surface: "mcp" | "bash"): boolean {
  if (hook.event !== "PreToolUse") return false;
  if (!isPolicyInterceptCommand(hook.command)) return false;
  if (surface === "mcp") return hook.match === MERGE_MCP_MATCH;
  return hook.match === "Bash" && hook.bash_match === MERGE_BASH_MATCH;
}

export function checkWorkflowGateWiring(manifest: Manifest): Diagnostic[] {
  const offending = manifest.workflows.filter((wf) => workflowRequiresMergeGate(wf));
  if (offending.length === 0) return [];

  const mcpHook = manifest.hooks.find((h) => h.name === REVIEW_EVIDENCE_HOOK_MCP);
  const bashHook = manifest.hooks.find((h) => h.name === REVIEW_EVIDENCE_HOOK_BASH);

  const problems: string[] = [];
  const missing: string[] = [];
  if (!mcpHook) {
    missing.push(REVIEW_EVIDENCE_HOOK_MCP);
  } else if (!isMergeGateHookProperlyWired(mcpHook, "mcp")) {
    problems.push(
      `hook "${REVIEW_EVIDENCE_HOOK_MCP}" is declared but not wired to intercept the merge ` +
        `gate surface (expects event: PreToolUse, match: "${MERGE_MCP_MATCH}", command running ` +
        "`harness policy intercept`)",
    );
  }
  if (!bashHook) {
    missing.push(REVIEW_EVIDENCE_HOOK_BASH);
  } else if (!isMergeGateHookProperlyWired(bashHook, "bash")) {
    problems.push(
      `hook "${REVIEW_EVIDENCE_HOOK_BASH}" is declared but not wired to intercept the merge ` +
        `gate surface (expects event: PreToolUse, match: "Bash", bash_match: "${MERGE_BASH_MATCH}", ` +
        "command running `harness policy intercept`)",
    );
  }
  if (missing.length > 0) {
    problems.unshift(`hooks[] is missing ${missing.join(" and ")}`);
  }
  if (problems.length === 0) return [];

  return offending.map((wf) => ({
    severity: "error" as const,
    path: "workflows",
    message:
      `workflow "${wf.name}" declares a review_subagent step with spawn: "required" ` +
      `followed by a merge step, but the runtime merge gate is not wired: ${problems.join("; ")}. ` +
      "Without both hooks correctly wired, harness policy intercept never derives this " +
      "workflow's merge-gate policy and the merge is NOT blocked (silent non-enforcement). " +
      "See docs/for-agents.md, or src/cli/init/templates.ts's require-review-evidence / " +
      'require-review-evidence-bash entries, or drop spawn: "required".',
  }));
}

/**
 * F1 (review round 2): a hand-authored policy on the identical trigger
 * surface + ledger_tag as a derived block gate, but weaker than it
 * (`enforcement: "warn"`/`"require_approval"`, or `when:`-scoped), no
 * longer suppresses the derived gate (see `isAtLeastAsStrongAsDerivedGate`
 * in workflow-policies.ts) — both apply. This check surfaces that overlap
 * as a warning so an operator reading the weaker policy does not mistake
 * it for the ONLY gate on the surface.
 */
export function checkWorkflowGateWeakOverlap(manifest: Manifest): Diagnostic[] {
  return findWeakGatePolicyOverlaps(manifest).map((overlap) => ({
    severity: "warning" as const,
    path: "workflows",
    message:
      `workflow "${overlap.workflowName}" derives a block gate on ${overlap.surface}; ` +
      `hand-authored policy "${overlap.handPolicyName}" on the same surface is weaker ` +
      `(${overlap.reason}). Both policies apply: the derived block gate ` +
      `("${overlap.derivedPolicyName}") still enforces review evidence independently, so this ` +
      "is informational, not a gap — but double-check the weaker policy is intentional.",
  }));
}

/**
 * F6 (review round 2): a workflow that declares BOTH a `merge` step and a
 * `review_subagent` step with `spawn: "required"`, but with the review
 * step coming AFTER the merge step, derives no gate at all
 * (`workflowRequiresMergeGate` only looks for review-then-merge). That
 * ordering is likely a mistake (a review that runs after the PR already
 * merged cannot gate it), but step-ordering validation in general is out
 * of scope for this slice (module doc, src/runtime/workflow-policies.ts).
 * This warns instead of silently doing nothing.
 */
export function checkWorkflowMergeBeforeReview(manifest: Manifest): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const wf of manifest.workflows) {
    if (workflowRequiresMergeGate(wf)) continue;
    let sawMerge = false;
    let requiredReviewAfterMerge = false;
    for (const step of wf.steps) {
      if (step.kind === "merge") {
        sawMerge = true;
      } else if (step.kind === "review_subagent" && step.spawn === "required" && sawMerge) {
        requiredReviewAfterMerge = true;
      }
    }
    if (requiredReviewAfterMerge) {
      out.push({
        severity: "warning",
        path: "workflows",
        message:
          `workflow "${wf.name}" declares a required review step after its merge step; no ` +
          "merge gate is derived (step ordering validation is a later slice).",
      });
    }
  }
  return out;
}

/**
 * Review round 3 (99f47307 Slice 1): a hand-authored policy whose name
 * equals a derived policy's name (`workflow:<name>:review-before-merge[-
 * bash]`) but sits on a DIFFERENT surface is not deduped (dedupe keys on
 * surface, not name), so the derived view carries two policies with one
 * name. The runtime evaluates both (fail-safe), but every by-name reader
 * (`explain`, `explain-policy`, `audit`, `diff`'s name-keyed policy list)
 * resolves the name to the hand-authored one and silently hides the
 * derived gate. The schema's duplicate-name refinement cannot see this
 * (it runs on the hand-authored view), so it is an error here.
 */
export function checkWorkflowDerivedNameCollision(manifest: Manifest): Diagnostic[] {
  const handNames = new Set(handAuthoredPolicies(manifest).map((p) => p.name));
  return deriveWorkflowGatePolicies(manifest)
    .filter((derived) => handNames.has(derived.name))
    .map((derived) => ({
      severity: "error" as const,
      path: "policies",
      message:
        `hand-authored policy "${derived.name}" collides with the policy of the same name ` +
        "derived from workflows[] (it does not intercept the same surface, so it does not " +
        "replace the derived gate); both are enforced, but explain/explain-policy/audit/diff " +
        "resolve the name to the hand-authored one. Rename the hand-authored policy.",
    }));
}

/**
 * Every `workflows[]` check in one list, so `harness validate`
 * (`runAssetChecks`) and `harness doctor`'s Workflows section run the
 * SAME set (review round 3, 99f47307 Slice 1: doctor previously picked
 * two of the three by hand and was missing `checkWorkflowMergeBeforeReview`).
 */
export function checkWorkflows(manifest: Manifest): Diagnostic[] {
  return [
    ...checkWorkflowGateWiring(manifest),
    ...checkWorkflowGateWeakOverlap(manifest),
    ...checkWorkflowMergeBeforeReview(manifest),
    ...checkWorkflowDerivedNameCollision(manifest),
  ];
}

/**
 * Answers "is `relPath` git-ignored here?": `true` / `false`, or `null`
 * when the question has no answer (not a git repository, git not
 * installed). See `createDefaultGitIgnoreProbe` for the real
 * implementation; checks receive the probe so tests stay hermetic.
 */
export type GitIgnoreProbe = (relPath: string) => boolean | null;

/**
 * The orchestrator-workflow knob the grounding-mcp producer reads
 * (`resolveOwKnob`). Repo-relative on purpose: the knob belongs to the
 * repository whose completions the OW arm gates.
 */
export const OW_KNOB_REL_PATH = ".ai/solution-acceptance.json";

export function createDefaultGitIgnoreProbe(cwd?: string): GitIgnoreProbe {
  return (relPath) => {
    const res = spawnSync("git", ["check-ignore", "-q", "--", relPath], {
      cwd: cwd ?? process.cwd(),
      stdio: "ignore",
    });
    if (res.error) return null;
    if (res.status === 0) return true;
    if (res.status === 1) return false;
    return null; // 128: not a git repository (or another fatal git error)
  };
}

// Knob-reachability lint (task 24f6ceb9, ow-review-2026-07-01). The OW arm
// of solution-acceptance reads repo state: the knob above plus run
// completeness under `.ai/runs/`. When the knob path is git-ignored the
// repo CANNOT commit its enforcement posture, so in a fresh clone or a git
// worktree `.ai/runs/` is absent, the default `auto` knob silently skips
// the OW arm, and the gate that exists to prevent process skipping is
// itself skipped exactly where process skipping happens. Warn (not error):
// the preflight floor still gates every completion; only the OW arm is
// affected. A `null` probe answer (non-repo cwd, git missing) skips the
// check — validate must stay usable for pure home-config linting.
export function checkSolutionAcceptanceKnobIgnored(
  manifest: Manifest,
  probe: GitIgnoreProbe,
): Diagnostic[] {
  const pack = manifest.policy_packs.find((p) => p.name === "solution-acceptance");
  if (!pack || !pack.enabled) return [];
  if (probe(OW_KNOB_REL_PATH) !== true) return [];
  return [
    {
      severity: "warning",
      path: "policy_packs",
      message:
        `solution-acceptance: the orchestrator-workflow knob ${OW_KNOB_REL_PATH} ` +
        `is git-ignored in this repository, so the OW enforcement posture cannot ` +
        `be committed. In a fresh clone or git worktree .ai/runs/ is absent and ` +
        `the default "auto" knob silently skips the OW arm — exactly where ` +
        `process skipping happens. Narrow the ignore to .ai/runs/ (run state ` +
        `stays local) and commit ${OW_KNOB_REL_PATH}; see ` +
        `docs/policy-packs/solution-acceptance.md ("Repo state and gitignore").`,
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
    // block-only on purpose: a require_approval policy's canonical unblock
    // path is the operator verb (`harness approve risk`), an ask-semantics
    // flow that exists independent of producers:, so absence of producers
    // there does not mean the evidence source is undocumented.
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

// M7 validate lint: a policy that gates on risk.* / action.reversible clauses
// WITHOUT an environment.name clause fires on EVERY unclassified command in
// EVERY environment because those three clauses fail-closed to matched=true
// when the action is unclassified ("unknown is not safe"). This is almost
// never what the operator intends: an unscoped risk policy becomes a blanket
// gate on any command the classifier does not recognise. See docs/risk-gate.md.
export function checkPolicyRiskWithoutEnvScope(manifest: Manifest): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (let i = 0; i < manifest.policies.length; i++) {
    const p = manifest.policies[i];
    if (!p?.when) continue;
    const when = p.when;
    // The three clauses that fail-closed to matched=true for an unclassified
    // action. An environment.name clause constrains the scope, so we only
    // warn when it is absent.
    const hasUnclassifiedFallbackClause =
      when["risk.severity_at_least"] !== undefined ||
      when["risk.category_in"] !== undefined ||
      when["action.reversible"] !== undefined;
    const hasEnvNameScope = when["environment.name"] !== undefined;
    if (hasUnclassifiedFallbackClause && !hasEnvNameScope) {
      diags.push({
        severity: "warning",
        path: `policies[${i}]`,
        message:
          `policy "${p.name}" declares a when: block with ` +
          `risk.severity_at_least / risk.category_in / action.reversible ` +
          `but no environment.name scope: those clauses fail-closed to ` +
          `matched=true for any unclassified command, so this policy fires ` +
          `on every unclassified action in every environment. ` +
          `Add an environment.name clause to scope the policy to a specific ` +
          `environment. See docs/risk-gate.md.`,
      });
    }
  }
  return diags;
}

// Safe-deletion-root syntax lint (task d03af8f6, review round 2, LOW (a)).
// `resolveDeletionTarget` (`src/runtime/deletion-target-resolve.ts`) only
// ever treats an ABSOLUTE, plain-literal `risk.safe_deletion_roots` entry
// as an allowlist member — a relative entry can never match any target
// (every target the resolver considers absolute-checks against is itself
// required to be absolute first, so a relative root is silently
// dead weight), and an entry containing `$` or `~` reads as a LITERAL
// dollar-sign/tilde character (this resolver never expands either), not
// the shell construct an operator likely intended when writing it. Both
// shapes are a config mistake the operator would otherwise discover only
// by noticing a deletion that should have been allowed still got gated.
// Warning-severity (not an error): unlike the bare-`/` case in
// `RiskSchema`'s own `superRefine` (which defeats the allowlist in the
// DANGEROUS direction — matching too much), a malformed entry here only
// fails to widen the allowlist — the resolver still fails CLOSED
// (unresolvable) for a target that entry was meant to cover, so it is a
// usability lint, not a security gap needing a parse-time refusal.
export function checkSafeDeletionRootsSyntax(manifest: Manifest): Diagnostic[] {
  const diags: Diagnostic[] = [];
  // Guarded (task d03af8f6, review round 3, LOW (e)) the same way
  // `src/runtime/intercept.ts` and `src/cli/explain-policy.ts` already
  // guard this same field: a hand-built `Manifest` that bypasses
  // `RiskSchema.parse` (every test fixture that constructs
  // `{ risk: { classifiers: [...] } }` directly, per that schema's own
  // comment) can carry a `risk` with no `safe_deletion_roots` at all, or
  // no `risk` object whatsoever — `manifest.risk.safe_deletion_roots`
  // would throw for either shape instead of degrading to the same
  // default the runtime resolver itself falls back to.
  const safeDeletionRoots = manifest.risk?.safe_deletion_roots ?? DEFAULT_SAFE_DELETION_ROOTS;
  safeDeletionRoots.forEach((root, i) => {
    const trimmed = root.trim();
    if (!trimmed.startsWith("/")) {
      diags.push({
        severity: "warning",
        path: `risk.safe_deletion_roots[${i}]`,
        message:
          `risk.safe_deletion_roots entry "${root}" is not an absolute path — ` +
          `resolveDeletionTarget only ever matches an absolute target against this list, ` +
          `so a relative entry can never allow anything. See docs/risk-gate.md.`,
      });
      return;
    }
    if (trimmed.includes("$") || trimmed.includes("~")) {
      diags.push({
        severity: "warning",
        path: `risk.safe_deletion_roots[${i}]`,
        message:
          `risk.safe_deletion_roots entry "${root}" contains "$" or "~" — this resolver never ` +
          `expands a shell variable or home-directory reference, so the entry is matched as a ` +
          `LITERAL "$"/"~" character, almost certainly not what was intended. Write the fully ` +
          `expanded absolute path instead. See docs/risk-gate.md.`,
      });
    }
  });
  return diags;
}

// Template-policy drift (task adf037c1): an installed harness.yaml ages in
// place — `harness apply` never retroactively adds newly-shipped default
// policies to an already-materialized manifest, so security policies
// introduced after install reach only fresh installs. The measured
// incident: a 0.44.0 machine whose manifest predated the kill-switch
// defenses (deny-kill-switch-bypass / deny-session-env-strip /
// deny-pause-sentinel-forgery) had the documented `harness pause` bypass
// live as ALLOW, with nothing surfacing the gap.
//
// Scope (operator decision 2026-08-08): compare only the shipped
// `operator_only` (kill-switch / security) policy names — the
// profile-independent security floor — against the installed manifest.
// A missing one is an ERROR (this is a real, exploitable defense gap),
// distinct from a merely-cosmetic drift; non-operator_only policies are
// intentionally not compared so solo/team installs are not nagged for
// full-only convenience policies they never carried.
//
// Two drift shapes are reported, both real aged-manifest bypasses:
//   - MISSING: the shipped operator_only policy name is absent entirely.
//   - DOWNGRADED: a policy of that name IS present but is no longer
//     operator_only (task 2cc73f55's history: these exact policies once
//     shipped with a `requires.ledger_tag` shape a ledger write could
//     satisfy; a manifest that kept the name but not operator_only:true
//     has a bypassable kill-switch). Name-presence alone would pass it as
//     no-drift, which is exactly the class this check exists to catch
//     (review finding 2026-08-08). operator_only:true is the single
//     sufficient predicate: the schema's superRefine forces enforcement
//     block for operator_only policies, so any downgrade (warn, a
//     requires: shape, operator_only dropped) fails this test.
//
// Deliberate opt-out (operator decision 2026-08-08): a name listed in
// `doctor.ignore_template_drift` is skipped ENTIRELY (both shapes). This
// is NOT a `policies[].enabled` flag — such a flag would be read here but
// ignored by the runtime engine, so an operator would believe a policy
// disabled while it still fired. The ignore-list only ever silences THIS
// report and changes no enforcement, so its meaning is honest. A
// stale/typo'd ignore entry (matching no shipped name) is itself
// surfaced as a warning so a dead opt-out cannot silently stop
// suppressing after a future rename.
export function checkTemplatePolicyDrift(manifest: Manifest): Diagnostic[] {
  const byName = new Map(manifest.policies.map((p) => [p.name, p]));
  const ignored = new Set(manifest.doctor.ignore_template_drift);
  const shipped = shippedOperatorOnlyPolicyNames();
  const diags: Diagnostic[] = [];
  for (const name of shipped) {
    if (ignored.has(name)) continue;
    const installed = byName.get(name);
    if (installed === undefined) {
      diags.push({
        severity: "error",
        path: "policies",
        message:
          `shipped operator_only security policy "${name}" is missing from ` +
          `this manifest, a defense the current template ships but this ` +
          `(older) install never received, so the gate it enforces is silently ` +
          `absent. Re-add the "${name}" policy + its hook from the full ` +
          `template (\`harness init --template full\` in a scratch dir and copy ` +
          `the block, or hand-add per docs/okf/pause-vs-gate-kill-switch.md), ` +
          `or, if you deliberately do not want it, list "${name}" under ` +
          `doctor.ignore_template_drift to acknowledge the opt-out.`,
      });
    } else if (installed.operator_only !== true) {
      diags.push({
        severity: "error",
        path: "policies",
        message:
          `security policy "${name}" is present but DOWNGRADED: the shipped ` +
          `template makes it \`operator_only: true\` (an unconditional deny no ` +
          `in-session evidence can satisfy), but this manifest's copy is not, ` +
          `so its kill-switch is bypassable (e.g. a \`requires:\` shape a ledger ` +
          `write satisfies, or \`enforcement: warn\`). Restore \`operator_only: ` +
          `true\` from the full template, or list "${name}" under ` +
          `doctor.ignore_template_drift if this weakening is deliberate.`,
      });
    }
  }
  // Stale/typo'd opt-out entries: named in ignore_template_drift but not a
  // shipped operator_only policy AND not a shipped bash_match trigger name
  // (task 037cfb7c's checkTriggerBoundaryDrift shares this same opt-out
  // field, see that function's header), so they suppress nothing. Warn
  // (not error), fail-safe already (the operator keeps seeing any real
  // drift), this only surfaces the dead config so a rename doesn't
  // silently strand an acknowledgement.
  const shippedSet = new Set(shipped);
  const knownBashMatchNames = new Set(shippedBashMatchBoundaries().map((e) => e.name));
  for (const name of manifest.doctor.ignore_template_drift) {
    if (!shippedSet.has(name) && !knownBashMatchNames.has(name)) {
      diags.push({
        severity: "warning",
        path: "doctor.ignore_template_drift",
        message:
          `doctor.ignore_template_drift lists "${name}", which is not a ` +
          `shipped operator_only policy name or a shipped bash_match trigger ` +
          `name, so it suppresses nothing. Remove the entry, or fix the name ` +
          `(a policy/hook rename can strand an acknowledgement here).`,
      });
    }
  }
  return diags;
}

// Trigger-boundary drift (task 037cfb7c, follow-up to adf037c1): a
// bash_match trigger's own drift check, parallel to
// checkTemplatePolicyDrift's missing/downgraded-policy check above.
// Compares, by exact name, every shipped-by-name bash_match trigger
// (hook-level hooks[].bash_match and policy-level
// policies[].trigger.bash_match) against shippedBashMatchBoundaries(),
// but ONLY the leading boundary-alternation group, never the rest of
// the regex; an operator's own edits to the command-shape match after
// the boundary group are legitimate and must not be flagged.
//
// Comparison is set-based, not string-equal (splitBoundaryAlternatives
// below splits the `|`-separated alternatives, escape-aware so `\|`
// inside an alternative is not itself treated as a separator, and
// trims each one). Only an alternative the template has that the
// installed regex is MISSING is reported by name; reordering the same
// alternatives, or an installed regex that is a superset of the
// template's, is not a finding (a superset can only widen what the
// trigger catches, never narrow it). An installed bash_match under a
// shipped name that has no recognizable boundary group at all is its
// own finding: it matches no command separator, so the trigger is
// unreachable for anything but a bare command at the very start of the
// string.
//
// Scope (mirrors checkTemplatePolicyDrift's operator decision
// 2026-08-08): an entry the template doesn't know by that name is out
// of scope for THIS check (a missing shipped hook/policy is
// checkTemplatePolicyDrift's concern, not this one's).
//
// Exit-code choice: ERROR, not warn, same rationale as
// checkTemplatePolicyDrift: a missing boundary alternative is a real,
// measured gate bypass, not cosmetic drift. See CHANGELOG.md's
// [Unreleased] entry for task 037cfb7c for the measured incident and
// reproduction. Severity is pinned directly (not just via message
// content) by tests/cli/doctor-trigger-boundary-drift.test.ts.
//
// Deliberate opt-out: a name listed under `doctor.ignore_template_drift`
// is skipped entirely, same field and same "silences only this report,
// never enforcement semantics" contract as checkTemplatePolicyDrift (see
// that function's header), NOT a `policies[].enabled` flag, which the
// runtime would still enforce while the operator believed it disabled.

/**
 * Splits a boundary-alternation group's inner content on top-level `|`
 * alternation separators. A backslash-escaped character (e.g. `\|`,
 * `\n`, `\(`) is treated as one atomic unit and is never itself a
 * separator, so an escaped pipe inside an alternative does not split
 * it. Each alternative is trimmed, so whitespace padding around a `|`
 * does not change the comparison.
 */
function splitBoundaryAlternatives(boundary: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < boundary.length; i++) {
    const ch = boundary[i];
    if (ch === "\\" && i + 1 < boundary.length) {
      current += ch + boundary[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/**
 * The template's boundary alternatives that are absent from the
 * installed boundary's alternative set. Order and duplicate extras in
 * `installedBoundary` never matter: only a missing alternative narrows
 * what the trigger can match relative to the template, so only a
 * missing alternative is reported.
 */
function missingBoundaryAlternatives(
  templateBoundary: string,
  installedBoundary: string,
): string[] {
  const installedSet = new Set(splitBoundaryAlternatives(installedBoundary));
  return splitBoundaryAlternatives(templateBoundary).filter((alt) => !installedSet.has(alt));
}

// Shared rehydration guidance appended to every finding message. `init`
// resolves its target manifest via `--config` (or `~/.harness/harness.yaml`
// by default, task adf037c1's original wording pointed at "a scratch dir",
// which `init` does not honor: it always resolves against `--config` or the
// home directory, never `cwd`); writing to a throwaway `--config` path is
// the only way to get the shipped regex to compare against without risking
// `--force` overwriting the live manifest.
function triggerBoundaryRehydrationGuidance(entryName: string): string {
  return (
    `Rehydrate the boundary: \`harness init --template full --config ` +
    `/tmp/harness-full.yaml\` and copy the boundary from there (or hand-edit ` +
    `per docs/okf/pause-vs-gate-kill-switch.md), or, if this is a deliberate ` +
    `custom boundary, list "${entryName}" under doctor.ignore_template_drift ` +
    `to acknowledge the opt-out.`
  );
}

// Shared "not a boundary at all" wording (review round 3, item 1). Used
// both when the leading group is syntactically absent (no parenthesized
// group at all) AND when one IS present but shares zero alternatives
// with the template's, e.g. a shipped-named trigger whose leading group
// serves an entirely different purpose such as `(gh|git)\s+pr merge\b`.
// In both cases the fix is the same (replace the group with the
// template's, not widen it with one more alternative), so the two cases
// share a message instead of the zero-overlap case being misdescribed as
// "missing" every single alternative.
function noRecognizableBoundaryMessage(
  entryLevel: "hook" | "policy",
  entryName: string,
  installedDescription: string,
): string {
  return (
    `${entryLevel} "${entryName}"'s bash_match has no recognizable ` +
    `leading boundary alternation (${installedDescription}). ` +
    `The trigger matches no command separator at all, so it only fires ` +
    `for a command that is literally the very first thing in the string, ` +
    `every other position (after \`;\`, \`&\`, a newline, a pipe, an open ` +
    `paren) is silently bypassable. ${triggerBoundaryRehydrationGuidance(entryName)}`
  );
}

export function checkTriggerBoundaryDrift(manifest: Manifest): Diagnostic[] {
  const ignored = new Set(manifest.doctor.ignore_template_drift);
  const shipped = shippedBashMatchBoundaries();
  const hooksByName = new Map(manifest.hooks.map((h) => [h.name, h]));
  const policiesByName = new Map(manifest.policies.map((p) => [p.name, p]));
  const diags: Diagnostic[] = [];
  for (const entry of shipped) {
    if (ignored.has(entry.name)) continue;
    const installedBashMatch =
      entry.level === "hook"
        ? hooksByName.get(entry.name)?.bash_match
        : policiesByName.get(entry.name)?.trigger.bash_match;
    // Not present by that name at that level (missing entirely, or no
    // longer carries a bash_match at all): out of this check's scope,
    // see the "Scope" note above.
    if (installedBashMatch === undefined) continue;
    const diagPath = entry.level === "hook" ? "hooks" : "policies";
    const actualBoundary = extractBashMatchBoundary(installedBashMatch);
    if (actualBoundary === undefined) {
      diags.push({
        severity: "error",
        path: diagPath,
        message: noRecognizableBoundaryMessage(
          entry.level,
          entry.name,
          `installed value: "${installedBashMatch}"`,
        ),
      });
      continue;
    }
    const templateAlternatives = splitBoundaryAlternatives(entry.boundary);
    const missing = missingBoundaryAlternatives(entry.boundary, actualBoundary);
    if (missing.length === 0) continue;
    if (missing.length === templateAlternatives.length) {
      // Zero overlap: the leading group is a syntactically valid
      // parenthesized alternation, but it shares no alternative at all
      // with the template's boundary, so it is not the boundary group
      // (an unrelated command-shape alternation like `(gh|git)` that
      // happens to sit first, or a fully custom, unrelated set). Report
      // it as "no recognizable boundary", not as "missing" every single
      // template alternative, since the fix is to replace this group,
      // not extend it.
      diags.push({
        severity: "error",
        path: diagPath,
        message: noRecognizableBoundaryMessage(
          entry.level,
          entry.name,
          `installed leading group: "(${actualBoundary})", which shares no ` +
            `boundary token with the shipped template's "(${entry.boundary})"`,
        ),
      });
      continue;
    }
    const missingList = missing.map((m) => `"${m}"`).join(", ");
    diags.push({
      severity: "error",
      path: diagPath,
      message:
        `${entry.level} "${entry.name}"'s bash_match boundary is missing ` +
        `${missing.length === 1 ? "an alternative" : "alternatives"} the shipped ` +
        `template has: ${missingList} (installed: "(${actualBoundary})", template: ` +
        `"(${entry.boundary})"). A command that only opens with ` +
        `${missing.length === 1 ? "that boundary token" : "one of those boundary tokens"} ` +
        `(e.g. a backgrounded \`cmd & gh pr merge 1\`) is not matched, so the gate ` +
        `this trigger guards is silently bypassable. ${triggerBoundaryRehydrationGuidance(entry.name)}`,
    });
  }
  return diags;
}

// Hook-budget-vs-ledger-timeout margin (task d20a7e0c, follow-up to
// f1aea826/7bf47554). A blocking (`blocking: "hard"`) hook that consults
// the evidence ledger before it can write its own decision is bounded
// TWICE: once by its own `budget_ms` (the runtime's outer kill-timeout —
// Claude Code and Codex both treat a KILLED hook as ALLOW, never as its
// own pending verdict) and once by the ledger round-trip it is waiting
// on. `budget_ms` below `requiredHookBudgetMs(health.timeout_ms)`
// (src/cli/policy/intercept.ts — see that function's doc comment for the
// full derivation from `realLedgerClient`'s own two round-trip shapes,
// INCLUDING the "KNOWN RESIDUAL" paragraph there: this check guarantees
// delivery on the pure-timeout hang shape only, not on a query() that
// degrades via a non-timeout ledger error and then hangs on record())
// means a merely SLOW (not even hard-down) ledger can get the hook
// killed before its fail-closed `deny` / `deny-degraded` JSON reaches
// stdout — silently turning the verdict into an unintended allow,
// defeating the deny-degraded fix (task f1aea826) on exactly the hang
// shape it exists to close.
//
// Two hook populations are checked, both GENERICALLY — unlike
// tests/runtime/hook-budget-ledger-margin.test.ts's pre-d20a7e0c version,
// which hand-imported three specific pack modules and pinned a hardcoded
// 15000ms floor instead of scaling with the manifest's own
// health.timeout_ms:
//   1. `manifest.hooks[]` entries that invoke `harness policy intercept`
//      (recognised via `isPolicyInterceptCommand`, robust to how the
//      operator or a local build spells the leading token — see that
//      function's own doc comment for why a verbatim string compare
//      under-recognises real manifests).
//   2. Every hook an ENABLED `manifest.policy_packs[]` entry resolves to,
//      for every runtime `harness apply` can target (`KNOWN_RUNTIMES`) —
//      iterating whichever packs the operator actually has enabled
//      through the shared `resolveBuiltin` registry lookup, not a
//      hand-maintained list of specific pack modules. Only the subset
//      whose command names one of the LEDGER_CONSULTING_PACK_SUBCOMMANDS
//      below is checked: `solution-acceptance` / `solution-acceptance-
//      writeguard` are DELIBERATELY excluded — they gate on a filesystem
//      verdict marker the producer writes, never a live ledger
//      round-trip (see solution-acceptance.ts's own header comment), so
//      flagging them here would be a false positive.
const LEDGER_CONSULTING_PACK_SUBCOMMANDS = [
  "pack hook branch-protection",
  "pack hook pre-tool-use",
  "pack hook codex-pre-tool-use",
  "pack hook post-merge-gate",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `command` invoke `subcommand` as adjacent, whitespace-separated
 * tokens, regardless of a leading interpreter/env-var prefix or a
 * trailing flag? Mirrors `isPolicyInterceptCommand`'s own reasoning
 * (src/cli/policy/intercept.ts) for the pack-hook subcommand names,
 * which that function does not itself cover (it only recognises `policy
 * intercept`).
 *
 * Trailing-boundary note (review 2026-08-09, fix round 1, finding 3):
 * `isPolicyInterceptCommand` widened ITS trailing boundary to also accept
 * a semicolon/quote glued directly onto the subcommand word, because it
 * classifies OPERATOR-authored `manifest.hooks[]` commands. This
 * function's callers only ever see the exact, harness-generated pack
 * command strings (`BLOCKER_COMMAND` constants in the
 * `src/policy-packs/builtin/*.ts` sources) — a fixed, known set this
 * codebase controls byte-for-byte — so the narrower whitespace-or-end
 * boundary here is deliberately left as is rather than mirrored; there is
 * no operator-authored input on this path for a glued shell metacharacter
 * to appear in.
 */
function commandInvokesSubcommand(command: string, subcommand: string): boolean {
  const pattern = subcommand.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?:^|[\\s/\\\\])${pattern}(?:\\s|$)`).test(command);
}

function isLedgerConsultingPackCommand(command: string): boolean {
  return LEDGER_CONSULTING_PACK_SUBCOMMANDS.some((s) => commandInvokesSubcommand(command, s));
}

// The one pack subcommand among LEDGER_CONSULTING_PACK_SUBCOMMANDS whose
// OWN degraded-ledger handling fails OPEN (allow) rather than closed —
// see hook-post-merge-gate.ts's explicit "Fail posture: OPEN" header
// comment and its `post-merge-gate fails open, allowing` diagnostics.
// `branch-protection` / `pre-tool-use` (understanding-before-execution) /
// `codex-pre-tool-use` all fail CLOSED absent ledger evidence (a missing
// or degraded query reads as "no evidence", which those hooks block or
// ask on, not allow). Tracked separately so the diagnostic below can
// stop attributing a fail-closed verdict this hook never produces to it
// (review 2026-08-09, fix round 1, finding 2).
const FAIL_OPEN_ON_DEGRADED_PACK_SUBCOMMAND = "pack hook post-merge-gate";

/**
 * A ledger-consulting blocking hook, tagged with the shape of ledger
 * traffic it actually performs — used only to pick the right explanatory
 * text in `checkHookBudgetLedgerMargin`'s diagnostic message below, never
 * to change the numeric threshold (`required` stays the same
 * `requiredHookBudgetMs(health.timeout_ms)` floor for every hook here;
 * see that message's own comment for why a per-kind lower bound isn't
 * derived instead).
 */
interface LedgerConsultingHook {
  hook: Hook;
  /**
   * True for a direct `manifest.hooks[]` entry invoking `harness policy
   * intercept` — the ledger client whose `query()` + deny-degraded
   * `record()` retry `requiredHookBudgetMs`'s 2T+3R is actually derived
   * from. False for a pack-contributed blocker, which only ever calls
   * `queryLedgerByTag` (open session, one `querySummary`, dispose) —
   * `src/cli/pack/hook-branch-protection.ts`,
   * `hook-codex-pre-tool-use.ts`, `hook-pre-tool-use.ts`,
   * `hook-post-merge-gate.ts` — never `ledger_add`, so it has no
   * deny-degraded audit-retry step of its own and its real worst case is
   * bounded at up to 2×timeout_ms, not 2T+3R.
   */
  isPolicyInterceptHook: boolean;
  /** True only for the post-merge-gate pack subcommand (see the constant
   * above) — its own decision on a degraded/unreachable ledger is to
   * allow, not deny. */
  isFailOpenOnDegraded: boolean;
}

function collectLedgerConsultingBlockingHooks(manifest: Manifest): LedgerConsultingHook[] {
  const direct: LedgerConsultingHook[] = manifest.hooks
    .filter((h) => h.blocking === "hard" && isPolicyInterceptCommand(h.command))
    .map((hook) => ({ hook, isPolicyInterceptHook: true, isFailOpenOnDegraded: false }));
  const fromPacks: LedgerConsultingHook[] = [];
  for (const pack of manifest.policy_packs) {
    if (!pack.enabled) continue;
    for (const runtime of KNOWN_RUNTIMES) {
      const resolved = resolveBuiltin(pack, runtime);
      // Unresolvable packs (unknown source / unknown builtin name) are
      // already flagged separately by checkPolicyPacks; nothing to
      // classify here.
      if (!resolved) continue;
      for (const hook of resolved.contribution.hooks) {
        if (hook.blocking === "hard" && isLedgerConsultingPackCommand(hook.command)) {
          fromPacks.push({
            hook,
            isPolicyInterceptHook: false,
            isFailOpenOnDegraded: commandInvokesSubcommand(
              hook.command,
              FAIL_OPEN_ON_DEGRADED_PACK_SUBCOMMAND,
            ),
          });
        }
      }
    }
  }
  return [...direct, ...fromPacks];
}

export function checkHookBudgetLedgerMargin(manifest: Manifest): Diagnostic[] {
  const grounding = manifest.tools.mcp.find(
    (m) => m.name === "grounding-mcp" && m.enabled !== false,
  );
  // No wired producer: `harness policy intercept` falls back to the
  // instant `degradedLedgerClient` (no subprocess, no wait), and a pack
  // blocker with no grounding-mcp entry to query is a separate,
  // already-reported misconfiguration (checkPolicyGroundingMcp). No live
  // ledger round-trip exists here for a margin to protect.
  if (!grounding) return [];
  const ledgerTimeoutMs = grounding.health?.timeout_ms ?? 5000;
  const required = requiredHookBudgetMs(ledgerTimeoutMs);
  const seen = new Set<string>();
  const diags: Diagnostic[] = [];
  for (const entry of collectLedgerConsultingBlockingHooks(manifest)) {
    const { hook, isPolicyInterceptHook, isFailOpenOnDegraded } = entry;
    // Both KNOWN_RUNTIMES resolutions of an enabled pack commonly yield a
    // hook with the same (name, budget_ms) pair — only the match/command
    // wording differs per runtime. De-dupe so one misconfigured budget
    // is reported once, not twice.
    const key = `${hook.name}:${hook.budget_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hook.budget_ms >= required) continue;
    const preamble =
      `hook "${hook.name}" carries budget_ms=${hook.budget_ms}, below the ${required}ms this ` +
      `manifest's grounding-mcp health.timeout_ms=${ledgerTimeoutMs}ms requires (2×timeout_ms ` +
      `+ 3× the deny-degraded audit-retry budget — see requiredHookBudgetMs in ` +
      `src/cli/policy/intercept.ts for the derivation`;
    let message: string;
    if (isPolicyInterceptHook) {
      message =
        `${preamble}, INCLUDING that function's "KNOWN RESIDUAL" paragraph: clearing ${required}ms ` +
        `only guarantees the fail-closed verdict on the pure-timeout hang shape, not on a ledger ` +
        `query that errors non-timeout and then hangs on the audit write). A merely SLOW (not even ` +
        `hard-down) ledger can get this blocking hook killed by the runtime's outer hook timeout ` +
        `before its fail-closed deny JSON reaches stdout — both Claude Code and Codex then read the ` +
        `kill as allow, defeating the deny-degraded fix (task f1aea826) on exactly this hang shape. ` +
        `Raise budget_ms to at least ${required}, or lower tools.mcp.grounding-mcp.health.timeout_ms ` +
        `(which lowers this requirement too, at the cost of a stricter ledger-latency budget); see ` +
        `docs/okf/gate-fail-posture-matrix.md.`;
    } else {
      // Pack-contributed blocker: only queries the ledger (no ledger_add,
      // no deny-degraded audit retry of its own), so the 2T+3R floor
      // above is a deliberately conservative carryover from the direct
      // `harness policy intercept` threshold, not this hook's own
      // derived worst case (which is bounded at up to 2×timeout_ms for
      // the query alone) — kept uniform rather than a separately-tested,
      // lower per-kind bound (review 2026-08-09, fix round 1, finding 2).
      const consequence = isFailOpenOnDegraded
        ? `this hook's OWN decision on a degraded or unreachable ledger is to fail OPEN (allow), ` +
          `not deny — see hook-post-merge-gate.ts's "Fail posture: OPEN" note — so a hook killed by ` +
          `the runtime's outer timeout here reaches the same allow outcome its own degraded-handling ` +
          `would already choose. It is still flagged here so a merely SLOW (not even hard-down) ` +
          `ledger cannot needlessly stall the gate up to its outer timeout, not because a fail-closed ` +
          `verdict is at risk`
        : `a merely SLOW (not even hard-down) ledger can still get this hook killed by the runtime's ` +
          `outer hook timeout before it can even complete that query, defeating its own fail-closed ` +
          `default on exactly this hang shape`;
      message =
        `${preamble}). This pack-contributed hook only QUERIES the ledger (queryLedgerByTag: open ` +
        `session, one querySummary, dispose) — it never calls ledger_add, so it has no ` +
        `deny-degraded audit-retry step of its own; ${consequence}. Raise budget_ms to at least ` +
        `${required}, or lower tools.mcp.grounding-mcp.health.timeout_ms (which lowers this ` +
        `requirement too, at the cost of a stricter ledger-latency budget); see ` +
        `docs/okf/gate-fail-posture-matrix.md.`;
    }
    diags.push({
      severity: "error",
      path: `hooks[${hook.name}].budget_ms`,
      message,
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
    ...checkSolutionAcceptanceKnobIgnored(
      manifest,
      opts.gitIgnoreProbe ?? createDefaultGitIgnoreProbe(),
    ),
    ...checkPolicyPacks(manifest),
    ...checkPolicyPackConfigsAsDiagnostics(manifest),
    ...checkPolicyRiskWithoutEnvScope(manifest),
    ...checkSafeDeletionRootsSyntax(manifest),
    ...checkPolicySelfAttestation(manifest),
    ...checkHookBudgetLedgerMargin(manifest),
    ...checkWorkflows(manifest),
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
