// Internal agent-tasks runtime adapter. Consumers keep their own event and
// diagnostic handling; this module owns provider-specific semantics only.

export const AGENT_TASKS_MCP_PREFIX = "mcp__agent-tasks__";

export const TASK_FINISH_TOOL = `${AGENT_TASKS_MCP_PREFIX}task_finish`;
export const TASK_MERGE_TOOL = `${AGENT_TASKS_MCP_PREFIX}task_merge`;
export const PULL_REQUESTS_MERGE_TOOL = `${AGENT_TASKS_MCP_PREFIX}pull_requests_merge`;

export const TASK_FINISH_AUTOMERGE_INPUT_MATCH: Record<string, boolean> = {
  "toolArgs.autoMerge": true,
};

export const TASK_ID_EXTRACT: Record<string, string> = { TASK_ID: "toolArgs.taskId" };
export const PR_NUMBER_EXTRACT: Record<string, string> = { PR_NUMBER: "toolArgs.prNumber" };
