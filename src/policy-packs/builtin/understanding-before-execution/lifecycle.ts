// `approval_lifecycle` pack-config parsing, split out of the former
// monolithic understanding-before-execution-runtime.ts (structural
// concentration slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import { InvalidDurationError, parseDurationSeconds } from "../../../policies/index.js";

// approval_lifecycle (agent-tasks/d8ee60ca, harness/f54e0ecb): per-task
// expiry of the approval marker. The legacy contract was one approval
// per session for the session's lifetime; multi-task sessions silently
// let a stale interpretation drive the next task's edits. The new
// config block expires the marker on three boundary kinds:
//
//   1. expire_on_tool_match: a list of MCP tool name patterns. When a
//      tool whose exact name appears in the list runs (PostToolUse hook),
//      the marker is deleted. Used to mark task-completion boundaries
//      for agent-tasks workflows (task_finish, task_abandon,
//      pull_requests_merge).
//   2. expire_on_bash_match: a list of regex patterns matched against
//      the Bash tool's command string. Same expiry semantics. Used by
//      gh-CLI / pure-Bash workflows where the task boundary is a shell
//      command (gh pr merge, git push origin master, etc.). Compiled
//      once at parse time; an invalid regex is skipped with a warning
//      so a typo in one pattern does not break the others.
//   3. max_age: a duration string. checkApprovalMarker treats a marker
//      older than this as expired. Safety net so a session that never
//      hits a listed tool / command still re-approves after the window.
//
// All three fields are optional. An empty list means no per-tool or
// per-command expiry; an omitted max_age means no TTL. `{ mode: "session" }`
// is the documented opt-out for operators who want the legacy behaviour —
// but it opts out of the tool/bash boundary expiry only. `max_age` still
// applies under `mode: session` (task 496660c5): a session-scoped install
// that never hits a listed tool or bash pattern still wants a TTL safety
// net, and an in-flight subagent's inherited approval (see
// inflight-records.ts) is checked against the same TTL either way.

export interface ApprovalLifecycle {
  /** Tool-name patterns whose successful PostToolUse expires the marker. */
  expireOnToolMatch: string[];
  /** Pre-compiled regex patterns matched against `Bash` tool_input.command. */
  expireOnBashMatch: RegExp[];
  /** Max marker age in milliseconds. Undefined means no TTL. */
  maxAgeMs?: number;
  /** Whether the operator explicitly opted out via `{ mode: "session" }`. */
  legacyMode: boolean;
}

const DEFAULT_LIFECYCLE: ApprovalLifecycle = {
  expireOnToolMatch: [],
  expireOnBashMatch: [],
  legacyMode: false,
};

/**
 * Parse the optional `approval_lifecycle` block from a pack config.
 * Best-effort: malformed values fall back to the default (no expiry,
 * legacyMode=false) and write a one-line warning to the supplied
 * stderr. The PreToolUse / PostToolUse hooks must keep working even
 * when the operator typed a typo in the YAML.
 */
export function parseApprovalLifecycle(
  raw: unknown,
  stderr?: { write: (s: string) => void } | null,
): ApprovalLifecycle {
  if (raw === undefined || raw === null) return DEFAULT_LIFECYCLE;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle ignored (expected object, got ${typeof raw})\n`,
    );
    return DEFAULT_LIFECYCLE;
  }
  const obj = raw as Record<string, unknown>;
  if (obj["mode"] === "session") {
    const maxAgeMs = parseMaxAge(obj["max_age"], stderr);
    return {
      expireOnToolMatch: [],
      expireOnBashMatch: [],
      ...(maxAgeMs !== undefined && { maxAgeMs }),
      legacyMode: true,
    };
  }
  const expireOnToolMatch: string[] = [];
  const list = obj["expire_on_tool_match"];
  if (Array.isArray(list)) {
    for (const v of list) {
      if (typeof v === "string" && v.length > 0) expireOnToolMatch.push(v);
    }
  } else if (list !== undefined) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle.expire_on_tool_match ignored (expected string[], got ${typeof list})\n`,
    );
  }
  const expireOnBashMatch: RegExp[] = [];
  const bashList = obj["expire_on_bash_match"];
  if (Array.isArray(bashList)) {
    for (const v of bashList) {
      if (typeof v !== "string" || v.length === 0) continue;
      try {
        expireOnBashMatch.push(new RegExp(v));
      } catch (err) {
        stderr?.write(
          `harness pack hook: config.approval_lifecycle.expire_on_bash_match entry ignored ("${v}"): ${(err as Error).message}\n`,
        );
      }
    }
  } else if (bashList !== undefined) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle.expire_on_bash_match ignored (expected string[], got ${typeof bashList})\n`,
    );
  }
  const maxAgeMs = parseMaxAge(obj["max_age"], stderr);
  return {
    expireOnToolMatch,
    expireOnBashMatch,
    ...(maxAgeMs !== undefined && { maxAgeMs }),
    legacyMode: false,
  };
}

/**
 * Parse `approval_lifecycle.max_age` into milliseconds. Shared by both the
 * boundary-lifecycle branch and the `{ mode: "session" }` branch (task
 * 496660c5) so a malformed value warns identically in either mode.
 */
function parseMaxAge(
  maxAgeRaw: unknown,
  stderr?: { write: (s: string) => void } | null,
): number | undefined {
  if (typeof maxAgeRaw === "string" && maxAgeRaw.length > 0) {
    try {
      return parseDurationSeconds(maxAgeRaw) * 1_000;
    } catch (err) {
      const msg = err instanceof InvalidDurationError ? err.message : String(err);
      stderr?.write(`harness pack hook: config.approval_lifecycle.max_age ignored: ${msg}\n`);
      return undefined;
    }
  }
  if (maxAgeRaw !== undefined) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle.max_age ignored (expected duration string like "4h", got ${typeof maxAgeRaw})\n`,
    );
  }
  return undefined;
}
