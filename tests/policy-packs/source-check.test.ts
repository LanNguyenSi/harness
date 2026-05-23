import { describe, expect, it } from "vitest";
import { checkPolicyPackSources } from "../../src/policy-packs/source-check.js";
import { parseManifest } from "../../src/schema/index.js";

function manifestWith(packs: unknown[]) {
  return parseManifest({
    version: 1,
    policy_packs: packs,
  });
}

describe("checkPolicyPackSources", () => {
  it("returns no issues when every enabled pack resolves cleanly", () => {
    const m = manifestWith([{ name: "understanding-before-execution" }]);
    expect(checkPolicyPackSources(m)).toEqual([]);
  });

  it("flags an unknown source on an enabled pack", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", source: "path:./somewhere" },
    ]);
    const issues = checkPolicyPackSources(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      packIndex: 0,
      packName: "understanding-before-execution",
      kind: "unknown-source",
      source: "path:./somewhere",
      field: "source",
    });
    expect(issues[0]?.message).toMatch(/only "builtin" resolves/);
  });

  it("flags an unknown builtin name on an enabled pack", () => {
    const m = manifestWith([{ name: "no-such-pack" }]);
    const issues = checkPolicyPackSources(m);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      packIndex: 0,
      packName: "no-such-pack",
      kind: "unknown-builtin",
      field: "name",
    });
    expect(issues[0]?.message).toMatch(/not a known builtin pack/);
  });

  it("does not flag enabled:false packs even with bogus source or name", () => {
    const m = manifestWith([
      { name: "no-such-pack", source: "git:https://x.git", enabled: false },
    ]);
    expect(checkPolicyPackSources(m)).toEqual([]);
  });

  it("aggregates one issue per bad enabled pack and preserves array order", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", source: "path:./a" },
      { name: "no-such-pack" },
    ]);
    const issues = checkPolicyPackSources(m);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.packIndex).toBe(0);
    expect(issues[0]?.kind).toBe("unknown-source");
    expect(issues[1]?.packIndex).toBe(1);
    expect(issues[1]?.kind).toBe("unknown-builtin");
  });
});
