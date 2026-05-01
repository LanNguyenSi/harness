// Phase 5 #2 — shared sessionId resolver.
//
// Three Phase 4 verbs (`audit`, `explain --trace`, `policy intercept`)
// previously defaulted to the literal string `"default"` when no
// session was given. Real Claude Code sessions are UUIDs that arrive
// via the hook event's `session_id`. When the user later runs
// `harness audit` or `harness explain --trace` without `--session`, the
// read path looked at `"default"` and silently returned an empty
// audit/trace even though the writes had landed correctly under the
// real UUID.
//
// This helper lifts the precedence chain into one place:
//   1. explicit value (from a `--session` flag or the runtime's
//      `event.session_id`)
//   2. `$CLAUDE_SESSION_ID` env (set by the Claude Code harness inside
//      every session)
//   3. literal `"default"` — preserves prior behaviour for ad-hoc
//      invocations outside a Claude Code session.

const FALLBACK = "default";

/**
 * Resolve the active grounding session id.
 *
 * Empty strings are treated as "not provided" — both for the explicit
 * argument and for the env var, since `--session ''` from a forgetful
 * shell expansion or `CLAUDE_SESSION_ID=` from a stale exec env should
 * fall through to the next tier rather than be honoured as a literal
 * empty session.
 */
export function resolveSessionId(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const env = process.env.CLAUDE_SESSION_ID;
  if (typeof env === "string" && env.length > 0) return env;
  return FALLBACK;
}
