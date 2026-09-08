// Phase 7 #5 — `harness explain-policy` CLI tests.
//
// Exercises the live match explanation: trigger verdict, risk
// classification, environment resolution, and the per-clause `when:`
// breakdown that decides whether a policy would APPLY to an event.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  // `explainPolicy` never derived a project name from its own cwd ,
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
