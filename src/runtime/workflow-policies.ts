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

const MERGE_MCP_MATCH = "mcp__agent-tasks__pull_requests_merge";
// Byte-identical to templates.ts's `review-before-merge-bash` trigger
// (verified against the parsed FULL_TEMPLATE at authoring time; pinned
// by tests/runtime/workflow-policies.test.ts's parity assertion so the
// two cannot silently drift apart).
const MERGE_BASH_MATCH = "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b";

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
 * so `deriveWorkflowGatePolicies` skips deriving a duplicate.
 */
function triggerSurfaceKey(policy: Pick<Policy, "trigger" | "requires">): string {
  return JSON.stringify({
    event: policy.trigger.event,
    match: policy.trigger.match ?? null,
    bash_match: policy.trigger.bash_match ?? null,
    ledger_tag: policy.requires?.ledger_tag ?? null,
  });
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

  const seen = new Set<string>(manifest.policies.map((p) => triggerSurfaceKey(p)));
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
