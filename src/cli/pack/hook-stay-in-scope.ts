// `harness pack hook stay-in-scope` — soft reminder on review-derived task
// creation.
//
// PostToolUse hook for the understanding-before-execution pack. Receives
// the Claude Code event JSON on stdin and, when the just-completed tool
// was an agent-tasks task-create / task-update verb AND the payload looks
// like a review-derived follow-up, emits a single stderr reminder line +
// appends one JSONL audit row.
//
// Why a soft reminder and not a hard block:
//   - PostToolUse cannot block by construction (the tool already ran).
//   - The rule being enforced ("small reviewer findings stay inline in
//     the same PR; follow-up tasks are for scope-out only") is
//     judgment-shaped, not a syntactic invariant. Hard-blocking would
//     either over-fire on legitimate trigger-bound scope-outs or accept
//     trivial self-attestation ("scope-out: yes") that erodes the rule.
//   - The audit log gives a 2-week dogfood window: count how often the
//     reminder fires vs. how often those tasks get abandoned. That
//     ratio is the signal for whether to escalate to a hard gate.
//
// Match criteria (any one is sufficient):
//   1. `tool_input.labels` contains a token matching
//      /(from-review|followup|reviewer-finding|review-finding)/i
//   2. `tool_input.description` contains a "follow-up from review"
//      textual marker (`Vorgaenger-PR:` / `Vorgänger-PR:` /
//      `Review-Subagent`, or `## Hintergrund` ... `Review` within 200
//      chars).
//
// Second-order heuristic: when both a review-shaped label AND a
// `Vorgaenger-PR.*#<n>` reference are present, the new task is itself
// a follow-up that traces back to another follow-up. The reminder
// upgrades to `[stay-in-scope: SECOND-ORDER]` since user-memory
// `feedback_reviewer_findings_stay_in_scope` explicitly forbids
// follow-ups spawning further follow-ups. Heuristic, not exact —
// resolving the parent task and checking its labels would need an
// agent-tasks roundtrip, which is out of scope for v1.
//
// Failure mode mirrors the other pack hooks: every error path resolves
// to no-op + stderr log. A reminder that can't write its audit log
// must NEVER escalate into a hook failure that disrupts the agent's
// turn — the reminder is informational, the tool already ran.
//
// Disable knob: `STAY_IN_SCOPE_DISABLED=1` short-circuits to no-op AFTER
// pause-sentinel evaluation, so an operator who pauses harness still
// sees the standard pause notice instead of stay-in-scope's silence.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHomeDir } from "../../runtime/home-dir.js";
import { checkHookPause, readStdin } from "./hook-bootstrap.js";
import type { LoaderOptions } from "../loader.js";

export const TOOL_NAME_TASK_CREATE = "mcp__agent-tasks__task_create";
export const TOOL_NAME_TASKS_CREATE = "mcp__agent-tasks__tasks_create";
export const TOOL_NAME_TASKS_UPDATE = "mcp__agent-tasks__tasks_update";

export const STAY_IN_SCOPE_TOOLS: readonly string[] = [
  TOOL_NAME_TASK_CREATE,
  TOOL_NAME_TASKS_CREATE,
  TOOL_NAME_TASKS_UPDATE,
];

export const STAY_IN_SCOPE_DISABLED_ENV = "STAY_IN_SCOPE_DISABLED";
export const STAY_IN_SCOPE_LOG_ENV = "STAY_IN_SCOPE_LOG";
export const REMINDERS_SUBDIR = "reminders";
export const STAY_IN_SCOPE_LOG_BASENAME = "stay-in-scope.log";

const LABEL_REVIEW_REGEX =
  /(from-review|followup|reviewer-finding|review-finding)/i;

// Inline description markers, checked case-sensitively for the
// literal source (Vorgänger-PR) and accent-stripped alternative
// (Vorgaenger-PR). `Review-Subagent` matches both the German task
// template ("Aus Review-Subagent ...") and English variations.
const DESCRIPTION_MARKERS: readonly string[] = [
  "Vorgänger-PR:",
  "Vorgaenger-PR:",
  "Review-Subagent",
];

// "## Hintergrund" followed by "Review" within 200 characters catches
// the existing German task body convention without insisting on the
// explicit marker keywords above. The 200-char window keeps it tight
// enough that a totally unrelated body that happens to use both words
// far apart doesn't trigger.
const HINTERGRUND_REVIEW_WINDOW = 200;

// Second-order heuristic: a follow-up whose body references a
// parent PR by number AND carries review-shaped labels is itself
// likely a follow-up-of-a-follow-up. The regex is intentionally loose
// (Vorgänger-PR / Vorgaenger-PR / `parent PR` / Parent-PR, optional
// punctuation) so common author variants all match.
const PARENT_PR_REGEX = /(?:Vorg(?:ä|ae)nger-PR|parent[\s-]+PR)\s*[:#-]?\s*#?\d+/i;

export type MatchedRule = "label" | "hintergrund-marker" | "explicit-marker" | "none";

export interface StayInScopeAuditRecord {
  ts: string;
  taskId: string | null;
  title: string | null;
  labels: string[];
  parentPrUrl: string | null;
  secondOrder: boolean;
  matchedRule: MatchedRule;
}

export interface PackHookStayInScopeOptions extends LoaderOptions {
  generatedDir?: string;
  /**
   * Override the audit log path. Defaults to
   * `resolveHomeDir().path/reminders/stay-in-scope.log`, with
   * `STAY_IN_SCOPE_LOG` env taking precedence over the resolved default
   * (but losing to an explicit option here, so tests can pin the path).
   */
  logPath?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  /** Override "now" for deterministic test output. */
  now?: Date;
  /** Override env lookup (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface PackHookStayInScopeResult {
  exitCode: number;
  /** Did the just-completed tool's payload match the reminder rules? */
  matched: boolean;
  /** Which match path fired ("none" when matched=false). */
  matchedRule: MatchedRule;
  /** Was the audit row appended successfully? */
  logged: boolean;
  /** Was the second-order heuristic positive? */
  secondOrder: boolean;
  /** Resolved audit log path, or null if logging was skipped/failed. */
  logPath: string | null;
  /** Diagnostic line emitted to stderr. */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
  partial: Partial<PackHookStayInScopeResult> = {},
): PackHookStayInScopeResult {
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matched: false,
    matchedRule: "none",
    logged: false,
    secondOrder: false,
    logPath: null,
    diagnostic,
    ...partial,
  };
}

function extractLabels(toolInput: unknown): string[] {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return [];
  }
  const labels = (toolInput as Record<string, unknown>)["labels"];
  if (!Array.isArray(labels)) return [];
  return labels.filter((v): v is string => typeof v === "string");
}

function extractDescription(toolInput: unknown): string {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return "";
  }
  const d = (toolInput as Record<string, unknown>)["description"];
  return typeof d === "string" ? d : "";
}

function extractTitle(toolInput: unknown): string | null {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return null;
  }
  const t = (toolInput as Record<string, unknown>)["title"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

// Pull a taskId out of either the tool_input (for tasks_update) or the
// tool_response (the typical create-call shape, where the task UUID is
// only known after the server roundtrip). Returns null when neither
// surface carries one.
function extractTaskId(event: ToolEventLite): string | null {
  const fromInput = (() => {
    if (
      typeof event.tool_input !== "object" ||
      event.tool_input === null ||
      Array.isArray(event.tool_input)
    ) {
      return null;
    }
    const tid = (event.tool_input as Record<string, unknown>)["taskId"];
    return typeof tid === "string" && tid.length > 0 ? tid : null;
  })();
  if (fromInput !== null) return fromInput;

  if (
    typeof event.tool_response !== "object" ||
    event.tool_response === null ||
    Array.isArray(event.tool_response)
  ) {
    return null;
  }
  const respObj = event.tool_response as Record<string, unknown>;
  // The server response wraps the task under `task` for task_create and
  // task_finish, but at the top level for some bulk verbs. Probe both
  // shapes; fall back to null on miss.
  const wrapped = respObj["task"];
  if (
    typeof wrapped === "object" &&
    wrapped !== null &&
    !Array.isArray(wrapped)
  ) {
    const tid = (wrapped as Record<string, unknown>)["id"];
    if (typeof tid === "string" && tid.length > 0) return tid;
  }
  const directId = respObj["id"];
  return typeof directId === "string" && directId.length > 0 ? directId : null;
}

function hintergrundReviewMatch(description: string): boolean {
  const idx = description.indexOf("## Hintergrund");
  if (idx === -1) return false;
  const window = description.slice(idx, idx + HINTERGRUND_REVIEW_WINDOW);
  return /Review/i.test(window);
}

export interface MatchEvaluation {
  matched: boolean;
  matchedRule: MatchedRule;
  secondOrder: boolean;
}

export function evaluateMatch(
  labels: readonly string[],
  description: string,
): MatchEvaluation {
  const labelMatch = labels.some((l) => LABEL_REVIEW_REGEX.test(l));
  const explicitMarker = DESCRIPTION_MARKERS.some((m) =>
    description.includes(m),
  );
  const hintergrundMarker = !explicitMarker && hintergrundReviewMatch(description);

  let matchedRule: MatchedRule = "none";
  if (labelMatch) matchedRule = "label";
  else if (explicitMarker) matchedRule = "explicit-marker";
  else if (hintergrundMarker) matchedRule = "hintergrund-marker";

  const matched = matchedRule !== "none";
  const secondOrder = labelMatch && PARENT_PR_REGEX.test(description);

  return { matched, matchedRule, secondOrder };
}

function resolveLogPath(
  opts: PackHookStayInScopeOptions,
  env: NodeJS.ProcessEnv,
): string {
  if (typeof opts.logPath === "string" && opts.logPath.length > 0) {
    return opts.logPath;
  }
  const fromEnv = env[STAY_IN_SCOPE_LOG_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  const home = resolveHomeDir(
    opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {},
  );
  return path.join(home.path, REMINDERS_SUBDIR, STAY_IN_SCOPE_LOG_BASENAME);
}

function appendAuditRow(
  logPath: string,
  record: StayInScopeAuditRecord,
): { ok: true } | { ok: false; reason: string } {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function runPackHookStayInScopeCli(
  opts: PackHookStayInScopeOptions = {},
): Promise<PackHookStayInScopeResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    return noop(
      "harness pack hook stay-in-scope: malformed event JSON, skipping",
      stderr,
    );
  }

  // Pause sentinel — operator pause silences this reminder so a debug
  // A/B-test doesn't fan out reminder noise the operator already knows
  // about.
  if (checkHookPause("stay-in-scope", stderr, opts, opts.generatedDir).paused) {
    return noop(
      "harness paused; stay-in-scope skipping without evaluating.",
      stderr,
    );
  }

  // Operator opt-out via env. Evaluated AFTER pause so a paused harness
  // still announces pause (the canonical operator-state signal) instead
  // of silently swallowing it.
  if (env[STAY_IN_SCOPE_DISABLED_ENV] === "1") {
    return noop(
      `harness pack hook stay-in-scope: ${STAY_IN_SCOPE_DISABLED_ENV}=1, skipping`,
      stderr,
    );
  }

  const toolName =
    typeof event.tool_name === "string" ? event.tool_name : "";
  if (toolName === "" || !STAY_IN_SCOPE_TOOLS.includes(toolName)) {
    return noop(
      `harness pack hook stay-in-scope: tool ${toolName || "(missing)"} not in watch list, skipping`,
      stderr,
    );
  }

  const labels = extractLabels(event.tool_input);
  const description = extractDescription(event.tool_input);
  const evaluation = evaluateMatch(labels, description);
  if (!evaluation.matched) {
    return noop(
      `harness pack hook stay-in-scope: ${toolName} payload carries no review-shaped label or description marker, skipping`,
      stderr,
    );
  }

  const taskId = extractTaskId(event);
  const title = extractTitle(event.tool_input);
  const now = (opts.now ?? new Date()).toISOString();

  const record: StayInScopeAuditRecord = {
    ts: now,
    taskId,
    title,
    labels,
    parentPrUrl: extractParentPrUrl(description),
    secondOrder: evaluation.secondOrder,
    matchedRule: evaluation.matchedRule,
  };

  const logPath = resolveLogPath(opts, env);
  const appendResult = appendAuditRow(logPath, record);

  const prefix = evaluation.secondOrder
    ? "[stay-in-scope: SECOND-ORDER]"
    : "[stay-in-scope]";
  const taskIdNote = taskId !== null ? ` task=${taskId}` : "";
  const secondOrderNote = evaluation.secondOrder
    ? " A follow-up of a follow-up: user-memory feedback_reviewer_findings_stay_in_scope forbids this — please fold this work into the immediate parent PR."
    : " War der Finding inline-fixbar im Parent-PR? Falls ja: task_abandon + Patch im Parent. (feedback_reviewer_findings_stay_in_scope)";
  const stderrLine = `${prefix} follow-up created from review context${taskIdNote}.${secondOrderNote}`;
  stderr.write(`${stderrLine}\n`);

  const logNote = appendResult.ok
    ? `; audit appended to ${logPath}`
    : `; audit append FAILED (${appendResult.reason})`;
  const diagnostic = `harness pack hook stay-in-scope: matched=${evaluation.matchedRule} secondOrder=${evaluation.secondOrder}${logNote}`;
  stderr.write(`${diagnostic}\n`);

  return {
    exitCode: 0,
    matched: true,
    matchedRule: evaluation.matchedRule,
    logged: appendResult.ok,
    secondOrder: evaluation.secondOrder,
    logPath: appendResult.ok ? logPath : null,
    diagnostic,
  };
}

// Best-effort GitHub PR URL extraction from a description body. Looks
// for an https://github.com/<owner>/<repo>/pull/<n> URL first (most
// reliable), then for `(Vorg(ä|ae)nger-PR|parent[\s-]+PR) ... #<n>`
// shorthand which is what the German task bodies usually carry. Returns
// null on miss.
export function extractParentPrUrl(description: string): string | null {
  const fullUrl = description.match(
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/,
  );
  if (fullUrl !== null) return fullUrl[0];
  // Shorthand: just the number, no repo. Return a `#<n>` token so the
  // audit log preserves the reference even though we can't resolve it
  // to a URL without an agent-tasks roundtrip (out of scope for v1).
  const shorthand = description.match(
    /(?:Vorg(?:ä|ae)nger-PR|parent[\s-]+PR)\s*[:#-]?\s*(#?\d+)/i,
  );
  if (shorthand !== null && typeof shorthand[1] === "string") {
    return shorthand[1].startsWith("#") ? shorthand[1] : `#${shorthand[1]}`;
  }
  return null;
}
