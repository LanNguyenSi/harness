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
 * the SAME policy pair `harness init --template full` would hand-author
 * (`src/cli/init/templates.ts` `review-before-merge` /
 * `review-before-merge-bash`), renamed per workflow so the provenance
 * is visible in `harness list policies` / `harness explain`.
 *
 * Deliberately does NOT touch `src/runtime/intercept.ts`: the engine
 * already knows how to evaluate a `Policy`, so the only thing missing
 * was a `Policy` to hand it. `src/cli/loader.ts#loadManifest` calls
 * this after parsing and appends the result to `manifest.policies`
 * before any consumer (the CLI `policy intercept` entrypoint, `list`,
 * `explain`, `explain-policy`) reads it.
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
 * Canonical key for "does this policy already intercept the same
 * surface for the same evidence?": event + match + bash_match +
 * requires.ledger_tag. Two policies sharing this key would double-fire
 * `harness policy intercept` on the identical event (double the ledger
 * query, double the audit write) for no additional enforcement value,
 * so `deriveWorkflowGatePolicies` skips deriving a duplicate — but ONLY
 * when the existing policy is at least as strong as the gate it would
 * be standing in for (see `isAtLeastAsStrongAsDerivedGate` immediately
 * below; F1, review round 2).
 */
function triggerSurfaceKey(policy: Pick<Policy, "trigger" | "requires">): string {
  return JSON.stringify({
    event: policy.trigger.event,
    match: policy.trigger.match ?? null,
    bash_match: policy.trigger.bash_match ?? null,
    ledger_tag: policy.requires?.ledger_tag ?? null,
  });
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
 * on the identical surface silently suppressed the derived BLOCK gate —
 * a `spawn: "required"` workflow step that LOOKED enforced actually
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
 * Derive the merge-gate `Policy` pair for every workflow that needs one
 * and does not already have an equivalent policy (hand-authored or
 * derived from an earlier workflow in the same manifest) intercepting
 * the same surface for the same evidence tag.
 *
 * Returns `[]` when `manifest.hooks[]` is missing either evidence hook
 * (see module doc: that gap is a `validate` error, not silent
 * derivation of an unenforceable policy) or when no workflow declares
 * a `spawn: "required"` review step followed by a merge step.
 */
export function deriveWorkflowGatePolicies(manifest: Manifest): Policy[] {
  if (!hasWiredMergeGateHooks(manifest)) return [];

  // F1 (review round 2): only an AT-LEAST-AS-STRONG hand-authored policy
  // seeds `seen` — a weaker one (enforcement: warn/require_approval, or
  // when:-scoped) shares the surface but must not suppress the derived
  // block gate. See `isAtLeastAsStrongAsDerivedGate`.
  const seen = new Set<string>(
    manifest.policies.filter(isAtLeastAsStrongAsDerivedGate).map((p) => triggerSurfaceKey(p)),
  );
  const derived: Policy[] = [];

  for (const workflow of manifest.workflows) {
    if (!workflowRequiresMergeGate(workflow)) continue;

    const mcpPolicy = buildMcpMergeGatePolicy(workflow.name);
    const mcpKey = triggerSurfaceKey(mcpPolicy);
    if (!seen.has(mcpKey)) {
      derived.push(mcpPolicy);
      seen.add(mcpKey);
    }

    const bashPolicy = buildBashMergeGatePolicy(workflow.name);
    const bashKey = triggerSurfaceKey(bashPolicy);
    if (!seen.has(bashKey)) {
      derived.push(bashPolicy);
      seen.add(bashKey);
    }
  }

  return derived;
}

/** One weaker hand-authored policy sharing a derived gate's trigger surface. */
export interface WeakGatePolicyOverlap {
  /** The workflow whose `spawn: "required"` step derives the gate. */
  workflowName: string;
  /** Name the derived policy would carry (`workflow:<name>:review-before-merge[-bash]`). */
  derivedPolicyName: string;
  /** Human-readable surface label for the message (`mcp__agent-tasks__pull_requests_merge` or `` `gh pr merge` (Bash) ``). */
  surface: string;
  /** The weaker hand-authored policy's name. */
  handPolicyName: string;
  /** Why it does not qualify as at-least-as-strong (see `weaknessReason`). */
  reason: string;
}

/**
 * Every hand-authored policy that shares a derived gate's trigger surface
 * + ledger_tag but is NOT strong enough to dedupe against (F1, review
 * round 2). `deriveWorkflowGatePolicies` still derives the block gate in
 * this case (both policies apply), but the overlap is worth flagging: an
 * operator reading `enforcement: warn` on `two-reviewers-required`-shaped
 * policy might reasonably believe THAT is the only gate on the surface.
 * `src/cli/validate/checks.ts` turns each entry into a warning
 * Diagnostic; `src/cli/doctor/index.ts` renders the same list in the
 * Workflows section. Returns `[]` when the evidence hooks are not wired
 * (mirrors `deriveWorkflowGatePolicies`'s own fail direction: nothing is
 * derived, so there is nothing to overlap with) or no workflow needs a
 * gate.
 */
export function findWeakGatePolicyOverlaps(manifest: Manifest): WeakGatePolicyOverlap[] {
  if (!hasWiredMergeGateHooks(manifest)) return [];

  const overlaps: WeakGatePolicyOverlap[] = [];
  for (const workflow of manifest.workflows) {
    if (!workflowRequiresMergeGate(workflow)) continue;

    const candidates: Array<{ policy: Policy; surface: string }> = [
      { policy: buildMcpMergeGatePolicy(workflow.name), surface: MERGE_MCP_MATCH },
      { policy: buildBashMergeGatePolicy(workflow.name), surface: "`gh pr merge` (Bash)" },
    ];

    for (const { policy: candidate, surface } of candidates) {
      const key = triggerSurfaceKey(candidate);
      for (const handPolicy of manifest.policies) {
        if (triggerSurfaceKey(handPolicy) !== key) continue;
        const reason = weaknessReason(handPolicy);
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
  return overlaps;
}

// F7 (review round 2): a registry of every `Policy` object this module has
// ever handed back from `deriveWorkflowGatePolicies`. `WeakSet` keys on
// object identity, not value equality — deliberately: two DIFFERENT
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
 * The ONE place `workflows[]` gets folded into `manifest.policies` (F2,
 * review round 2). Before this, `src/cli/loader.ts#loadManifest` inlined
 * the append, so every OTHER manifest consumer that parses the manifest
 * a different way (`src/cli/validate/index.ts`'s `loadMergedRaw` +
 * `parseManifest`, notably) saw a manifest with no derived policies at
 * all — `apply` and `validate` diverged: a manifest with `workflows:` +
 * both evidence hooks but no hand-authored policies and no `grounding-mcp`
 * validated with "0 errors" while `apply --dry-run` refused with "policies
 * declared but grounding-mcp not wired". Both loader.ts and
 * src/cli/validate/index.ts (and therefore `doctor`, which loads via
 * loadManifest) now call this function so they share one view of
 * "effective policies".
 *
 * Registers each derived `Policy` object in the module-level
 * `derivedPolicyRegistry` (F7) so `isDerivedPolicy` can later distinguish
 * it from a hand-authored one (used by `harness export`'s filter and
 * `list`/`doctor`'s "(derived from workflows[])" marker).
 */
export function withDerivedPolicies(manifest: Manifest): Manifest {
  const derivedPolicies = deriveWorkflowGatePolicies(manifest);
  if (derivedPolicies.length === 0) return manifest;
  for (const policy of derivedPolicies) derivedPolicyRegistry.add(policy);
  return { ...manifest, policies: [...manifest.policies, ...derivedPolicies] };
}
