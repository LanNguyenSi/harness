import { describe, expect, it } from "vitest";
import { expandPolicyPacks } from "../../src/policy-packs/expand.js";
import { parseManifest } from "../../src/schema/index.js";
import { expandCodexHookMatchPattern } from "../../src/runtime/tool-name-aliases.js";

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

  it("resolves the understanding-before-execution builtin into 5 hooks + 1 instructions file", () => {
    // Was 3 hooks through v0.17.x (UserPromptSubmit + Stop + PreToolUse).
    // v0.18 added the PostToolUse marker-expiry hook (agent-tasks/d8ee60ca)
    // default-on, growing the default expansion to four. v2 of the
    // task-scope work (harness/494fd1e5) adds a second PostToolUse hook
    // for active-claim tracking (always emitted; matcher is agent-tasks
    // specific so it's a no-op for other tasking systems). Operators who
    // opt out of marker expiry via `approval_lifecycle: { mode: session }`
    // drop the first PostToolUse hook but keep the active-claim tracker
    // (covered by a dedicated test below).
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.hooks).toHaveLength(6);
    const events = r.hooks.map((h) => h.event).sort();
    expect(events).toEqual([
      "PostToolUse",
      "PostToolUse",
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    const names = r.hooks.map((h) => h.name).sort();
    expect(names).toEqual([
      "policy-pack:understanding-before-execution:post-tool-use",
      "policy-pack:understanding-before-execution:pre-tool-use",
      "policy-pack:understanding-before-execution:stay-in-scope",
      "policy-pack:understanding-before-execution:stop",
      "policy-pack:understanding-before-execution:track-active-claim",
      "policy-pack:understanding-before-execution:user-prompt-submit",
    ]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.relativePath).toBe(
      "policy-packs/understanding-before-execution/instructions.md",
    );
    expect(r.files[0]?.content).toContain(
      "# Policy Pack: understanding-before-execution",
    );
    expect(r.warnings).toEqual([]);
  });

  it("PostToolUse hook fires on the default agent-tasks task-boundary tools", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post).toBeDefined();
    expect(post?.command).toBe("harness pack hook post-tool-use");
    expect(post?.blocking).toBe(false);
    // Match pattern is anchored + alternation of the default boundary
    // tools. tasks_transition is included since PR #200 with an in-hook
    // status filter (only `status=done` actually clears the marker).
    expect(post?.match).toBe(
      "^(?:mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__pull_requests_merge|mcp__agent-tasks__tasks_transition)$",
    );
  });

  it("marker-expiry PostToolUse hook is suppressed when approval_lifecycle.mode = session (but track-active-claim still emits)", () => {
    // Opt-out path for operators who prefer the legacy per-session
    // contract for MARKER expiry. The track-active-claim hook is
    // independent (it maintains an ergonomic shortcut for `harness
    // approve --task` regardless of marker semantics) and always emits.
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { mode: "session" } },
      },
    ]);
    const r = expandPolicyPacks(m);
    const postToolUseHooks = r.hooks.filter((h) => h.event === "PostToolUse");
    // 2 emit unconditionally (track-active-claim + stay-in-scope); the
    // marker-expiry post-tool-use is the only one suppressed by the
    // session-mode opt-out.
    expect(postToolUseHooks).toHaveLength(2);
    const postToolUseNames = postToolUseHooks.map((h) => h.name).sort();
    expect(postToolUseNames).toEqual([
      "policy-pack:understanding-before-execution:stay-in-scope",
      "policy-pack:understanding-before-execution:track-active-claim",
    ]);
    expect(r.hooks).toHaveLength(5);
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

  it("widens the PostToolUse matcher to include Bash when expire_on_bash_match is configured (task bea04a03)", () => {
    // Before task bea04a03, `match` was built ONLY from
    // expire_on_tool_match, so a real Bash call never invoked this hook
    // at all — expire_on_bash_match was dead at the wiring level. This
    // pins the fix: the default tool list PLUS "Bash".
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_bash_match: ["^gh pr (merge|close)\\b"],
          },
        },
      },
    ]);
    const r = expandPolicyPacks(m);
    const post = r.hooks.find(
      (h) => h.name === "policy-pack:understanding-before-execution:post-tool-use",
    );
    expect(post?.match).toBe(
      "^(?:mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__pull_requests_merge|mcp__agent-tasks__tasks_transition|Bash)$",
    );
    // Positive control: a real Bash tool_name now routes through the
    // emitted matcher. Negative control: an unrelated tool does not.
    const re = new RegExp(post!.match!);
    expect(re.test("Bash")).toBe(true);
    expect(re.test("Read")).toBe(false);
  });

  it("still emits the PostToolUse hook (Bash-only matcher) when expire_on_tool_match is explicitly empty but expire_on_bash_match is configured", () => {
    // Regression guard: resolveExpireOnToolMatch alone would have
    // returned emitHook:false here (tools.length === 0), which would
    // have suppressed the hook entirely even though a bash boundary was
    // configured — a worse bug than merely not routing Bash.
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_tool_match: [],
            expire_on_bash_match: ["^gh pr (merge|close)\\b"],
          },
        },
      },
    ]);
    const r = expandPolicyPacks(m);
    const post = r.hooks.find(
      (h) => h.name === "policy-pack:understanding-before-execution:post-tool-use",
    );
    expect(post).toBeDefined();
    expect(post?.match).toBe("^(?:Bash)$");
  });

  it("does not duplicate Bash in the matcher when expire_on_tool_match already lists it", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_tool_match: ["Bash"],
            expire_on_bash_match: ["^gh pr merge\\b"],
          },
        },
      },
    ]);
    const r = expandPolicyPacks(m);
    const post = r.hooks.find(
      (h) => h.name === "policy-pack:understanding-before-execution:post-tool-use",
    );
    expect(post?.match).toBe("^(?:Bash)$");
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
    // is now wired at 0.4.0 (harness task 798d7173): 0.4.0 ships the
    // required "Prior Art" 10th section of the Understanding Report
    // (agent-grounding PR #85). Operators below this floor would
    // silently miss the section because the pre-0.4.0 Stop-capture
    // parser doesn't enforce it. The PreToolUse hook is the harness
    // CLI itself, not an npm-backed bin, so it carries no floor here.
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    const ups = r.hooks.find((h) => h.event === "UserPromptSubmit");
    const stop = r.hooks.find((h) => h.event === "Stop");
    const pre = r.hooks.find((h) => h.event === "PreToolUse");
    expect(ups?.min_version).toBe("0.4.0");
    expect(ups?.version_command).toEqual(["understanding-gate", "--version"]);
    expect(stop?.min_version).toBe("0.4.0");
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
    expect(r.hooks.find((h) => h.event === "PreToolUse")?.match).toBe(
      "apply_patch|Bash|shell|exec_command|functions.exec_command",
    );
  });

  it("Codex adapter contributes a PostToolUse marker-expiry hook (task a1348c89 — closes the parity gap)", () => {
    // Before task a1348c89 the Codex branch of buildHooks emitted exactly
    // 3 hooks (UserPromptSubmit + Stop + PreToolUse); approval_lifecycle
    // boundaries never fired in Codex sessions. This pins the 4th hook.
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m, "codex");
    expect(r.hooks).toHaveLength(4);
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post).toBeDefined();
    expect(post?.command).toBe("harness pack hook codex-post-tool-use");
    expect(post?.blocking).toBe(false);
    // Same default tool-boundary set as the Claude sibling
    // (resolveExpireOnToolMatch), but a BARE pipe list, not the Claude
    // builder's anchored `^(?:...)$` form (review finding on task
    // a1348c89, codexPostToolUseMatchPattern's own doc comment): the
    // anchor characters trip `expandCodexHookMatchPattern`'s "simple
    // token" guard in the generator and would silently skip the MCP
    // tool-name alias expansion Codex needs.
    expect(post?.match).toBe(
      "mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__pull_requests_merge|mcp__agent-tasks__tasks_transition",
    );
  });

  it("Codex PostToolUse hook is suppressed when approval_lifecycle.mode = session (parity with the Claude opt-out)", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: { approval_lifecycle: { mode: "session" } },
      },
    ]);
    const r = expandPolicyPacks(m, "codex");
    expect(r.hooks).toHaveLength(3);
    expect(r.hooks.some((h) => h.event === "PostToolUse")).toBe(false);
  });

  it("Codex PostToolUse hook match pattern reflects a custom expire_on_tool_match list", () => {
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
    const r = expandPolicyPacks(m, "codex");
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post?.match).toBe("mcp__linear__issue_close|Bash");
  });

  it("widens the Codex PostToolUse matcher to include the shell-tool aliases when expire_on_bash_match is configured (task bea04a03)", () => {
    // Codex parity of the Claude widening test above: before task
    // bea04a03, expire_on_bash_match never routed a real shell call
    // (Bash/shell/exec_command/functions.exec_command) to this hook on
    // Codex either.
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_bash_match: ["^gh pr (merge|close)\\b"],
          },
        },
      },
    ]);
    const r = expandPolicyPacks(m, "codex");
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post?.match).toBe(
      "mcp__agent-tasks__task_finish|mcp__agent-tasks__task_abandon|mcp__agent-tasks__pull_requests_merge|mcp__agent-tasks__tasks_transition|Bash|shell|exec_command|functions.exec_command",
    );
    // Positive control (each shell alias routes); negative control (an
    // unrelated tool does not).
    const re = new RegExp(`^(?:${post!.match!})$`);
    expect(re.test("Bash")).toBe(true);
    expect(re.test("shell")).toBe(true);
    expect(re.test("exec_command")).toBe(true);
    expect(re.test("functions.exec_command")).toBe(true);
    expect(re.test("Read")).toBe(false);
  });

  it("still emits the Codex PostToolUse hook when expire_on_tool_match is explicitly empty but expire_on_bash_match is configured", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: {
          approval_lifecycle: {
            expire_on_tool_match: [],
            expire_on_bash_match: ["^gh pr merge\\b"],
          },
        },
      },
    ]);
    const r = expandPolicyPacks(m, "codex");
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    expect(post).toBeDefined();
    expect(post?.match).toBe("Bash|shell|exec_command|functions.exec_command");
  });

  it("the emitted Codex PostToolUse match string is alias-expandable and routes MCP tool-name variants (task a1348c89 review finding)", () => {
    // The whole point of switching to a bare pipe list
    // (codexPostToolUseMatchPattern) instead of the anchored Claude form:
    // `expandCodexHookMatchPattern` — the exact function
    // `generate-codex-config.ts` runs over every Codex hook's `match`
    // field at `harness apply` time — must actually widen it. Positive
    // control: the canonical and all three variant forms match once
    // expanded. Negative control: an unrelated tool never matches.
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m, "codex");
    const post = r.hooks.find((h) => h.event === "PostToolUse");
    const expanded = expandCodexHookMatchPattern(post?.match ?? "");
    // Proves the anchored Claude form would NOT have expanded (that was
    // the bug this test guards against): a raw split of the OLD
    // "^(?:...)$" string trips the simple-token guard and comes back
    // byte-identical to its input.
    expect(expanded).not.toBe(post?.match);
    const re = new RegExp(expanded);
    expect(re.test("mcp__agent-tasks__task_finish")).toBe(true); // canonical
    expect(re.test("mcp__agent-tasks__.task_finish")).toBe(true); // dotted
    expect(re.test("mcp__agent_tasks__task_finish")).toBe(true); // underscore-server
    expect(re.test("mcp__agent_tasks__.task_finish")).toBe(true); // both
    expect(re.test("Read")).toBe(false); // negative control
  });

  it("prefixes the Codex PostToolUse command with UNDERSTANDING_GATE_REPORT_DIR when reportsDir is supplied", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m, "codex", { reportsDir: "/tmp/reports" });
    expect(r.hooks.find((h) => h.event === "PostToolUse")?.command).toBe(
      "UNDERSTANDING_GATE_REPORT_DIR='/tmp/reports' harness pack hook codex-post-tool-use",
    );
  });

  it("uses default mode 'grill_me' when config omits mode", () => {
    const m = buildManifest([{ name: "understanding-before-execution" }]);
    const r = expandPolicyPacks(m);
    expect(r.files[0]?.content).toMatch(/## Mode\s*\n\s*grill_me/);
  });

  it("threads explicit modes through the instructions file", () => {
    for (const mode of ["fast_confirm", "grill_me", "strict"] as const) {
      const m = buildManifest([
        { name: "understanding-before-execution", config: { mode } },
      ]);
      const r = expandPolicyPacks(m);
      expect(r.files[0]?.content).toMatch(
        new RegExp(`## Mode\\s*\\n\\s*${mode}`),
      );
    }
  });

  it("warns and falls back to grill_me when mode is unrecognised", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: { mode: "definitely_invalid" },
      },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.warnings.some((w) => w.includes("definitely_invalid"))).toBe(true);
    expect(r.files[0]?.content).toMatch(/## Mode\s*\n\s*grill_me/);
  });

  it("skips an enabled:false pack and records its name in `skipped`", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        enabled: false,
        config: { mode: "strict" },
      },
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
    expect(r.hooks).toHaveLength(6); // v0.18: 3 legacy + 1 PostToolUse expiry; v2 (494fd1e5): +1 track-active-claim; 2ba06030: +1 stay-in-scope
    expect(r.files).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("not a known builtin pack"))).toBe(
      true,
    );
  });

  it("contributes permissions when config.permission_profile names a builtin", () => {
    const m = buildManifest([
      {
        name: "understanding-before-execution",
        config: { permission_profile: "safe-start" },
      },
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
      {
        name: "understanding-before-execution",
        config: { permission_profile: "ghost" },
      },
    ]);
    const r = expandPolicyPacks(m);
    expect(r.permissions).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("unrecognised profile"))).toBe(
      true,
    );
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
    expect(r.hooks).toHaveLength(5); // 6 contributions - 1 dropped collision (Stop)
    expect(r.hooks.find((h) => h.event === "Stop")).toBeUndefined();
    expect(
      r.warnings.some((w) => w.includes("collides with a manifest hooks")),
    ).toBe(true);
  });
});
