import { describe, expect, it } from "vitest";
import { checkPolicyPackUxDrift } from "../../src/policy-packs/ux-drift-check.js";
import { defaultUx as branchProtectionDefaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { parseManifest } from "../../src/schema/index.js";

function manifestWith(packs: unknown[]) {
  return parseManifest({ version: 1, policy_packs: packs });
}

const STALE_UX = { cannot: "old", required: ["old"], run: ["old"] };

describe("checkPolicyPackUxDrift: branch-protection", () => {
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
    expect(drift[0]).toMatchObject({
      packIndex: 0,
      packName: "branch-protection",
      fields: ["ux"],
    });
    expect(drift[0]?.message).toMatch(/harness pack reseed branch-protection/);
  });

  it("does not flag a ux matching the shipped template", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { ux: branchProtectionDefaultUx() } },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("does not flag when config.ux is absent entirely (missing is out of scope)", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { protected_branches: ["main"] } },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
    // Positive control: the same fixture shape with a (stale, malformed)
    // config.ux DOES flag, so the empty result above is the check running
    // and passing on an absent ux, not the pack being skipped.
    const stale = manifestWith([
      { name: "branch-protection", config: { ux: { cannot: "x" } } },
    ]);
    expect(checkPolicyPackUxDrift(stale)).toHaveLength(1);
  });
  it("treats a malformed config.ux as diverging (not silently skipped)", () => {
    const m = manifestWith([
      {
        name: "branch-protection",
        config: { ux: { cannot: "x" } }, // missing required/run
      },
    ]);
    const drift = checkPolicyPackUxDrift(m);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.fields).toEqual(["ux"]);
  });
  it("disabled packs are not checked", () => {
    const m = manifestWith([
      {
        name: "branch-protection",
        enabled: false,
        config: { ux: { cannot: "old", required: ["old"], run: ["old"] } },
      },
    ]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
    // Positive control: the same stale ux with enabled: true flags, so the
    // empty result above is the disabled flag, not the check being skipped.
    const enabled = manifestWith([
      {
        name: "branch-protection",
        enabled: true,
        config: { ux: { cannot: "old", required: ["old"], run: ["old"] } },
      },
    ]);
    expect(checkPolicyPackUxDrift(enabled)).toHaveLength(1);
  });
});

describe("checkPolicyPackUxDrift: pack selection", () => {
  it("unknown pack names are skipped (source-check's job)", () => {
    const m = manifestWith([{ name: "no-such-pack", config: { ux: STALE_UX } }]);
    expect(checkPolicyPackUxDrift(m)).toEqual([]);
  });

  it("the removed understanding-before-execution pack is stripped by the manifest parse, so it is never checked", () => {
    const m = manifestWith([
      { name: "branch-protection", config: { ux: STALE_UX } },
      { name: "understanding-before-execution", config: { mode: "grill_me", ux: STALE_UX } },
    ]);
    expect(m.policy_packs.map((p) => p.name)).toEqual(["branch-protection"]);
    expect(checkPolicyPackUxDrift(m).map((d) => d.packName)).toEqual(["branch-protection"]);
  });
});

describe("checkPolicyPackUxDrift: cross-entry semantics", () => {
  // Only one builtin pack ships, and the schema refuses two entries with the
  // same name, so the second entry is spread in after the parse: the check
  // walks whatever entries the manifest carries.
  it("preserves manifest order and reports one entry per diverging pack entry", () => {
    const one = manifestWith([{ name: "branch-protection", config: { ux: STALE_UX } }]);
    const m = { ...one, policy_packs: [...one.policy_packs, ...one.policy_packs] };
    const drift = checkPolicyPackUxDrift(m);
    expect(drift.map((d) => [d.packIndex, d.packName])).toEqual([
      [0, "branch-protection"],
      [1, "branch-protection"],
    ]);
  });

  it("indexes by manifest position: a matching entry before a stale one does not shift the stale one's index", () => {
    const ok = manifestWith([{ name: "branch-protection", config: { ux: branchProtectionDefaultUx() } }]);
    const stale = manifestWith([{ name: "branch-protection", config: { ux: STALE_UX } }]);
    const m = { ...ok, policy_packs: [...ok.policy_packs, ...stale.policy_packs] };
    expect(checkPolicyPackUxDrift(m).map((d) => d.packIndex)).toEqual([1]);
  });
});
