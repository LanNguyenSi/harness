import { describe, expect, it } from "vitest";
import { checkPolicyPackConfigs } from "../../src/policy-packs/config-check.js";
import { parseManifest } from "../../src/schema/index.js";

function manifestWith(packs: unknown[]) {
  return parseManifest({
    version: 1,
    policy_packs: packs,
  });
}

describe("checkPolicyPackConfigs — understanding-before-execution", () => {
  it("clean config produces no issues", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "fast_confirm", permission_profile: "safe-start" },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("missing config (defaults) is silent", () => {
    const m = manifestWith([{ name: "understanding-before-execution" }]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("rejects a bad `mode` enum value (the camelCase typo case)", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", config: { mode: "fastConfirm" } },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("mode");
    expect(issues[0]?.code).toBe("invalid_enum_value");
    expect(issues[0]?.packName).toBe("understanding-before-execution");
  });

  it("rejects a typo'd top-level key (strict mode)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { permision_profile: "safe-start" },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("unrecognized_keys");
    expect(issues[0]?.message).toMatch(/permision_profile/);
  });

  it("rejects a bad permission_profile enum", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { permission_profile: "yolo" },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("permission_profile");
    expect(issues[0]?.code).toBe("invalid_enum_value");
  });

  it("accepts a session-mode approval_lifecycle", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { mode: "session" } },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("accepts an expire_on_tool_match list", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_tool_match: ["mcp__agent-tasks__task_finish"],
          },
        },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("rejects a bad nested approval_lifecycle.mode literal", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { mode: "task" } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("approval_lifecycle.mode");
  });

  it("rejects an unknown nested approval_lifecycle key", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { hold_until: "next_session" } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("unrecognized_keys");
    expect(issues[0]?.configPath).toBe("approval_lifecycle");
  });

  it("rejects an empty entry inside expire_on_tool_match (nested array path)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { expire_on_tool_match: [""] } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("approval_lifecycle.expire_on_tool_match[0]");
  });

  it("accepts a well-formed auto_approve block", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: ["bypassPermissions"], require_report: true } },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("rejects auto_approve.require_report: false", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: ["bypassPermissions"], require_report: false } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.require_report");
  });

  it("rejects auto_approve missing require_report", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: ["bypassPermissions"] } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.require_report");
  });

  it("rejects an unknown nested auto_approve key", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: { when: ["bypassPermissions"], require_report: true, mode: "auto" },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("unrecognized_keys");
    expect(issues[0]?.configPath).toBe("auto_approve");
  });

  it("rejects an empty auto_approve.when array", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: [], require_report: true } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.when");
  });

  // `auto_approve.harnesses` (slice 2 review round 1): the per-harness
  // opt-in that keeps a shared auto path from widening a Claude-only
  // opt-in to Codex. Absent is legal and means `[claude-code]`, which is
  // why the "well-formed block" case above carries no `harnesses` key.
  it("accepts a well-formed auto_approve.harnesses list", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["claude-code", "codex"],
            require_report: true,
          },
        },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("rejects an empty auto_approve.harnesses array", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: { when: ["bypassPermissions"], harnesses: [], require_report: true },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.harnesses");
  });

  it("rejects an unknown harness value at the exact index", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["claude-code", "cursor"],
            require_report: true,
          },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.harnesses[1]");
    expect(issues[0]?.code).toBe("invalid_enum_value");
  });

  it("rejects a non-array auto_approve.harnesses", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: { when: ["bypassPermissions"], harnesses: "codex", require_report: true },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.harnesses");
    expect(issues[0]?.code).toBe("invalid_type");
  });

  it("rejects a duplicated auto_approve.harnesses entry", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["codex", "codex"],
            require_report: true,
          },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.harnesses");
    expect(issues[0]?.message).toMatch(/duplicate/);
  });

  it("rejects an empty entry inside auto_approve.when (nested array path)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: [""], require_report: true } },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("auto_approve.when[0]");
  });

  it("accepts a well-formed ux block and rejects an ux block missing `cannot`", () => {
    const goodM = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          ux: {
            cannot: "You cannot do that.",
            required: ["context"],
            run: ["harness approve understanding"],
          },
        },
      },
    ]);
    expect(checkPolicyPackConfigs(goodM)).toEqual([]);

    const badM = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          ux: { required: ["context"], run: ["harness approve understanding"] },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(badM);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("ux.cannot");
  });

  it("accepts a well-formed kind:mcp producer", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          producers: [
            {
              kind: "mcp",
              verb: "mcp__grounding-mcp__ledger_add",
              example: "ledger_add({ type: 'fact', content: 'ok' })",
              description: "record an evidence-ledger fact",
            },
          ],
        },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("rejects a producer with a missing required field (the description on a kind:bash entry)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          producers: [{ kind: "bash", command: "echo hi" }],
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]?.configPath).toMatch(/^producers\[0\]/);
  });
});

describe("checkPolicyPackConfigs — branch-protection", () => {
  it("default config (no override) is silent", () => {
    const m = manifestWith([{ name: "branch-protection" }]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("accepts a string array of protected_branches", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { protected_branches: ["master", "main"] } },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("rejects a non-array protected_branches", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { protected_branches: "master" } },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("protected_branches");
  });

  it("rejects a typo'd top-level key", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { protected_brnches: ["master"] } },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("unrecognized_keys");
  });
});

describe("checkPolicyPackConfigs — cross-pack semantics", () => {
  it("disabled packs are not checked", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        enabled: false,
        config: { mode: "fastConfirm" },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("unknown pack names are skipped (source-check's job)", () => {
    const m = manifestWith([{ name: "no-such-pack", config: { mode: "fastConfirm" } }]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("preserves manifest order across multiple packs with issues", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "fastConfirm" },
      },
      {
        name: "branch-protection",
        config: { protected_brnches: ["master"] },
      },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.packIndex).toBe(0);
    expect(issues[0]?.packName).toBe("understanding-before-execution");
    expect(issues[1]?.packIndex).toBe(1);
    expect(issues[1]?.packName).toBe("branch-protection");
  });
});
