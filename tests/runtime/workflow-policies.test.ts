// 99f47307 Slice 1: runtime enforcement for `workflows:`.
//
// Unit coverage for `deriveWorkflowGatePolicies` / `workflowRequiresMergeGate`
// (src/runtime/workflow-policies.ts): the pure function `src/cli/loader.ts`
// calls after every manifest parse to turn a `review_subagent (spawn:
// required) -> merge` workflow shape into the same runtime policy pair
// `harness init --template full` hand-authors (`review-before-merge` /
// `review-before-merge-bash`, `src/cli/init/templates.ts`).
//
// Intercept-level (allow/deny via the real `harness policy intercept`
// entrypoint, loaded from an on-disk manifest) coverage lives in
// tests/runtime/intercept-cli-workflow-gate.test.ts. `harness validate`
// coverage for the companion `checkWorkflowGateWiring` check lives in
// tests/cli/validate.test.ts.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  deriveWorkflowGatePolicies,
  hasWiredMergeGateHooks,
  REVIEW_EVIDENCE_HOOK_BASH,
  REVIEW_EVIDENCE_HOOK_MCP,
  workflowRequiresMergeGate,
} from "../../src/runtime/workflow-policies.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { makeManifest } from "../_helpers/manifest.js";
import {
  parseManifest,
  type Hook,
  type Policy,
  type Workflow,
  type WorkflowStep,
} from "../../src/schema/index.js";

// Real hooks, byte-identical to the pair `src/cli/init/templates.ts` wires
// for the hand-authored merge gate (name, event, match, bash_match). Only
// `command` / `blocking` / `budget_ms` matter for `hasWiredMergeGateHooks`
// (name presence), the rest is here for readability / realism.
const WIRED_HOOKS: Hook[] = [
  {
    name: REVIEW_EVIDENCE_HOOK_MCP,
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_merge",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 15000,
  },
  {
    name: REVIEW_EVIDENCE_HOOK_BASH,
    event: "PreToolUse",
    match: "Bash",
    bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 15000,
  },
];

function branchStep(): WorkflowStep {
  return { kind: "branch", from: "master", per_task: true };
}

function reviewStep(spawn: "required" | "optional" | "skip"): WorkflowStep {
  return {
    kind: "review_subagent",
    spawn,
    agent_type: "Explore",
    rigor: "rigorous",
    template: spawn === "required" ? "t1" : undefined,
    on_findings: "fix_then_remerge",
  } as WorkflowStep;
}

function ciGateStep(): WorkflowStep {
  return { kind: "ci_gate", wait_for: "completed/success" };
}

function mergeStep(): WorkflowStep {
  return { kind: "merge", method: "squash", gate: "solo" };
}

function workflow(name: string, steps: WorkflowStep[]): Workflow {
  return { name, when: {}, steps } as Workflow;
}

/**
 * Read the exact `trigger` / `requires.ledger_tag` templates.ts ships for
 * `review-before-merge` / `review-before-merge-bash`, straight out of the
 * parsed FULL_TEMPLATE. Mirrors the `policyBashMatch` precedent in
 * tests/runtime/intercept-cli.test.ts: a hand-copied literal here would
 * keep passing after templates.ts drifts, silently certifying a stale
 * shape.
 */
function shippedPolicy(name: string): Policy {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === name);
  if (!policy) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
  return policy;
}

describe("workflowRequiresMergeGate", () => {
  it("is false for an empty steps-adjacent workflow (no merge step)", () => {
    expect(workflowRequiresMergeGate(workflow("w", [branchStep(), reviewStep("required")]))).toBe(
      false,
    );
  });

  it("is false when the review step is spawn: optional", () => {
    expect(
      workflowRequiresMergeGate(
        workflow("w", [branchStep(), reviewStep("optional"), mergeStep()]),
      ),
    ).toBe(false);
  });

  it("is false when the review step is spawn: skip", () => {
    expect(
      workflowRequiresMergeGate(workflow("w", [branchStep(), reviewStep("skip"), mergeStep()])),
    ).toBe(false);
  });

  it("is true when spawn: required precedes a later merge step (a ci_gate in between)", () => {
    expect(
      workflowRequiresMergeGate(
        workflow("w", [branchStep(), reviewStep("required"), ciGateStep(), mergeStep()]),
      ),
    ).toBe(true);
  });

  it("is false when the required review step comes AFTER the merge step", () => {
    expect(
      workflowRequiresMergeGate(workflow("w", [mergeStep(), reviewStep("required")])),
    ).toBe(false);
  });
});

describe("hasWiredMergeGateHooks", () => {
  it("is false when neither evidence hook is declared", () => {
    expect(hasWiredMergeGateHooks(makeManifest({ hooks: [] }))).toBe(false);
  });

  it("is false when only one of the two evidence hooks is declared", () => {
    expect(hasWiredMergeGateHooks(makeManifest({ hooks: [WIRED_HOOKS[0]!] }))).toBe(false);
  });

  it("is true when both evidence hooks are declared", () => {
    expect(hasWiredMergeGateHooks(makeManifest({ hooks: WIRED_HOOKS }))).toBe(true);
  });
});

describe("deriveWorkflowGatePolicies", () => {
  it("returns [] for a manifest with no workflows", () => {
    expect(deriveWorkflowGatePolicies(makeManifest({ hooks: WIRED_HOOKS, workflows: [] }))).toEqual(
      [],
    );
  });

  it("returns [] when the review step is spawn: optional or skip (no gate needed)", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [
        workflow("w1", [branchStep(), reviewStep("optional"), mergeStep()]),
        workflow("w2", [branchStep(), reviewStep("skip"), mergeStep()]),
      ],
    });
    expect(deriveWorkflowGatePolicies(manifest)).toEqual([]);
  });

  it("returns [] for a qualifying workflow when the evidence hooks are NOT wired (M2 guard)", () => {
    const manifest = makeManifest({
      hooks: [],
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    expect(deriveWorkflowGatePolicies(manifest)).toEqual([]);
  });

  it("returns [] for a workflow with no merge step at all", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [workflow("no-merge", [branchStep(), reviewStep("required")])],
    });
    expect(deriveWorkflowGatePolicies(manifest)).toEqual([]);
  });

  it("derives the exact review-before-merge / review-before-merge-bash pair for a qualifying workflow", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [
        workflow("ship", [branchStep(), reviewStep("required"), ciGateStep(), mergeStep()]),
      ],
    });
    const derived = deriveWorkflowGatePolicies(manifest);
    expect(derived).toHaveLength(2);

    const mcp = derived.find((p) => p.name === "workflow:ship:review-before-merge");
    const bash = derived.find((p) => p.name === "workflow:ship:review-before-merge-bash");
    expect(mcp).toBeDefined();
    expect(bash).toBeDefined();

    const shippedMcp = shippedPolicy("review-before-merge");
    const shippedBash = shippedPolicy("review-before-merge-bash");

    // Parity with templates.ts's hand-authored pair: same trigger surface,
    // same hook, same enforcement, same requires.ledger_tag. Name and
    // description are the only fields allowed to differ (provenance).
    expect(mcp?.trigger).toEqual(shippedMcp.trigger);
    expect(mcp?.hook).toBe(shippedMcp.hook);
    expect(mcp?.hook).toBe(REVIEW_EVIDENCE_HOOK_MCP);
    expect(mcp?.enforcement).toBe(shippedMcp.enforcement);
    expect(mcp?.requires?.ledger_tag).toBe(shippedMcp.requires?.ledger_tag);

    expect(bash?.trigger).toEqual(shippedBash.trigger);
    expect(bash?.hook).toBe(shippedBash.hook);
    expect(bash?.hook).toBe(REVIEW_EVIDENCE_HOOK_BASH);
    expect(bash?.enforcement).toBe(shippedBash.enforcement);
    expect(bash?.requires?.ledger_tag).toBe(shippedBash.requires?.ledger_tag);
  });

  it("dedupes against an existing hand-authored policy on the same trigger surface + ledger_tag", () => {
    const handAuthored = shippedPolicy("review-before-merge");
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [handAuthored],
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    const derived = deriveWorkflowGatePolicies(manifest);
    // The MCP variant dupes the hand-authored policy's surface + tag and is
    // skipped; the bash variant has no hand-authored counterpart here and
    // is still derived (kein Doppel-Intercept, not "derive nothing").
    expect(derived).toHaveLength(1);
    expect(derived[0]?.name).toBe("workflow:ship:review-before-merge-bash");
  });

  it("dedupes across two workflows that would otherwise derive the identical policy twice", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [
        workflow("ship-a", [branchStep(), reviewStep("required"), mergeStep()]),
        workflow("ship-b", [branchStep(), reviewStep("required"), mergeStep()]),
      ],
    });
    const derived = deriveWorkflowGatePolicies(manifest);
    // Both workflows are named differently, so their derived policy NAMES
    // differ (workflow:ship-a:... vs workflow:ship-b:...), dedupe is keyed
    // on trigger surface + ledger_tag, not name, so the first workflow wins
    // and the second's would-be-duplicate pair is skipped entirely.
    expect(derived).toHaveLength(2);
    expect(derived.map((p) => p.name).sort()).toEqual(
      ["workflow:ship-a:review-before-merge", "workflow:ship-a:review-before-merge-bash"].sort(),
    );
  });

  it("mutation probe M1: flipping spawn required -> skip drops the derived policy entirely", () => {
    const requiredManifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    expect(deriveWorkflowGatePolicies(requiredManifest)).toHaveLength(2);

    const skippedManifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [workflow("ship", [branchStep(), reviewStep("skip"), mergeStep()])],
    });
    expect(deriveWorkflowGatePolicies(skippedManifest)).toEqual([]);
  });
});
