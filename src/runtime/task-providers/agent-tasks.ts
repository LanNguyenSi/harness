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

/**
 * Default approval-marker expiry tool list. It only shapes the EMITTED
 * PostToolUse matcher when a manifest configures no explicit
 * `approval_lifecycle.expire_on_tool_match`; the runtime boundary list
 * the hook applies comes from the config alone (`parseApprovalLifecycle`
 * returns an empty list when the key is absent). `task_merge` is listed
 * because a `task_finish` that lands in `review` no longer expires the
 * approval (it keeps the work claim, task 5018c0c4); an operator's
 * explicit list, and every `harness init` scaffold, needs `task_merge`
 * too for the review-then-`task_merge` path to expire the approval.
 */
export const DEFAULT_BOUNDARY_TOOL_NAMES = [
  TASK_FINISH_TOOL,
  TASK_ABANDON_TOOL,
  PULL_REQUESTS_MERGE_TOOL,
  TASKS_TRANSITION_TOOL,
  TASK_MERGE_TOOL,
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
 * Best-effort recursive unwrap of a task_finish tool RESULT into the
 * mcp-server receipt object it ultimately carries, tolerating every
 * transport shape observed or plausible for a PostToolUse event (task
 * c86e3c4a: an earlier version of this function read only shape (a)
 * below and was inert against the shape Claude Code actually sends):
 *
 *   (a) the receipt object itself, `{ ok, task: { id, status } }` -- both
 *       the small default receipt and the `include:["task"]` full-object
 *       variant, since both nest the task under `task` and this function
 *       only reads that key, not the rest of the shape;
 *   (b) Claude Code's REAL PostToolUse `tool_response` for an MCP tool
 *       (live capture, claude 2.1.280): a content-block array
 *       `[{ type: "text", text: "<json>" }, ...]` -- the first `text`
 *       block is located and its `text` is JSON-parsed, then unwrapped
 *       again as (a). See `tests/fixtures/track-active-claim/
 *       real-posttooluse-task-finish-2.1.280.json` for the verbatim
 *       redacted capture;
 *   (c) an MCP `CallToolResult` object, `{ content: [{ type: "text",
 *       text: "<json>" }] }` -- plausible on Codex, UNMEASURED here (no
 *       Codex capture exists in this run; see
 *       `docs/policy-packs/understanding-before-execution.md`), handled
 *       defensively the same way as (b);
 *   (d) a bare JSON string -- parsed once, then unwrapped again.
 *
 * Anything else, a `JSON.parse` failure at any step, or a nesting depth
 * past a small guard, returns `null` so the caller fails safe rather
 * than throwing or silently misreading.
 */
function unwrapToolResponseEnvelope(
  toolResponse: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof toolResponse === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolResponse);
    } catch {
      return null;
    }
    return unwrapToolResponseEnvelope(parsed, depth + 1);
  }
  if (Array.isArray(toolResponse)) {
    const textBlock = toolResponse.find((block) => {
      const rec = inputRecord(block);
      return rec !== null && rec["type"] === "text" && typeof rec["text"] === "string";
    });
    const text = inputRecord(textBlock)?.["text"];
    return typeof text === "string" ? unwrapToolResponseEnvelope(text, depth + 1) : null;
  }
  const record = inputRecord(toolResponse);
  if (record === null) return null;
  if (Array.isArray(record["content"])) {
    return unwrapToolResponseEnvelope(record["content"], depth + 1);
  }
  return record;
}

/**
 * Read the resulting status off a task_finish tool RESULT (not the
 * request), unwrapping whichever transport shape it arrived in (see
 * `unwrapToolResponseEnvelope`). Returns `null` when the result is
 * absent, malformed, or carries no string status, so a caller can tell
 * "the task landed on a known non-review status" apart from "we could
 * not tell" (task c86e3c4a).
 */
export function taskFinishResultingStatus(toolResponse: unknown): string | null {
  const task = unwrapToolResponseEnvelope(toolResponse)?.["task"];
  const status = inputRecord(task)?.["status"];
  return typeof status === "string" && status.length > 0 ? status : null;
}

/**
 * Read the acted-on task id off a task_finish (or any agent-tasks) tool
 * RESULT, unwrapping the same shapes as `taskFinishResultingStatus`.
 * Used as a fallback when the tool_input did not carry a `taskId` (task
 * c86e3c4a, id-equality guard on release verbs), and by the stay-in-scope
 * hook to read the created task id off a create verb's result, which never
 * carries a `taskId` input (task b5e65f5e).
 */
export function taskIdFromToolResponse(toolResponse: unknown): string {
  const task = unwrapToolResponseEnvelope(toolResponse)?.["task"];
  const id = inputRecord(task)?.["id"];
  return typeof id === "string" ? id : "";
}

/**
 * Diagnostic-only companion to `claimEffectForAgentTasksTool`: was a
 * task_finish's resulting status actually readable? This does NOT feed
 * back into the release/keep decision (that stays the classifier's
 * alone) -- it lets `hook-track-active-claim.ts` label its stderr line
 * so a silent fail-safe fallback release does not look identical to an
 * intentional `done` release in the operator's own trail (task
 * c86e3c4a).
 */
export function taskFinishReleaseIsUnreadable(toolResponse: unknown): boolean {
  return taskFinishResultingStatus(toolResponse) === null;
}

/**
 * Coarse shape label for a tool_response, for the same stderr diagnostic
 * above -- never used to decide anything, only to name what shape a
 * fail-safe release fell back from.
 */
export function describeToolResponseShape(
  toolResponse: unknown,
): "array" | "string" | "object" | "absent" {
  if (toolResponse === undefined || toolResponse === null) return "absent";
  if (Array.isArray(toolResponse)) return "array";
  if (typeof toolResponse === "string") return "string";
  return "object";
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
 * return `release`.
 *
 * Fail-safe rationale (task c86e3c4a -- corrected from an earlier
 * wording of this comment that was wrong about what the marker feeds):
 * the active-claim file
 * this classifier feeds is read by the FAIL-CLOSED completion gate
 * (`src/cli/pack/hook-solution-acceptance.ts`'s `readActiveClaim` call)
 * to derive the verdict id it gates `task_finish` / `task_submit_pr` /
 * `task_merge` / `pull_requests_merge` / `git push` on. Release-on-
 * unreadable is chosen because a KEPT marker for a task that actually
 * finished would fail OPEN: until the next `task_start` overwrites it,
 * post-done completion-gated actions (git push, task_merge, PR merge)
 * would pass on that finished task's already-accepted verdict, and the
 * marker would override SOLUTION_VERDICT_ID. Releasing fails CLOSED
 * instead, at the cost of a possible wedge (the gate refuses with "no
 * active-claim task id recorded" until a fresh `task_start` or an
 * operator clears the file). It is not costless, and it is not merely
 * giving up an "ergonomic shortcut".
 *
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
