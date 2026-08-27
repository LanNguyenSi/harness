// Review round 3 (99f47307 Slice 1): the mechanical guard for the class
// "one manifest reader sees the workflows[]-derived policies differently
// from another". Round 1 found `apply` vs `validate`, round 2 found the
// two sides of `diff --since`; this file runs ONE on-disk manifest through
// every reader and asserts which view each one takes (see the view table
// in src/runtime/workflow-policies.ts's module doc):
//
//   derived view (hand-authored + derived pair): loadManifest, validate,
//     doctor, list, describe, explain, diff (both sides), dry-run;
//   hand-authored view (derived pair absent): export, the .last-apply
//     manifest snapshot.
//
// Adding a reader that parses a manifest its own way? Add it here.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe as describeSuite, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { apply, GENERATED_DIRNAME } from "../../src/cli/apply/index.js";
import { describe } from "../../src/cli/describe.js";
import { diff } from "../../src/cli/diff/index.js";
import { doctor } from "../../src/cli/doctor/index.js";
import { dryRun } from "../../src/cli/dry-run.js";
import { explain } from "../../src/cli/explain.js";
import { exportManifest } from "../../src/cli/export.js";
import { list } from "../../src/cli/list.js";
import { loadManifest } from "../../src/cli/loader.js";
import { validate } from "../../src/cli/validate/index.js";
import { readLastApply } from "../../src/io/last-apply.js";
import { isDerivedPolicy } from "../../src/runtime/workflow-policies.js";

// F2 (review round 3, 99f47307 Slice 1): `runAssetChecks` (a named ESM
// export) can't be `vi.spyOn`-ed directly ("Cannot redefine property"), so
// this wraps it with `vi.fn` over the real implementation via `vi.mock` +
// `importOriginal` (see reference_vitest_spyon_esm_named_export). Behavior
// is unchanged (the wrapped fn still runs the real checks); this only lets
// the `add` test below inspect which manifest each call received.
vi.mock("../../src/cli/validate/checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/validate/checks.js")>();
  return { ...actual, runAssetChecks: vi.fn(actual.runAssetChecks) };
});
const { add } = await import("../../src/cli/add/index.js");
const { runAssetChecks } = await import("../../src/cli/validate/checks.js");
const runAssetChecksMock = runAssetChecks as unknown as ReturnType<typeof vi.fn>;

const DERIVED = ["workflow:ship:review-before-merge", "workflow:ship:review-before-merge-bash"];
const HAND = ["preflight-before-investigation-lite"];

// One hand-authored policy on an UNRELATED surface, so the derived pair is
// produced AND a hand-authored entry is present to prove the two are told
// apart (not just "policies empty" vs "policies non-empty").
const MANIFEST = `version: 1
tools:
  mcp:
    - name: grounding-mcp
      command: [node, /x/grounding.js]
  cli: []
  skills: {enabled: [], source_dirs: []}
  builtin: {known: []}
memory:
  directories: []
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
  - name: preflight-before-investigation-lite
    description: Unrelated hand-authored policy.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "git status"
    requires:
      ledger_tag: "preflight:ready"
    hook: require-review-evidence-bash
    enforcement: warn
`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function fixture(): { home: string; configPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-view-parity-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "harness.yaml");
  fs.writeFileSync(configPath, MANIFEST, "utf8");
  return { home, configPath };
}

function gitCommitAll(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: dir });
}

const names = (policies: ReadonlyArray<{ name: string }>) => policies.map((p) => p.name);
const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
  gitIgnoreProbe: () => null,
};

describeSuite("manifest view parity: derived-view readers", () => {
  it("loadManifest: hand-authored first, then the derived pair, registered as derived", () => {
    const { home, configPath } = fixture();
    const { manifest } = loadManifest({ homeDir: home, configPath });
    expect(names(manifest.policies)).toEqual([...HAND, ...DERIVED]);
    expect(manifest.policies.filter((p) => isDerivedPolicy(p)).map((p) => p.name)).toEqual(DERIVED);
  });

  it("validate: the checked manifest is the same view loadManifest hands out", () => {
    const { home, configPath } = fixture();
    const result = validate({ homeDir: home, configPath, ...NOOP_PROBES });
    expect(names(result.manifest!.policies)).toEqual([...HAND, ...DERIVED]);
    expect(result.diagnostics.filter((d) => d.path === "workflows")).toEqual([]);
  });

  it("doctor: lists the derived pair, marked derived", async () => {
    const { home, configPath } = fixture();
    const report = await doctor({ configPath, homeOverride: home, shallow: true });
    expect(names(report.policies)).toEqual([...HAND, ...DERIVED]);
    expect(report.policies.filter((p) => p.derived === true).map((p) => p.name)).toEqual(DERIVED);
  });

  it("list policies: one row per policy, provenance marker only on the derived pair", () => {
    const { home, configPath } = fixture();
    const r = list("policies", { homeDir: home, configPath });
    expect(r.rows.map((row) => row.name)).toEqual([...HAND, ...DERIVED]);
    expect(r.rows.filter((row) => row.provenance === "(derived from workflows[])").map((row) => row.name)).toEqual(
      DERIVED,
    );
  });

  it("describe --pillar policies: the derived view", () => {
    const { home, configPath } = fixture();
    const r = describe({ homeDir: home, configPath, pillar: "policies", json: true });
    const parsed = JSON.parse(r.output) as { policies: { name: string }[] };
    expect(names(parsed.policies)).toEqual([...HAND, ...DERIVED]);
  });

  it("explain <derived policy>: resolves the derived name", async () => {
    const { home, configPath } = fixture();
    const r = await explain("workflow:ship:review-before-merge", { homeDir: home, configPath, json: true });
    const parsed = JSON.parse(r.output) as { name: string; hook: string };
    expect(parsed.name).toBe("workflow:ship:review-before-merge");
    expect(parsed.hook).toBe("require-review-evidence");
  });

  it("dry-run: predicts the derived bash gate for `gh pr merge`", () => {
    const { home, configPath } = fixture();
    const r = dryRun("merge it", { homeDir: home, configPath, tool: "Bash", toolArgs: '{"command":"gh pr merge 1"}' });
    expect(r.report.matchingPolicies.map((p) => p.name)).toContain("workflow:ship:review-before-merge-bash");
  });

  // F2 (review round 3, 99f47307 Slice 1): the previous "add's asset gate"
  // header claim had no test that actually reads which manifest `add`
  // hands to `runAssetChecks`. Spies on the real call so a regression to
  // `parseManifest` (dropping `withDerivedPolicies`) turns this red: the
  // derived pair would be absent from the manifest the gate evaluated.
  it("add: the asset gate's proposed-manifest call carries the derived pair", async () => {
    const { home, configPath } = fixture();
    runAssetChecksMock.mockClear();
    const r = await add(
      {
        type: "hook",
        entry: { name: "unrelated", event: "SessionStart", command: "/usr/bin/true", blocking: false },
      },
      { configPath, homeDir: home },
    );
    expect(r.applied).toBe(true);
    const manifestsSeen = runAssetChecksMock.mock.calls.map(
      (call: unknown[]) => call[0] as { policies: ReadonlyArray<{ name: string }> },
    );
    // add calls the gate twice, proposed manifest first, then the baseline
    // (src/cli/add/index.ts). A `.find()` over all calls would be satisfied
    // by the baseline call alone, so each call is pinned individually: the
    // first call is the proposed manifest, and every call must carry the
    // derived pair (review round 4).
    expect(manifestsSeen.length).toBe(2);
    for (const [index, m] of manifestsSeen.entries()) {
      for (const name of DERIVED) {
        expect(names(m.policies), `runAssetChecks call ${index}`).toContain(name);
      }
    }
  });

  it("diff --since: both sides derived, so an unchanged manifest diffs clean", () => {
    const { home, configPath } = fixture();
    gitCommitAll(home);
    const r = diff({
      configPath,
      since: "master",
      homeDir: home,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(r.changes).toEqual([]);
    expect(names(r.before.policies)).toEqual([...HAND, ...DERIVED]);
    expect(names(r.after.policies)).toEqual([...HAND, ...DERIVED]);
  });
});

describeSuite("manifest view parity: hand-authored-view writers", () => {
  it("export: emits only what the operator declared", () => {
    const { home, configPath } = fixture();
    const r = exportManifest({ homeDir: home, configPath });
    const parsed = parseYaml(r.output) as { policies: { name: string }[] };
    expect(names(parsed.policies)).toEqual(HAND);
    expect(names(r.manifest.policies)).toEqual(HAND);
  });

  it(".last-apply manifest snapshot: only what the operator declared, and a re-apply is hint-free", async () => {
    const { home } = fixture();
    const r1 = await apply({ homeDir: home });
    expect(r1.outcome).toBe("applied");
    const record = readLastApply(path.join(home, GENERATED_DIRNAME))!;
    const snapshot = JSON.parse(record.manifest!.content) as { policies: { name: string }[] };
    expect(names(snapshot.policies)).toEqual(HAND);
    const r2 = await apply({ homeDir: home });
    expect(r2.restartHints).toEqual([]);
  });
});
