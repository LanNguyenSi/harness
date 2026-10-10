import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkPolicyPackConfigs, checkPolicyPackSources } from "../../policy-packs/index.js";
import { expandHome } from "../../io/expand-home.js";
import { parseProbedVersion, compareVersionFloor } from "../../io/version-compare.js";
import {
  extractBashMatchBoundary,
  shippedBashMatchBoundaries,
  shippedOperatorOnlyPolicyNames,
} from "../init/templates.js";
import { isPolicyInterceptCommand, requiredHookBudgetMs } from "../policy/intercept.js";
import type { Hook, Manifest } from "../../schema/index.js";
import {
  deriveWorkflowGatePolicies,
  findWeakGatePolicyOverlaps,
  handAuthoredPolicies,
  MERGE_BASH_MATCH,
  MERGE_MCP_MATCH,
  REVIEW_EVIDENCE_HOOK_BASH,
  REVIEW_EVIDENCE_HOOK_MCP,
  REVIEW_EVIDENCE_HOOK_TASK_FINISH,
  REVIEW_EVIDENCE_HOOK_TASK_MERGE,
  workflowRequiresMergeGate,
} from "../../runtime/workflow-policies.js";
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
  const errors: Diagnostic[] =
    problems.length === 0
      ? []
      : offending.map((wf) => ({
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

  return [...errors, ...checkTaskVerbGateWiring(manifest, offending)];
}

/**
 * MEDIUM security (review round 1, task 2699b476 round 2): a manifest can
 * wire the ORIGINAL pair of review-evidence hooks
 * (`require-review-evidence` / `require-review-evidence-bash`, gating
 * `mcp__agent-tasks__pull_requests_merge` and `gh pr merge`) without ever
 * adding the two task-scoped ones task 2699b476 introduced
 * (`require-review-evidence-task-merge` / `require-review-evidence-task-finish`,
 * gating `mcp__agent-tasks__task_merge` and `task_finish { autoMerge: true }`).
 * `deriveWorkflowGatePolicies` derives the task-scoped gate ONLY when its
 * own hook is present (same "quietly returns nothing" shape
 * `checkWorkflowGateWiring` already guards for the original pair), so a
 * manifest predating that task keeps the two newer verbs completely
 * uncovered: a PR can be merged via `task_merge` or an auto-merging
 * `task_finish` with no recorded review at all, while `harness validate`
 * stayed silent about it. This is a `warning`, not an `error`, because the
 * ORIGINAL surfaces (`pull_requests_merge`, `gh pr merge`) are still
 * enforced when this fires: the gap is narrower than the fully-unwired
 * case above, but still silent non-enforcement for the two verbs it names.
 */
function checkTaskVerbGateWiring(manifest: Manifest, offending: Manifest["workflows"]): Diagnostic[] {
  const mcpHook = manifest.hooks.find((h) => h.name === REVIEW_EVIDENCE_HOOK_MCP);
  const bashHook = manifest.hooks.find((h) => h.name === REVIEW_EVIDENCE_HOOK_BASH);
  if (!mcpHook || !bashHook) return [];

  const taskMergeHook = manifest.hooks.find((h) => h.name === REVIEW_EVIDENCE_HOOK_TASK_MERGE);
  const taskFinishHook = manifest.hooks.find((h) => h.name === REVIEW_EVIDENCE_HOOK_TASK_FINISH);
  const uncoveredVerbs: string[] = [];
  const missingHookNames: string[] = [];
  if (!taskMergeHook) {
    uncoveredVerbs.push("mcp__agent-tasks__task_merge");
    missingHookNames.push(`"${REVIEW_EVIDENCE_HOOK_TASK_MERGE}"`);
  }
  if (!taskFinishHook) {
    uncoveredVerbs.push("mcp__agent-tasks__task_finish (autoMerge: true)");
    missingHookNames.push(`"${REVIEW_EVIDENCE_HOOK_TASK_FINISH}"`);
  }
  if (uncoveredVerbs.length === 0) return [];

  return offending.map((wf) => ({
    severity: "warning" as const,
    path: "workflows",
    message:
      `workflow "${wf.name}" wires the review-evidence gate for mcp__agent-tasks__pull_requests_merge ` +
      `and gh pr merge, but not for ${uncoveredVerbs.join(" or ")}: ` +
      `hooks[] is missing ${missingHookNames.join(" and ")}. ` +
      "Without them harness policy intercept never derives the task-scoped merge gate (task 2699b476) " +
      "and a PR can be merged through those verbs with no recorded review, even though the original " +
      "pull_requests_merge / gh pr merge surfaces are still gated. See docs/for-agents.md, or " +
      "src/cli/init/templates.ts's require-review-evidence-task-merge / " +
      "require-review-evidence-task-finish entries.",
  }));
}

/**
 * F1 (review round 2): a hand-authored policy on the identical trigger
 * surface + ledger_tag as a derived block gate, but weaker than it
 * (`enforcement: "warn"`/`"require_approval"`, or `when:`-scoped), no
 * longer suppresses the derived gate (see `isAtLeastAsStrongAsDerivedGate`
 * in workflow-policies.ts). This check surfaces that overlap as a warning
 * so an operator reading the weaker policy does not mistake it for the ONLY
 * gate on the surface. A `when:`-scoped hand-authored policy NEVER applies
 * anymore (the interim Risk Gate guard, task 6e52c044), so it gets a
 * dedicated message naming the never-applies consequence instead of the
 * "both apply" one.
 */
export function checkWorkflowGateWeakOverlap(manifest: Manifest): Diagnostic[] {
  return findWeakGatePolicyOverlaps(manifest).map((overlap) => {
    const handPolicy = manifest.policies.find((p) => p.name === overlap.handPolicyName);
    if (handPolicy?.when !== undefined) {
      return {
        severity: "warning" as const,
        path: "workflows" as const,
        message:
          `workflow "${overlap.workflowName}" derives a block gate on ${overlap.surface}; ` +
          `hand-authored policy "${overlap.handPolicyName}" on the same surface carries a when: ` +
          `clause and never applies, so the derived block gate ("${overlap.derivedPolicyName}") ` +
          `is the only gate on this surface. Remove the when: policy or drop its when: clause.`,
      };
    }
    return {
      severity: "warning" as const,
      path: "workflows" as const,
      message:
        `workflow "${overlap.workflowName}" derives a block gate on ${overlap.surface}; ` +
        `hand-authored policy "${overlap.handPolicyName}" on the same surface is weaker ` +
        `(${overlap.reason}). Both policies apply: the derived block gate ` +
        `("${overlap.derivedPolicyName}") still enforces review evidence independently, so this ` +
        "is informational, not a gap, but double-check the weaker policy is intentional. Note " +
        "also that this overlap is not suppressed on purpose, so the same event now round-trips " +
        "the ledger twice (once per policy); if that hook's budget_ms was sized for one policy, " +
        "check it against two, since requiredHookBudgetMs does not scale with the policy count.",
    };
  });
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
 * bash]`) is not deduped by name (dedupe keys on surface, not name), so
 * the derived view carries two policies with one name. This fires both
 * when the hand-authored policy sits on a DIFFERENT surface (dedupe never
 * even compares them), and when it sits on the SAME surface but is not
 * `isAtLeastAsStrongAsDerivedGate` (weaker enforcement or a `when:` scope
 * — that case IS a surface match, so `findWeakGatePolicyOverlaps` also
 * reports it as an overlap; the two checks are not mutually exclusive).
 * Either way the runtime evaluates both policies (fail-safe), but every
 * by-name reader (`explain`, `audit`, `diff`'s name-keyed policy list) resolves the name to the hand-authored one and
 * silently hides the derived gate. The schema's duplicate-name refinement
 * cannot see this (it runs on the hand-authored view), so it is an error
 * here.
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
        "derived from workflows[] (it does not stand in for the derived gate: either a " +
        "different trigger surface, or weaker / differently-extracting on the same one); " +
        "both are enforced, but explain/audit/diff resolve the name to the " +
        "hand-authored one. Rename the hand-authored policy.",
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
// measured gate bypass, not cosmetic drift. See the `CHANGELOG.md:#0.49.0`
// entry for task 037cfb7c for the measured incident and reproduction.
// Severity is pinned directly (not just via message
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
// The checked population is the `manifest.hooks[]` entries that invoke
// `harness policy intercept` (recognised via `isPolicyInterceptCommand`,
// robust to how the operator or a local build spells the leading token, see
// that function's own doc comment for why a verbatim string compare
// under-recognises real manifests). No builtin pack contributes a
// ledger-consulting blocker any more: `pack hook branch-protection` asks git
// for the branch and makes no ledger round-trip, so its budget is not tied to
// the ledger's timeout.
function collectLedgerConsultingBlockingHooks(manifest: Manifest): Hook[] {
  return manifest.hooks.filter((h) => h.blocking === "hard" && isPolicyInterceptCommand(h.command));
}

export function checkHookBudgetLedgerMargin(manifest: Manifest): Diagnostic[] {
  const grounding = manifest.tools.mcp.find(
    (m) => m.name === "grounding-mcp" && m.enabled !== false,
  );
  // No wired producer: `harness policy intercept` falls back to the
  // instant `degradedLedgerClient` (no subprocess, no wait). No live
  // ledger round-trip exists here for a margin to protect.
  if (!grounding) return [];
  const ledgerTimeoutMs = grounding.health?.timeout_ms ?? 5000;
  const required = requiredHookBudgetMs(ledgerTimeoutMs);
  const diags: Diagnostic[] = [];
  for (const hook of collectLedgerConsultingBlockingHooks(manifest)) {
    if (hook.budget_ms >= required) continue;
    const message =
      `hook "${hook.name}" carries budget_ms=${hook.budget_ms}, below the ${required}ms this ` +
      `manifest's grounding-mcp health.timeout_ms=${ledgerTimeoutMs}ms requires (2×timeout_ms ` +
      `+ 3× the deny-degraded audit-retry budget — see requiredHookBudgetMs in ` +
      `src/cli/policy/intercept.ts for the derivation, INCLUDING that function's "KNOWN RESIDUAL" ` +
      `paragraph: clearing ${required}ms ` +
      `only guarantees the fail-closed verdict on the pure-timeout hang shape, not on a ledger ` +
      `query that errors non-timeout and then hangs on the audit write). A merely SLOW (not even ` +
      `hard-down) ledger can get this blocking hook killed by the runtime's outer hook timeout ` +
      `before its fail-closed deny JSON reaches stdout — both Claude Code and Codex then read the ` +
      `kill as allow, defeating the deny-degraded fix (task f1aea826) on exactly this hang shape. ` +
      `Raise budget_ms to at least ${required}, or lower tools.mcp.grounding-mcp.health.timeout_ms ` +
      `(which lowers this requirement too, at the cost of a stricter ledger-latency budget); see ` +
      `docs/okf/gate-fail-posture-matrix.md.`;
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
    ...checkHookBudgetLedgerMargin(manifest),
    ...checkWorkflows(manifest),
  ];
}

export const __testables = {
  expandHome,
  isRootedPath,
  firstToken,
  resolveOnPath,
  DEFAULT_RUNTIME_BUILTINS,
};
