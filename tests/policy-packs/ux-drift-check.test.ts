import { describe, expect, it } from "vitest";
import { checkPolicyPackUxDrift } from "../../src/policy-packs/ux-drift-check.js";
import { defaultUx } from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { defaultUx as branchProtectionDefaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { parseManifest } from "../../src/schema/index.js";

function manifestWith(packs: unknown[]) {
  return parseManifest({ version: 1, policy_packs: packs });
}

const CANONICAL_UX_GRILL_ME = defaultUx("grill_me");
const STALE_UX = {
  cannot: "You cannot use write-capable tools yet.",
  required: ["an approved Understanding Report for this session"],
  run: [
    "Run `harness approve understanding` once you have produced and confirmed an Understanding Report.",
  ],
};

describe("checkPolicyPackUxDrift — understanding-before-execution", () => {
  it("flags a stale ux.run (mutation: pre-fix wording vs the shipped template)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "grill_me", ux: STALE_UX },
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      packIndex: 0,
      packName: "understanding-before-execution",
      fields: ["ux"],
    });
    expect(drift[0]?.message).toMatch(/harness pack reseed understanding-before-execution/);
  });

  it("does NOT flag a ux that already matches the shipped template (negative control)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "grill_me", ux: CANONICAL_UX_GRILL_ME },
      },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("compares against the CURRENT mode's canonical wording, not a hardcoded default mode", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "strict", ux: defaultUx("strict") },
      },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("flags stale producers independently of ux", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          mode: "grill_me",
          ux: CANONICAL_UX_GRILL_ME,
          producers: [
            { kind: "ask", command: "old command", description: "old" },
          ],
        },
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.fields).toEqual(["producers"]);
  });

  it("flags both ux and producers together in one entry", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: {
          mode: "grill_me",
          ux: STALE_UX,
          producers: [{ kind: "ask", command: "old", description: "old" }],
        },
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.fields).toEqual(["ux", "producers"]);
  });

  it("does not flag when config.ux / config.producers are absent entirely (missing is out of scope)", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", config: { mode: "grill_me" } },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("treats a malformed config.ux as diverging (not silently skipped)", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "grill_me", ux: { cannot: "x" } }, // missing required/run
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.fields).toEqual(["ux"]);
  });

  it("disabled packs are not checked", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        enabled: false,
        config: { mode: "grill_me", ux: STALE_UX },
      },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("unknown pack names are skipped (source-check's job)", () => {
    const m = manifestWith([{ name: "no-such-pack", config: { ux: STALE_UX } }]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });
});

describe("checkPolicyPackUxDrift — branch-protection", () => {
  it("flags a stale ux", () => {
    const m = manifestWith([
      {
        name: "branch-protection",
        config: {
          ux: {
            cannot: "old wording",
            required: ["old requirement"],
            run: ["old step"],
          },
        },
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.packName).toBe("branch-protection");
  });

  it("does not flag a ux matching the shipped template", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { ux: branchProtectionDefaultUx() } },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("has no canonical producers, so a declared producers list is never flagged", () => {
    const m = manifestWith([
      {
        name: "branch-protection",
        config: {
          ux: branchProtectionDefaultUx(),
          producers: [{ kind: "ask", command: "whatever", description: "whatever" }],
        },
      },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });
});

describe("checkPolicyPackUxDrift — solution-acceptance (no registered shipped default)", () => {
  it("never flags this pack, even with an obviously non-canonical ux", () => {
    const m = manifestWith([
      {
        name: "solution-acceptance",
        enabled: true,
        config: {
          ux: { cannot: "whatever", required: ["whatever"], run: ["whatever"] },
        },
      },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });
});

describe("checkPolicyPackUxDrift — cross-pack semantics", () => {
  it("preserves manifest order and reports one entry per diverging pack", () => {
    const m = manifestWith([
      {
        name: "understanding-before-execution",
        config: { mode: "grill_me", ux: STALE_UX },
      },
      {
        name: "branch-protection",
        config: {
          ux: { cannot: "old", required: ["old"], run: ["old"] },
        },
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(2);
    expect(drift[0]?.packName).toBe("understanding-before-execution");
    expect(drift[1]?.packName).toBe("branch-protection");
  });
});
