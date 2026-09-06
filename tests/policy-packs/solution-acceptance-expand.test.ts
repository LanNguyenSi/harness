import { describe, expect, it } from "vitest";
import {
  configSchema,
  resolve,
} from "../../src/policy-packs/builtin/solution-acceptance.js";
import type { PolicyPack } from "../../src/schema/index.js";

function pack(config: Record<string, unknown> = {}): PolicyPack {
  return {
    name: "solution-acceptance",
    source: "builtin",
    enabled: true,
    config,
  } as PolicyPack;
}

describe("solution-acceptance pack — hook expansion", () => {
  it("emits exactly two hard PreToolUse hooks", () => {
    const { contribution } = resolve(pack(), "claude-code");
    expect(contribution.hooks).toHaveLength(2);
    for (const h of contribution.hooks) {
      expect(h.event).toBe("PreToolUse");
      expect(h.blocking).toBe("hard");
    }
    const names = contribution.hooks.map((h) => h.name);
    expect(names).toContain("policy-pack:solution-acceptance:completion-gate");
    expect(names).toContain("policy-pack:solution-acceptance:write-guard");
  });

  it("completion-gate matches Bash + the agent-tasks completion verbs (claude)", () => {
    const { contribution } = resolve(pack(), "claude-code");
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    expect(gate.command).toBe("harness pack hook solution-acceptance");
    expect(gate.match).toContain("Bash");
    expect(gate.match).toContain("mcp__agent-tasks__task_finish");
    expect(gate.match).toContain("mcp__agent-tasks__pull_requests_merge");
  });

  it("write-guard matches the path-mutating tools + Bash (claude)", () => {
    const { contribution } = resolve(pack(), "claude-code");
    const wg = contribution.hooks.find((h) => h.name.endsWith(":write-guard"))!;
    expect(wg.command).toBe("harness pack hook solution-acceptance-writeguard");
    expect(wg.match).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
  });

  it("uses the codex tool vocabulary on the codex runtime", () => {
    const { contribution } = resolve(pack(), "codex");
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    const wg = contribution.hooks.find((h) => h.name.endsWith(":write-guard"))!;
    // Codex has no agent-tasks MCP surface here -> bash arm only.
    expect(gate.match).toBe("Bash");
    expect(wg.match).toBe("apply_patch|Bash");
  });

  it("reflects a protected_completion_tools override in the completion match", () => {
    const { contribution } = resolve(
      pack({ protected_completion_tools: ["task_finish"] }),
      "claude-code",
    );
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    expect(gate.match).toBe("Bash|mcp__agent-tasks__task_finish");
  });

  it("emits an instructions.md audit file", () => {
    const { contribution } = resolve(pack(), "claude-code");
    const file = contribution.files.find((f) =>
      f.relativePath.endsWith("policy-packs/solution-acceptance/instructions.md"),
    );
    expect(file).toBeDefined();
    expect(file!.content).toMatch(/solution_evaluate/);
  });

  it("teaches reconnect-vs-retry: poll status/result with the same id, never re-call solution_evaluate as a stall workaround", () => {
    const { contribution } = resolve(pack(), "claude-code");
    const file = contribution.files.find((f) =>
      f.relativePath.endsWith("policy-packs/solution-acceptance/instructions.md"),
    );
    const content = file!.content;
    // Pins the poll sentence: naming both lookup tools by name. A mutant
    // that drops this sentence (or either tool name) fails here.
    expect(content).toMatch(/mcp__grounding-mcp__solution_evaluate_status/);
    expect(content).toMatch(/mcp__grounding-mcp__solution_evaluate_result/);
    // Pins the never-re-call-as-a-stall-workaround guidance. A mutant that
    // rewords this into "re-call solution_evaluate" (dropping the "Never")
    // fails here.
    expect(content).toMatch(/Never re-call .solution_evaluate. as a stall workaround/);
  });
});

describe("solution-acceptance pack — solutionVerdictDir opt (SOLUTION_VERDICT_DIR projection)", () => {
  it("prefixes both hook commands with SOLUTION_VERDICT_DIR=<path> when solutionVerdictDir is set", () => {
    const { contribution } = resolve(pack(), "claude-code", {
      solutionVerdictDir: "/custom/verdict/dir",
    });
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    const wg = contribution.hooks.find((h) => h.name.endsWith(":write-guard"))!;
    expect(gate.command).toBe(
      "SOLUTION_VERDICT_DIR='/custom/verdict/dir' harness pack hook solution-acceptance",
    );
    expect(wg.command).toBe(
      "SOLUTION_VERDICT_DIR='/custom/verdict/dir' harness pack hook solution-acceptance-writeguard",
    );
  });

  it("emits no prefix when solutionVerdictDir is not set (commands unchanged)", () => {
    const { contribution } = resolve(pack(), "claude-code");
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    const wg = contribution.hooks.find((h) => h.name.endsWith(":write-guard"))!;
    expect(gate.command).toBe("harness pack hook solution-acceptance");
    expect(wg.command).toBe("harness pack hook solution-acceptance-writeguard");
  });

  it("shell-quotes a path containing a space", () => {
    const { contribution } = resolve(pack(), "claude-code", {
      solutionVerdictDir: "/home/user/my verdicts/dir",
    });
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    expect(gate.command).toBe(
      "SOLUTION_VERDICT_DIR='/home/user/my verdicts/dir' harness pack hook solution-acceptance",
    );
  });

  it("shell-quotes a path containing a single quote", () => {
    const { contribution } = resolve(pack(), "claude-code", {
      solutionVerdictDir: "/tmp/it's/a/path",
    });
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    expect(gate.command).toBe(
      "SOLUTION_VERDICT_DIR='/tmp/it'\\''s/a/path' harness pack hook solution-acceptance",
    );
  });

  it("applies solutionVerdictDir on the codex runtime too", () => {
    const { contribution } = resolve(pack(), "codex", {
      solutionVerdictDir: "/custom/verdict/dir",
    });
    const gate = contribution.hooks.find((h) => h.name.endsWith(":completion-gate"))!;
    expect(gate.command).toBe(
      "SOLUTION_VERDICT_DIR='/custom/verdict/dir' harness pack hook solution-acceptance",
    );
  });
});

describe("solution-acceptance pack — strict config schema", () => {
  it("accepts the known keys", () => {
    expect(configSchema.safeParse({}).success).toBe(true);
    expect(
      configSchema.safeParse({ protected_completion_tools: ["task_finish"] }).success,
    ).toBe(true);
  });
  it("rejects a typo'd key (strict)", () => {
    expect(configSchema.safeParse({ protected_completion_verbs: ["x"] }).success).toBe(false);
  });
  it("rejects an empty protected_completion_tools array", () => {
    expect(configSchema.safeParse({ protected_completion_tools: [] }).success).toBe(false);
  });
});
