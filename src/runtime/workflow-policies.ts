import type { Manifest, Policy, Workflow } from "../schema/index.js";

/**
 * Runtime enforcement for `workflows:` (99f47307, Slice 1).
 *
 * `manifest.workflows[]` describes a review-then-merge process (schema:
 * `src/schema/workflows.ts`), but until now nothing read it at
 * enforcement time: `src/runtime/intercept.ts` (the Risk Gate / policy
 * engine `harness policy intercept` runs on every PreToolUse) only ever
 * evaluates `manifest.policies[]`. A `workflows:` declaration alone was
 * documentation, not a gate (`docs/for-agents.md`, pre-Slice-1 wording:
 * "The schema cannot enforce that today").
 *
 * This module closes that gap for exactly ONE step pairing: a
 * `review_subagent` step with `spawn: "required"` followed (at any
 * later index in the same workflow) by a `merge` step. When BOTH
 * `require-review-evidence` and `require-review-evidence-bash` are
 * declared in `manifest.hooks[]`, `deriveWorkflowGatePolicies` returns
 * the SAME policies `harness init --template full` would hand-author
 * (`src/cli/init/templates.ts` `review-before-merge` /
 * `review-before-merge-bash`), renamed per workflow so the provenance
 * is visible in `harness list policies` / `harness explain`.
 *
 * Task 2699b476 added the two task-scoped merge surfaces to that set:
 * `review-before-task-merge` (`mcp__agent-tasks__task_merge`) and
 * `review-before-task-finish-automerge`
 * (`mcp__agent-tasks__task_finish` narrowed by `trigger.input_match` to
 * `autoMerge: true`), each derived only when its own hook
 * (`require-review-evidence-task-merge` /
 * `require-review-evidence-task-finish`) is declared. A manifest that
 * predates those hooks derives exactly the pair it always did.
 *
 * Deliberately does NOT touch `src/runtime/intercept.ts`: the engine
 * already knows how to evaluate a `Policy`, so the only thing missing
 * was a `Policy` to hand it. `src/cli/loader.ts#loadManifest` calls
 * `withDerivedPolicies` after parsing and appends the result to
 * `manifest.policies` before any consumer (the CLI `policy intercept`
 * entrypoint, `list`, `explain`, `explain-policy`) reads it.
 *
 * TWO VIEWS OF ONE MANIFEST (review round 3, 99f47307 Slice 1). Every
 * reader of a parsed manifest sees exactly one of:
 *
 * - the HAND-AUTHORED view: `parseManifest(...)` as-is, only what the
 *   operator wrote under `policies:`. Right for anything that writes a
 *   manifest back to disk or serialises it for later comparison
 *   (`harness export`, the `.last-apply` manifest snapshot, `add` /
 *   `remove` / `adopt` / `pack reseed` file rewrites, the schema gate in
 *   `io/validate-before-write.ts`), because a derived policy written out
 *   as if hand-authored would be re-derived on top of itself next time.
 *   `withoutDerivedPolicies` turns a derived view back into this one.
 * - the DERIVED view: `withDerivedPolicies(parseManifest(...))`, hand-
 *   authored policies plus the workflow gate pair. Right for enforcement
 *   (`policy intercept`, hook entrypoints), validation (`validate`,
 *   `doctor`, `add`'s asset gate), display (`list`, `explain[-policy]`,
 *   `describe`, `dry-run`), and every COMPARISON where the other side is
 *   also derived (`diff --since` ref side vs working side; the
 *   `.last-apply` snapshot vs the current manifest in restart hints).
 *   `loadManifest` hands out this view; the few readers that parse
 *   without it (`validate`, `diff`'s ref side, `apply`'s snapshot
 *   reader, `add`'s gate) call `withDerivedPolicies` themselves.
 *
 * Both helpers are idempotent and accept either view as input (they
 * partition on `isDerivedPolicy`), so a reader can never "double derive"
 * or strip a hand-authored policy by calling them on the wrong view.
 * Review rounds 1 and 2 each found one reader on the wrong side of this
 * line (`apply` vs `validate`; `diff --since`'s two sides); the table
 * above plus tests/cli/manifest-view-parity.test.ts are the guard.
 *
 * Fail direction: when the two evidence hooks are NOT wired, this
 * returns `[]` for every workflow rather than deriving an
 * unenforceable policy (there would be no hook name to bind it to, and
 * `manifest.policies[].hook` must reference a declared hook, see
 * `ManifestSchema`'s superRefine in `src/schema/index.ts`). That silent
 * non-enforcement case is exactly what `checkWorkflowGateWiring`
 * (`src/cli/validate/checks.ts`) turns into a loud `validate` error, so
 * "declared `spawn: required`, gate never wired" cannot pass silently.
 */

/** The two hooks templates.ts wires for the hand-authored merge gate. */
export const REVIEW_EVIDENCE_HOOK_MCP = "require-review-evidence";
export const REVIEW_EVIDENCE_HOOK_BASH = "require-review-evidence-bash";

/**
 * The two hooks templates.ts wires for the task-scoped merge surfaces
 * (task 2699b476). Unlike the pair above these are NOT part of
 * `hasWiredMergeGateHooks`: a manifest that predates them still derives
 * the `pull_requests_merge` / `gh pr merge` gates exactly as before, and
 * each task-scoped gate is derived only when ITS OWN hook is declared.
 *
 * That per-hook gating is not a style choice. A derived policy's `hook:`
 * must name a declared hook (`ManifestSchema`'s superRefine), and, more
 * importantly, the hook's `match` is what `harness apply` projects into
 * settings.json's tool-name matcher: without a matcher for
 * `mcp__agent-tasks__task_merge`, Claude Code never spawns `harness
 * policy intercept` for that verb, so a gate derived anyway would be
 * INERT while looking enforced in `harness list policies` (the exact
 * "No-Op that LOOKS protective" shape `checkWorkflowGateWiring` exists
 * to prevent). Deriving nothing until the hook is wired keeps the
 * absence visible instead of fake-covering it.
 */
export const REVIEW_EVIDENCE_HOOK_TASK_MERGE = "require-review-evidence-task-merge";
export const REVIEW_EVIDENCE_HOOK_TASK_FINISH = "require-review-evidence-task-finish";

// Exported (review round 2, F5) so `src/cli/validate/checks.ts` can check a
// declared hook's `match`/`bash_match` against the EXACT surface the
// derivation binds to, instead of trusting the hook name alone. See
// `checkWorkflowGateWiring`'s header for the "right name, wrong trigger"
// gap this closes.
export const MERGE_MCP_MATCH = "mcp__agent-tasks__pull_requests_merge";
// Byte-identical to templates.ts's `review-before-merge-bash` trigger
// (verified against the parsed FULL_TEMPLATE at authoring time; pinned
// by tests/runtime/workflow-policies.test.ts's parity assertion so the
// two cannot silently drift apart).
export const MERGE_BASH_MATCH = "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b";

// The two task-scoped agent-tasks merge surfaces (task 2699b476), pinned
// here the same way `MERGE_MCP_MATCH` / `MERGE_BASH_MATCH` are and held
// byte-identical to templates.ts by this module's parity assertion in
// tests/runtime/workflow-policies.test.ts.
export const TASK_MERGE_MCP_MATCH = "mcp__agent-tasks__task_merge";
export const TASK_FINISH_MCP_MATCH = "mcp__agent-tasks__task_finish";

/**
 * The `trigger.input_match` predicate that separates the merging mode of
 * `task_finish` from the ordinary one. Both auto-merge modes the MCP
 * server documents (soloMode work claim, review claim + approve) carry
 * `autoMerge: true`; a plain finish omits the argument entirely, and a
 * missing path never satisfies an `input_match` entry, so the gate stays
 * out of the way of the non-merging call.
 */
export const TASK_FINISH_AUTOMERGE_INPUT_MATCH: Record<string, boolean> = {
  "toolArgs.autoMerge": true,
};

/** `toolArgs.taskId` is the only identifier either task-scoped verb carries. */
export const TASK_ID_EXTRACT: Record<string, string> = { TASK_ID: "toolArgs.taskId" };

/**
 * True when `workflow.steps` contains a `review_subagent` step with
 * `spawn: "required"` at an index earlier than some `merge` step
 * (not necessarily adjacent; a `ci_gate` or another step may sit
 * between them). A workflow with no `merge` step at all, or whose only
 * `review_subagent` steps are `spawn: "optional"` / `"skip"`, returns
 * `false`.
 */
export function workflowRequiresMergeGate(workflow: Workflow): boolean {
  let sawRequiredReview = false;
  for (const step of workflow.steps) {
    if (step.kind === "review_subagent" && step.spawn === "required") {
      sawRequiredReview = true;
    } else if (step.kind === "merge" && sawRequiredReview) {
      return true;
    }
  }
  return false;
}

/** True when both merge-gate evidence hooks are declared in `manifest.hooks[]`. */
export function hasWiredMergeGateHooks(manifest: Manifest): boolean {
  const hookNames = new Set(manifest.hooks.map((h) => h.name));
  return hookNames.has(REVIEW_EVIDENCE_HOOK_MCP) && hookNames.has(REVIEW_EVIDENCE_HOOK_BASH);
}

/**
 * Canonical key for "does this policy intercept the same surface for the
 * same evidence?": event + match + bash_match + requires.ledger_tag. Two
 * policies sharing this key fire on the identical event for the identical
 * ledger tag, so the derivation treats a hand-authored policy with this
 * key as a CANDIDATE for standing in for the derived gate. Whether it
 * actually does is decided by `isEquivalentToDerivedGate` below: it must
 * also extract its template variables the same way (F4, review round 3)
 * and be at least as strong (F1, review round 2).
 */
function triggerSurfaceKey(policy: Pick<Policy, "trigger" | "requires">): string {
  return JSON.stringify({
    event: policy.trigger.event,
    match: policy.trigger.match ?? null,
    bash_match: policy.trigger.bash_match ?? null,
    input_match: inputMatchKey(policy),
    ledger_tag: policy.requires?.ledger_tag ?? null,
  });
}

/**
 * Canonical form of `trigger.input_match` for the surface key: key-sorted
 * so authoring order does not change identity, `null` when the policy
 * declares none.
 *
 * `input_match` is part of the SURFACE, not of the extract comparison
 * (task 2699b476): two policies on `mcp__agent-tasks__task_finish` that
 * disagree about which `autoMerge` value they gate intercept DIFFERENT
 * tool calls, so they are no more interchangeable than a policy on a
 * different tool name would be. Leaving it out of the key would let a
 * hand-authored `input_match: { toolArgs.autoMerge: false }` policy dedupe
 * the derived `autoMerge: true` gate away and leave the merging call
 * ungated while the manifest still reads as covered.
 */
function inputMatchKey(policy: Pick<Policy, "trigger">): Record<string, unknown> | null {
  const inputMatch = policy.trigger.input_match;
  if (inputMatch === undefined) return null;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(inputMatch).sort()) {
    sorted[key] = inputMatch[key];
  }
  return sorted;
}

/**
 * Canonical form of `trigger.extract` for equality: key-sorted so two
 * maps that declare the same variables from the same paths compare equal
 * regardless of authoring order. `null` when the policy extracts nothing.
 *
 * F4 (review round 3): `extract` was NOT part of the dedupe key before,
 * so a hand-authored block policy on the derived surface that extracted
 * `PR_NUMBER` from a WRONG path (say `toolArgs.pr` instead of
 * `toolArgs.prNumber`) counted as equivalent, suppressed the derived
 * gate, and then evaluated its own `review:${PR_NUMBER}` against an
 * unresolved variable. Under `risk.degraded_fail_posture: fail_open` that
 * is an allow with "template variables unresolved": the merge went
 * through with no review evidence at all. A differently-extracting policy
 * no longer dedupes: the derived gate is produced as well, both apply,
 * and `findWeakGatePolicyOverlaps` names the mismatch.
 */
function extractKey(policy: Pick<Policy, "trigger">): string | null {
  const extract = policy.trigger.extract;
  if (extract === undefined) return null;
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(extract).sort()) {
    const value = extract[key];
    if (value !== undefined) sorted[key] = value;
  }
  return JSON.stringify(sorted);
}

/**
 * True when a hand-authored policy sharing the derived gate's trigger
 * surface + ledger_tag is strong enough to stand in for it: `enforcement:
 * "block"`, no `when:` risk/environment scoping, and not `operator_only:
 * true` (which carries no `requires:`/ledger_tag at all, so it would not
 * normally share a key, but the check is defensive since operator_only
 * would otherwise read as "block" and pass the enforcement check alone).
 *
 * F1 (review round 2, 99f47307 Slice 1): before this, `triggerSurfaceKey`
 * alone decided dedupe, so a hand-authored `enforcement: "warn"` policy
 * (or a `block` policy scoped down via `when:` to only some environments)
 * on the identical surface silently suppressed the derived BLOCK gate: a
 * `spawn: "required"` workflow step that LOOKED enforced actually
 * degraded to warn-only, or to unenforced outside the `when:` scope,
 * with no diagnostic anywhere. A weaker match no longer dedupes: the
 * derived block gate is ALSO produced (both apply), and
 * `findWeakGatePolicyOverlaps` surfaces the overlap so validate/doctor
 * can flag it instead of leaving it silent.
 */
function isAtLeastAsStrongAsDerivedGate(policy: Policy): boolean {
  return (
    policy.enforcement === "block" &&
    policy.when === undefined &&
    policy.operator_only !== true
  );
}

/**
 * Why `policy` does NOT qualify as at-least-as-strong (see
 * `isAtLeastAsStrongAsDerivedGate`), in a form suitable for a diagnostic
 * message. `null` when the policy DOES qualify (nothing weak to report).
 */
function weaknessReason(policy: Policy): string | null {
  if (isAtLeastAsStrongAsDerivedGate(policy)) return null;
  if (policy.enforcement !== "block") return `enforcement: ${policy.enforcement}`;
  if (policy.when !== undefined) return "when: (risk/environment-scoped)";
  if (policy.operator_only === true) return "operator_only: true";
  return "weaker than a plain block gate";
}

/**
 * Why a hand-authored policy on the derived gate's surface does NOT stand
 * in for it, or `null` when it does (same surface, same extract, at least
 * as strong). Strength is reported before an extract mismatch: a warn
 * policy with a wrong extract path is first and foremost a warn policy.
 */
function nonEquivalenceReason(handPolicy: Policy, derivedGate: Policy): string | null {
  const weakness = weaknessReason(handPolicy);
  if (weakness !== null) return weakness;
  const handExtract = extractKey(handPolicy);
  const gateExtract = extractKey(derivedGate);
  if (handExtract !== gateExtract) {
    return `trigger.extract differs (${handExtract ?? "none"} vs derived ${gateExtract ?? "none"})`;
  }
  return null;
}

function buildMcpMergeGatePolicy(workflowName: string): Policy {
  return {
    name: `workflow:${workflowName}:review-before-merge`,
    description:
      `Derived from workflows[] (workflow "${workflowName}"): a review_subagent step ` +
      `with spawn: "required" precedes a merge step, so block PR merges unless a ` +
      "ledger entry tagged review:<pr-number> exists for this session.",
    trigger: {
      event: "PreToolUse",
      match: MERGE_MCP_MATCH,
      extract: { PR_NUMBER: "toolArgs.prNumber" },
    },
    requires: { ledger_tag: "review:${PR_NUMBER}" },
    hook: REVIEW_EVIDENCE_HOOK_MCP,
    enforcement: "block",
    producers: [
      {
        kind: "mcp",
        verb: "mcp__grounding-mcp__ledger_add",
        example:
          '{sessionId:"${SESSION_ID}", type:"fact", content:"review:${PR_NUMBER}: <verdict + key findings + nits>", source:"Agent(general-purpose) review"}',
        description:
          "Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the PR number. The content should be self-contained enough for an auditor to read without re-opening the chat.",
      },
    ],
    ux: {
      cannot: "You cannot merge PR #${PR_NUMBER} yet.",
      required: ["a recorded review of PR #${PR_NUMBER}"],
      run: ['harness record review --pr ${PR_NUMBER} "<summary>"'],
    },
  };
}

function buildBashMergeGatePolicy(workflowName: string): Policy {
  return {
    name: `workflow:${workflowName}:review-before-merge-bash`,
    description:
      `Derived from workflows[] (workflow "${workflowName}"): a review_subagent step ` +
      'with spawn: "required" precedes a merge step, so block `gh pr merge` unless a ' +
      "ledger entry tagged review:<branch> exists for this session.",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: MERGE_BASH_MATCH,
    },
    requires: { ledger_tag: "review:${BRANCH}" },
    hook: REVIEW_EVIDENCE_HOOK_BASH,
    enforcement: "block",
    producers: [
      {
        kind: "mcp",
        verb: "mcp__grounding-mcp__ledger_add",
        example:
          '{sessionId:"${SESSION_ID}", type:"fact", content:"review:${BRANCH}: <verdict + key findings + nits>", source:"Agent(general-purpose) review"}',
        description:
          "Spawn a review subagent against the branch diff, capture its verdict, then persist a ledger entry tagged with the branch name. Mirror of the review-before-merge producer for the gh-cli surface.",
      },
    ],
    ux: {
      cannot: "You cannot merge the PR for branch ${BRANCH} via `gh pr merge` yet.",
      required: ["a recorded review of the PR for branch ${BRANCH}"],
      run: ['harness record review --pr <pr> "<summary>"'],
    },
  };
}

/**
 * The two task-scoped merge gates (task 2699b476), structurally identical
 * to templates.ts's `review-before-task-merge` /
 * `review-before-task-finish-automerge` apart from name and description.
 * They key on `review:${TASK_ID}` rather than the PR number because both
 * verbs derive owner/repo/PR from the task, so `toolArgs.taskId` is the
 * only identifier in the payload; `harness record review --pr <pr> --task
 * <id>` writes both tag families in ONE fact so a single recorded review
 * opens every merge surface.
 */
function buildTaskMergeGatePolicy(workflowName: string): Policy {
  return {
    name: `workflow:${workflowName}:review-before-task-merge`,
    description:
      `Derived from workflows[] (workflow "${workflowName}"): a review_subagent step ` +
      `with spawn: "required" precedes a merge step, so block agent-tasks task_merge ` +
      "unless a ledger entry tagged review:<task-id> exists for this session.",
    trigger: {
      event: "PreToolUse",
      match: TASK_MERGE_MCP_MATCH,
      extract: { ...TASK_ID_EXTRACT },
    },
    requires: { ledger_tag: "review:${TASK_ID}" },
    hook: REVIEW_EVIDENCE_HOOK_TASK_MERGE,
    enforcement: "block",
    producers: [
      {
        kind: "mcp",
        verb: "mcp__grounding-mcp__ledger_add",
        example:
          '{sessionId:"${SESSION_ID}", type:"fact", content:"review:${TASK_ID}: <verdict + key findings + nits>", source:"Agent(general-purpose) review"}',
        description:
          "Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the task id. Mirror of the review-before-merge producer for the task-scoped merge surface.",
      },
    ],
    ux: {
      cannot: "You cannot merge the PR for task ${TASK_ID} yet.",
      required: ["a recorded review of task ${TASK_ID}"],
      run: ['harness record review --pr <pr> --task ${TASK_ID} "<summary>"'],
    },
  };
}

function buildTaskFinishAutoMergeGatePolicy(workflowName: string): Policy {
  return {
    name: `workflow:${workflowName}:review-before-task-finish-automerge`,
    description:
      `Derived from workflows[] (workflow "${workflowName}"): a review_subagent step ` +
      `with spawn: "required" precedes a merge step, so block agent-tasks task_finish ` +
      "in its auto-merge mode unless a ledger entry tagged review:<task-id> exists for " +
      "this session.",
    trigger: {
      event: "PreToolUse",
      match: TASK_FINISH_MCP_MATCH,
      input_match: { ...TASK_FINISH_AUTOMERGE_INPUT_MATCH },
      extract: { ...TASK_ID_EXTRACT },
    },
    requires: { ledger_tag: "review:${TASK_ID}" },
    hook: REVIEW_EVIDENCE_HOOK_TASK_FINISH,
    enforcement: "block",
    producers: [
      {
        kind: "mcp",
        verb: "mcp__grounding-mcp__ledger_add",
        example:
          '{sessionId:"${SESSION_ID}", type:"fact", content:"review:${TASK_ID}: <verdict + key findings + nits>", source:"Agent(general-purpose) review"}',
        description:
          "Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the task id. Same evidence the task_merge gate reads, so one recorded review opens both.",
      },
    ],
    ux: {
      cannot: "You cannot finish task ${TASK_ID} with autoMerge yet.",
      required: ["a recorded review of task ${TASK_ID}"],
      run: ['harness record review --pr <pr> --task ${TASK_ID} "<summary>"'],
    },
  };
}

// F7 (review round 2): a registry of every `Policy` object this module has
// ever handed back from `deriveWorkflowGatePolicies`. `WeakSet` keys on
// object identity, not value equality, deliberately: two DIFFERENT
// workflows can derive value-identical-looking policies with different
// names, and a hand-authored policy could theoretically share a derived
// policy's exact shape too (nothing stops an operator hand-copying one
// into `policies:`). Identity is the only unambiguous "did THIS module
// produce THIS object" test. `harness export`/`list`/`doctor` use
// `isDerivedPolicy` to distinguish "declared by the operator" from
// "derived from workflows[]" without re-deriving and re-comparing.
const derivedPolicyRegistry = new WeakSet<Policy>();

/** True when `policy` is an object this module derived (see `withDerivedPolicies`). */
export function isDerivedPolicy(policy: Policy): boolean {
  return derivedPolicyRegistry.has(policy);
}

/**
 * The hand-authored slice of `manifest.policies`: everything the operator
 * wrote under `policies:`, none of the workflow-derived entries. Works on
 * either view (see module doc); on a hand-authored view it is the
 * identity.
 */
export function handAuthoredPolicies(manifest: Manifest): Policy[] {
  return manifest.policies.filter((p) => !isDerivedPolicy(p));
}

/** One weaker hand-authored policy sharing a derived gate's trigger surface. */
export interface WeakGatePolicyOverlap {
  /** The workflow whose `spawn: "required"` step derives the gate. */
  workflowName: string;
  /** Name of the derived policy that is ALSO in force (`workflow:<name>:review-before-merge[-bash]`). */
  derivedPolicyName: string;
  /** Human-readable surface label for the message (`mcp__agent-tasks__pull_requests_merge` or `` `gh pr merge` (Bash) ``). */
  surface: string;
  /** The weaker hand-authored policy's name. */
  handPolicyName: string;
  /** Why it does not stand in for the derived gate (see `nonEquivalenceReason`). */
  reason: string;
}

interface WorkflowGateDerivation {
  policies: Policy[];
  overlaps: WeakGatePolicyOverlap[];
}

/**
 * The ONE walk that decides, per qualifying workflow and per surface,
 * whether a gate is derived and which hand-authored policies overlap it.
 * `deriveWorkflowGatePolicies` and `findWeakGatePolicyOverlaps` are both
 * projections of this result, so they cannot disagree about what was
 * derived (F1, review round 3: the overlap finder used to re-implement
 * the walk without the `seen` set, and warned about a "derived" gate that
 * a strong hand-authored policy had in fact suppressed).
 *
 * Only HAND-authored policies feed the walk (`handAuthoredPolicies`), so
 * the result is the same whether the input is the hand-authored or the
 * derived view.
 */
function deriveWorkflowGates(manifest: Manifest): WorkflowGateDerivation {
  const empty: WorkflowGateDerivation = { policies: [], overlaps: [] };
  if (!hasWiredMergeGateHooks(manifest)) return empty;

  const hand = handAuthoredPolicies(manifest);
  const declaredHookNames = new Set(manifest.hooks.map((h) => h.name));
  const bySurface = new Map<string, Policy[]>();
  for (const policy of hand) {
    const key = triggerSurfaceKey(policy);
    const bucket = bySurface.get(key);
    if (bucket) bucket.push(policy);
    else bySurface.set(key, [policy]);
  }

  // Surfaces already covered: by an equivalent hand-authored policy (F1 +
  // F4: at least as strong AND extracting the same way), or by a gate an
  // earlier workflow in this same manifest already derived.
  const seen = new Set<string>();
  const derived: Policy[] = [];
  const overlaps: WeakGatePolicyOverlap[] = [];

  for (const workflow of manifest.workflows) {
    if (!workflowRequiresMergeGate(workflow)) continue;

    const candidates: Array<{ policy: Policy; surface: string }> = [
      { policy: buildMcpMergeGatePolicy(workflow.name), surface: MERGE_MCP_MATCH },
      { policy: buildBashMergeGatePolicy(workflow.name), surface: "`gh pr merge` (Bash)" },
      { policy: buildTaskMergeGatePolicy(workflow.name), surface: TASK_MERGE_MCP_MATCH },
      {
        policy: buildTaskFinishAutoMergeGatePolicy(workflow.name),
        surface: `${TASK_FINISH_MCP_MATCH} (autoMerge: true)`,
      },
    ];

    for (const { policy: candidate, surface } of candidates) {
      // A candidate whose own hook is not declared is skipped rather than
      // derived (task 2699b476): see REVIEW_EVIDENCE_HOOK_TASK_MERGE's
      // doc for why an unwired hook makes a derived gate inert rather
      // than enforcing. `hasWiredMergeGateHooks` above already guarantees
      // this holds for the two pull_requests_merge / gh pr merge
      // candidates, so their behaviour is unchanged.
      if (!declaredHookNames.has(candidate.hook)) continue;
      const key = triggerSurfaceKey(candidate);
      if (seen.has(key)) continue;
      const sharing = bySurface.get(key) ?? [];
      const reasons = sharing.map((hp) => ({
        handPolicy: hp,
        reason: nonEquivalenceReason(hp, candidate),
      }));
      if (reasons.some((r) => r.reason === null)) {
        // An equivalent hand-authored policy already gates this surface;
        // nothing is derived, so there is nothing to overlap with either.
        seen.add(key);
        continue;
      }
      derived.push(candidate);
      seen.add(key);
      for (const { handPolicy, reason } of reasons) {
        if (reason === null) continue;
        overlaps.push({
          workflowName: workflow.name,
          derivedPolicyName: candidate.name,
          surface,
          handPolicyName: handPolicy.name,
          reason,
        });
      }
    }
  }

  return { policies: derived, overlaps };
}

/**
 * Derive the merge-gate `Policy` pair for every workflow that needs one
 * and does not already have an equivalent policy (hand-authored, or
 * derived from an earlier workflow in the same manifest) intercepting
 * the same surface for the same evidence tag.
 *
 * Returns `[]` when `manifest.hooks[]` is missing either evidence hook
 * (see module doc: that gap is a `validate` error, not silent
 * derivation of an unenforceable policy) or when no workflow declares
 * a `spawn: "required"` review step followed by a merge step.
 */
export function deriveWorkflowGatePolicies(manifest: Manifest): Policy[] {
  return deriveWorkflowGates(manifest).policies;
}

/**
 * Every hand-authored policy that shares an ACTUALLY DERIVED gate's
 * trigger surface + ledger_tag but does not stand in for it: weaker
 * (F1, review round 2) or extracting its variables differently (F4,
 * review round 3). Both policies apply in that case, and the overlap is
 * worth flagging: an operator reading `enforcement: warn` on a
 * `two-reviewers-required`-shaped policy might reasonably believe THAT
 * is the only gate on the surface. `src/cli/validate/checks.ts` turns
 * each entry into a warning Diagnostic; `src/cli/doctor/index.ts`
 * renders the same list in the Workflows section.
 *
 * Mirrors `deriveWorkflowGatePolicies` exactly (same walk, same `seen`
 * set): a surface an equivalent hand-authored policy already covers
 * derives nothing and therefore reports nothing, even when a second,
 * weaker policy sits on it too. Returns `[]` when the evidence hooks are
 * not wired or no workflow needs a gate.
 */
export function findWeakGatePolicyOverlaps(manifest: Manifest): WeakGatePolicyOverlap[] {
  return deriveWorkflowGates(manifest).overlaps;
}

/**
 * The ONE place `workflows[]` gets folded into `manifest.policies` (F2,
 * review round 2). Before this, `src/cli/loader.ts#loadManifest` inlined
 * the append, so every OTHER manifest consumer that parses the manifest
 * a different way (`src/cli/validate/index.ts`'s `loadMergedRaw` +
 * `parseManifest`, notably) saw a manifest with no derived policies at
 * all, and `apply` and `validate` diverged. See the module doc for the
 * full list of readers and which view each one takes.
 *
 * Idempotent and view-agnostic (review round 3): the derivation runs on
 * `handAuthoredPolicies(manifest)` only and any derived entries already
 * present are replaced, so calling this on an already-derived view yields
 * the same policy names with no duplicates. Returns the input object
 * unchanged when there is nothing to derive and nothing to replace.
 *
 * Registers each derived `Policy` object in the module-level
 * `derivedPolicyRegistry` (F7) so `isDerivedPolicy` can later distinguish
 * it from a hand-authored one (used by `harness export`'s filter and
 * `list`/`doctor`'s "(derived from workflows[])" marker).
 */
export function withDerivedPolicies(manifest: Manifest): Manifest {
  const hand = handAuthoredPolicies(manifest);
  const derivedPolicies = deriveWorkflowGatePolicies(manifest);
  if (derivedPolicies.length === 0 && hand.length === manifest.policies.length) return manifest;
  for (const policy of derivedPolicies) derivedPolicyRegistry.add(policy);
  return { ...manifest, policies: [...hand, ...derivedPolicies] };
}

/**
 * The hand-authored view of a manifest that may carry derived policies:
 * what `harness export` emits and what the `.last-apply` manifest
 * snapshot stores, so nothing that gets written out or re-read later
 * carries a derived policy as if the operator had declared it. Returns
 * the input object unchanged when it carries no derived policy.
 */
export function withoutDerivedPolicies(manifest: Manifest): Manifest {
  const hand = handAuthoredPolicies(manifest);
  if (hand.length === manifest.policies.length) return manifest;
  return { ...manifest, policies: hand };
}
