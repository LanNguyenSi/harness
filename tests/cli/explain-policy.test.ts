// Phase 7 #5 — `harness explain-policy` CLI tests.
//
// Exercises the live match explanation: trigger verdict, risk
// classification, environment resolution, and the per-clause `when:`
// breakdown that decides whether a policy would APPLY to an event.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
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
    expect(projection.session_start_preflight).toEqual({ setup: false });
  });

  it("shows session_start_preflight.setup:true when the manifest enables it", () => {
    const file = writeEvent(DESTROY_EVENT);
    const { projection } = explainPolicy("preflight-before-investigation", {
      ...seams("main"),
      eventPath: file,
      manifest: MANIFEST_WITH_SETUP,
    });
    expect(projection.session_start_preflight).toEqual({ setup: true });
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
    expect(projection.session_start_preflight).toEqual({ setup: true });
  });
});
