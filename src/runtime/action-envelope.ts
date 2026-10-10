// Action Envelope.
//
// The normalized, stable representation of a tool call. The raw runtime
// event (`ToolEvent`, the Claude Code PreToolUse hook payload) is
// runtime-specific and loosely shaped; this shape lets a consumer avoid
// re-parsing a runtime-specific payload.
//
// STATUS: no longer consumed by `harness policy intercept` or any CLI
// verb (the Risk Gate stages that built it are removed); it stays as a
// runtime export.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md
// ("Action Envelope" section).

import type { GitRepoContext } from "./git-context.js";
import type { ToolEvent } from "./intercept.js";

export interface ActionEnvelopeSession {
  /** Grounding / Claude Code session id, or "" when absent. */
  id: string;
  /** Work-tree basename for the event's cwd, or "" when not in a repo. */
  repo: string;
  /** Current branch, or "" when not in a repo or HEAD is detached. */
  branch: string;
  /**
   * agent-tasks task id. Not present in the Claude Code PreToolUse
   * payload, so "" in practice; a harness-driven or synthetic event may
   * carry one. The MVP does no agent-tasks lookup.
   */
  task_id: string;
}

export interface ActionEnvelopeRuntime {
  /** Working directory the action runs in. */
  cwd: string;
  /** OS user, or "" when unavailable. */
  user: string;
  /** Host name, or "" when unavailable. */
  host: string;
}

export interface ActionEnvelope {
  /** Hook event name, e.g. "PreToolUse". "" when absent. */
  event: string;
  /** Tool name, e.g. "Bash". "" when absent. */
  tool: string;
  /** The tool's raw input, verbatim. `null` when the event carries none. */
  raw_input: unknown;
  session: ActionEnvelopeSession;
  runtime: ActionEnvelopeRuntime;
  /** ISO-8601 UTC timestamp the envelope was built. */
  timestamp: string;
}

/**
 * Ambient facts the builder cannot derive from the event alone. The CLI
 * wrapper resolves these (filesystem + process reads) and hands them in,
 * keeping `buildActionEnvelope` itself pure and I/O-free — the same
 * resolved-by-the-wrapper pattern `intercept()` uses for the git sha and
 * the policy builtins.
 */
export interface EnvelopeContext {
  /** Final working directory: the event's cwd, or the wrapper's fallback. */
  cwd: string;
  /** Git context resolved against `cwd`. Empty strings when cwd is not in a repo. */
  git: GitRepoContext;
  /** OS user (`os.userInfo().username`), or "" when unavailable. */
  user: string;
  /** Host name (`os.hostname()`), or "" when unavailable. */
  host: string;
  /** Timestamp to stamp on the envelope. */
  now: Date;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize a runtime tool event into an Action Envelope.
 *
 * Pure: every non-deterministic input (cwd, git, user, host, now)
 * arrives via `context`. A sparse or malformed event never throws —
 * absent fields become "" (or `null` for `raw_input`), so a hand-probed
 * `{}` event still yields a well-formed envelope.
 */
export function buildActionEnvelope(
  event: ToolEvent,
  context: EnvelopeContext,
): ActionEnvelope {
  return {
    event: asString(event.hook_event_name),
    tool: asString(event.tool_name),
    raw_input: event.tool_input ?? null,
    session: {
      id: asString(event.session_id),
      repo: context.git.repo,
      branch: context.git.branch,
      task_id: asString(event.task_id),
    },
    runtime: {
      cwd: context.cwd,
      user: context.user,
      host: context.host,
    },
    timestamp: context.now.toISOString(),
  };
}
