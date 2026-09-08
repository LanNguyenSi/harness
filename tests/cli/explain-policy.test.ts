// Phase 7 #5 — `harness explain-policy` CLI tests.
//
// Exercises the live match explanation: trigger verdict, risk
// classification, environment resolution, and the per-clause `when:`
// breakdown that decides whether a policy would APPLY to an event.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { explainPolicy } from "../../src/cli/explain-policy.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import type { GitRepoContext } from "../../src/runtime/git-context.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeEvent(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "event.json");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const DESTROY_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "terraform destroy" },
});

const NON_BASH_EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: "/etc/hosts" },
});

// Shared raw manifest input (task 30183330 adds MANIFEST_WITH_SETUP, a
// variant of the SAME config plus `session_start_preflight.setup: true`,
// below).
const MANIFEST_INPUT = {
  version: 1,
  hooks: [
    { name: "risk-gate", event: "PreToolUse", command: "/usr/bin/true", blocking: false },
  ],
  policies: [
    {
      name: "gate-prod-destructive",
      description: "require approval for destructive production actions",
      trigger: { event: "PreToolUse", match: "Bash" },
      when: {
        "risk.severity_at_least": "high",
        "environment.name": "production",
      },
      requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
      hook: "risk-gate",
      enforcement: "require_approval",
    },
    {
      name: "plain-bash-gate",
      description: "a no-when: policy, Phase 4 shape",
      trigger: { event: "PreToolUse", match: "Bash" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "risk-gate",
      enforcement: "block",
    },
    {
      name: "preflight-before-investigation",
      description: "require a fresh preflight tag before git investigation (task 30183330 fixture)",
      trigger: { event: "PreToolUse", match: "Bash" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "risk-gate",
      enforcement: "block",
    },
  ],
  risk: {
    classifiers: [
      {
        name: "dangerous-shell",
        tool: "Bash",
        patterns: [
          {
            pattern: "terraform\\s+destroy",
            categories: ["destructive", "infrastructure_change"],
            severity: "critical",
          },
        ],
      },
    ],
  },
  environments: {
    resolvers: [
      {
        name: "production-signals",
        environment: "production",
        signals: { branch_patterns: ["main"] },
      },
    ],
  },
};

const MANIFEST: Manifest = parseManifest(MANIFEST_INPUT);

// Same config as MANIFEST, plus `session_start_preflight.setup: true`
// (task 30183330), used to prove `explain-policy` shows the flag's
// TRUE value too, not just its default.
const MANIFEST_WITH_SETUP: Manifest = parseManifest({
  ...MANIFEST_INPUT,
  session_start_preflight: { setup: true },
});

// Deterministic seams: the branch drives environment resolution.
const seams = (branch: string) => ({
  now: new Date("2026-05-22T12:00:00.000Z"),
  host: "h",
  user: "u",
  resolveGit: (): GitRepoContext => ({ repo: "r", branch, sha: "" }),
  cwdFallback: "/fallback",
  env: {},
  kubeContext: "",
  kubeNamespace: "",
});

describe("explainPolicy — applies", () => {
  it("reports applies:true when trigger and every when: clause hold", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection, output } = explainPolicy("gate-prod-destructive", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.trigger.matched).toBe(true);
    expect(projection.classifier.severity).toBe("critical");
    expect(projection.environment.name).toBe("production");
    expect(projection.when).toMatchObject({ declared: true, matched: true });
    expect(projection.applies).toBe(true);
    expect(parseYaml(output)).toEqual(projection);
  });

  it("reports applies:false and names the failing when: clause", () => {
    // Branch `feature/x` resolves to environment `unknown`, so the
    // `environment.name: production` clause fails.
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("gate-prod-destructive", {
      ...seams("feature/x"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.trigger.matched).toBe(true);
    expect(projection.environment.name).toBe("unknown");
    expect(projection.applies).toBe(false);
    const envClause =
      projection.when.declared &&
      projection.when.clauses.find((c) => c.clause === "environment.name");
    expect(envClause).toMatchObject({ matched: false, actual: "unknown" });
  });

  it("reports trigger.matched:false when the tool does not match", () => {
    const file = writeEvent(NON_BASH_EVENT);
    const { projection } = explainPolicy("gate-prod-destructive", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.trigger.matched).toBe(false);
    expect(projection.applies).toBe(false);
  });

  it("a no-when: policy has when.declared:false; applies follows the trigger", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("plain-bash-gate", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST,
    });
    expect(projection.when).toEqual({ declared: false });
    expect(projection.applies).toBe(projection.trigger.matched);
    expect(projection.applies).toBe(true);
  });

  it("emits valid JSON with --json", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection, output } = explainPolicy("gate-prod-destructive", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST,
      json: true,
    });
    expect(JSON.parse(output)).toEqual(projection);
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("explainPolicy — errors", () => {
  it("throws EX_USAGE for an unknown policy name", () => {
    const file = writeEvent(DESTROY_EVENT);
    let caught: unknown;
    try {
      explainPolicy("no-such-policy", {
        ...seams("main"),
        eventPath: file,
        manifest: MANIFEST,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(64);
    expect((caught as HarnessExitError).message).toMatch(/no policy named/);
  });

  it("throws EX_NOINPUT when the event file is missing", () => {
    let caught: unknown;
    try {
      explainPolicy("gate-prod-destructive", {
        ...seams("main"),
        eventPath: "/nonexistent.json",
        manifest: MANIFEST,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
  });
});

describe("explainPolicy: session_start_preflight (task 30183330)", () => {
  it("shows session_start_preflight.setup:false for a preflight-before-* policy by default", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST,
    });
    // `source` defaults to "base" for an injected `manifest`: it carries
    // no per-layer provenance to re-derive from (task c88461c1, see
    // "explainPolicy: session_start_preflight.source" below for the
    // real-layer cases).
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "base" });
  });

  it("shows session_start_preflight.setup:true when the manifest enables it", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST_WITH_SETUP,
    });
    expect(projection.session_start_preflight).toEqual({ setup: true, source: "base" });
  });

  it("omits session_start_preflight for a non-preflight policy", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("gate-prod-destructive", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST_WITH_SETUP,
    });
    expect(projection.session_start_preflight).toBeUndefined();
    expect(Object.keys(projection)).not.toContain("session_start_preflight");
  });
});

describe("explainPolicy: session_start_preflight.source (task c88461c1)", () => {
  function makeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-home-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function writeBaseManifest(home: string, setup: boolean): void {
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      stringifyYaml({ ...MANIFEST_INPUT, session_start_preflight: { setup } }),
    );
  }

  function writeMachineLayer(home: string, setup: boolean): void {
    fs.mkdirSync(path.join(home, "machines"), { recursive: true });
    // "default" is always a machine-override candidate (see
    // tests/cli/session-start/preflight.test.ts's identical idiom), so
    // this layer applies with no hostname/platform discriminator to pin.
    fs.writeFileSync(
      path.join(home, "machines", "default.harness.overrides.yaml"),
      ["session_start_preflight:", `  setup: ${setup}`, ""].join("\n"),
    );
  }

  function writeProjectLayer(home: string, projectName: string, setup: boolean): void {
    const projectDir = path.join(home, "projects", projectName);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      ["session_start_preflight:", `  setup: ${setup}`, ""].join("\n"),
    );
  }

  it("names source:base when only the base manifest declares setup (no layer on disk)", () => {
    const home = makeHome();
    writeBaseManifest(home, false);
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
    });
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "base" });
  });

  it("names source:machine when a machine-override layer decides the value", () => {
    const home = makeHome();
    writeBaseManifest(home, true);
    writeMachineLayer(home, false);
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
    });
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "machine" });
  });

  it("names source:project when a project-override layer decides the value, over both base and a machine layer", () => {
    const home = makeHome();
    writeBaseManifest(home, false);
    writeMachineLayer(home, false);
    writeProjectLayer(home, "demo-project", true);
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      project: "demo-project",
    });
    expect(projection.session_start_preflight).toEqual({ setup: true, source: "project" });
  });

  /** Create `<tmp>/<name>/.git/HEAD` and return the work-tree path. */
  function makeRepoFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-repo-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  // Review round 2, decision D-021b: the round-1 reviewer reproduced
  // `explain-policy` printing `source: base` / `setup: false` in the
  // SAME cwd where the producer (`harness session-start preflight`)
  // actually read a project layer and passed `--setup true`, because
  // `explainPolicy` never derived a project name from its own cwd,
  // only an explicit `--project` reached the loader. This test drives
  // `explainPolicy` with NO `project` opt, only `cwd`, in a repo that
  // HAS a matching project layer on disk, and asserts it now agrees
  // with the producer.
  it("names source:project from a cwd-derived project name, with no explicit --project (review round 2)", () => {
    const home = makeHome();
    writeBaseManifest(home, false);
    const repo = makeRepoFixture("explain-cwd-project-repo");
    writeProjectLayer(home, "explain-cwd-project-repo", true);
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      cwd: repo,
    });
    expect(projection.session_start_preflight).toEqual({ setup: true, source: "project" });
  });

  it("keeps source:base from a cwd-derived lookup when no project layer matches the repo's name", () => {
    const home = makeHome();
    writeBaseManifest(home, true);
    const repo = makeRepoFixture("explain-cwd-no-layer-repo");
    // A project layer exists, but under a DIFFERENT name.
    writeProjectLayer(home, "some-other-project", false);
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      cwd: repo,
    });
    expect(projection.session_start_preflight).toEqual({ setup: true, source: "base" });
  });

  // Review round 2, finding: a layer that TOMBSTONES the key (`{setup:
  // null}`, honoured by `mergeValue` in src/overrides/merge.ts as
  // "delete the merged key, letting the schema default win") is just as
  // much a declaration by that layer as `setup: true`/`false`, round-1's
  // `layerDeclaresSetup` only recognized a literal boolean, so it would
  // have attributed this decision to whichever LOWER layer happens to
  // also set a boolean (here, the machine layer), naming the wrong
  // layer as the one that decided the merged result.
  it("attributes a project layer's tombstone (`{setup: null}`) as source:project, not the machine layer underneath it", () => {
    const home = makeHome();
    writeBaseManifest(home, true);
    writeMachineLayer(home, true);
    const projectDir = path.join(home, "projects", "tombstone-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      ["session_start_preflight:", "  setup: null", ""].join("\n"),
    );
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      project: "tombstone-project",
    });
    // The tombstone deletes the merged key entirely, so the schema
    // default (false) wins, but the PROJECT layer is what decided that,
    // not the machine layer underneath it (which said `true`).
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "project" });
  });

  // Residual of task c88461c1's review round 3 (T-004 of the follow-up
  // batch, decision D-006): `layerDeclaresSetup`'s WHOLE-BLOCK
  // tombstone branch (`session_start_preflight: null`, distinct from
  // the per-key `{setup: null}` tombstone above) had no test. A whole
  // top-level `null` deletes the ENTIRE key when merged (`mergeValue`,
  // `src/overrides/merge.ts`), same end result as the per-key form, but
  // `layerDeclaresSetup` reaches it through a different branch
  // (`block === null`, returning `true` directly instead of checking
  // `"setup" in block`).
  it("attributes a project layer's WHOLE-BLOCK tombstone (`session_start_preflight: null`) as source:project", () => {
    const home = makeHome();
    writeBaseManifest(home, true);
    writeMachineLayer(home, true);
    const projectDir = path.join(home, "projects", "whole-block-tombstone-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      ["session_start_preflight: null", ""].join("\n"),
    );
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      project: "whole-block-tombstone-project",
    });
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "project" });
  });

  // Review round 3, decision D-028: two machine layers plus a project
  // layer that does NOT declare `setup` itself. `resolveSessionStartPreflightSource`
  // walks `resolved.machineLayers` from the LAST entry backwards
  // (highest precedence first), so the hostname-discriminated layer
  // (applied after "default", see `machineOverrideCandidates`) must
  // decide both the value AND the `source` label, not the "default"
  // layer underneath it, even though a (non-declaring) project layer
  // also exists on disk.
  it("attributes the LAST machine layer's value/source when two machine layers exist and the project layer does not declare setup", () => {
    const home = makeHome();
    writeBaseManifest(home, true);
    writeMachineLayer(home, true); // "default": setup:true
    fs.mkdirSync(path.join(home, "machines"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "machines", "sspf-test-host.harness.overrides.yaml"),
      ["session_start_preflight:", "  setup: false", ""].join("\n"),
    );
    // A project layer that exists on disk but declares NOTHING (an
    // empty YAML object): it must not be picked as the source, and it
    // must not block the last-machine-layer attribution above it
    // either.
    const projectDir = path.join(home, "projects", "unrelated-key-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "harness.overrides.yaml"), "{}\n");
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      project: "unrelated-key-project",
      discriminator: { hostname: "sspf-test-host", platform: "linux" },
    });
    expect(projection.session_start_preflight).toEqual({ setup: false, source: "machine" });
  });
});

// Review round 3, decision D-028: the derived project layer this task
// wires through `explain-policy`'s SECOND load must be scoped to
// `session_start_preflight.setup` (and its `source` attribution) ONLY.
// A project layer that changes any OTHER key must never reach the
// POLICY EVALUATION above (trigger matching, the Risk Classifier,
// environment resolution, the `when:` verdict): that manifest is loaded
// PLAIN (base/machine/explicit `--project` only), exactly the manifest
// `harness policy intercept` and `harness dry-run` enforce a real tool
// call against.
describe("explainPolicy: the derived project layer never reaches policy evaluation (task c88461c1, review round 3, decision D-028)", () => {
  function makeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-boundary-home-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function makeRepoFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-boundary-repo-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  it("keeps trigger.matched:true when a cwd-derived project layer adds a bash_match that the command never satisfies", () => {
    const home = makeHome();
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      stringifyYaml(MANIFEST_INPUT),
    );
    const repoName = "explain-boundary-repo";
    const repo = makeRepoFixture(repoName);
    const projectDir = path.join(home, "projects", repoName);
    fs.mkdirSync(projectDir, { recursive: true });
    // If this layer reached the POLICY-evaluation load, "terraform
    // destroy" would fail this bash_match and trigger.matched would
    // flip to false.
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      [
        "policies:",
        "  - name: preflight-before-investigation",
        "    trigger:",
        '      bash_match: "^this-pattern-never-matches-anything$"',
        "",
      ].join("\n"),
    );
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      cwd: repo,
    });
    expect(projection.trigger.matched).toBe(true);
    expect(projection.applies).toBe(true);
  });
});

// Review round 3: the projection is gated on the exact
// `preflight-before-` name prefix (`src/cli/explain-policy.ts`), not on
// "consumes a preflight: tag" and not on a looser `preflight` prefix.
// The test above only rules out a policy that neither starts with
// `preflight` nor consumes the tag, so a widened prefix would survive it.
// These two cases pin the boundary itself.
const MANIFEST_PREFIX_BOUNDARY: Manifest = parseManifest({
  ...MANIFEST_INPUT,
  session_start_preflight: { setup: true },
  policies: [
    ...MANIFEST_INPUT.policies,
    {
      // Starts with `preflight` and CONSUMES the preflight tag, but is not
      // one of the init-generated `preflight-before-*` gates.
      name: "preflight-custom-audit",
      description: "a custom policy consuming preflight: evidence outside the generated naming",
      trigger: { event: "PreToolUse", match: "Bash" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "risk-gate",
      enforcement: "block",
    },
    {
      // The bare prefix itself: the shortest name the rule must still match.
      name: "preflight-before-",
      description: "bare-prefix boundary fixture for the preflight-before- name rule",
      trigger: { event: "PreToolUse", match: "Bash" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "risk-gate",
      enforcement: "block",
    },
  ],
});

describe("explainPolicy: session_start_preflight name-prefix boundary (task 30183330)", () => {
  it("omits the field for a custom policy that requires preflight: facts but is not named preflight-before-*", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-custom-audit", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST_PREFIX_BOUNDARY,
    });
    expect(projection.session_start_preflight).toBeUndefined();
    expect(Object.keys(projection)).not.toContain("session_start_preflight");
  });

  it("shows the field for a bare `preflight-before-` prefixed policy", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST_PREFIX_BOUNDARY,
    });
    expect(projection.session_start_preflight).toEqual({ setup: true, source: "base" });
  });
});

// Residual of task c88461c1's review round 3 (T-004 of the follow-up
// batch, decision D-006): the cwd-derived, project-scoped SECOND
// `loadManifest` call ran unconditionally, before the named policy was
// even looked up, even though its result is rendered only for a
// `preflight-before-*` policy (see
// `ExplainPolicyProjection.session_start_preflight`'s doc comment).
// Wraps the loader's own `loadManifest` with a call-counting spy
// (`vi.mock` + `importOriginal`, the same idiom
// tests/cli/manifest-view-parity.test.ts uses for an ESM named export
// that cannot be `vi.spyOn`-ed directly, see
// reference_vitest_spyon_esm_named_export) to prove the SECOND load is
// skipped entirely for a policy this field is never rendered for, not
// merely computed and discarded. `vi.mock` factory calls are hoisted
// by Vitest above every import in this file regardless of where they
// are written, so placing it here (at the file's end, per this task's
// "new tests at the end" convention) does not change when it takes
// effect.
vi.mock("../../src/cli/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/loader.js")>();
  return { ...actual, loadManifest: vi.fn(actual.loadManifest) };
});

describe("explainPolicy: the scoped SECOND load runs only for a preflight-before-* policy (task c88461c1, review round 3 residual, decision D-006)", () => {
  function makeHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-loadcount-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "harness.yaml"), stringifyYaml(MANIFEST_INPUT));
    return dir;
  }

  async function loadManifestMock(): Promise<ReturnType<typeof vi.fn>> {
    const { loadManifest } = await import("../../src/cli/loader.js");
    return loadManifest as unknown as ReturnType<typeof vi.fn>;
  }

  it("calls loadManifest exactly once (the plain load only) for a policy outside the preflight-before- prefix", async () => {
    const mockFn = await loadManifestMock();
    mockFn.mockClear();
    const home = makeHome();
    const file = writeEvent(DESTROY_EVENT);
    explainPolicy("plain-bash-gate", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
    });
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it("calls loadManifest twice (the plain load, then the scoped load) for a preflight-before-* policy", async () => {
    const mockFn = await loadManifestMock();
    mockFn.mockClear();
    const home = makeHome();
    const file = writeEvent(DESTROY_EVENT);
    explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
    });
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});

// Residual of task c88461c1's review round 3 (T-004 of the follow-up
// batch, decision D-006): a scoped-load failure used to keep the PLAIN
// load's `setup`/`source` values (a comment claimed this mirrored the
// producer's own catch, but the producer degrades to `setup: false`
// instead, see src/cli/session-start/index.ts). This drives the
// scoped load into a genuine failure (a malformed project layer file)
// and asserts the degrade decided for this residual: `setup: false`,
// `source: "unresolvable"`, never the plain load's own value.
describe("explainPolicy: session_start_preflight degrades to setup:false/source:unresolvable on a scoped-load failure (task c88461c1, review round 3 residual, decision D-006)", () => {
  /** Create `<tmp>/<name>/.git/HEAD` and return the work-tree path. */
  function makeRepoFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-unresolvable-repo-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  it("reports setup:false, source:unresolvable when the CWD-DERIVED project layer fails to parse, not the plain load's setup:true", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-explain-policy-unresolvable-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    // The PLAIN load (no explicit --project, so it never touches the
    // project layer below) says setup:true; if the scoped-load failure
    // kept this value (the pre-fix behavior), the assertion below
    // would see {setup: true, source: "base"} instead.
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      stringifyYaml({ ...MANIFEST_INPUT, session_start_preflight: { setup: true } }),
    );
    const repo = makeRepoFixture("explain-cwd-unresolvable-repo");
    const projectDir = path.join(home, "projects", "explain-cwd-unresolvable-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    // Malformed YAML (an unterminated flow mapping): the CWD-DERIVED
    // scoped `loadManifest` call throws while parsing this layer; no
    // explicit `--project` is passed, so the PLAIN load above never
    // reaches this file at all (see the D-028 boundary tests).
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      "session_start_preflight: {setup: true\n",
    );
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      homeDir: home,
      cwd: repo,
    });
    expect(projection.session_start_preflight).toEqual({
      setup: false,
      source: "unresolvable",
    });
  });
});
