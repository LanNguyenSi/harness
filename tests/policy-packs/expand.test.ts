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

  it("resolves the understanding-before-execution builtin into 4 hooks + 1 instructions file", () => {
    // Was 3 hooks through v0.17.x (UserPromptSubmit + Stop + PreToolUse).
    // v0.18 adds the PostToolUse marker-expiry hook (agent-tasks/d8ee60ca)
    // default-on, so the default expansion now ships four hooks. Operators
    // who opt out via `approval_lifecycle: { mode: session }` drop back
    // to three (covered by a dedicated test below).
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(4);
    const events = r.hooks.map((h) => h.event).sort();
    expect(events).toEqual(["PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
    const names = r.hooks.map((h) => h.name).sort();
    expect(names).toEqual([
      "policy-pack:understanding-before-execution:post-tool-use",
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

  it("PostToolUse hook fires on the default agent-tasks task-boundary tools", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post).toBeDefined();
    expect(post?.command).toBe("harness pack hook post-tool-use");
    expect(post?.blocking).toBe(false);
    // Match pattern is anchored + alternation of the three defaults.
    expect(post?.match).toBe(
      "^(?:mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__pull_requests_merge)$",
    );
  });

  it("PostToolUse hook is suppressed when approval_lifecycle.mode = session", () => {
    // Opt-out path for operators who prefer the legacy per-session contract.
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { mode: "session" } },
      },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.hooks.find((h) => h.event === "PostToolUse")).toBeUndefined();
    expect(r.hooks).toHaveLength(3);
  });

  it("PostToolUse hook match pattern reflects custom expire_on_tool_match list", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_tool_match: ["mcp__linear__issue_close", "Bash"],
          },
        },
      },
    ]);
    const r = expandPolicyPacks(m);
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post?.match).toBe("^(?:mcp__linear__issue_close|Bash)$");
  });

  it("PreToolUse hook is hard-blocking with the documented match", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    const pre = r.hooks.find((h) => h.event === "PreToolUse");
    expect(pre?.blocking).toBe("hard");
    expect(pre?.match).toBe("Edit|Write|Bash");
  });

  it("emits unwrapped hook commands when no reportsDir is supplied", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks.find((h) => h.event === "Stop")?.command).toBe(
      "understanding-gate-claude-stop",
    );
    expect(r.hooks.find((h) => h.event === "PreToolUse")?.command).toBe(
      "harness pack hook pre-tool-use",
    );
    expect(r.hooks.find((h) => h.event === "UserPromptSubmit")?.command).toBe(
      "understanding-gate-claude-hook",
    );
  });

  it("prefixes Stop + PreToolUse commands with UNDERSTANDING_GATE_REPORT_DIR when reportsDir is supplied", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m, undefined, {
      reportsDir: "/home/u/.claude/.understanding-gate/reports",
    });
    // Stop hook (writer) and PreToolUse hook (reader) both get the env
    // prefix so they round-trip the same dir as the operator's
    // `harness approve understanding` invocation.
    expect(r.hooks.find((h) => h.event === "Stop")?.command).toBe(
      "UNDERSTANDING_GATE_REPORT_DIR='/home/u/.claude/.understanding-gate/reports' understanding-gate-claude-stop",
    );
    expect(r.hooks.find((h) => h.event === "PreToolUse")?.command).toBe(
      "UNDERSTANDING_GATE_REPORT_DIR='/home/u/.claude/.understanding-gate/reports' harness pack hook pre-tool-use",
    );
    // UserPromptSubmit injector does not write/read the reports dir,
    // so we keep its command unprefixed (smaller surface, no needless
    // env in the visible command).
    expect(r.hooks.find((h) => h.event === "UserPromptSubmit")?.command).toBe(
      "understanding-gate-claude-hook",
    );
  });

  it("npm-backed Claude hooks declare a min_version floor pointing at understanding-gate --version", () => {
    // Regression guard for agent-tasks/6af1727f: the Claude
    // UserPromptSubmit + Stop hooks both wrap bins shipped by
    // @lannguyensi/understanding-gate. Without a min_version floor,
    // `harness doctor` cannot warn operators on stale 0.2.x installs
    // (which silently emit no_marker_fast_confirm_attempt parse-error
    // logs every session per agent-grounding/91b21f31 triage). The floor
    // is wired at 0.3.1, the first release whose `understanding-gate
    // --version` reports the real package.json version (agent-grounding
    // PRs #80 + #81 fixed the hardcoded literal). The PreToolUse hook
    // is the harness CLI itself, not an npm-backed bin, so it carries
    // no floor here.
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    const ups = r.hooks.find((h) => h.event === "UserPromptSubmit");
    const stop = r.hooks.find((h) => h.event === "Stop");
    const pre = r.hooks.find((h) => h.event === "PreToolUse");
    expect(ups?.min_version).toBe("0.3.1");
    expect(ups?.version_command).toEqual(["understanding-gate", "--version"]);
    expect(stop?.min_version).toBe("0.3.1");
    expect(stop?.version_command).toEqual(["understanding-gate", "--version"]);
    expect(pre?.min_version).toBeUndefined();
    expect(pre?.version_command).toBeUndefined();
  });

  it("escapes single quotes in reportsDir paths", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m, undefined, {
      reportsDir: "/has/q'uote/reports",
    });
    expect(r.hooks.find((h) => h.event === "Stop")?.command).toContain(
      "UNDERSTANDING_GATE_REPORT_DIR='/has/q'\\''uote/reports'",
    );
  });

  it("prefixes the Codex Stop + PreToolUse adapters too", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m, "codex", {
      reportsDir: "/tmp/reports",
    });
    expect(r.hooks.find((h) => h.event === "Stop")?.command).toBe(
      "UNDERSTANDING_GATE_REPORT_DIR='/tmp/reports' harness pack hook codex-stop",
    );
    expect(r.hooks.find((h) => h.event === "PreToolUse")?.command).toBe(
      "UNDERSTANDING_GATE_REPORT_DIR='/tmp/reports' harness pack hook codex-pre-tool-use",
    );
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

  it("aggregates two enabled packs independently when both resolve cleanly", () => {
    // Phase 6 #2 only ships one builtin (`understanding-before-execution`),
    // so this test exercises the same builtin twice under different
    // names. Both names fail the registry lookup; the only one that
    // resolves is the canonical one. The second entry's purpose here is
    // proving that the loop in expand.ts (a) iterates over every entry,
    // (b) accumulates warnings without dropping the first pack's
    // contributions, (c) preserves the contribution of the resolvable
    // pack on the way through.
    const m = buildManifest([
      { name: "understanding-before-execution" },
      { name: "no-such-pack" },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(4); // v0.18 default: 3 legacy + 1 PostToolUse expiry
    expect(r.files).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("not a known builtin pack"))).toBe(true);
  });

  it("contributes permissions when config.permission_profile names a builtin", () => {
    const m = buildManifest([
      { name: "understanding-before-execution", config: { permission_profile: "safe-start" } },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.permissions).toBeDefined();
    expect(r.permissions?.allow).toContain("Read");
    expect(r.permissions?.ask).toContain("Edit");
    expect(r.permissions?.deny).toContain("Bash(git commit*)");
  });

  it("contributes no permissions when permission_profile is omitted", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.permissions).toBeUndefined();
  });

  it("warns and skips permissions when permission_profile is unrecognised", () => {
    const m = buildManifest([
      { name: "understanding-before-execution", config: { permission_profile: "ghost" } },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.permissions).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("unrecognised profile"))).toBe(true);
  });

  it("threads implementation-after-approval permissions through", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: { permission_profile: "implementation-after-approval" },
      },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.permissions?.allow).toContain("Edit");
    expect(r.permissions?.allow).toContain("Write");
    expect(r.permissions?.ask).toContain("Bash");
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
    expect(r.hooks).toHaveLength(3); // 4 contributions - 1 dropped collision (Stop)
    expect(r.hooks.find((h) => h.event === "Stop")).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("collides with a manifest hooks"))).toBe(true);
  });
});
