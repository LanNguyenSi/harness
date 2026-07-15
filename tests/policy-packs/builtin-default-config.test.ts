// Canonical shipped-default `config.ux` / `config.producers` (task
// 68b9ad9c): the single source `harness pack reseed`, the ux-drift
// doctor check, and the init generation surfaces (Solo/Team/Full
// templates, the Custom composer) all read from.

import { describe, expect, it } from "vitest";
import {
  defaultProducers,
  defaultUx,
} from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { defaultUx as branchProtectionDefaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { resolveBuiltinDefaultConfig } from "../../src/policy-packs/registry.js";
import { parseManifest } from "../../src/schema/index.js";

describe("understanding-before-execution.defaultUx", () => {
  it("varies only the `required` line across modes", () => {
    const grillMe = defaultUx("grill_me");
    const strict = defaultUx("strict");
    const fastConfirm = defaultUx("fast_confirm");
    expect(grillMe.cannot).toBe(strict.cannot);
    expect(grillMe.run).toEqual(strict.run);
    expect(grillMe.required).toEqual(["an approved Understanding Report for this session"]);
    expect(fastConfirm.required).toEqual(grillMe.required);
    expect(strict.required).toEqual([
      "a human-approved Understanding Report for this session",
    ]);
  });

  it("teaches the heredoc submission form (agent-tasks/e48e3b45) in the second run: line", () => {
    const ux = defaultUx("grill_me");
    expect(ux.run[1]).toMatch(/<<'UNDERSTANDING_REPORT'/);
    expect(ux.run[1]).toMatch(/no pipes, chaining, or other redirection/);
  });

  it("is schema-valid", () => {
    const m = parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          config: { mode: "grill_me", ux: defaultUx("grill_me") },
        },
      ],
    });
    expect(m.policy_packs[0]?.config["ux"]).toBeDefined();
  });
});

describe("understanding-before-execution.defaultProducers", () => {
  it("includes the golden-path `ask` producer and the un-hooked `bash` producer", () => {
    const producers = defaultProducers();
    expect(producers).toHaveLength(2);
    expect(producers.some((p) => p.kind === "ask" && p.command === "harness approve understanding")).toBe(
      true,
    );
    expect(
      producers.some((p) => p.kind === "bash" && p.command === "harness approve understanding"),
    ).toBe(true);
  });
});

describe("branch-protection.defaultUx", () => {
  it("teaches the branch-check recovery command", () => {
    const ux = branchProtectionDefaultUx();
    expect(ux.run).toContain("harness session-start branch-check");
  });
});

describe("resolveBuiltinDefaultConfig", () => {
  function packWith(name: string, config: Record<string, unknown> = {}) {
    return parseManifest({
      version: 1,
      policy_packs: [{ name, config }],
    }).policy_packs[0]!;
  }

  it("understanding-before-execution: resolves ux from the pack's OWN configured mode", () => {
    const pack = packWith("understanding-before-execution", { mode: "strict" });
    const result = resolveBuiltinDefaultConfig(pack);
    expect(result?.ux).toEqual(defaultUx("strict"));
    expect(result?.producers).toEqual(defaultProducers());
  });

  it("understanding-before-execution: defaults to grill_me when mode is unset", () => {
    const pack = packWith("understanding-before-execution");
    const result = resolveBuiltinDefaultConfig(pack);
    expect(result?.ux).toEqual(defaultUx("grill_me"));
  });

  it("branch-protection: ux only, no canonical producers", () => {
    const pack = packWith("branch-protection");
    const result = resolveBuiltinDefaultConfig(pack);
    expect(result?.ux).toEqual(branchProtectionDefaultUx());
    expect(result?.producers).toBeUndefined();
  });

  it("solution-acceptance: no registered shipped default (null)", () => {
    const pack = packWith("solution-acceptance");
    expect(resolveBuiltinDefaultConfig(pack)).toBeNull();
  });

  it("unknown pack name: null", () => {
    // Bypass the schema's builtin-name checks are elsewhere; this function
    // itself just needs a `PolicyPack`-shaped object with an unknown name.
    const pack = { ...packWith("branch-protection"), name: "no-such-pack" };
    expect(resolveBuiltinDefaultConfig(pack)).toBeNull();
  });
});
