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
