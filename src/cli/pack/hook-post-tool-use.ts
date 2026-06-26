// `harness pack hook post-tool-use [--pack <name>]` — task-boundary marker expiry.
//
// PostToolUse hook for the understanding-before-execution pack. Receives
// the Claude Code event JSON on stdin and, when the just-completed tool
// matches the pack's `config.approval_lifecycle.expire_on_tool_match`
// list, deletes the per-session approval marker so the next Edit /
// Write / Bash forces a fresh Understanding Report.
//
// Why a PostToolUse hook and not a PreToolUse one: the marker is the
// canonical "operator approved this interpretation" signal. Expiring it
// AFTER the boundary-marker tool (task_finish / pull_requests_merge /
// task_abandon) is semantically right — the agent has just declared the
// current task done, so the next tool call belongs to a new task and
// deserves a fresh re-interpretation. PostToolUse fires only when the
// tool actually ran (a PreToolUse-blocked call does NOT fire PostToolUse),
// so we never expire a marker for a tool the agent merely attempted.
//
// Failure mode: every error path resolves to no-op + stderr log. The
// gate is opt-in; turning a buggy hook into a session-wide "everything
// is unapproved now" surface would be hostile. Worst case the marker
// persists past the intended boundary, which degrades to the legacy
// per-session contract.

import { existsSync } from "node:fs";
import {
  approvalMarkerPathFor,
  clearApprovalMarker,
  clearTaskApprovalMarker,
  defaultReportsDir,
  expirePersistedReport,
  parseApprovalLifecycle,
  taskApprovalMarkerPathFor,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  readStdin,
} from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookPostToolUseOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  /**
   * Override the persisted-report directory. Defaults to
   * `defaultReportsDir()` which honours `UNDERSTANDING_GATE_REPORT_DIR`
   * (set by the pack's hook-command wrapper) or falls back to
   * `<cwd>/.understanding-gate/reports`.
   */
  reportsDir?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface PackHookPostToolUseResult {
  exitCode: number;
  /** Did the just-completed tool match the expiry list? */
  matchedExpiry: boolean;
  /** Was the session marker actually cleared (false if it was already absent). */
  markerCleared: boolean;
  /**
   * Was a task-scoped marker also cleared (harness/1ee26e77)? Only set
   * when the matched tool was an agent-tasks task-transition verb AND
   * `tool_input.taskId` was present in the event, AND a marker existed
   * for that task id. False otherwise. Independent of markerCleared.
   */
  taskMarkerCleared: boolean;
  /**
   * Was the persisted report (`.understanding-gate/reports/...json`)
   * flipped from `approved` to `expired`? Closes the silent re-approval
   * bypass that pre-this-fix existed since PR #172: the marker was
   * deleted on task_finish but the persisted-report fallback still
   * satisfied the gate.
   */
  persistedReportExpired: boolean;
  /** Diagnostic line emitted to stderr. */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

// Match a tool name against one of the patterns. The pattern is a plain
// tool name like `mcp__agent-tasks__task_finish`; wildcard expansion is
// deliberately not supported in v1 so operators write what they mean.
function toolMatches(toolName: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === toolName) return true;
  }
  return false;
}

// Match a Bash tool_input.command against the operator's regex list.
// Patterns are pre-compiled by parseApprovalLifecycle, so invalid
// regexes were dropped (with a warning) at parse time and we just
// iterate here. Empty / missing command short-circuits to false.
function bashCommandMatches(command: string, patterns: readonly RegExp[]): RegExp | undefined {
  if (command === "") return undefined;
  for (const re of patterns) {
    if (re.test(command)) return re;
  }
  return undefined;
}

function extractBashCommand(toolInput: unknown): string {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return "";
  }
  const command = (toolInput as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : "";
}

// Pull `taskId` out of an MCP tool_input payload. agent-tasks verbs that
// mark a task boundary (`task_finish`, `task_abandon`, etc.) carry the
// taskId as a top-level string field. When present, the post-tool-use
// hook also clears the corresponding task-scoped approval marker
// (harness/1ee26e77). Returns "" when absent / malformed.
function extractTaskId(toolInput: unknown): string {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return "";
  }
  const tid = (toolInput as Record<string, unknown>)["taskId"];
  return typeof tid === "string" ? tid : "";
}

// `tasks_transition` (v1) carries `status: "open" | "in_progress" | "review" | "done"`.
// Only "done" releases the work claim (per task_finish docs); other values
// keep the marker so the agent's continued work on the same task remains
// approved. Returns "" for malformed / missing status; the caller treats
// any non-"done" return as keep-claim.
function extractTasksTransitionStatus(toolInput: unknown): string {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return "";
  }
  const s = (toolInput as Record<string, unknown>)["status"];
  return typeof s === "string" ? s : "";
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
): PackHookPostToolUseResult {
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matchedExpiry: false,
    markerCleared: false,
    taskMarkerCleared: false,
    persistedReportExpired: false,
    diagnostic,
  };
}

export async function runPackHookPostToolUseCli(
  opts: PackHookPostToolUseOptions = {},
): Promise<PackHookPostToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    return noop(
      "harness pack hook post-tool-use: malformed event JSON, skipping marker expiry",
      stderr,
    );
  }

  // Pause sentinel — skip marker expiry while paused so a debug A/B-test
  // doesn't silently invalidate the operator's approval state.
  if (checkHookPause("post-tool-use", stderr, opts, opts.generatedDir).paused) {
    return noop(
      "harness paused; post-tool-use skipping marker expiry without evaluating.",
      stderr,
    );
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (sessionId === "" || toolName === "") {
    return noop(
      `harness pack hook post-tool-use: missing session_id (${sessionId === "" ? "absent" : "ok"}) or tool_name (${toolName === "" ? "absent" : "ok"}), skipping`,
      stderr,
    );
  }

  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    return noop(
      `harness pack hook post-tool-use: manifest load failed (${(err as Error).message}), skipping`,
      stderr,
    );
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return noop(
      `harness pack hook post-tool-use: pack "${packName}" not declared in manifest, skipping`,
      stderr,
    );
  }
  if (!declared.enabled) {
    return noop(
      `harness pack hook post-tool-use: pack "${packName}" is enabled:false, skipping`,
      stderr,
    );
  }

  const lifecycle = parseApprovalLifecycle(
    (declared.config as Record<string, unknown>)["approval_lifecycle"],
    stderr,
  );
  if (lifecycle.legacyMode) {
    return noop(
      `harness pack hook post-tool-use: legacy-session mode, skipping`,
      stderr,
    );
  }
  const noBoundariesConfigured =
    lifecycle.expireOnToolMatch.length === 0 && lifecycle.expireOnBashMatch.length === 0;
  if (noBoundariesConfigured) {
    return noop(
      `harness pack hook post-tool-use: no expire_on_tool_match or expire_on_bash_match configured, skipping`,
      stderr,
    );
  }

  // tool-name match is the first filter; status-based refinement below
  // catches the legacy v1 `tasks_transition` verb whose terminality
  // depends on `tool_input.status` rather than on the tool name alone.
  const rawToolNameMatched = toolMatches(toolName, lifecycle.expireOnToolMatch);
  // Legacy v1 `tasks_transition`: only `status=done` releases the work
  // claim (per task_finish docs: "The work claim is cleared when going
  // to done and kept when going to review"). open / in_progress / review
  // / missing status keep the marker so subsequent agent work on the
  // same task continues to satisfy the gate.
  const tasksTransitionStatusOk =
    toolName === "mcp__agent-tasks__tasks_transition"
      ? extractTasksTransitionStatus(event.tool_input) === "done"
      : true;
  const toolNameMatched = rawToolNameMatched && tasksTransitionStatusOk;
  // Bash check only runs when the event is actually a Bash call; an MCP
  // tool whose name happens to match a regex is not a Bash boundary.
  const bashRegex =
    toolName === "Bash"
      ? bashCommandMatches(extractBashCommand(event.tool_input), lifecycle.expireOnBashMatch)
      : undefined;
  if (!toolNameMatched && bashRegex === undefined) {
    const detail = !rawToolNameMatched
      ? toolName === "Bash"
        ? `Bash command did not match any expire_on_bash_match regex`
        : `tool ${toolName} not in expire_on_tool_match`
      : `tasks_transition status keeps work claim, skipping`;
    return noop(
      `harness pack hook post-tool-use: ${detail}, skipping`,
      stderr,
    );
  }

  const generatedDir =
    opts.generatedDir ??
    (manifestPath !== undefined
      ? resolveGeneratedDir({
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          manifestPath,
        })
      : undefined);
  if (generatedDir === undefined) {
    return noop(
      "harness pack hook post-tool-use: generatedDir unresolvable, skipping marker expiry",
      stderr,
    );
  }

  // The marker may already be absent (operator revoked, prior expiry).
  // Always log the attempt so the diagnostic trail names the boundary
  // tool; the markerCleared flag distinguishes the two paths.
  // clearApprovalMarker swallows errors and uses force:true, so we
  // probe the marker path first to set markerCleared accurately.
  const markerPath = approvalMarkerPathFor(generatedDir, sessionId);
  const wasPresent = existsSync(markerPath);
  clearApprovalMarker(generatedDir, sessionId);

  // Task-scoped marker cleanup (harness/1ee26e77). Only when the
  // matched tool is an MCP task-transition verb whose tool_input.taskId
  // names a specific task; Bash regex boundaries don't carry a taskId
  // by design.
  let taskMarkerCleared = false;
  let clearedTaskId = "";
  if (toolNameMatched) {
    const taskId = extractTaskId(event.tool_input);
    if (taskId !== "") {
      const taskMarkerPath = taskApprovalMarkerPathFor(generatedDir, taskId);
      if (existsSync(taskMarkerPath)) {
        clearTaskApprovalMarker(generatedDir, taskId);
        taskMarkerCleared = true;
        clearedTaskId = taskId;
      }
    }
  }

  // Persisted-report expiry (harness/1ee26e77 follow-up). Closes the
  // silent bypass that existed since PR #172: marker-deletion alone
  // did not invalidate the persisted-report fallback the gate consults
  // when the marker is absent, so the next Edit/Write/Bash silently
  // re-approved via the report even though the marker had just been
  // expired. Best-effort; a missing reports dir or unrelated read
  // failure is logged but does not break the hook.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const reportExpiry = expirePersistedReport(reportsDir, sessionId, opts.now);
  const persistedReportExpired = reportExpiry.ok;

  const matchSource = bashRegex !== undefined
    ? `bash regex /${bashRegex.source}/`
    : `tool name`;
  const taskNote = taskMarkerCleared
    ? `; also cleared task marker for task ${clearedTaskId}`
    : "";
  const reportNote = reportExpiry.ok
    ? `; expired persisted report ${reportExpiry.filePath}`
    : `; persisted-report expiry skipped (${reportExpiry.reason})`;
  const diagnostic = wasPresent
    ? `harness pack hook post-tool-use: expired approval marker for session ${sessionId} after ${toolName} (${matchSource})${taskNote}${reportNote}`
    : `harness pack hook post-tool-use: ${toolName} matched ${matchSource} but no marker present for session ${sessionId}${taskNote}${reportNote}`;
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matchedExpiry: true,
    markerCleared: wasPresent,
    taskMarkerCleared,
    persistedReportExpired,
    diagnostic,
  };
}
