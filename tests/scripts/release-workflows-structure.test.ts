import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Pins the structure of the publish chain: the npm publish must wait for the
// full CI, CI and publish must use one resolved commit, and a running publish
// or release is never cancelled. actionlint cannot see any of this.

type Step = {
  name?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  permissions?: Record<string, string>;
  uses?: string; needs?: string | string[]; with?: Record<string, unknown>; steps?: Step[] };
type Workflow = {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, Job>;
};

function load(file: string): Workflow {
  return parse(readFileSync(join(process.cwd(), ".github/workflows", file), "utf8")) as Workflow;
}

const asList = (needs: string | string[] | undefined): string[] =>
  needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];

describe("publish-npm.yml", () => {
  const wf = load("publish-npm.yml");
  const publish = wf.jobs.publish as Job;

  it("runs the reusable CI against the resolved commit", () => {
    expect(wf.jobs.ci?.uses).toBe("./.github/workflows/ci.yml");
    expect(asList(wf.jobs.ci?.needs)).toContain("resolve");
    expect(wf.jobs.ci?.with?.ref).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("publish waits for CI and for the resolve job", () => {
    expect(asList(publish.needs)).toEqual(expect.arrayContaining(["ci", "resolve"]));
  });

  it("publish checks out the resolved SHA, not the tag name", () => {
    const checkout = publish.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ needs.resolve.outputs.sha }}");
  });

  it("no job in the chain has a job-level `if:` (always() would publish past a red CI)", () => {
    for (const name of ["resolve", "ci", "publish"]) {
      expect(wf.jobs[name]?.if, `job ${name}`).toBeUndefined();
    }
  });

  it("verifies the checkout is the resolved commit before setup-node and the build", () => {
    const steps = publish.steps ?? [];
    const verifyAt = steps.findIndex((s) => s.name === "Verify checkout is the resolved commit");
    expect(verifyAt).toBeGreaterThan(-1);
    const verify = steps[verifyAt] as Step;
    expect(verify.env?.EXPECTED_SHA).toBe("${{ needs.resolve.outputs.sha }}");
    expect(verify.run).toContain("git rev-parse HEAD");
    expect(verify.run).toMatch(/\[ "\$\{actual\}" != "\$\{EXPECTED_SHA\}" \]/);
    const setupAt = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
    const buildAt = steps.findIndex((s) => s.run === "npm run build");
    expect(setupAt).toBeGreaterThan(verifyAt);
    expect(buildAt).toBeGreaterThan(verifyAt);
  });

  it("grants id-token: write to the publish job only", () => {
    expect(wf.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.resolve?.permissions?.["id-token"]).toBeUndefined();
    expect(wf.jobs.ci?.permissions?.["id-token"]).toBeUndefined();
    expect(publish.permissions?.["id-token"]).toBe("write");
    expect(publish.permissions?.contents).toBe("read");
  });

  it("no publish step is skipped by an `if:` (CI failure must stop the job)", () => {
    for (const step of publish.steps ?? []) {
      expect(step.if, `step ${step.name ?? step.uses}`).toBeUndefined();
    }
  });
});

describe.each(["publish-npm.yml", "release.yml"])("%s concurrency", (file) => {
  it("never cancels a running job", () => {
    const wf = load(file);
    expect(wf.concurrency?.group).toBeTruthy();
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});
