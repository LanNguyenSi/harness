import { describe, expect, it } from "vitest";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest } from "../../src/schema/index.js";

function buildManifest(
  packs: unknown[],
  extraHooks: unknown[] = [],
): ReturnType<typeof parseManifest> {
  return parseManifest({
    version: 1,
    hooks: extraHooks,
    policy_packs: packs,
  });
}

describe("expandPolicyPacks", () => {
  it("returns an empty result when policy_packs is empty", () => {
    const m = parseManifest({ version: 1 });
    const r = expandPolicyPacks(m);
    expect(r).toEqual({ hooks: [], files: [], warnings: [], skipped: [] });
  });

  it("resolves the branch-protection builtin into one blocking PreToolUse hook + 1 instructions file, on every runtime", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    for (const runtime of ["claude-code", "codex"] as const) {
      const r = expandPolicyPacks(m, runtime);
      expect(r.hooks.map((h) => [h.name, h.event, h.blocking]), `runtime ${runtime}`).toEqual([
        ["policy-pack:branch-protection:pre-tool-use", "PreToolUse", "hard"],
      ]);
      expect(r.files, `runtime ${runtime}`).toHaveLength(1);
      expect(r.files[0]?.relativePath).toBe("policy-packs/branch-protection/instructions.md");
      expect(r.warnings).toEqual([]);
    }
  });

  it("skips an enabled:false pack and records its name in `skipped`", () => {
    const m = buildManifest([
      {
        name: "branch-protection",
        enabled: false,
      },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual(["branch-protection"]);
  });

  it("warns and skips when source is not 'builtin'", () => {
    const m = buildManifest([
      { name: "branch-protection", source: "path:./somewhere" },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/source .* is not recognised/);
  });

  it("warns and skips when name is not a known builtin", () => {
    const m = buildManifest([{ name: "no-such-pack" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/not a known builtin pack/);
  });

  it("aggregates enabled packs independently: a resolving builtin plus an unknown name", () => {
    // The unknown second entry proves the loop in expand.ts (a) iterates
    // over every entry, (b) records the warning without dropping the
    // first pack's contributions, (c) preserves the resolvable pack's
    // contribution on the way through. `branch-protection` contributes
    // exactly one PreToolUse blocker and one instructions file, so the
    // counts are exact.
    const m = buildManifest([
      { name: "branch-protection" },
      { name: "no-such-pack" },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(1);
    expect(r.files).toHaveLength(1);
    const unknownNameWarnings = r.warnings.filter((w) =>
      w.includes("not a known builtin pack"),
    );
    expect(unknownNameWarnings).toHaveLength(1);
    expect(unknownNameWarnings[0]).toContain("no-such-pack");
  });

  it("drops a pack hook whose name collides with a manifest hooks[] entry", () => {
    const m = buildManifest(
      [{ name: "branch-protection" }],
      [
        {
          name: "policy-pack:branch-protection:pre-tool-use",
          event: "PreToolUse",
          command: "/usr/local/bin/handler.sh",
          blocking: false,
          budget_ms: 5000,
        },
      ],
    );
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(0); // 1 contribution - 1 dropped collision (PreToolUse)
    expect(
      r.hooks.find((h) => h.name === "policy-pack:branch-protection:pre-tool-use"),
    ).toBeUndefined();
    expect(r.files).toHaveLength(1); // positive: the pack resolved, its instructions file remains
    expect(
      r.warnings.some((w) => w.includes("collides with a manifest hooks")),
    ).toBe(true);
  });
});
