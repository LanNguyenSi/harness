// Canonical shipped-default `config.ux` / `config.producers` (task
// 68b9ad9c): the single source `harness pack reseed`, the ux-drift
// doctor check, and the init generation surfaces (Solo/Team/Full
// templates, the Custom composer) all read from.

import { describe, expect, it } from "vitest";
import { defaultUx as branchProtectionDefaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { resolveBuiltinDefaultConfig } from "../../src/policy-packs/registry.js";
import { parseManifest } from "../../src/schema/index.js";

describe("branch-protection.defaultUx", () => {
  it("teaches branching off as the only recovery command (task a4d8adc5: the session-start producer is gone)", () => {
    const ux = branchProtectionDefaultUx();
    expect(ux.run).toEqual(["git checkout -b feat/<your-task>"]);
  });
});

describe("resolveBuiltinDefaultConfig", () => {
  function packWith(name: string, config: Record<string, unknown> = {}) {
    return parseManifest({
      version: 1,
      policy_packs: [{ name, config }],
    }).policy_packs[0]!;
  }

  it("branch-protection: ux only, no canonical producers", () => {
    const pack = packWith("branch-protection");
    const result = resolveBuiltinDefaultConfig(pack);
    expect(result?.ux).toEqual(branchProtectionDefaultUx());
    expect(result?.producers).toBeUndefined();
  });

  it("the removed understanding-before-execution pack is no longer a builtin: null", () => {
    const pack = { ...packWith("branch-protection"), name: "understanding-before-execution" };
    expect(resolveBuiltinDefaultConfig(pack)).toBeNull();
  });

  it("unknown pack name: null", () => {
    // Bypass the schema's builtin-name checks are elsewhere; this function
    // itself just needs a `PolicyPack`-shaped object with an unknown name.
    const pack = { ...packWith("branch-protection"), name: "no-such-pack" };
    expect(resolveBuiltinDefaultConfig(pack)).toBeNull();
  });
});
