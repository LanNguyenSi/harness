import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest } from "../../src/cli/loader.js";
import { validate } from "../../src/cli/validate/index.js";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { list } from "../../src/cli/list.js";
import { exportManifest } from "../../src/cli/export.js";
import { diff } from "../../src/cli/diff/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

// Task e62f03ea: `workflows:` remains a declarative key (it still loads,
// and the schema still validates its shape), but no command derives a
// policy from it any more. The manifest below is the exact shape the old
// derivation keyed on: a `ship` workflow with a required review step
// before a merge step, plus both evidence hooks correctly wired. It now
// must behave as pure documentation everywhere.
const MANIFEST = `version: 1
doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
hooks:
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
policies:
  - name: my-review-gate
    description: Hand-authored merge gate on the surface the old derived gate used to cover.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block
`;

function writeFixture(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-nodeps-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "harness.yaml"), MANIFEST, "utf8");
  return home;
}

function configPathOf(home: string): string {
  return path.join(home, "harness.yaml");
}

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
};

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

describe("workflows[] no longer derives policies (task e62f03ea)", () => {
  it("loadManifest surfaces exactly the one hand-authored policy", () => {
    const home = writeFixture();
    const { manifest } = loadManifest({ configPath: configPathOf(home) });
    expect(manifest.policies.map((p) => p.name)).toEqual(["my-review-gate"]);
  });

  it("a workflows-gated manifest loads without error or schema complaint", () => {
    const home = writeFixture();
    expect(() => loadManifest({ configPath: configPathOf(home) })).not.toThrow();
  });

  it("validate reports no workflow diagnostics and no workflow: policy", () => {
    const home = writeFixture();
    const result = validate({
      homeDir: home,
      configPath: configPathOf(home),
      ...NOOP_PROBES,
    });
    expect(result.diagnostics.filter((d) => d.path === "workflows")).toEqual([]);
    expect(result.manifest?.policies.filter((p) => p.name.startsWith("workflow:"))).toEqual([]);
  });

  it("the doctor report has no workflows section and no derived flag on policies", async () => {
    const home = writeFixture();
    const report = await doctor({
      configPath: configPathOf(home),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report).not.toHaveProperty("workflows");
    expect(report.policies.map((p) => p.name)).toEqual(["my-review-gate"]);
    for (const entry of report.policies) {
      expect(entry).not.toHaveProperty("derived");
    }
    expect(JSON.stringify(report)).not.toMatch(/"derived"/);
    expect(format(report)).not.toMatch(/Workflows/);
  });

  it("list policies shows exactly the hand-authored row, without provenance", () => {
    const home = writeFixture();
    const r = list("policies", { configPath: configPathOf(home) });
    expect(r.rows.map((row) => row.name)).toEqual(["my-review-gate"]);
    for (const row of r.rows) {
      expect(row).not.toHaveProperty("provenance");
    }
  });

  it("export emits only the hand-authored policy", () => {
    const home = writeFixture();
    const r = exportManifest({ configPath: configPathOf(home), json: true });
    const parsed = JSON.parse(r.output) as { policies: Array<{ name: string }> };
    expect(parsed.policies.map((p) => p.name)).toEqual(["my-review-gate"]);
    expect(r.output).not.toContain("workflow:ship");
  });

  it("diff of an unchanged manifest emits no changes and no workflow rows", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "harness-nodeps-diff-"));
    cleanups.push(() => fs.rmSync(repo, { recursive: true, force: true }));
    gitInit(repo);
    fs.writeFileSync(path.join(repo, "harness.yaml"), MANIFEST, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(r.changes).toEqual([]);
    expect(r.output).not.toContain("workflow:ship");
  });
});
