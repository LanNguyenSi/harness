import { describe, expect, it } from "vitest";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest } from "../../src/schema/index.js";

function buildManifest(packs: unknown[]): ReturnType<typeof parseManifest> {
  return parseManifest({ version: 1, policy_packs: packs });
}

describe("branch-protection pack expansion", () => {
  it("contributes one PreToolUse blocker + instructions.md, and no SessionStart producer", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(1);
    expect(r.hooks.map((h) => h.event)).toEqual(["PreToolUse"]);
    expect(r.hooks.map((h) => h.name)).toEqual(["policy-pack:branch-protection:pre-tool-use"]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.relativePath).toBe(
      "policy-packs/branch-protection/instructions.md",
    );
    expect(r.files[0]?.content).toContain("# Policy Pack: branch-protection");
    expect(r.warnings).toEqual([]);
  });

  it.each(["claude-code", "codex"] as const)("on %s contributes no SessionStart hook and names no removed verb", (rt) => {
    const r = expandPolicyPacks(buildManifest([{ name: "branch-protection" }]), rt);
    expect(r.hooks.some((h) => h.event === "SessionStart")).toBe(false);
    const text = JSON.stringify(r.hooks) + (r.files[0]?.content ?? "");
    expect(text).not.toMatch(/session-start branch-check|approve branch-protection|branch:non-protected|branch-protection-ack|ledger/);
  });

  it("budgets the blocker at 5000 ms", () => {
    const r = expandPolicyPacks(buildManifest([{ name: "branch-protection" }]));
    expect(r.hooks[0]?.budget_ms).toBe(5000);
  });

  it("wires the PreToolUse blocker as blocking:hard with the Write|Edit match on claude-code", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m);
    const blocker = r.hooks.find((h) => h.event === "PreToolUse");
    expect(blocker?.blocking).toBe("hard");
    expect(blocker?.match).toBe("Write|Edit");
    expect(blocker?.command).toBe("harness pack hook branch-protection");
  });

  it("switches the PreToolUse match to apply_patch on codex, with the Codex block contract", () => {
    const m = buildManifest([{ name: "branch-protection" }]);
    const r = expandPolicyPacks(m, "codex");
    const blocker = r.hooks.find((h) => h.event === "PreToolUse");
    expect(blocker?.match).toBe("apply_patch");
    expect(blocker?.blocking).toBe("hard");
    expect(blocker?.command).toBe("harness pack hook branch-protection --runtime codex");
    expect(r.files[0]?.content).toContain("Codex contract: a refusal exits 2 with the reason on stderr.");
  });

  it("names the Claude Code contract in the claude-code instructions", () => {
    const r = expandPolicyPacks(buildManifest([{ name: "branch-protection" }]));
    expect(r.files[0]?.content).toContain("Claude Code contract: a refusal is a JSON deny envelope on stdout (exit 0).");
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
