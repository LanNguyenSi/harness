// Internal agent-tasks runtime adapter. Consumers keep their own event and
// diagnostic handling; this module owns provider-specific semantics only.

import { expandToolNameAliases } from "../tool-name-aliases.js";

export const AGENT_TASKS_MCP_PREFIX = "mcp__agent-tasks__";

export const TASK_START_TOOL = `${AGENT_TASKS_MCP_PREFIX}task_start`;
export const TASK_FINISH_TOOL = `${AGENT_TASKS_MCP_PREFIX}task_finish`;
export const TASK_ABANDON_TOOL = `${AGENT_TASKS_MCP_PREFIX}task_abandon`;
export const TASKS_TRANSITION_TOOL = `${AGENT_TASKS_MCP_PREFIX}tasks_transition`;
export const TASK_MERGE_TOOL = `${AGENT_TASKS_MCP_PREFIX}task_merge`;
export const PULL_REQUESTS_MERGE_TOOL = `${AGENT_TASKS_MCP_PREFIX}pull_requests_merge`;

export const ACTIVE_CLAIM_TOOL_NAMES = [
  TASK_START_TOOL,
  TASK_FINISH_TOOL,
  TASK_ABANDON_TOOL,
  TASKS_TRANSITION_TOOL,
  TASK_MERGE_TOOL,
] as const;

export const DEFAULT_BOUNDARY_TOOL_NAMES = [
  TASK_FINISH_TOOL,
  TASK_ABANDON_TOOL,
  PULL_REQUESTS_MERGE_TOOL,
  TASKS_TRANSITION_TOOL,
] as const;

export const DEFAULT_PROTECTED_COMPLETION_TOOLS = [
  "task_finish",
  "task_submit_pr",
  "task_merge",
  "pull_requests_merge",
] as const;

export const TASK_FINISH_AUTOMERGE_INPUT_MATCH: Record<string, boolean> = {
  "toolArgs.autoMerge": true,
};

export const TASK_ID_EXTRACT: Record<string, string> = { TASK_ID: "toolArgs.taskId" };
export const PR_NUMBER_EXTRACT: Record<string, string> = { PR_NUMBER: "toolArgs.prNumber" };

function inputRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

export function taskIdFromInput(input: unknown): string {
  const taskId = inputRecord(input)?.["taskId"];
  return typeof taskId === "string" ? taskId : "";
}

export function tasksTransitionStatusFromInput(input: unknown): string {
  const status = inputRecord(input)?.["status"];
  return typeof status === "string" ? status : "";
}

export function tasksTransitionReleasesClaim(input: unknown): boolean {
  return tasksTransitionStatusFromInput(input) === "done";
}

/**
 * Read the resulting status off a task_finish tool RESULT (not the
 * request). The v2 mcp-server task_finish receipt is shaped
 * `{ ok, task: { id, status }, deviations? }`; returns `null` when the
 * result is absent, malformed, or carries no string status, so a caller
 * can tell "the task landed on a known non-review status" apart from
 * "we could not tell" (task c86e3c4a).
 */
export function taskFinishResultingStatus(toolResponse: unknown): string | null {
  const task = inputRecord(toolResponse)?.["task"];
  const status = inputRecord(task)?.["status"];
  return typeof status === "string" && status.length > 0 ? status : null;
}

export function agentTasksToolName(verb: string): string {
  return `${AGENT_TASKS_MCP_PREFIX}${verb}`;
}

/** Alias-aware for runtime events, including mcp__server.verb variants. */
export function matchesAgentTasksRuntimeVerb(
  toolName: string,
  verbs: readonly string[],
): boolean {
  const expected = new Set(verbs.map(agentTasksToolName));
  return expandToolNameAliases(toolName).some((alias) => expected.has(alias));
}

/** Strict canonical parsing for Solution Acceptance's deliberately narrow gate. */
export function canonicalAgentTasksVerb(
  toolName: string,
  verbs: readonly string[],
): string | null {
  if (!toolName.startsWith(AGENT_TASKS_MCP_PREFIX)) return null;
  const verb = toolName.slice(AGENT_TASKS_MCP_PREFIX.length);
  return verbs.includes(verb) ? verb : null;
}

export type ClaimEffect = "acquire" | "release" | "none";

/**
 * Claim lifecycle is separate from approval boundaries: only a completed
 * legacy transition releases a claim, while abandon and merge always do.
 *
 * task_finish is decided from the RESULT, not the verb (task c86e3c4a):
 * agent-tasks's own v2 semantics clear the work claim going to `done`
 * and keep it going to `review`, so `toolResponse` (the tool RESULT
 * envelope, optional third parameter -- the caller's PostToolUse event
 * carries this alongside `tool_input`) is read via
 * `taskFinishResultingStatus`. A resulting status of `review` returns
 * `none` (keep); `done`, any other resolvable status, and an
 * unresolvable result (no `toolResponse`, or a malformed one) all
 * return `release` -- fail safe, since the active-claim file this
 * classifier feeds is an ergonomic auto-resolve shortcut, not a
 * security-relevant signal, so releasing on an unreadable result costs
 * only that shortcut rather than risking a marker that can never clear.
 * This is the ONE place that decision is made: callers (e.g.
 * `hook-track-active-claim.ts`) do not re-derive it locally.
 */
export function claimEffectForAgentTasksTool(
  toolName: string,
  input: unknown,
  toolResponse?: unknown,
): ClaimEffect {
  if (matchesAgentTasksRuntimeVerb(toolName, ["task_start"])) return "acquire";
  if (matchesAgentTasksRuntimeVerb(toolName, ["task_finish"])) {
    return taskFinishResultingStatus(toolResponse) === "review" ? "none" : "release";
  }
  if (matchesAgentTasksRuntimeVerb(toolName, ["task_abandon", "task_merge"])) {
    return "release";
  }
  if (
    matchesAgentTasksRuntimeVerb(toolName, ["tasks_transition"]) &&
    tasksTransitionReleasesClaim(input)
  ) {
    return "release";
  }
  return "none";
}

export function resolveProtectedCompletionTools(config: unknown): string[] {
  if (
    Array.isArray(config) &&
    config.length > 0 &&
    config.every((verb) => typeof verb === "string" && verb.length > 0)
  ) {
    return config as string[];
  }
  return [...DEFAULT_PROTECTED_COMPLETION_TOOLS];
}
