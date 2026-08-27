// PostToolUse boundary matching + expiry (task a1348c89, Codex parity),
// split out of the former monolithic understanding-before-execution-runtime.ts
// (structural concentration slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import * as fs from "node:fs";
import { expandToolNameAliases } from "../../../runtime/tool-name-aliases.js";
import { type ApprovalLifecycle } from "./lifecycle.js";
import { approvalMarkerPathFor, clearApprovalMarker } from "./markers.js";
import { expirePersistedReport } from "./persisted-reports.js";
import { clearTaskApprovalMarker, taskApprovalMarkerPathFor } from "./task-markers.js";

// ---------------------------------------------------------------------
// PostToolUse boundary matching + expiry (task a1348c89, Codex parity).
// Shared between `harness pack hook post-tool-use` (Claude) and
// `harness pack hook codex-post-tool-use` (Codex): both clear the SAME
// marker/task-marker/persisted-report state on the SAME configured
// task-boundary tools. Before this extraction the matching logic lived
// only inline in the Claude hook file; a Codex sibling copying it by
// hand would have re-implemented (and eventually drifted from) it —
// the exact drift class task e7c2ec3c fixed on the PreToolUse side via
// `checkOperatorApprovalMarkers` above. One implementation, two thin
// runtime-specific callers.
// ---------------------------------------------------------------------

/**
 * Tool names treated as "the Bash tool" for `expire_on_bash_match`
 * command-regex matching. Claude Code has exactly one Bash tool name;
 * a runtime with shell-tool aliases (e.g. Codex's `shell` /
 * `exec_command` / `functions.exec_command`) passes its own set.
 */
export const DEFAULT_BASH_TOOL_NAMES: ReadonlySet<string> = new Set(["Bash"]);

/** Canonical agent-tasks v1 tool name whose `tool_input.status` gates
 * marker expiry (see `matchPostToolUseBoundary` below). Not imported
 * from `hook-track-active-claim.ts`'s own `TOOL_NAME_TASKS_TRANSITION`
 * constant: `policy-packs/` may not import from `cli/` (layering rule,
 * `.dependency-cruiser.cjs`). */
const TASKS_TRANSITION_TOOL_NAME = "mcp__agent-tasks__tasks_transition";

/**
 * Tool-name membership test against `expire_on_tool_match`. No GLOB
 * wildcard expansion by design (agent-tasks/d8ee60ca): operators write
 * the exact tool name they mean.
 *
 * It IS alias-aware, though: a tool name is compared against `patterns`
 * after expanding it through `expandToolNameAliases` (shell-tool
 * aliases `Bash`/`shell`/`exec_command`/`functions.exec_command`, and
 * MCP tool-name variants — server hyphen/underscore swap, the
 * `mcp__server__.tool` dotted form). This mirrors the normalization
 * `harness policy intercept`'s `policyMatchesEvent` already applies to
 * the incoming `event.tool_name` (`src/runtime/intercept.ts`, commit
 * 9aacbcd "Fix Codex hook tool matching") — that fix exists precisely
 * because Codex can emit an MCP tool name in one of these variant
 * forms for the identical tool. Before this, a Codex session sending
 * `mcp__agent-tasks__.task_finish` (dotted) or an underscore-server
 * variant would silently never expire the marker: the Codex generator
 * alias-expands the EMITTED TOML `matcher` (`expandCodexHookMatchPattern`
 * in `generate-codex-config.ts`) so Codex's own dispatcher still
 * invokes the hook command, but this function's comparison against the
 * canonical `expire_on_tool_match` config list would reject the
 * variant `tool_name` once inside the hook body — the boundary would
 * silently never fire even though the hook ran (review finding on task
 * a1348c89).
 */
export function toolNameMatchesAny(
  toolName: string,
  patterns: readonly string[],
): boolean {
  const patternSet = new Set(patterns);
  return expandToolNameAliases(toolName).some((alias) => patternSet.has(alias));
}

/** First `expire_on_bash_match` regex the command satisfies, or
 * undefined. Patterns are pre-compiled by `parseApprovalLifecycle`
 * (invalid ones already dropped with a warning). Empty command
 * short-circuits to undefined. */
export function bashCommandMatchesAny(
  command: string,
  patterns: readonly RegExp[],
): RegExp | undefined {
  if (command === "") return undefined;
  for (const re of patterns) {
    if (re.test(command)) return re;
  }
  return undefined;
}

function toolInputRecord(toolInput: unknown): Record<string, unknown> | null {
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
    return null;
  }
  return toolInput as Record<string, unknown>;
}

/** Pull the Bash command out of a tool_input payload, `""` when absent
 * or malformed. */
export function extractBashCommandFromToolInput(toolInput: unknown): string {
  const command = toolInputRecord(toolInput)?.["command"];
  return typeof command === "string" ? command : "";
}

/** Pull `taskId` out of an MCP tool_input payload (`""` when absent /
 * malformed). Task-boundary agent-tasks verbs carry this as a
 * top-level string field. */
export function extractTaskIdFromToolInput(toolInput: unknown): string {
  const tid = toolInputRecord(toolInput)?.["taskId"];
  return typeof tid === "string" ? tid : "";
}

/** Pull the legacy v1 `tasks_transition` `status` field out of a
 * tool_input payload (`""` when absent / malformed). Only `"done"`
 * releases the work claim; the caller treats any other value as
 * keep-claim. */
export function extractTasksTransitionStatusFromToolInput(toolInput: unknown): string {
  const s = toolInputRecord(toolInput)?.["status"];
  return typeof s === "string" ? s : "";
}

export interface PostToolUseBoundaryMatch {
  /** Final match decision: `toolNameMatched || bashRegex !== undefined`. */
  matched: boolean;
  /** Tool-name match, refined by the tasks_transition status filter. */
  toolNameMatched: boolean;
  /** Tool-name match BEFORE the tasks_transition status filter — lets
   * the caller distinguish "not in the list" from "in the list, but
   * status keeps the claim" for its diagnostic. */
  rawToolNameMatched: boolean;
  /** The `expire_on_bash_match` regex the command satisfied, if any. */
  bashRegex: RegExp | undefined;
}

/**
 * Decide whether `toolName` (+ its `tool_input`) crosses one of the
 * configured `approval_lifecycle` boundaries. Pure — no filesystem
 * access. Callers branch on `.matched` before touching marker/report
 * state (see `applyPostToolUseExpiry`).
 */
export function matchPostToolUseBoundary(
  toolName: string,
  toolInput: unknown,
  lifecycle: Pick<ApprovalLifecycle, "expireOnToolMatch" | "expireOnBashMatch">,
  bashToolNames: ReadonlySet<string> = DEFAULT_BASH_TOOL_NAMES,
): PostToolUseBoundaryMatch {
  const rawToolNameMatched = toolNameMatchesAny(toolName, lifecycle.expireOnToolMatch);
  // Legacy v1 `tasks_transition`: only `status=done` releases the work
  // claim (per task_finish docs: "The work claim is cleared when going
  // to done and kept when going to review"). open / in_progress /
  // review / missing status keep the marker. Detected via the same
  // alias-aware `toolNameMatchesAny` as the general match above (not a
  // raw `===`): a Codex dotted/server-variant `tasks_transition`
  // tool_name must still get the status filter applied, otherwise it
  // would fall through to the unconditional `true` branch below and
  // clear the marker on ANY status — a worse bug than a missed match
  // (review finding on task a1348c89).
  const tasksTransitionStatusOk = toolNameMatchesAny(toolName, [
    TASKS_TRANSITION_TOOL_NAME,
  ])
    ? extractTasksTransitionStatusFromToolInput(toolInput) === "done"
    : true;
  const toolNameMatched = rawToolNameMatched && tasksTransitionStatusOk;
  // Bash check only runs when the event is actually a Bash(-alias) call;
  // an MCP tool whose name happens to match a regex is not a Bash
  // boundary.
  const bashRegex = bashToolNames.has(toolName)
    ? bashCommandMatchesAny(
        extractBashCommandFromToolInput(toolInput),
        lifecycle.expireOnBashMatch,
      )
    : undefined;
  return {
    matched: toolNameMatched || bashRegex !== undefined,
    toolNameMatched,
    rawToolNameMatched,
    bashRegex,
  };
}

export interface ApplyPostToolUseExpiryResult {
  /** Did the session marker exist before this call cleared it? */
  wasMarkerPresent: boolean;
  /** Was a task-scoped marker also cleared? Only possible when
   * `toolNameMatched` (Bash regex boundaries never carry a taskId). */
  taskMarkerCleared: boolean;
  /** The task id whose marker was cleared, `""` when none. */
  clearedTaskId: string;
  /** Did the persisted-report expiry succeed? */
  persistedReportExpired: boolean;
  /** Full expiry result (success detail or skip reason) for diagnostics. */
  reportExpiry: ReturnType<typeof expirePersistedReport>;
}

/**
 * Side-effecting: clear the session marker, the task-scoped marker
 * (when `toolNameMatched` and `tool_input.taskId` names an existing
 * marker), and expire the persisted report. Call ONLY after
 * `matchPostToolUseBoundary(...).matched` is true — this function does
 * not re-check the match itself. Mirrors the Claude hook's original
 * side effects exactly so both runtimes share one clearing
 * implementation (task a1348c89).
 */
export function applyPostToolUseExpiry(
  generatedDir: string,
  sessionId: string,
  toolInput: unknown,
  toolNameMatched: boolean,
  reportsDir: string,
  now?: Date,
): ApplyPostToolUseExpiryResult {
  const markerPath = approvalMarkerPathFor(generatedDir, sessionId);
  const wasMarkerPresent = fs.existsSync(markerPath);
  clearApprovalMarker(generatedDir, sessionId);

  // Task-scoped marker cleanup (harness/1ee26e77). Only when the
  // matched tool is an MCP task-transition verb whose tool_input.taskId
  // names a specific task; Bash regex boundaries don't carry a taskId
  // by design.
  let taskMarkerCleared = false;
  let clearedTaskId = "";
  if (toolNameMatched) {
    const taskId = extractTaskIdFromToolInput(toolInput);
    if (taskId !== "") {
      const taskMarkerPath = taskApprovalMarkerPathFor(generatedDir, taskId);
      if (fs.existsSync(taskMarkerPath)) {
        clearTaskApprovalMarker(generatedDir, taskId);
        taskMarkerCleared = true;
        clearedTaskId = taskId;
      }
    }
  }

  // Persisted-report expiry (harness/1ee26e77 follow-up). Originally
  // closed a silent bypass that existed since PR #172: marker-deletion
  // alone did not invalidate the persisted-report fallback. Since task
  // 7402301d the report can no longer satisfy the gate on its own, so
  // this now exists so the audit record agrees with the cleared marker.
  // Best-effort.
  const reportExpiry = expirePersistedReport(reportsDir, sessionId, now);

  return {
    wasMarkerPresent,
    taskMarkerCleared,
    clearedTaskId,
    persistedReportExpired: reportExpiry.ok,
    reportExpiry,
  };
}

/**
 * Compose the stderr diagnostic line for a matched-and-applied PostToolUse
 * expiry. Shared by `harness pack hook post-tool-use` (Claude) and
 * `harness pack hook codex-post-tool-use` (Codex) — before this extraction
 * the two hooks each built this line by hand from the same four pieces
 * (`matchSource`/`taskNote`/`reportNote`/the present-vs-absent branch),
 * which `check:duplication` flagged as new clones the moment the Codex
 * sibling landed (task a1348c89). `hookLabel` is the caller's own
 * `harness pack hook ...` command string so the message still names the
 * right verb.
 */
export function describePostToolUseExpiry(
  hookLabel: string,
  sessionId: string,
  toolName: string,
  bashRegex: RegExp | undefined,
  expiry: ApplyPostToolUseExpiryResult,
): string {
  const matchSource = bashRegex !== undefined
    ? `bash regex /${bashRegex.source}/`
    : `tool name`;
  const taskNote = expiry.taskMarkerCleared
    ? `; also cleared task marker for task ${expiry.clearedTaskId}`
    : "";
  const reportNote = expiry.reportExpiry.ok
    ? `; expired persisted report ${expiry.reportExpiry.filePath}`
    : `; persisted-report expiry skipped (${expiry.reportExpiry.reason})`;
  return expiry.wasMarkerPresent
    ? `${hookLabel}: expired approval marker for session ${sessionId} after ${toolName} (${matchSource})${taskNote}${reportNote}`
    : `${hookLabel}: ${toolName} matched ${matchSource} but no marker present for session ${sessionId}${taskNote}${reportNote}`;
}
