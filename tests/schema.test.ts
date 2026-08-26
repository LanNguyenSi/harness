import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ManifestParseError, parseManifest } from "../src/schema/index.js";
import { FULL_TEMPLATE } from "../src/cli/init/templates.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const EXAMPLES_DIR = path.join(REPO_ROOT, "docs", "examples");
const INVALID_DIR = path.join(EXAMPLES_DIR, "invalid");

function loadYaml(p: string): unknown {
  return parseYaml(fs.readFileSync(p, "utf8"));
}

function expectIssueMatching(err: unknown, pattern: RegExp): void {
  expect(err).toBeInstanceOf(ManifestParseError);
  const issues = (err as ManifestParseError).issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
  expect(issues).toMatch(pattern);
}

describe("parseManifest — happy path", () => {
  it("parses the full reference manifest into a typed object", () => {
    const raw = loadYaml(path.join(EXAMPLES_DIR, "full-manifest.yaml"));
    const manifest = parseManifest(raw);
    expect(manifest.version).toBe(1);
    expect(manifest.tools.mcp).toHaveLength(3);
    expect(manifest.tools.mcp[0]?.name).toBe("codebase-oracle");
    expect(manifest.tools.mcp[2]?.name).toBe("grounding-mcp");
    expect(manifest.hooks).toHaveLength(12);
    expect(manifest.policies).toHaveLength(14);
    const reviewPolicy = manifest.policies.find((p) => p.name === "review-before-merge");
    expect(reviewPolicy?.requires?.ledger_tag).toBe("review:${PR_NUMBER}");
    expect(reviewPolicy?.trigger.extract?.PR_NUMBER).toBe("toolArgs.prNumber");
    // Field-level invariants on the two policies added alongside this test.
    // Schema parsing alone would not catch a typo like `toolArgs.task_id` —
    // it's grammatical per the extract DSL but would silently never resolve
    // at runtime. Lock the load-bearing strings explicitly.
    const reviewSubagentPolicy = manifest.policies.find(
      (p) => p.name === "review-subagent-before-pr-create",
    );
    expect(reviewSubagentPolicy?.trigger.match).toBe("mcp__agent-tasks__pull_requests_create");
    expect(reviewSubagentPolicy?.trigger.extract?.TASK_ID).toBe("toolArgs.taskId");
    expect(reviewSubagentPolicy?.requires?.ledger_tag).toBe("review-subagent:${TASK_ID}");
    const preflightPushPolicy = manifest.policies.find(
      (p) => p.name === "preflight-before-push",
    );
    expect(preflightPushPolicy?.trigger.match).toBe("Bash");
    expect(preflightPushPolicy?.trigger.bash_match).toBe(
      "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
    );
    expect(preflightPushPolicy?.requires?.ledger_tag).toBe("preflight:${BRANCH}");
    expect(preflightPushPolicy?.requires?.within).toBe("10m");
    expect(manifest.policy_packs).toHaveLength(4);
    expect(manifest.policy_packs[0]?.name).toBe("understanding-before-execution");
    expect(manifest.policy_packs[0]?.source).toBe("builtin");
    expect(manifest.policy_packs[0]?.enabled).toBe(true);
    expect(manifest.policy_packs[1]?.name).toBe("branch-protection");
    expect(manifest.policy_packs[1]?.source).toBe("builtin");
    expect(manifest.policy_packs[1]?.enabled).toBe(true);
    // solution-acceptance ships as a disabled discoverable exemplar (hard
    // completion-gate; operator opts in once the producer is wired).
    expect(manifest.policy_packs[2]?.name).toBe("solution-acceptance");
    expect(manifest.policy_packs[2]?.source).toBe("builtin");
    expect(manifest.policy_packs[2]?.enabled).toBe(false);
    // post-merge-gate ships disabled too (a fresh gate; operator opts in
    // once they've reviewed the curated command list for their workflow).
    expect(manifest.policy_packs[3]?.name).toBe("post-merge-gate");
    expect(manifest.policy_packs[3]?.source).toBe("builtin");
    expect(manifest.policy_packs[3]?.enabled).toBe(false);
    // config carries the gate mode + the producers list extension
    // (agent-tasks/25bced52). Assert on keys rather than deep-equality
    // so further config additions don't churn this test.
    const packConfig = manifest.policy_packs[0]?.config as Record<string, unknown>;
    expect(packConfig?.mode).toBe("grill_me");
    expect(Array.isArray(packConfig?.producers)).toBe(true);
    // Producers (agent-tasks/3804b785 + fa4b188b): all six reference
    // policies must ship with remediation hints carrying an MCP path,
    // since that is the ungated recovery route for Bash-lockout
    // scenarios. The full chain was completed in fa4b188b.
    for (const policyName of [
      "review-before-merge",
      "review-before-merge-bash",
      "dogfood-before-release",
      "two-reviewers-required",
      "preflight-before-investigation",
      "review-subagent-before-pr-create",
      "review-subagent-before-pr-create-bash",
      "preflight-before-push",
    ]) {
      const p = manifest.policies.find((x) => x.name === policyName);
      expect(p?.producers, `${policyName} producers`).toBeDefined();
      expect(p?.producers?.some((pr) => pr.kind === "mcp"), `${policyName} has mcp producer`).toBe(true);
    }
  });

  it("applies defaults when optional sections are omitted", () => {
    const m = parseManifest({ version: 1 });
    expect(m.grounding.session.auto_start).toBe(true);
    expect(m.grounding.evidence_ledger.retention_days).toBe(90);
    expect(m.grounding.policies_source).toBeNull();
    expect(m.tools.mcp).toEqual([]);
    expect(m.tools.builtin.known).toEqual([]);
    expect(m.memory.retention.staleness_days).toBe(180);
    expect(m.memory.scopes.default).toBe("project");
    expect(m.hooks).toEqual([]);
    expect(m.policies).toEqual([]);
    expect(m.policy_packs).toEqual([]);
    expect(m.risk.classifiers).toEqual([]);
    // Task f1aea826: the degraded fail posture defaults to fail-closed
    // for block/require_approval tiers; the opt-out must be explicit.
    expect(m.risk.degraded_fail_posture).toBe("preserve_enforcement");
    expect(m.environments.resolvers).toEqual([]);
  });

  it("accepts the explicit risk.degraded_fail_posture opt-out and rejects unknown values", () => {
    const m = parseManifest({
      version: 1,
      risk: { degraded_fail_posture: "fail_open" },
    });
    expect(m.risk.degraded_fail_posture).toBe("fail_open");
    expect(m.risk.classifiers).toEqual([]);
    expect(() =>
      parseManifest({
        version: 1,
        risk: { degraded_fail_posture: "fail_closed_sometimes" },
      }),
    ).toThrow(/invalid enum|Invalid enum|invalid_value/i);
  });

  it("accepts a string command for tools.mcp[].command", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [{ name: "x", command: "node /tmp/x.js" }] },
    });
    expect(m.tools.mcp[0]?.command).toBe("node /tmp/x.js");
  });

  it("rejects a policy whose producers list has no mcp entry", () => {
    // The MCP path is the ungated recovery route for Bash-lockout
    // scenarios. A producers list that omits it would leave agents
    // stuck. The schema's superRefine enforces at-least-one-mcp.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "x:${SESSION_ID}" },
            hook: "h",
            enforcement: "block",
            producers: [
              { kind: "bash", command: "harness do-thing", description: "the standard producer" },
            ],
          },
        ],
      }),
    ).toThrow(/at least one producer with kind:mcp/);
  });

  it("accepts a policy with mixed-kind producers (bash + mcp)", () => {
    const m = parseManifest({
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
      policies: [
        {
          name: "p",
          description: "d",
          trigger: { event: "PreToolUse" },
          requires: { ledger_tag: "x:${SESSION_ID}" },
          hook: "h",
          enforcement: "block",
          producers: [
            { kind: "bash", command: "harness do-thing", description: "standard" },
            { kind: "mcp", verb: "mcp__x__write", example: '{tag:"x:${SESSION_ID}"}', description: "ungated fallback" },
          ],
        },
      ],
    });
    expect(m.policies[0]?.producers).toHaveLength(2);
    expect(m.policies[0]?.producers?.[1]?.kind).toBe("mcp");
  });

  it("accepts ISO-8601 and shorthand within values", () => {
    for (const within of ["24h", "30m", "7d", "60s", "PT1H", "P1D"]) {
      const m = parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "x:${SESSION_ID}", within },
            hook: "h",
            enforcement: "block",
          },
        ],
      });
      expect(m.policies[0]?.requires?.within).toBe(within);
    }
  });
});

describe("parseManifest — invalid fixtures", () => {
  const cases: Array<{ file: string; pattern: RegExp }> = [
    { file: "01-unknown-version.yaml", pattern: /version/i },
    { file: "02-unknown-toplevel-key.yaml", pattern: /unrecognized key|foo/i },
    { file: "03-policy-undeclared-variable.yaml", pattern: /PR_NUMBER/ },
    { file: "04-policy-dangling-hook.yaml", pattern: /nonexistent-hook/ },
    { file: "05-bad-extract-grammar.yaml", pattern: /unknown namespace|extract expression|toolArgs/i },
    { file: "06-bad-within-duration.yaml", pattern: /duration/i },
    { file: "07-count-min-zero.yaml", pattern: /count/i },
    { file: "08-duplicate-mcp-name.yaml", pattern: /duplicate mcp/i },
    { file: "09-skills-required-not-enabled.yaml", pattern: /required.*subset.*enabled/i },
    { file: "10-memory-default-not-allowed.yaml", pattern: /default.*allowed/i },
    { file: "11-bad-blocking-enum.yaml", pattern: /blocking|invalid/i },
    { file: "12-missing-version.yaml", pattern: /version/i },
    { file: "13-workflow-duplicate-name.yaml", pattern: /duplicate workflow name/i },
    {
      file: "14-workflow-template-not-defined.yaml",
      pattern: /ghost-template.*not defined in review_templates/i,
    },
    {
      file: "15-workflow-required-without-template.yaml",
      pattern: /spawn:\s*"required".*template/i,
    },
    { file: "16-workflow-unknown-step-kind.yaml", pattern: /invalid_union_discriminator|kind/i },
    {
      file: "17-policy-pack-duplicate-name.yaml",
      pattern: /duplicate policy_pack name/i,
    },
    { file: "18-policy-pack-unknown-key.yaml", pattern: /unrecognized key|bogus_field/i },
    {
      file: "19-risk-classifier-duplicate-name.yaml",
      pattern: /duplicate risk classifier name/i,
    },
    { file: "20-risk-pattern-bad-regex.yaml", pattern: /invalid regex/i },
    { file: "21-risk-unknown-category.yaml", pattern: /data-loss|invalid enum/i },
    {
      file: "22-environment-resolver-no-signals.yaml",
      pattern: /at least one of/i,
    },
    {
      file: "23-policy-when-empty.yaml",
      pattern: /when must declare at least one clause/i,
    },
    {
      file: "24-policy-operator-only-with-requires.yaml",
      pattern: /operator_only.*must not also declare requires/i,
    },
    {
      file: "25-policy-operator-only-wrong-enforcement.yaml",
      pattern: /operator_only.*only meaningful for enforcement: block/i,
    },
    {
      file: "26-policy-missing-requires-and-operator-only.yaml",
      pattern: /requires is mandatory unless.*operator_only/i,
    },
    {
      file: "27-policy-operator-only-with-producers.yaml",
      pattern: /operator_only.*must not also declare producers/i,
    },
  ];

  for (const c of cases) {
    it(`rejects ${c.file}`, () => {
      const raw = loadYaml(path.join(INVALID_DIR, c.file));
      let caught: unknown;
      try {
        parseManifest(raw);
      } catch (e) {
        caught = e;
      }
      expect(caught, `expected ${c.file} to throw`).toBeDefined();
      expectIssueMatching(caught, c.pattern);
    });
  }
});

describe("parseManifest — built-in variables bypass trigger.extract", () => {
  // The five runtime-resolved built-ins listed in `src/schema/requires.ts`
  // may be referenced in `requires.ledger_tag` without a matching
  // `trigger.extract` entry. This guards against an accidental tightening
  // that would break dogfood manifests + ARCHITECTURE §6 examples.
  const BUILTINS = ["SESSION_ID", "REPO", "BRANCH", "TOOL_NAME", "CWD"];

  for (const name of BUILTINS) {
    it(`accepts \${${name}} with no trigger.extract entry`, () => {
      expect(() =>
        parseManifest({
          version: 1,
          hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
          policies: [
            {
              name: "p",
              description: "d",
              trigger: { event: "PreToolUse" },
              requires: { ledger_tag: `t:\${${name}}` },
              hook: "h",
              enforcement: "block",
            },
          ],
        }),
      ).not.toThrow();
    });
  }

  it("still rejects a non-built-in reference without trigger.extract", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "t:${CUSTOM_VAR}" },
            hook: "h",
            enforcement: "block",
          },
        ],
      }),
    ).toThrow(/CUSTOM_VAR/);
  });
});

describe("parseManifest — requires shapes", () => {
  function buildPolicyManifest(requires: unknown): unknown {
    return {
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
      policies: [
        {
          name: "p",
          description: "d",
          trigger: { event: "PreToolUse" },
          requires,
          hook: "h",
          enforcement: "block",
        },
      ],
    };
  }

  it("accepts shape 1 (ledger_tag only)", () => {
    expect(() => parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}" }))).not.toThrow();
  });

  it("accepts shape 1 + within", () => {
    expect(() =>
      parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}", within: "24h" })),
    ).not.toThrow();
  });

  it("accepts shape 1 + count", () => {
    expect(() =>
      parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}", count: { min: 2 } })),
    ).not.toThrow();
  });

  it("accepts all three shapes composed together", () => {
    expect(() =>
      parseManifest(
        buildPolicyManifest({
          ledger_tag: "x:${SESSION_ID}",
          within: "PT1H",
          count: { exact: 1 },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects count.exact alongside count.min", () => {
    expect(() =>
      parseManifest(
        buildPolicyManifest({
          ledger_tag: "x:${SESSION_ID}",
          count: { min: 2, exact: 3 },
        }),
      ),
    ).toThrow(/exact.*min|count/i);
  });

  it("rejects count with no constraints declared", () => {
    expect(() =>
      parseManifest(buildPolicyManifest({ ledger_tag: "x:${SESSION_ID}", count: {} })),
    ).toThrow(/count/i);
  });

  it("rejects count.min greater than count.max", () => {
    expect(() =>
      parseManifest(
        buildPolicyManifest({
          ledger_tag: "x:${SESSION_ID}",
          count: { min: 5, max: 2 },
        }),
      ),
    ).toThrow(/min.*<=.*max/i);
  });
});

describe("parseManifest — operator_only unconditional deny (task 2cc73f55)", () => {
  function buildOperatorOnlyManifest(overrides: Record<string, unknown> = {}): unknown {
    return {
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
      policies: [
        {
          name: "p",
          description: "d",
          trigger: { event: "PreToolUse" },
          hook: "h",
          enforcement: "block",
          operator_only: true,
          ...overrides,
        },
      ],
    };
  }

  it("accepts operator_only: true with enforcement: block and no requires:", () => {
    const m = parseManifest(buildOperatorOnlyManifest());
    expect(m.policies[0]?.operator_only).toBe(true);
    expect(m.policies[0]?.requires).toBeUndefined();
  });

  it("rejects operator_only: true alongside a requires: block (self-contradictory)", () => {
    expect(() =>
      parseManifest(
        buildOperatorOnlyManifest({ requires: { ledger_tag: "x:${SESSION_ID}" } }),
      ),
    ).toThrow(/operator_only.*must not also declare requires/i);
  });

  it("rejects operator_only: true alongside a declared producers: array (same mutual-exclusion class)", () => {
    // producers: documents a legitimate way to SATISFY the gate; an
    // unconditional deny never evaluates any evidence, so declaring both
    // would misrepresent the gate as satisfiable.
    expect(() =>
      parseManifest(
        buildOperatorOnlyManifest({
          producers: [
            {
              kind: "mcp",
              verb: "mcp__grounding-mcp__ledger_add",
              example: '{sessionId:"x", type:"fact", content:"x"}',
              description: "bogus",
            },
          ],
        }),
      ),
    ).toThrow(/operator_only.*must not also declare producers/i);
  });

  it("rejects operator_only: true with enforcement: warn", () => {
    expect(() =>
      parseManifest(buildOperatorOnlyManifest({ enforcement: "warn" })),
    ).toThrow(/operator_only.*only meaningful for enforcement: block/i);
  });

  it("rejects operator_only: true with enforcement: require_approval", () => {
    expect(() =>
      parseManifest(buildOperatorOnlyManifest({ enforcement: "require_approval" })),
    ).toThrow(/operator_only.*only meaningful for enforcement: block/i);
  });

  it("still rejects a plain block policy with neither requires: nor operator_only: true", () => {
    expect(() =>
      parseManifest(
        buildOperatorOnlyManifest({ operator_only: undefined }),
      ),
    ).toThrow(/requires is mandatory unless.*operator_only/i);
  });

  it("existing requires-carrying block policies are unaffected (regression pin)", () => {
    // operator_only is absent entirely here — the pre-existing mandatory-
    // requires path must still work byte-identically.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "x:${SESSION_ID}" },
            hook: "h",
            enforcement: "block",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("the three shipped operator_only kill-switch policies in FULL_TEMPLATE are unaffected by the producers: restriction (they use ux:, not producers:)", () => {
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    for (const name of [
      "deny-kill-switch-bypass",
      "deny-session-env-strip",
      "deny-pause-sentinel-forgery",
    ]) {
      const p = m.policies.find((x) => x.name === name);
      expect(p?.operator_only, `${name} operator_only`).toBe(true);
      expect(p?.producers, `${name} producers`).toBeUndefined();
      expect(p?.ux, `${name} ux`).toBeDefined();
    }
  });

  it("does not warn/error the self-attestation check for an operator_only policy with no producers", async () => {
    // checkPolicySelfAttestation lives in src/cli/validate/checks.ts and
    // is exercised end-to-end (via `validate()`) in
    // tests/cli/validate.test.ts; this is a light schema-layer sanity
    // check that the parsed shape (operator_only true, no producers) is
    // exactly what that check inspects.
    const m = parseManifest(buildOperatorOnlyManifest());
    const p = m.policies[0];
    expect(p?.enforcement).toBe("block");
    expect(p?.operator_only).toBe(true);
    expect(p?.producers).toBeUndefined();
  });
});

describe("parseManifest — uniqueness checks", () => {
  it("rejects duplicate hook names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          { name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false },
          { name: "h", event: "PostToolUse", command: "/usr/bin/true", blocking: false },
        ],
      }),
    ).toThrow(/duplicate hook/i);
  });

  it("rejects hook names starting with reserved `memory:` prefix (PR #204)", () => {
    // `harness apply` injects a synthetic Hook with `name: "memory:router"`
    // for the memory-router projection. Without this check, an operator
    // who happened to name their own hook with the same prefix would
    // produce a duplicate entry in the generated settings.json silently.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "memory:router",
            event: "UserPromptSubmit",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).toThrow(/reserved prefix.*"memory:"/);
  });

  it("rejects any hook name starting with `memory:` even when not literally `memory:router`", () => {
    // Prefix reservation is whole-namespace, not exact-string. Future
    // memory-* synthetic projections (e.g. memory:retention) are
    // pre-reserved without needing another schema bump.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "memory:my-custom-thing",
            event: "PreToolUse",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).toThrow(/reserved prefix.*"memory:"/);
  });

  it("reserved-prefix check is case-sensitive (`Memory:router` parses, intentional)", () => {
    // startsWith is case-sensitive; we deliberately do not normalize.
    // Claude Code and Codex hook keys are compared verbatim, so a
    // capital-M variant cannot collide with the lowercase synthetic.
    // Pin the intent here so a future "let's be lenient and lowercase
    // both sides" refactor breaks this test explicitly.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "Memory:router",
            event: "UserPromptSubmit",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("accepts hook names that merely contain `memory:` as a substring", () => {
    // Prefix check is `startsWith`, not `includes`. A hook named
    // `xmemory:y` or `policy-pack:memory:router` does not collide with
    // the synthetic projection and must continue to parse.
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "policy-pack:memory:router",
            event: "UserPromptSubmit",
            command: "/usr/bin/true",
            blocking: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects duplicate policy names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "x:${SESSION_ID}" },
            hook: "h",
            enforcement: "block",
          },
          {
            name: "p",
            description: "d2",
            trigger: { event: "PostToolUse" },
            requires: { ledger_tag: "y:${SESSION_ID}" },
            hook: "h",
            enforcement: "warn",
          },
        ],
      }),
    ).toThrow(/duplicate policy/i);
  });

  it("rejects duplicate cli tool names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        tools: {
          cli: [
            { name: "git-batch", binary: "git-batch" },
            { name: "git-batch", binary: "git-batch-other" },
          ],
        },
      }),
    ).toThrow(/duplicate cli/i);
  });
});

describe("parseManifest — workflows", () => {
  it("defaults workflows and review_templates to empty when absent", () => {
    const m = parseManifest({ version: 1 });
    expect(m.workflows).toEqual([]);
    expect(m.review_templates).toEqual({});
  });

  it("parses a minimal workflow with default step values", () => {
    const m = parseManifest({
      version: 1,
      workflows: [
        {
          name: "feature-pr",
          steps: [
            { kind: "branch" },
            { kind: "merge" },
          ],
        },
      ],
    });
    const wf = m.workflows[0]!;
    expect(wf.name).toBe("feature-pr");
    const branch = wf.steps[0];
    if (branch?.kind !== "branch") throw new Error("expected branch step");
    expect(branch.from).toBe("master");
    expect(branch.per_task).toBe(true);
    const merge = wf.steps[1];
    if (merge?.kind !== "merge") throw new Error("expected merge step");
    expect(merge.method).toBe("squash");
    expect(merge.gate).toBe("solo");
  });

  it("parses a full workflow with review_subagent referencing a defined template", () => {
    const m = parseManifest({
      version: 1,
      workflows: [
        {
          name: "feature-pr",
          when: { task_label: ["feat", "fix"], project: "harness" },
          steps: [
            { kind: "branch", from: "master", per_task: true },
            {
              kind: "review_subagent",
              spawn: "required",
              agent_type: "Explore",
              rigor: "rigorous",
              template: "rigorous",
              on_findings: "fix_then_remerge",
            },
            { kind: "ci_gate", wait_for: "completed/success" },
            { kind: "merge", method: "squash", gate: "solo" },
          ],
        },
      ],
      review_templates: {
        rigorous: "Rigorous checklist...\n",
      },
    });
    expect(m.workflows[0]?.steps).toHaveLength(4);
    const review = m.workflows[0]?.steps[1];
    if (review?.kind !== "review_subagent") throw new Error("expected review step");
    expect(review.template).toBe("rigorous");
  });

  it("accepts spawn: optional without a template", () => {
    expect(() =>
      parseManifest({
        version: 1,
        workflows: [
          {
            name: "docs-pr",
            steps: [{ kind: "review_subagent", spawn: "optional" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects spawn: required without a template", () => {
    expect(() =>
      parseManifest({
        version: 1,
        workflows: [
          {
            name: "feature-pr",
            steps: [{ kind: "review_subagent", spawn: "required" }],
          },
        ],
      }),
    ).toThrow(/spawn:\s*"required".*template/i);
  });

  it("rejects review_subagent.template referencing a non-existent template", () => {
    expect(() =>
      parseManifest({
        version: 1,
        workflows: [
          {
            name: "feature-pr",
            steps: [{ kind: "review_subagent", spawn: "required", template: "ghost" }],
          },
        ],
        review_templates: { rigorous: "..." },
      }),
    ).toThrow(/ghost.*not defined in review_templates/i);
  });

  it("rejects duplicate workflow names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        workflows: [
          { name: "feature-pr", steps: [{ kind: "branch" }] },
          { name: "feature-pr", steps: [{ kind: "merge" }] },
        ],
      }),
    ).toThrow(/duplicate workflow name/i);
  });

  it("rejects unknown step.kind values", () => {
    expect(() =>
      parseManifest({
        version: 1,
        workflows: [
          {
            name: "feature-pr",
            steps: [{ kind: "deploy" } as unknown],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects empty steps array", () => {
    expect(() =>
      parseManifest({
        version: 1,
        workflows: [{ name: "wf", steps: [] }],
      }),
    ).toThrow();
  });
});

describe("parseManifest — policy_packs", () => {
  it("defaults policy_packs to an empty array when absent", () => {
    const m = parseManifest({ version: 1 });
    expect(m.policy_packs).toEqual([]);
  });

  it("parses a minimal pack with only a name; source defaults to 'builtin'", () => {
    const m = parseManifest({
      version: 1,
      policy_packs: [{ name: "understanding-before-execution" }],
    });
    expect(m.policy_packs[0]).toEqual({
      name: "understanding-before-execution",
      source: "builtin",
      enabled: true,
      config: {},
    });
  });

  it("preserves an opaque config payload on the pack entry", () => {
    const m = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          config: { mode: "grill_me", custom_extra: { nested: 42 } },
        },
      ],
    });
    expect(m.policy_packs[0]?.config).toEqual({
      mode: "grill_me",
      custom_extra: { nested: 42 },
    });
  });

  it("rejects an empty name", () => {
    expect(() =>
      parseManifest({ version: 1, policy_packs: [{ name: "" }] }),
    ).toThrow();
  });

  it("rejects names containing path separators or parent-dir refs", () => {
    for (const bad of ["../etc", "foo/bar", "..", "/abs", "name with space", "-leading-dash"]) {
      expect(() =>
        parseManifest({ version: 1, policy_packs: [{ name: bad }] }),
      ).toThrow(/path separators are rejected|alphanumeric/i);
    }
  });

  it("accepts conservative name shapes (alphanumeric + dash + dot + underscore)", () => {
    for (const ok of ["pack", "pack_v2", "pack-name", "pack.v1", "Pack123"]) {
      expect(() =>
        parseManifest({ version: 1, policy_packs: [{ name: ok }] }),
      ).not.toThrow();
    }
  });

  it("rejects unknown keys on a pack entry (.strict())", () => {
    expect(() =>
      parseManifest({
        version: 1,
        policy_packs: [{ name: "x", source: "builtin", surprise: true }],
      }),
    ).toThrow(/unrecognized key|surprise/i);
  });

  it("rejects duplicate pack names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        policy_packs: [{ name: "p" }, { name: "p" }],
      }),
    ).toThrow(/duplicate policy_pack name/i);
  });
});

describe("parseManifest — permission_profiles (Phase 6 #5)", () => {
  it("defaults permission_profiles to {} when absent", () => {
    const m = parseManifest({ version: 1 });
    expect(m.permission_profiles).toEqual({});
  });

  it("parses a profile with all 7 action keys + accepts boolean shorthand", () => {
    const m = parseManifest({
      version: 1,
      permission_profiles: {
        custom: {
          description: "test",
          actions: {
            read: { allow: true },
            edit: { allow: false },
            bash: { allow: "ask" },
            commit: { allow: "false" },
            push: { allow: "true" },
            pr: { allow: "limited" },
            deploy: { allow: "ask_or_deny" },
          },
        },
      },
    });
    expect(m.permission_profiles.custom?.actions.read?.allow).toBe("true");
    expect(m.permission_profiles.custom?.actions.edit?.allow).toBe("false");
    expect(m.permission_profiles.custom?.actions.deploy?.allow).toBe("ask_or_deny");
  });

  it("rejects unknown action keys via .strict()", () => {
    expect(() =>
      parseManifest({
        version: 1,
        permission_profiles: {
          bad: { actions: { unknown_action: { allow: "true" } } },
        },
      }),
    ).toThrow(/unrecognized key|unknown_action/i);
  });

  it("rejects unknown allow values", () => {
    expect(() =>
      parseManifest({
        version: 1,
        permission_profiles: {
          bad: { actions: { read: { allow: "maybe" } } },
        },
      }),
    ).toThrow();
  });

  it("permits an inline `requires:` shape on a profile action", () => {
    const m = parseManifest({
      version: 1,
      permission_profiles: {
        gated: {
          actions: {
            edit: {
              allow: "true",
              requires: { ledger_tag: "understanding-approved:${SESSION_ID}" },
            },
          },
        },
      },
    });
    expect(m.permission_profiles.gated?.actions.edit?.requires?.ledger_tag).toBe(
      "understanding-approved:${SESSION_ID}",
    );
  });
});

describe("parseManifest — min_version numeric pattern", () => {
  // Five schema fields feed `compareNumericVersions`: hooks[].min_version,
  // policy_packs[].min_version, tools.mcp[].min_version,
  // tools.cli[].min_version, memory.router.min_version. Without a schema
  // pattern, a malformed value (`"latest"`, `"v1.0"`, `"1.0.0-alpha"`)
  // parses to NaN inside the comparator, which maps NaN to 0 (equality)
  // and silently swallows the version floor. Lock the schema rejection
  // explicitly per field so a future refactor that loosens any of the
  // five surfaces breaks loud.
  const REJECTED = ["latest", "v1.0", "1.0.0-alpha", "1.2.3+meta", "1..2", "."];
  const ACCEPTED = ["1", "1.0", "1.0.0", "1.0.0.0", "0.2.0"];

  function withHookMinVersion(value: string): unknown {
    return {
      version: 1,
      hooks: [
        {
          name: "h",
          event: "PreToolUse",
          command: "/usr/bin/true",
          blocking: false,
          min_version: value,
          version_command: ["/usr/bin/true", "--version"],
        },
      ],
    };
  }

  function withPolicyPackMinVersion(value: string): unknown {
    return {
      version: 1,
      policy_packs: [{ name: "understanding-before-execution", min_version: value }],
    };
  }

  function withMcpMinVersion(value: string): unknown {
    return {
      version: 1,
      tools: {
        mcp: [
          {
            name: "x",
            command: "node /tmp/x.js",
            min_version: value,
            version_command: ["node", "--version"],
          },
        ],
      },
    };
  }

  function withCliMinVersion(value: string): unknown {
    return {
      version: 1,
      tools: {
        cli: [
          {
            name: "x",
            binary: "x",
            min_version: value,
            version_command: ["x", "--version"],
          },
        ],
      },
    };
  }

  function withMemoryRouterMinVersion(value: string): unknown {
    return {
      version: 1,
      memory: {
        router: {
          command: ["node", "/tmp/router.js"],
          min_version: value,
          version_command: ["node", "/tmp/router.js", "--version"],
        },
      },
    };
  }

  const surfaces: Array<{ name: string; build: (v: string) => unknown }> = [
    { name: "hooks[]", build: withHookMinVersion },
    { name: "policy_packs[]", build: withPolicyPackMinVersion },
    { name: "tools.mcp[]", build: withMcpMinVersion },
    { name: "tools.cli[]", build: withCliMinVersion },
    { name: "memory.router", build: withMemoryRouterMinVersion },
  ];

  for (const { name, build } of surfaces) {
    for (const bad of REJECTED) {
      it(`rejects ${name}.min_version = ${JSON.stringify(bad)}`, () => {
        expect(() => parseManifest(build(bad))).toThrow(/min_version must be numeric semver/i);
      });
    }
    for (const good of ACCEPTED) {
      it(`accepts ${name}.min_version = ${JSON.stringify(good)}`, () => {
        expect(() => parseManifest(build(good))).not.toThrow();
      });
    }
  }
});

describe("parseManifest — Phase 7 risk-gate vocabulary", () => {
  it("parses the risk + environments blocks in the full reference manifest", () => {
    const raw = loadYaml(path.join(EXAMPLES_DIR, "full-manifest.yaml"));
    const manifest = parseManifest(raw);

    expect(manifest.risk.classifiers).toHaveLength(1);
    const classifier = manifest.risk.classifiers[0];
    expect(classifier?.name).toBe("dangerous-shell");
    expect(classifier?.tool).toBe("Bash");
    expect(classifier?.patterns).toHaveLength(4);
    expect(classifier?.patterns[0]?.severity).toBe("critical");
    expect(classifier?.patterns[0]?.categories).toEqual(["destructive", "data_loss"]);

    expect(manifest.environments.resolvers).toHaveLength(1);
    const resolver = manifest.environments.resolvers[0];
    expect(resolver?.name).toBe("production-signals");
    expect(resolver?.environment).toBe("production");
    expect(resolver?.signals.branch_patterns).toEqual(["main", "release/*"]);
    expect(resolver?.signals.env_var_patterns?.[0]?.var).toBe("DATABASE_URL");
  });

  it("rejects a risk severity outside the closed scale", () => {
    expect(() =>
      parseManifest({
        version: 1,
        risk: {
          classifiers: [
            {
              name: "c",
              tool: "Bash",
              patterns: [{ pattern: "rm", categories: ["destructive"], severity: "catastrophic" }],
            },
          ],
        },
      }),
    ).toThrow(/severity|enum/i);
  });

  it("rejects an unknown key inside a risk classifier (.strict)", () => {
    expect(() =>
      parseManifest({
        version: 1,
        risk: {
          classifiers: [
            {
              name: "c",
              tool: "Bash",
              patterns: [{ pattern: "rm", categories: ["destructive"], severity: "high" }],
              bogus: true,
            },
          ],
        },
      }),
    ).toThrow(/unrecognized key|bogus/i);
  });

  it("rejects an environment resolver asserting the unmatchable `unknown` name", () => {
    // `unknown` is the implicit no-resolver-matched fallback; a resolver
    // that asserts it is a contradiction the enum rejects.
    expect(() =>
      parseManifest({
        version: 1,
        environments: {
          resolvers: [
            { name: "r", environment: "unknown", signals: { branch_patterns: ["main"] } },
          ],
        },
      }),
    ).toThrow(/environment|enum/i);
  });

  it("rejects two environment resolvers sharing a name", () => {
    expect(() =>
      parseManifest({
        version: 1,
        environments: {
          resolvers: [
            { name: "r", environment: "production", signals: { branch_patterns: ["main"] } },
            { name: "r", environment: "staging", signals: { branch_patterns: ["develop"] } },
          ],
        },
      }),
    ).toThrow(/duplicate environment resolver name/i);
  });

  it("rejects an env_var_patterns entry missing its var", () => {
    expect(() =>
      parseManifest({
        version: 1,
        environments: {
          resolvers: [
            {
              name: "r",
              environment: "production",
              signals: { env_var_patterns: [{ patterns: ["prod"] }] },
            },
          ],
        },
      }),
    ).toThrow(/var|required/i);
  });

  it("accepts a policy with a populated when: block", () => {
    const m = parseManifest({
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
      policies: [
        {
          name: "gate-prod-destructive",
          description: "d",
          trigger: { event: "PreToolUse", match: "Bash" },
          requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
          hook: "h",
          enforcement: "block",
          when: {
            "risk.severity_at_least": "high",
            "risk.category_in": ["destructive", "data_loss"],
            "environment.name": "production",
            "action.reversible": false,
          },
        },
      ],
    });
    expect(m.policies[0]?.when?.["risk.severity_at_least"]).toBe("high");
    expect(m.policies[0]?.when?.["environment.name"]).toBe("production");
  });

  it("accepts when.environment.name = unknown (unknown is matchable)", () => {
    const m = parseManifest({
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
      policies: [
        {
          name: "p",
          description: "d",
          trigger: { event: "PreToolUse" },
          requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
          hook: "h",
          enforcement: "block",
          when: { "environment.name": "unknown" },
        },
      ],
    });
    expect(m.policies[0]?.when?.["environment.name"]).toBe("unknown");
  });

  it("rejects an unknown clause key inside when: (.strict)", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/usr/bin/true", blocking: false }],
        policies: [
          {
            name: "p",
            description: "d",
            trigger: { event: "PreToolUse" },
            requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
            hook: "h",
            enforcement: "block",
            when: { "risk.bogus_clause": "high" },
          },
        ],
      }),
    ).toThrow(/unrecognized key|bogus_clause/i);
  });
});

describe("parseManifest — friendly version-mismatch message (task 50a94127)", () => {
  it("replaces the bare literal error with upgrade guidance for version: 2", () => {
    try {
      parseManifest({ version: 2 });
      expect.unreachable("version: 2 must not parse");
    } catch (err) {
      expectIssueMatching(err, /this CLI supports manifest version 1/);
      expectIssueMatching(err, /your manifest declares version 2/);
      expectIssueMatching(err, /npm i -g @lannguyensi\/harness/);
      // Structure unchanged: still a version-pathed issue, so callers
      // branching on issue paths (and the exit-code mapping) are
      // unaffected.
      const issue = (err as ManifestParseError).issues.find(
        (i) => i.path.length === 1 && i.path[0] === "version",
      );
      expect(issue).toBeDefined();
    }
  });

  it("names the missing-version case instead of suggesting an upgrade", () => {
    try {
      parseManifest({ hooks: [] });
      expect.unreachable("missing version must not parse");
    } catch (err) {
      expectIssueMatching(err, /missing manifest version: add `version: 1`/);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/npm i -g/);
    }
  });

  it("leaves non-version issues untouched (control)", () => {
    try {
      parseManifest({ version: 1, bogus_key: true });
      expect.unreachable("unknown key must not parse");
    } catch (err) {
      expectIssueMatching(err, /bogus_key|unrecognized/i);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/supports manifest version/);
    }
  });
});

describe("parseManifest — version-message variants for non-newer values (task 50a94127 review)", () => {
  it("does not give upgrade advice for a LOWER numeric version", () => {
    try {
      parseManifest({ version: 0 });
      expect.unreachable("version: 0 must not parse");
    } catch (err) {
      expectIssueMatching(err, /unsupported manifest version 0/);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/npm i -g/);
    }
  });

  it("tells a quoted-string version to unquote, not to upgrade", () => {
    try {
      parseManifest({ version: "1" });
      expect.unreachable('version: "1" must not parse');
    } catch (err) {
      expectIssueMatching(err, /unsupported manifest version "1"/);
      expectIssueMatching(err, /unquoted/);
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/npm i -g/);
    }
  });

  it("leaves a non-object root's issues untouched (no version rewrite on scalars)", () => {
    try {
      parseManifest("just a string");
      expect.unreachable("scalar root must not parse");
    } catch (err) {
      const text = (err as ManifestParseError).issues.map((i) => i.message).join("\n");
      expect(text).not.toMatch(/supports manifest version/);
    }
  });
});
