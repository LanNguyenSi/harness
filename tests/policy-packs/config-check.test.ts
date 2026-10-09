import { describe, expect, it } from "vitest";
import { checkPolicyPackConfigs } from "../../src/policy-packs/config-check.js";
import { parseManifest } from "../../src/schema/index.js";

function manifestWith(packs: unknown[]) {
  return parseManifest({
    version: 1,
    policy_packs: packs,
  });
}

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

  it("rejects an empty entry inside protected_branches (nested array path)", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { protected_branches: ["main", ""] } },
    ]);
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("protected_branches[1]");
  });

  it("accepts a well-formed ux block and rejects an ux block missing `cannot`", () => {
    const goodM = manifestWith([
      {
        name: "branch-protection",
        config: {
          ux: {
            cannot: "You cannot edit files on a protected branch.",
            required: ["a non-protected checkout"],
            run: ["git checkout -b feat/x"],
          },
        },
      },
    ]);
    expect(checkPolicyPackConfigs(goodM)).toEqual([]);

    const badM = manifestWith([
      {
        name: "branch-protection",
        config: {
          ux: {
            required: ["a non-protected checkout"],
            run: ["git checkout -b feat/x"],
          },
        },
      },
    ]);
    const issues = checkPolicyPackConfigs(badM);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.configPath).toBe("ux.cannot");
  });
});

describe("checkPolicyPackConfigs — cross-pack semantics", () => {
  it("disabled packs are not checked", () => {
    const m = manifestWith([
      {
        name: "branch-protection",
        enabled: false,
        config: { protected_branches: "master" },
      },
    ]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
    // Positive control: the same bad config on an enabled entry is flagged,
    // so the empty result above is the disabled flag, not the check being
    // skipped.
    const enabled = manifestWith([
      { name: "branch-protection", enabled: true, config: { protected_branches: "master" } },
    ]);
    expect(checkPolicyPackConfigs(enabled)).toHaveLength(1);
  });

  it("unknown pack names are skipped (source-check's job)", () => {
    const m = manifestWith([{ name: "no-such-pack", config: { mode: "fastConfirm" } }]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("the removed understanding-before-execution pack is stripped by the manifest parse, so its config is never checked", () => {
    const m = manifestWith([
      { name: "branch-protection" },
      { name: "understanding-before-execution", config: { mode: "fastConfirm" } },
    ]);
    expect(m.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
    expect(checkPolicyPackConfigs(m)).toEqual([]);
  });

  it("preserves manifest order across multiple pack entries with issues", () => {
    // Only one builtin pack ships, and the schema refuses two entries with
    // the same name, so the second entry is spread in after the parse: the
    // check walks whatever entries the manifest carries.
    const one = manifestWith([
      { name: "branch-protection", config: { protected_branches: "master" } },
    ]);
    const m = {
      ...one,
      policy_packs: [
        ...one.policy_packs,
        { ...one.policy_packs[0]!, config: { protected_brnches: ["master"] } },
      ],
    };
    const issues = checkPolicyPackConfigs(m);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ packIndex: 0, packName: "branch-protection", configPath: "protected_branches" });
    expect(issues[1]).toMatchObject({ packIndex: 1, packName: "branch-protection", code: "unrecognized_keys" });
  });
});
