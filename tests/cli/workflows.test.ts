import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe as describeBlock, expect, it } from "vitest";
import { describe } from "../../src/cli/describe.js";
import { list } from "../../src/cli/list.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeHome(contents: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-workflows-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "harness.yaml"), contents, "utf8");
  return home;
}

const MANIFEST_WITH_WORKFLOWS = `
version: 1
workflows:
  - name: feature-pr
    when:
      task_label: ["feat", "fix"]
      project: harness
    steps:
      - kind: branch
        from: master
        per_task: true
      - kind: review_subagent
        spawn: required
        rigor: rigorous
        template: rigorous
        on_findings: fix_then_remerge
      - kind: ci_gate
        wait_for: completed/success
      - kind: merge
        method: squash
        gate: solo
  - name: docs-pr
    when:
      task_label: ["docs"]
    steps:
      - kind: review_subagent
        spawn: optional
        rigor: docs-only
      - kind: merge
        method: squash
        gate: solo
review_templates:
  rigorous: |
    Run through the rigorous checklist.
  docs-only: |
    Read prose; flag em-dashes.
`;

describeBlock("describe workflows / review_templates", () => {
  it("emits a workflows: section when the pillar is selected", () => {
    const homeDir = makeHome(MANIFEST_WITH_WORKFLOWS);
    const result = describe({ homeDir, pillar: "workflows" });
    expect(result.output).toContain("workflows:");
    expect(result.output).toContain("name: feature-pr");
    expect(result.output).toContain("template: rigorous");
    // Should NOT include review_templates pillar contents.
    expect(result.output).not.toContain("Run through the rigorous checklist.");
  });

  it("emits a review_templates: section when the pillar is selected", () => {
    const homeDir = makeHome(MANIFEST_WITH_WORKFLOWS);
    const result = describe({ homeDir, pillar: "review_templates" });
    expect(result.output).toContain("review_templates:");
    expect(result.output).toContain("Run through the rigorous checklist.");
  });
});

describeBlock("list workflows", () => {
  it("renders one row per workflow with its summary fields", () => {
    const homeDir = makeHome(MANIFEST_WITH_WORKFLOWS);
    const result = list("workflows", { homeDir });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      name: "feature-pr",
      review_spawn: "required",
      review_template: "rigorous",
      merge_gate: "solo",
    });
    expect(result.rows[1]).toMatchObject({
      name: "docs-pr",
      review_spawn: "optional",
      review_template: "",
    });
  });

  it("is filterable by --filter on workflow name", () => {
    const homeDir = makeHome(MANIFEST_WITH_WORKFLOWS);
    const result = list("workflows", { homeDir, filter: "docs" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("docs-pr");
  });
});
