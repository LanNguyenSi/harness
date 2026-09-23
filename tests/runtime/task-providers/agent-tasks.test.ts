import { describe, expect, it } from "vitest";
import {
  ACTIVE_CLAIM_TOOL_NAMES,
  canonicalAgentTasksVerb,
  claimEffectForAgentTasksTool,
  DEFAULT_PROTECTED_COMPLETION_TOOLS,
  matchesAgentTasksRuntimeVerb,
  resolveProtectedCompletionTools,
  taskFinishResultingStatus,
  TASK_FINISH_AUTOMERGE_INPUT_MATCH,
  TASK_ID_EXTRACT,
  taskIdFromInput,
  TASK_MERGE_TOOL,
} from "../../../src/runtime/task-providers/agent-tasks.js";

describe("agent-tasks runtime adapter", () => {
  it("keeps claim acquisition and release semantics, including runtime aliases", () => {
    expect(claimEffectForAgentTasksTool("mcp__agent-tasks__task_start", { taskId: "t" })).toBe(
      "acquire",
    );
    // No toolResponse (undefined): fails safe as "release", same as the
    // old unconditional behavior, since the resulting status cannot be
    // established (task c86e3c4a).
    expect(claimEffectForAgentTasksTool("mcp__agent-tasks__.task_finish", {})).toBe("release");
    expect(claimEffectForAgentTasksTool("mcp__agent_tasks__task_abandon", {})).toBe("release");
    expect(claimEffectForAgentTasksTool("mcp__agent-tasks__task_merge", {})).toBe("release");
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__tasks_transition", { status: "done" }),
    ).toBe("release");
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__tasks_transition", { status: "review" }),
    ).toBe("none");
  });

  it("decides task_finish from the tool RESULT, not the verb (task c86e3c4a)", () => {
    // Single decider: claimEffectForAgentTasksTool reads the resulting
    // task.status off the optional third parameter (the tool RESPONSE,
    // never the request). Only `review` keeps the claim; `done`, any
    // other resolvable status, and an unresolvable result all release.
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__task_finish", {}, {
        ok: true,
        task: { id: "t", status: "review" },
      }),
    ).toBe("none");
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__task_finish", {}, {
        ok: true,
        task: { id: "t", status: "done" },
      }),
    ).toBe("release");
    expect(claimEffectForAgentTasksTool("mcp__agent-tasks__task_finish", {}, undefined)).toBe(
      "release",
    );
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__task_finish", {}, {
        ok: true,
        task: { id: "t", status: 42 },
      }),
    ).toBe("release");
    // Alias-aware: a dotted/underscore-server task_finish variant still
    // reads the same result.
    expect(
      claimEffectForAgentTasksTool("mcp__agent_tasks__task_finish", {}, {
        task: { status: "review" },
      }),
    ).toBe("none");
  });

  it("taskFinishResultingStatus extracts only a string task.status", () => {
    expect(taskFinishResultingStatus({ ok: true, task: { id: "t", status: "review" } })).toBe(
      "review",
    );
    expect(taskFinishResultingStatus(undefined)).toBeNull();
    expect(taskFinishResultingStatus({})).toBeNull();
    expect(taskFinishResultingStatus({ task: {} })).toBeNull();
    expect(taskFinishResultingStatus({ task: { status: 42 } })).toBeNull();
    expect(taskFinishResultingStatus({ task: null })).toBeNull();
    expect(taskFinishResultingStatus("not an object")).toBeNull();
  });

  it("extracts only a string taskId and recognizes dotted runtime aliases", () => {
    expect(taskIdFromInput({ taskId: "task-1" })).toBe("task-1");
    expect(taskIdFromInput({ taskId: 1 })).toBe("");
    expect(matchesAgentTasksRuntimeVerb("mcp__agent-tasks.task_finish", ["task_finish"])).toBe(
      true,
    );
  });

  it("keeps Solution Acceptance canonical and permits arbitrary configured verbs", () => {
    expect(canonicalAgentTasksVerb("mcp__agent-tasks__task_finish", ["task_finish"])).toBe(
      "task_finish",
    );
    expect(canonicalAgentTasksVerb("mcp__agent-tasks__.task_finish", ["task_finish"])).toBeNull();
    expect(canonicalAgentTasksVerb("mcp__agent_tasks__task_finish", ["task_finish"])).toBeNull();
    expect(canonicalAgentTasksVerb("mcp__agent-tasks__custom_close", ["custom_close"])).toBe(
      "custom_close",
    );
  });

  it("tracks task_merge in the active-claim tool set (task c86e3c4a, AC-002 item 3)", () => {
    // ACTIVE_CLAIM_TOOL_NAMES feeds the generated PostToolUse matcher
    // (understanding-before-execution.ts's TRACK_ACTIVE_CLAIM_MATCH /
    // _CODEX); task_merge must be a member for a real task_merge tool
    // call to dispatch to hook-track-active-claim.ts at all.
    expect(ACTIVE_CLAIM_TOOL_NAMES).toContain(TASK_MERGE_TOOL);
  });

  it("preserves every completion default and auto-merge metadata", () => {
    expect(DEFAULT_PROTECTED_COMPLETION_TOOLS).toEqual([
      "task_finish",
      "task_submit_pr",
      "task_merge",
      "pull_requests_merge",
    ]);
    expect(resolveProtectedCompletionTools(undefined)).toEqual([
      "task_finish",
      "task_submit_pr",
      "task_merge",
      "pull_requests_merge",
    ]);
    for (const verb of DEFAULT_PROTECTED_COMPLETION_TOOLS) {
      expect(canonicalAgentTasksVerb(`mcp__agent-tasks__${verb}`, DEFAULT_PROTECTED_COMPLETION_TOOLS)).toBe(verb);
    }
    expect(resolveProtectedCompletionTools(["custom_close"])).toEqual(["custom_close"]);
    expect(TASK_FINISH_AUTOMERGE_INPUT_MATCH).toEqual({ "toolArgs.autoMerge": true });
    expect(TASK_ID_EXTRACT).toEqual({ TASK_ID: "toolArgs.taskId" });
  });
});
