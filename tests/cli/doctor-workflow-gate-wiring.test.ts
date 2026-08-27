// F3 (review round 2, 99f47307 Slice 1): `harness doctor` imported checks
// selectively (task adf037c1's `checkTemplatePolicyDrift`, task 037cfb7c's
// `checkTriggerBoundaryDrift`, ...) and never wired in
// `checkWorkflowGateWiring` (src/cli/validate/checks.ts). A manifest with
// a `spawn: "required"` review-then-merge workflow whose evidence hooks
// are missing or mis-wired therefore showed green under `harness doctor`
// while `harness validate` errored on the exact same manifest. This file
// covers doctor's Workflows section picking up both that error
// (checkWorkflowGateWiring) and the F1 weak-overlap warning
// (checkWorkflowGateWeakOverlap).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-workflow-gate-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

// Silences the (unrelated) operator_only template-policy-drift check so
// errorCount assertions are about the workflow gate alone.
const SILENCE_OPERATOR_ONLY_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

const WORKFLOW_REQUIRED = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
`;

const WIRED_HOOKS = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;

describe("doctor — checkWorkflowGateWiring wired into the Workflows section (F3)", () => {
  it("reports an error when spawn: required precedes a merge step but no evidence hook is declared", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1\n${SILENCE_OPERATOR_ONLY_DRIFT}${WORKFLOW_REQUIRED}hooks: []\n`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.workflows.errors).toHaveLength(1);
    expect(report.workflows.errors[0]).toContain("not wired");
    expect(report.errorCount).toBeGreaterThan(0);
    const text = format(report);
    expect(text).toContain("Workflows");
    expect(text).toContain("✗");
  });

  // Mutation probe M3 (this round): removing the `checkWorkflowGateWiring`
  // call from `buildWorkflows` (src/cli/doctor/index.ts) would leave
  // `report.workflows.errors` empty for this exact fixture, turning this
  // assertion red while `tests/cli/validate.test.ts`'s equivalent
  // assertion stays green — discriminating "doctor never wires the check
  // in" from "the check itself is broken".
  it("emits no workflow-gate error when both evidence hooks are correctly wired", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1\n${SILENCE_OPERATOR_ONLY_DRIFT}${WORKFLOW_REQUIRED}${WIRED_HOOKS}`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.workflows.errors).toEqual([]);
  });

  it("reports the F1 weak-overlap warning in the same Workflows section", async () => {
    const weakOverlapPolicy = `policies:
  - name: two-reviewers-required
    description: Warn-level companion sharing review-before-merge's exact surface + tag.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
      count:
        min: 2
    hook: require-review-evidence
    enforcement: warn
`;
    const home = makeFixture({
      "harness.yaml": `version: 1\n${SILENCE_OPERATOR_ONLY_DRIFT}${WORKFLOW_REQUIRED}${weakOverlapPolicy}${WIRED_HOOKS}`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.workflows.errors).toEqual([]);
    expect(report.workflows.warnings).toHaveLength(1);
    expect(report.workflows.warnings[0]).toContain("two-reviewers-required");
    const text = format(report);
    expect(text).toContain("⚠");
  });

  // F1 (review round 3, 99f47307 Slice 1): buildWorkflows delegates to
  // the shared checkWorkflows aggregate (src/cli/validate/checks.ts), but
  // the two tests above only exercise the pair doctor picked by hand
  // before (checkWorkflowGateWiring + checkWorkflowGateWeakOverlap). If
  // buildWorkflows were rolled back to that old pair, this file would
  // stay all-green while `harness validate` errors/warns on the exact
  // same manifests. These two assertions cover the other half of the
  // aggregate: checkWorkflowMergeBeforeReview and
  // checkWorkflowDerivedNameCollision.
  it("reports the merge-before-review warning (checkWorkflowMergeBeforeReview) in the Workflows section", async () => {
    const reversedWorkflow = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: merge
      - kind: review_subagent
        spawn: required
        template: t1
`;
    const home = makeFixture({
      "harness.yaml": `version: 1\n${SILENCE_OPERATOR_ONLY_DRIFT}${reversedWorkflow}${WIRED_HOOKS}`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.workflows.warnings).toHaveLength(1);
    expect(report.workflows.warnings[0]).toContain(
      "declares a required review step after its merge step",
    );
  });

  it("reports the derived-name-collision error (checkWorkflowDerivedNameCollision) in the Workflows section", async () => {
    const colliding = `policies:
  - name: workflow:ship:review-before-merge
    description: Same name as the derived gate, different surface.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "git push"
    requires:
      ledger_tag: "review:done"
    hook: require-review-evidence-bash
    enforcement: block
`;
    const home = makeFixture({
      "harness.yaml": `version: 1\n${SILENCE_OPERATOR_ONLY_DRIFT}${WORKFLOW_REQUIRED}${colliding}${WIRED_HOOKS}`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    expect(report.workflows.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("collides with the policy of the same name")]),
    );
  });

  it("marks a workflows[]-derived policy in the Policies section (F7)", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1\n${SILENCE_OPERATOR_ONLY_DRIFT}${WORKFLOW_REQUIRED}${WIRED_HOOKS}`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
    });
    const derived = report.policies.find((p) => p.name === "workflow:ship:review-before-merge");
    expect(derived).toBeDefined();
    expect(derived?.derived).toBe(true);
    const text = format(report);
    expect(text).toContain("(derived from workflows[])");
  });
});
