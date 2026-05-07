import { describe, expect, it } from "vitest";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest } from "../../src/schema/index.js";

function buildManifest(packs: unknown[], extraHooks: unknown[] = []): ReturnType<typeof parseManifest> {
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

  it("resolves the understanding-before-execution builtin into 3 hooks + 1 instructions file", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(3);
    const events = r.hooks.map((h) => h.event).sort();
    expect(events).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);
    const names = r.hooks.map((h) => h.name).sort();
    expect(names).toEqual([
      "policy-pack:understanding-before-execution:pre-tool-use",
      "policy-pack:understanding-before-execution:stop",
      "policy-pack:understanding-before-execution:user-prompt-submit",
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.relativePath).toBe(
      "policy-packs/understanding-before-execution/instructions.md",
    );
    expect(r.files[0]?.content).toContain("# Policy Pack: understanding-before-execution");
    expect(r.warnings).toEqual([]);
  });

  it("PreToolUse hook is hard-blocking with the documented match", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    const pre = r.hooks.find((h) => h.event === "PreToolUse");
    expect(pre?.blocking).toBe("hard");
    expect(pre?.match).toBe("Edit|Write|Bash");
  });

  it("uses default mode 'grill_me' when config omits mode", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.files[0]?.content).toMatch(/## Mode\s*\n\s*grill_me/);
  });

  it("threads explicit modes through the instructions file", () => {
    for (const mode of ["fast_confirm", "grill_me", "strict"] as const) {
      const m = buildManifest([{ name: "understanding-before-execution", config: { mode } }]);
      const r = expandPolicyPacks(m);
      expect(r.files[0]?.content).toMatch(new RegExp(`## Mode\\s*\\n\\s*${mode}`));
    }
  });

  it("warns and falls back to grill_me when mode is unrecognised", () => {
    const m = buildManifest([
      { name: "understanding-before-execution", config: { mode: "definitely_invalid" } },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.warnings.some((w) => w.includes("definitely_invalid"))).toBe(true);
    expect(r.files[0]?.content).toMatch(/## Mode\s*\n\s*grill_me/);
  });

  it("skips an enabled:false pack and records its name in `skipped`", () => {
    const m = buildManifest([
      { name: "understanding-before-execution", enabled: false, config: { mode: "strict" } },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual(["understanding-before-execution"]);
  });

  it("warns and skips when source is not 'builtin'", () => {
    const m = buildManifest([
      { name: "understanding-before-execution", source: "path:./somewhere" },
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

  it("drops a pack hook whose name collides with a manifest hooks[] entry", () => {
    const m = buildManifest(
      [{ name: "understanding-before-execution" }],
      [
        {
          name: "policy-pack:understanding-before-execution:stop",
          event: "Stop",
          command: "/usr/local/bin/handler.sh",
          blocking: false,
          budget_ms: 5000,
        },
      ],
    );
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(2);
    expect(r.hooks.find((h) => h.event === "Stop")).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("collides with a manifest hooks"))).toBe(true);
  });
});
