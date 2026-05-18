import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ManifestParseError, parseManifest } from "../src/schema/index.js";

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
    expect(manifest.hooks).toHaveLength(8);
    expect(manifest.policies).toHaveLength(8);
    const reviewPolicy = manifest.policies.find((p) => p.name === "review-before-merge");
    expect(reviewPolicy?.requires.ledger_tag).toBe("review:${PR_NUMBER}");
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
    expect(reviewSubagentPolicy?.requires.ledger_tag).toBe("review-subagent:${TASK_ID}");
    const preflightPushPolicy = manifest.policies.find(
      (p) => p.name === "preflight-before-push",
    );
    expect(preflightPushPolicy?.trigger.match).toBe("Bash");
    expect(preflightPushPolicy?.trigger.bash_match).toBe(
      "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
    );
    expect(preflightPushPolicy?.requires.ledger_tag).toBe("preflight:${BRANCH}");
    expect(preflightPushPolicy?.requires.within).toBe("10m");
    expect(manifest.policy_packs).toHaveLength(2);
    expect(manifest.policy_packs[0]?.name).toBe("understanding-before-execution");
    expect(manifest.policy_packs[0]?.source).toBe("builtin");
    expect(manifest.policy_packs[0]?.enabled).toBe(true);
    expect(manifest.policy_packs[1]?.name).toBe("branch-protection");
    expect(manifest.policy_packs[1]?.source).toBe("builtin");
    expect(manifest.policy_packs[1]?.enabled).toBe(true);
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
        hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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
      hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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
        hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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
      expect(m.policies[0]?.requires.within).toBe(within);
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
          hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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
        hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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
      hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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

describe("parseManifest — uniqueness checks", () => {
  it("rejects duplicate hook names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [
          { name: "h", event: "PreToolUse", command: "/bin/true", blocking: false },
          { name: "h", event: "PostToolUse", command: "/bin/true", blocking: false },
        ],
      }),
    ).toThrow(/duplicate hook/i);
  });

  it("rejects duplicate policy names", () => {
    expect(() =>
      parseManifest({
        version: 1,
        hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
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
