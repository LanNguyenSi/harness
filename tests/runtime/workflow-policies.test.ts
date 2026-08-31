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
  findWeakGatePolicyOverlaps,
  handAuthoredPolicies,
  hasWiredMergeGateHooks,
  isDerivedPolicy,
  REVIEW_EVIDENCE_HOOK_BASH,
  REVIEW_EVIDENCE_HOOK_MCP,
  REVIEW_EVIDENCE_HOOK_TASK_FINISH,
  REVIEW_EVIDENCE_HOOK_TASK_MERGE,
  withDerivedPolicies,
  withoutDerivedPolicies,
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

// The two task-scoped merge-surface hooks (task 2699b476). Deliberately a
// SEPARATE list from WIRED_HOOKS above: a manifest declaring only the
// original pair must keep deriving only the original pair, so every
// pre-2699b476 case in this file keeps exercising that shape.
const TASK_VERB_HOOKS: Hook[] = [
  {
    name: REVIEW_EVIDENCE_HOOK_TASK_MERGE,
    event: "PreToolUse",
    match: "mcp__agent-tasks__task_merge",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 15000,
  },
  {
    name: REVIEW_EVIDENCE_HOOK_TASK_FINISH,
    event: "PreToolUse",
    match: "mcp__agent-tasks__task_finish",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 15000,
  },
];

const ALL_MERGE_GATE_HOOKS: Hook[] = [...WIRED_HOOKS, ...TASK_VERB_HOOKS];

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

  // F1 (review round 2): a WEAKER hand-authored policy on the identical
  // trigger surface + ledger_tag must NOT suppress the derived block gate
  // — only a policy at least as strong (enforcement: block, no when:, not
  // operator_only) may dedupe. Round-1 code deduped on trigger-surface-key
  // alone, so a `two-reviewers-required`-shaped warn policy silently
  // downgraded a `spawn: "required"` workflow to unenforced.
  describe("F1: weaker hand-authored policy does not suppress the derived gate", () => {
    it("enforcement: warn on the same surface — derived block gate is still produced", () => {
      const strong = shippedPolicy("review-before-merge");
      const weak: Policy = { ...strong, name: "two-reviewers-required", enforcement: "warn" };
      const manifest = makeManifest({
        hooks: WIRED_HOOKS,
        policies: [weak],
        workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
      });
      const derived = deriveWorkflowGatePolicies(manifest);
      const mcp = derived.find((p) => p.name === "workflow:ship:review-before-merge");
      expect(mcp).toBeDefined();
      expect(mcp?.enforcement).toBe("block");
    });

    it("mutation probe M1 (this round): reintroducing surface-key-only dedupe drops the derived gate again", () => {
      // Documents the exact failure the fix guards: if dedupe were keyed
      // purely on triggerSurfaceKey (ignoring enforcement/when/
      // operator_only), the weak policy above WOULD be treated as
      // "already covered" and the derived gate would vanish. The
      // preceding test's `toBeDefined()` assertion is what goes red if
      // that regression is reintroduced — this test just documents the
      // mutant in prose so a reviewer can locate the exact assertion.
      const strong = shippedPolicy("review-before-merge");
      const weak: Policy = { ...strong, name: "two-reviewers-required", enforcement: "warn" };
      const manifest = makeManifest({
        hooks: WIRED_HOOKS,
        policies: [weak],
        workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
      });
      expect(deriveWorkflowGatePolicies(manifest).length).toBeGreaterThan(0);
    });

    it("a hand policy scoped via when: on the same surface also does not suppress the gate", () => {
      const strong = shippedPolicy("review-before-merge");
      const whenScoped: Policy = {
        ...strong,
        name: "review-before-merge-prod-only",
        when: { "environment.name": "production" },
      };
      const manifest = makeManifest({
        hooks: WIRED_HOOKS,
        policies: [whenScoped],
        workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
      });
      const derived = deriveWorkflowGatePolicies(manifest);
      expect(derived.find((p) => p.name === "workflow:ship:review-before-merge")).toBeDefined();
    });

    it("a hand policy at LEAST as strong (block, no when, not operator_only) still dedupes", () => {
      // Unchanged round-1 behaviour, re-asserted here alongside the new
      // weak-overlap cases so the strong/weak boundary is visible in one
      // place.
      const strong = shippedPolicy("review-before-merge");
      const manifest = makeManifest({
        hooks: WIRED_HOOKS,
        policies: [strong],
        workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
      });
      const derived = deriveWorkflowGatePolicies(manifest);
      expect(derived.find((p) => p.name === "workflow:ship:review-before-merge")).toBeUndefined();
    });
  });
});

describe("findWeakGatePolicyOverlaps", () => {
  it("returns [] when the evidence hooks are not wired", () => {
    const strong = shippedPolicy("review-before-merge");
    const weak: Policy = { ...strong, name: "two-reviewers-required", enforcement: "warn" };
    const manifest = makeManifest({
      hooks: [],
      policies: [weak],
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    expect(findWeakGatePolicyOverlaps(manifest)).toEqual([]);
  });

  it("returns [] when no hand policy shares the derived surface", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    expect(findWeakGatePolicyOverlaps(manifest)).toEqual([]);
  });

  it("returns [] when the overlapping hand policy is at least as strong (round-1 dedupe case)", () => {
    const strong = shippedPolicy("review-before-merge");
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [strong],
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    expect(findWeakGatePolicyOverlaps(manifest)).toEqual([]);
  });

  it("reports the overlap for a weaker (enforcement: warn) hand policy on the derived MCP surface", () => {
    const strong = shippedPolicy("review-before-merge");
    const weak: Policy = { ...strong, name: "two-reviewers-required", enforcement: "warn" };
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [weak],
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    const overlaps = findWeakGatePolicyOverlaps(manifest);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      workflowName: "ship",
      derivedPolicyName: "workflow:ship:review-before-merge",
      handPolicyName: "two-reviewers-required",
      reason: "enforcement: warn",
    });
  });
});

describe("isDerivedPolicy / withDerivedPolicies (F2/F7)", () => {
  it("returns the SAME manifest reference when nothing is derived (no workflows)", () => {
    const manifest = makeManifest({ hooks: WIRED_HOOKS, workflows: [] });
    expect(withDerivedPolicies(manifest)).toBe(manifest);
  });

  it("appends derived policies and registers them as isDerivedPolicy", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
    const withDerived = withDerivedPolicies(manifest);
    expect(withDerived.policies.length).toBe(manifest.policies.length + 2);
    const derivedOnes = withDerived.policies.filter((p) => isDerivedPolicy(p));
    expect(derivedOnes).toHaveLength(2);
    // Hand-authored policies already on the manifest are NOT registered.
    for (const p of manifest.policies) {
      expect(isDerivedPolicy(p)).toBe(false);
    }
  });
});

// Review round 3 (99f47307 Slice 1): the overlap finder re-implemented the
// derivation walk WITHOUT its `seen` set, so a surface an equivalent
// hand-authored policy had already covered (nothing derived) still got a
// warning naming a `workflow:<name>:...` policy that did not exist
// (`harness validate` on the full template + a qualifying workflow: "0
// errors, 1 warning", `list policies` showing no workflow:* row). Both
// are now projections of one walk (`deriveWorkflowGates`).
describe("F1 (review round 3): findWeakGatePolicyOverlaps mirrors the dedupe walk", () => {
  const strong = () => shippedPolicy("review-before-merge");
  const weak = (): Policy => ({ ...strong(), name: "two-reviewers-required", enforcement: "warn" });
  const shipWorkflow = () => workflow("ship", [branchStep(), reviewStep("required"), mergeStep()]);

  it("reports nothing on a surface an equivalent hand policy already covers, even with a weaker second policy there", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [strong(), weak()],
      workflows: [shipWorkflow()],
    });
    // The MCP gate is NOT derived (the strong policy stands in for it), so
    // the weak policy overlaps nothing that exists; only the bash gate is
    // derived, and nothing hand-authored sits on that surface.
    expect(deriveWorkflowGatePolicies(manifest).map((p) => p.name)).toEqual([
      "workflow:ship:review-before-merge-bash",
    ]);
    expect(findWeakGatePolicyOverlaps(manifest)).toEqual([]);
  });

  it("the real FULL_TEMPLATE plus a qualifying workflow derives nothing and reports no overlap", () => {
    // FULL_TEMPLATE hand-authors review-before-merge (block) AND
    // two-reviewers-required (warn) on the MCP surface, plus
    // review-before-merge-bash (block) on the bash surface: both surfaces
    // are covered by an equivalent policy, so the workflow adds nothing.
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const manifest = { ...parsed, workflows: [shipWorkflow()] };
    expect(deriveWorkflowGatePolicies(manifest)).toEqual([]);
    expect(findWeakGatePolicyOverlaps(manifest)).toEqual([]);
  });

  it("names only the workflow whose gate was actually derived when two workflows share the surface", () => {
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [weak()],
      workflows: [
        shipWorkflow(),
        workflow("ship-b", [branchStep(), reviewStep("required"), mergeStep()]),
      ],
    });
    const overlaps = findWeakGatePolicyOverlaps(manifest);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.workflowName).toBe("ship");
    expect(overlaps[0]?.derivedPolicyName).toBe("workflow:ship:review-before-merge");
  });
});

// F4 (review round 3): `trigger.extract` was not part of the dedupe key.
// A hand-authored block policy on the derived surface that extracts
// PR_NUMBER from the WRONG path counted as equivalent, suppressed the
// derived gate, and then evaluated `review:${PR_NUMBER}` against an
// unresolved variable; under `risk.degraded_fail_posture: fail_open` the
// merge was allowed with "template variables unresolved".
describe("F4 (review round 3): trigger.extract is part of the equivalence key", () => {
  const shipWorkflow = () => workflow("ship", [branchStep(), reviewStep("required"), mergeStep()]);

  it("a block policy extracting PR_NUMBER from a different path does not dedupe the derived gate (both apply)", () => {
    const strong = shippedPolicy("review-before-merge");
    const wrongExtract: Policy = {
      ...strong,
      name: "review-before-merge-wrong-path",
      trigger: { ...strong.trigger, extract: { PR_NUMBER: "toolArgs.pr" } },
    };
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [wrongExtract],
      workflows: [shipWorkflow()],
    });
    const derived = deriveWorkflowGatePolicies(manifest);
    expect(derived.map((p) => p.name)).toContain("workflow:ship:review-before-merge");
    const overlaps = findWeakGatePolicyOverlaps(manifest);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      handPolicyName: "review-before-merge-wrong-path",
      derivedPolicyName: "workflow:ship:review-before-merge",
    });
    expect(overlaps[0]?.reason).toMatch(/trigger\.extract differs/);
    expect(overlaps[0]?.reason).toContain("toolArgs.pr");
    expect(overlaps[0]?.reason).toContain("toolArgs.prNumber");
  });

  it("a block policy with NO extract on the same surface + tag does not dedupe either", () => {
    const strong = shippedPolicy("review-before-merge");
    const { extract: _dropped, ...triggerWithoutExtract } = strong.trigger;
    const noExtract: Policy = {
      ...strong,
      name: "review-before-merge-no-extract",
      trigger: triggerWithoutExtract,
    };
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [noExtract],
      workflows: [shipWorkflow()],
    });
    expect(deriveWorkflowGatePolicies(manifest).map((p) => p.name)).toContain(
      "workflow:ship:review-before-merge",
    );
    expect(findWeakGatePolicyOverlaps(manifest)[0]?.reason).toMatch(/trigger\.extract differs \(none vs/);
  });

  it("strength is reported before an extract mismatch (a warn policy with a wrong path reads as warn)", () => {
    const strong = shippedPolicy("review-before-merge");
    const weakAndWrong: Policy = {
      ...strong,
      name: "warn-wrong-path",
      enforcement: "warn",
      trigger: { ...strong.trigger, extract: { PR_NUMBER: "toolArgs.pr" } },
    };
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [weakAndWrong],
      workflows: [shipWorkflow()],
    });
    expect(findWeakGatePolicyOverlaps(manifest)[0]?.reason).toBe("enforcement: warn");
  });
});

// F7 (review round 3): the two remaining `weaknessReason` branches.
describe("F7 (review round 3): weakness reasons for when-scoped and operator_only overlaps", () => {
  const shipWorkflow = () => workflow("ship", [branchStep(), reviewStep("required"), mergeStep()]);

  it("reports 'when: (risk/environment-scoped)' for a block policy scoped via when:", () => {
    const strong = shippedPolicy("review-before-merge");
    const whenScoped: Policy = {
      ...strong,
      name: "review-before-merge-prod-only",
      when: { "environment.name": "production" },
    };
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [whenScoped],
      workflows: [shipWorkflow()],
    });
    const overlaps = findWeakGatePolicyOverlaps(manifest);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      handPolicyName: "review-before-merge-prod-only",
      reason: "when: (risk/environment-scoped)",
    });
  });

  it("reports 'operator_only: true' for an operator_only block policy sharing the surface + tag", () => {
    // The schema forbids `operator_only: true` together with `requires:`
    // (src/schema/policies.ts), so a PARSED manifest can never reach this
    // branch; it is defensive against hand-built Policy objects, and this
    // test builds exactly such an object to pin the branch.
    const strong = shippedPolicy("review-before-merge");
    const operatorOnly: Policy = {
      ...strong,
      name: "review-before-merge-operator-only",
      operator_only: true,
    };
    const manifest = makeManifest({
      hooks: WIRED_HOOKS,
      policies: [operatorOnly],
      workflows: [shipWorkflow()],
    });
    const overlaps = findWeakGatePolicyOverlaps(manifest);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      handPolicyName: "review-before-merge-operator-only",
      reason: "operator_only: true",
    });
    // And the derived gate is still produced (operator_only does not dedupe).
    expect(deriveWorkflowGatePolicies(manifest).map((p) => p.name)).toContain(
      "workflow:ship:review-before-merge",
    );
  });
});

// Review round 3: the two view helpers are idempotent and accept either
// view, so no reader can double-derive or strip a hand-authored policy by
// calling them on the "wrong" side. See the module doc's view table.
describe("manifest views: withDerivedPolicies / withoutDerivedPolicies / handAuthoredPolicies", () => {
  const shipWorkflow = () => workflow("ship", [branchStep(), reviewStep("required"), mergeStep()]);
  const names = (m: { policies: Policy[] }) => m.policies.map((p) => p.name);

  it("withDerivedPolicies is idempotent: a second application yields the same names, no duplicates", () => {
    const hand = { ...shippedPolicy("preflight-before-investigation") };
    const raw = makeManifest({ hooks: WIRED_HOOKS, policies: [hand], workflows: [shipWorkflow()] });
    const once = withDerivedPolicies(raw);
    const twice = withDerivedPolicies(once);
    expect(names(once)).toEqual([
      "preflight-before-investigation",
      "workflow:ship:review-before-merge",
      "workflow:ship:review-before-merge-bash",
    ]);
    expect(names(twice)).toEqual(names(once));
    expect(twice.policies.filter((p) => isDerivedPolicy(p))).toHaveLength(2);
    // Hand-authored entries keep their identity through both applications.
    expect(twice.policies[0]).toBe(hand);
  });

  it("deriveWorkflowGatePolicies / findWeakGatePolicyOverlaps give the same answer on either view", () => {
    const weak: Policy = { ...shippedPolicy("review-before-merge"), name: "two-reviewers-required", enforcement: "warn" };
    const raw = makeManifest({ hooks: WIRED_HOOKS, policies: [weak], workflows: [shipWorkflow()] });
    const derivedView = withDerivedPolicies(raw);
    expect(deriveWorkflowGatePolicies(derivedView).map((p) => p.name)).toEqual(
      deriveWorkflowGatePolicies(raw).map((p) => p.name),
    );
    expect(findWeakGatePolicyOverlaps(derivedView)).toEqual(findWeakGatePolicyOverlaps(raw));
  });

  it("withoutDerivedPolicies restores the hand-authored view and is the identity on it", () => {
    const hand = shippedPolicy("preflight-before-investigation");
    const raw = makeManifest({ hooks: WIRED_HOOKS, policies: [hand], workflows: [shipWorkflow()] });
    const derivedView = withDerivedPolicies(raw);
    const restored = withoutDerivedPolicies(derivedView);
    expect(names(restored)).toEqual(["preflight-before-investigation"]);
    expect(restored.policies[0]).toBe(hand);
    expect(withoutDerivedPolicies(raw)).toBe(raw);
    expect(handAuthoredPolicies(derivedView)).toEqual([hand]);
  });
});

// ---------------------------------------------------------------------------
// Task 2699b476: the two task-scoped merge surfaces
// ---------------------------------------------------------------------------

describe("deriveWorkflowGatePolicies: task-scoped merge gates (task 2699b476)", () => {
  function qualifyingManifest(hooks: Hook[], policies: Policy[] = []) {
    return makeManifest({
      hooks,
      policies,
      workflows: [workflow("ship", [branchStep(), reviewStep("required"), mergeStep()])],
    });
  }

  it("derives all four gates when all four hooks are wired", () => {
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(ALL_MERGE_GATE_HOOKS));
    expect(derived.map((p) => p.name).sort()).toEqual(
      [
        "workflow:ship:review-before-merge",
        "workflow:ship:review-before-merge-bash",
        "workflow:ship:review-before-task-merge",
        "workflow:ship:review-before-task-finish-automerge",
      ].sort(),
    );
  });

  // Backwards compatibility, and the reason the two new hooks are NOT part
  // of `hasWiredMergeGateHooks`: an unwired hook means settings.json never
  // spawns `harness policy intercept` for that verb, so a derived gate
  // there would be inert while reading as enforced.
  it("derives only the original pair when the task-verb hooks are absent", () => {
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(WIRED_HOOKS));
    expect(derived.map((p) => p.name).sort()).toEqual(
      ["workflow:ship:review-before-merge", "workflow:ship:review-before-merge-bash"].sort(),
    );
  });

  it("derives each task-verb gate independently of the other's hook", () => {
    const merged = deriveWorkflowGatePolicies(
      qualifyingManifest([...WIRED_HOOKS, TASK_VERB_HOOKS[0]!]),
    );
    expect(merged.map((p) => p.name)).toContain("workflow:ship:review-before-task-merge");
    expect(merged.map((p) => p.name)).not.toContain(
      "workflow:ship:review-before-task-finish-automerge",
    );
  });

  // Same comparison the pre-2699b476 parity assertion applies to the
  // original pair (trigger surface, hook, enforcement, requires), now
  // covering all FOUR derived gates in one place.
  it("parity: all four derived gates match the policies templates.ts ships", () => {
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(ALL_MERGE_GATE_HOOKS));
    const pairs: Array<[string, string]> = [
      ["workflow:ship:review-before-merge", "review-before-merge"],
      ["workflow:ship:review-before-merge-bash", "review-before-merge-bash"],
      ["workflow:ship:review-before-task-merge", "review-before-task-merge"],
      [
        "workflow:ship:review-before-task-finish-automerge",
        "review-before-task-finish-automerge",
      ],
    ];
    for (const [derivedName, shippedName] of pairs) {
      const gate = derived.find((p) => p.name === derivedName);
      expect(gate, `${derivedName} not derived`).toBeDefined();
      const shipped = shippedPolicy(shippedName);
      expect(gate?.trigger).toEqual(shipped.trigger);
      expect(gate?.hook).toBe(shipped.hook);
      expect(gate?.enforcement).toBe(shipped.enforcement);
      expect(gate?.requires).toEqual(shipped.requires);
      expect(gate?.when).toEqual(shipped.when);
      expect(gate?.operator_only).toEqual(shipped.operator_only);
    }
  });

  // Stricter parity for the two gates this task adds: the agent-facing
  // `producers:` / `ux:` blocks are byte-identical to the shipped ones
  // too, so the remediation text an agent reads is the same whether the
  // gate came from `policies:` or from `workflows:`.
  //
  // Deliberately NOT asserted for the ORIGINAL pair: their derived
  // `producers[].example` has used `review:${PR_NUMBER}: <verdict...>`
  // since 99f47307 Slice 1 while templates.ts uses an em-dash separator
  // there. That drift predates this task and changing either side would
  // change the existing pair's behaviour, which this task must not do.
  it("parity: the two task-scoped gates also match the shipped producers and ux", () => {
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(ALL_MERGE_GATE_HOOKS));
    const pairs: Array<[string, string]> = [
      ["workflow:ship:review-before-task-merge", "review-before-task-merge"],
      [
        "workflow:ship:review-before-task-finish-automerge",
        "review-before-task-finish-automerge",
      ],
    ];
    for (const [derivedName, shippedName] of pairs) {
      const gate = derived.find((p) => p.name === derivedName);
      const shipped = shippedPolicy(shippedName);
      expect(gate?.producers).toEqual(shipped.producers);
      expect(gate?.ux).toEqual(shipped.ux);
    }
  });

  it("the derived task_finish gate carries the autoMerge input_match predicate", () => {
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(ALL_MERGE_GATE_HOOKS));
    const gate = derived.find(
      (p) => p.name === "workflow:ship:review-before-task-finish-automerge",
    );
    expect(gate?.trigger.input_match).toEqual({ "toolArgs.autoMerge": true });
  });

  it("an equivalent hand-authored task-verb policy dedupes the derived gate", () => {
    const hand = shippedPolicy("review-before-task-merge");
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(ALL_MERGE_GATE_HOOKS, [hand]));
    expect(derived.find((p) => p.name === "workflow:ship:review-before-task-merge")).toBeUndefined();
    // The other three surfaces are untouched by that dedupe.
    expect(derived).toHaveLength(3);
  });

  // Mutation probe (d) in this task's brief: dropping `input_match` from
  // `triggerSurfaceKey` makes these two policies share a key, so the
  // `autoMerge: false` policy would dedupe the derived `autoMerge: true`
  // gate away and the merging call would go ungated while the manifest
  // still reads as covered. Both assertions below go red under that mutant.
  it("input_match is part of the surface key: an autoMerge:false hand policy does NOT dedupe the autoMerge:true gate", () => {
    const shipped = shippedPolicy("review-before-task-finish-automerge");
    const inverted: Policy = {
      ...shipped,
      name: "allow-plain-task-finish",
      trigger: { ...shipped.trigger, input_match: { "toolArgs.autoMerge": false } },
    };
    const derived = deriveWorkflowGatePolicies(
      qualifyingManifest(ALL_MERGE_GATE_HOOKS, [inverted]),
    );
    const gate = derived.find(
      (p) => p.name === "workflow:ship:review-before-task-finish-automerge",
    );
    expect(gate).toBeDefined();
    expect(gate?.trigger.input_match).toEqual({ "toolArgs.autoMerge": true });
  });

  it("input_match is part of the surface key: a policy with NO input_match does not dedupe the narrowed gate", () => {
    const shipped = shippedPolicy("review-before-task-finish-automerge");
    const broad: Policy = { ...shipped, name: "gate-every-task-finish", trigger: { ...shipped.trigger } };
    delete broad.trigger.input_match;
    const derived = deriveWorkflowGatePolicies(qualifyingManifest(ALL_MERGE_GATE_HOOKS, [broad]));
    expect(
      derived.find((p) => p.name === "workflow:ship:review-before-task-finish-automerge"),
    ).toBeDefined();
  });

  it("a weaker hand policy on the task_merge surface is reported as an overlap, not a dedupe", () => {
    const shipped = shippedPolicy("review-before-task-merge");
    const weak: Policy = { ...shipped, name: "task-merge-warn-only", enforcement: "warn" };
    const manifest = qualifyingManifest(ALL_MERGE_GATE_HOOKS, [weak]);
    expect(
      deriveWorkflowGatePolicies(manifest).find(
        (p) => p.name === "workflow:ship:review-before-task-merge",
      ),
    ).toBeDefined();
    const overlaps = findWeakGatePolicyOverlaps(manifest);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      derivedPolicyName: "workflow:ship:review-before-task-merge",
      handPolicyName: "task-merge-warn-only",
      reason: "enforcement: warn",
    });
  });
});
