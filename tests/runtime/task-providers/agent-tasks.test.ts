import { describe, expect, it } from "vitest";
import {
  canonicalAgentTasksVerb,
  claimEffectForAgentTasksTool,
  DEFAULT_PROTECTED_COMPLETION_TOOLS,
  matchesAgentTasksRuntimeVerb,
  resolveProtectedCompletionTools,
  TASK_FINISH_AUTOMERGE_INPUT_MATCH,
  TASK_ID_EXTRACT,
  taskIdFromInput,
} from "../../../src/runtime/task-providers/agent-tasks.js";

describe("agent-tasks runtime adapter", () => {
  it("keeps claim acquisition and release semantics, including runtime aliases", () => {
    expect(claimEffectForAgentTasksTool("mcp__agent-tasks__task_start", { taskId: "t" })).toBe(
      "acquire",
    );
    expect(claimEffectForAgentTasksTool("mcp__agent-tasks__.task_finish", {})).toBe("release");
    expect(claimEffectForAgentTasksTool("mcp__agent_tasks__task_abandon", {})).toBe("release");
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__tasks_transition", { status: "done" }),
    ).toBe("release");
    expect(
      claimEffectForAgentTasksTool("mcp__agent-tasks__tasks_transition", { status: "review" }),
    ).toBe("none");
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
