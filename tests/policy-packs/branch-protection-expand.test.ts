import { describe, expect, it } from "vitest";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest } from "../../src/schema/index.js";

function buildManifest(packs: unknown[]): ReturnType<typeof parseManifest> {
  return parseManifest({ version: 1, policy_packs: packs });
}

describe("branch-protection pack expansion", () => {
  it("contributes one SessionStart producer + one PreToolUse blocker + instructions.md", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(2);
    const events = r.hooks.map((h) => h.event).sort();
    expect(events).toEqual(["PreToolUse", "SessionStart"]);
    const names = r.hooks.map((h) => h.name).sort();
    expect(names).toEqual([
      "policy-pack:branch-protection:pre-tool-use",
      "policy-pack:branch-protection:session-start",
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.relativePath).toBe(
      "policy-packs/branch-protection/instructions.md",
    );
    expect(r.files[0]?.content).toContain("# Policy Pack: branch-protection");
    expect(r.warnings).toEqual([]);
  });

  it("wires the producer as blocking:false (must never break the session)", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m);
    const producer = r.hooks.find((h) => h.event === "SessionStart");
    expect(producer?.blocking).toBe(false);
    expect(producer?.command).toBe("harness session-start branch-check");
  });

  it("wires the PreToolUse blocker as blocking:hard with the Write|Edit match on claude-code", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m);
    const blocker = r.hooks.find((h) => h.event === "PreToolUse");
    expect(blocker?.blocking).toBe("hard");
    expect(blocker?.match).toBe("Write|Edit");
    expect(blocker?.command).toBe("harness pack hook branch-protection");
  });

  it("switches the PreToolUse match to apply_patch on codex", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m, "codex");
    const blocker = r.hooks.find((h) => h.event === "PreToolUse");
    expect(blocker?.match).toBe("apply_patch");
  });

  it("renders the protected list in instructions.md", () => {
    const m = buildManifest([
      { name: "branch-protection", config: { protected_branches: ["main", "production"] } },
    ]);
    const r = expandPolicyPacks(m);
    const md = r.files[0]?.content ?? "";
    expect(md).toContain("- `main`");
    expect(md).toContain("- `production`");
    expect(md).not.toContain("- `master`");
  });

  it("surfaces a config warning when protected_branches is malformed", () => {
    const m = buildManifest([
      { name: "branch-protection", config: { protected_branches: "main" } },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.warnings.join("\n")).toMatch(/expected an array of strings/);
  });

  it("skips the pack when enabled:false", () => {
    const m = buildManifest([{ name: "branch-protection", enabled: false }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual(["branch-protection"]);
  });
});
