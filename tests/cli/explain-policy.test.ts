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

const MANIFEST: Manifest = parseManifest({
  version: 1,
  hooks: [
    { name: "risk-gate", event: "PreToolUse", command: "/bin/true", blocking: false },
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
