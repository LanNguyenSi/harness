import { describe, expect, it } from "vitest";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest } from "../../src/schema/index.js";

function buildManifest(packs: unknown[]): ReturnType<typeof parseManifest> {
  return parseManifest({ version: 1, policy_packs: packs });
}

describe("post-merge-gate pack expansion", () => {
  it("contributes one PostToolUse producer + one PreToolUse blocker + instructions.md", () => {
    const m = buildManifest([{ name: "post-merge-gate" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(2);
    const events = r.hooks.map((h) => h.event).sort();
    expect(events).toEqual(["PostToolUse", "PreToolUse"]);
    const names = r.hooks.map((h) => h.name).sort();
    expect(names).toEqual([
      "policy-pack:post-merge-gate:post-tool-use",
      "policy-pack:post-merge-gate:pre-tool-use",
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.relativePath).toBe("policy-packs/post-merge-gate/instructions.md");
    expect(r.files[0]?.content).toContain("# Policy Pack: post-merge-gate");
    expect(r.warnings).toEqual([]);
  });

  it("wires the producer as blocking:false on Bash", () => {
    const m = buildManifest([{ name: "post-merge-gate" }]);
    const r = expandPolicyPacks(m);
    const producer = r.hooks.find((h) => h.event === "PostToolUse");
    expect(producer?.blocking).toBe(false);
    expect(producer?.match).toBe("Bash");
    expect(producer?.command).toBe("harness pack hook post-merge-gate-record");
  });

  it("wires the blocker as blocking:hard on Bash", () => {
    const m = buildManifest([{ name: "post-merge-gate" }]);
    const r = expandPolicyPacks(m);
    const blocker = r.hooks.find((h) => h.event === "PreToolUse");
    expect(blocker?.blocking).toBe("hard");
    expect(blocker?.match).toBe("Bash");
    expect(blocker?.command).toBe("harness pack hook post-merge-gate");
  });

  it("instructions.md documents the escape list, curated mutation list, and known gaps", () => {
    const m = buildManifest([{ name: "post-merge-gate" }]);
    const r = expandPolicyPacks(m);
    const md = r.files[0]?.content ?? "";
    expect(md).toContain("Escape hatches");
    expect(md).toContain("git switch");
    expect(md).toContain("Known gaps");
    expect(md).toContain("MCP merge path");
    expect(md).toContain("Fail posture");
  });

  // Task 19356be7 drift pin. The precedence reversal (deny wins; the escape
  // list no longer short-circuits the whole command) has to reach the
  // OPERATOR-VISIBLE surfaces, not just the module comments: the blocker
  // hook's `description` is written verbatim into the user's settings.json.
  // Review found five surfaces still teaching escape-first AFTER the docs
  // already declared the gap closed — two of them in the same file as the
  // correctly-updated instructions text. Pin both directions so the stale
  // claim cannot silently reappear.
  it("neither the blocker hook description nor instructions.md still teaches escape-first precedence", () => {
    const m = buildManifest([{ name: "post-merge-gate" }]);
    const r = expandPolicyPacks(m);
    const blocker = r.hooks.find((h) => h.event === "PreToolUse");
    const description = blocker?.description ?? "";
    const md = r.files[0]?.content ?? "";

    expect(description).not.toMatch(/checked first, unconditionally/i);
    expect(description).not.toMatch(/escape allowlist/i);
    expect(md).not.toMatch(/checked first, unconditionally/i);

    // …and positively states the new precedence, so an empty/renamed field
    // cannot satisfy this test by vacuity.
    expect(description).toMatch(/does NOT exempt the mutation/);
    expect(md).toMatch(/[Dd]eny wins/);
  });

  it("skips the pack when enabled:false", () => {
    const m = buildManifest([{ name: "post-merge-gate", enabled: false }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual(["post-merge-gate"]);
  });

  it("warns when wired under a codex runtime (no Codex adapter in v1)", () => {
    const m = buildManifest([{ name: "post-merge-gate" }]);
    const r = expandPolicyPacks(m, "codex");
    expect(r.warnings.join("\n")).toMatch(/no Codex adapter/);
    // Hooks are still emitted (best-effort, documented limitation) —
    // just with a loud warning attached.
    expect(r.hooks).toHaveLength(2);
  });
});
