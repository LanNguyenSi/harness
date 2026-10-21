// Phase 5 #2 — shared sessionId resolver.
//
// Session-aware verbs once defaulted to the literal string `"default"` when
// no session was given. Real Claude Code sessions are UUIDs that arrive
// via the hook event's `session_id`.
//
// `resolveSessionId` lifts the precedence chain into one place for callers
// that already carry a concrete `event.session_id` (the write side):
//   1. explicit value (the runtime's `event.session_id`)
//   2. `$CLAUDE_CODE_SESSION_ID` env (the var Claude Code actually exports)
//   3. `$CLAUDE_SESSION_ID` env (legacy fallback)
//   4. literal `"default"`
//
// Both env tiers rank `$CLAUDE_CODE_SESSION_ID` above the legacy
// `$CLAUDE_SESSION_ID`.

const FALLBACK = "default";

/**
 * Resolve the active grounding session id (WRITE path).
 *
 * Empty strings are treated as "not provided" — both for the explicit
 * argument and for the env var, since `--session ''` from a forgetful
 * shell expansion or `CLAUDE_SESSION_ID=` from a stale exec env should
 * fall through to the next tier rather than be honoured as a literal
 * empty session.
 */
export function resolveSessionId(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const envCode = process.env.CLAUDE_CODE_SESSION_ID;
  if (typeof envCode === "string" && envCode.length > 0) return envCode;
  const env = process.env.CLAUDE_SESSION_ID;
  if (typeof env === "string" && env.length > 0) return env;
  return FALLBACK;
}
