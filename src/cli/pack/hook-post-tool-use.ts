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

import {
  applyPostToolUseExpiry,
  defaultReportsDir,
  describePostToolUseExpiry,
  matchPostToolUseBoundary,
  parseApprovalLifecycle,
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
   * flipped from `approved` to `expired`? Originally closed a silent
   * re-approval bypass that pre-this-fix existed since PR #172: the
   * marker was deleted on task_finish but the persisted-report fallback
   * still satisfied the gate. Since task 7402301d the report can no
   * longer satisfy the gate on its own, so this now exists so the audit
   * record agrees with the cleared marker.
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

  // tool-name / bash-command boundary match (shared with the Codex
  // sibling hook via matchPostToolUseBoundary, task a1348c89). Bash
  // check only runs when the event is actually a Bash call; an MCP tool
  // whose name happens to match a regex is not a Bash boundary.
  const boundary = matchPostToolUseBoundary(toolName, event.tool_input, lifecycle);
  if (!boundary.matched) {
    const detail = !boundary.rawToolNameMatched
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

  // Clear the session marker, the task-scoped marker (when applicable),
  // and expire the persisted report — same side effects the Codex
  // sibling hook applies via the shared `applyPostToolUseExpiry`.
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const expiry = applyPostToolUseExpiry(
    generatedDir,
    sessionId,
    event.tool_input,
    boundary.toolNameMatched,
    reportsDir,
    opts.now,
  );

  const diagnostic = describePostToolUseExpiry(
    "harness pack hook post-tool-use",
    sessionId,
    toolName,
    boundary.bashRegex,
    expiry,
  );
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matchedExpiry: true,
    markerCleared: expiry.wasMarkerPresent,
    taskMarkerCleared: expiry.taskMarkerCleared,
    persistedReportExpired: expiry.persistedReportExpired,
    diagnostic,
  };
}
