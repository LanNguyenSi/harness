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
// `resolveSessionId` lifts the precedence chain into one place for the
// WRITE path (`policy intercept`), which always carries a concrete
// `event.session_id`:
//   1. explicit value (the runtime's `event.session_id`)
//   2. `$CLAUDE_CODE_SESSION_ID` env (the var Claude Code actually exports)
//   3. `$CLAUDE_SESSION_ID` env (legacy fallback)
//   4. literal `"default"`
//
// The READ path (`audit`, `explain --trace/--last`) needs more. The
// Phase 5 #2 fix assumed `$CLAUDE_SESSION_ID` is exported into the
// session's shell environment — it is not (Claude Code does not put it
// in the Bash tool env), so tier 2 is inert in practice and the readers
// still fell through to `"default"`. `resolveReadSessionId` adds a
// transcript-discovery tier: when no explicit id and no env, it reads
// the active session id off the newest Claude Code transcript JSONL.
// That is the programmatic form of the heuristic `harness approve`'s
// own help text recommends to humans.
//
// Both resolvers also accept `$CLAUDE_CODE_SESSION_ID` as a higher-priority
// env tier than the legacy `$CLAUDE_SESSION_ID`, mirroring the
// `harness approve` verbs (`src/cli/approve/{risk,understanding}.ts`).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPendingApproval } from "./pending-approval.js";

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

export interface DiscoverSessionOptions {
  /** Override the Claude Code projects root (tests). */
  projectsRoot?: string;
  /** Override `$HOME` used to derive the projects root (tests). */
  homeDir?: string;
}

// Claude Code names each session's transcript `<uuid>.jsonl`. Anchored
// so sibling files (memory dirs, `.pending-approval`, etc.) are ignored.
const SESSION_TRANSCRIPT_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Discover the current Claude Code session id from the most recently
 * modified transcript JSONL under `~/.claude/projects/<project>/`.
 *
 * Claude Code appends to the active session's transcript live, so the
 * newest-mtime `<uuid>.jsonl` across all project dirs is the running
 * session. Returns `null` when the projects root is absent or holds no
 * transcript files — callers fall through to their own default.
 */
export function discoverNewestSessionId(
  opts: DiscoverSessionOptions = {},
): string | null {
  const projectsRoot =
    opts.projectsRoot ??
    path.join(opts.homeDir ?? os.homedir(), ".claude", "projects");
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  let newest: { id: string; mtimeMs: number } | null = null;
  for (const dir of projectDirs) {
    const projectPath = path.join(projectsRoot, dir);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath);
    } catch {
      continue; // not a directory, or unreadable — skip
    }
    for (const file of files) {
      const match = SESSION_TRANSCRIPT_RE.exec(file);
      if (!match) continue;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(projectPath, file)).mtimeMs;
      } catch {
        continue;
      }
      if (newest === null || mtimeMs > newest.mtimeMs) {
        newest = { id: match[1]!, mtimeMs };
      }
    }
  }
  return newest === null ? null : newest.id;
}

export interface ResolveReadSessionOptions extends DiscoverSessionOptions {
  /**
   * Test seam — override the transcript-discovery tier wholesale. The
   * default scans the real `~/.claude/projects` via
   * `discoverNewestSessionId`.
   */
  discover?: (opts: DiscoverSessionOptions) => string | null;
}

/**
 * Resolve the session id for the READ path (`audit`,
 * `explain --trace/--last`).
 *
 * Precedence:
 *   1. explicit value (the `--session` flag)
 *   2. `$CLAUDE_CODE_SESSION_ID` env (the var Claude Code actually exports)
 *   3. `$CLAUDE_SESSION_ID` env (legacy fallback)
 *   4. newest Claude Code transcript (the live session)
 *   5. literal `"default"`
 *
 * The WRITE path keeps `resolveSessionId`: it always has
 * `event.session_id`, so it never reaches the discovery tier, and a
 * per-hook-event filesystem scan would be wasteful.
 */
export function resolveReadSessionId(
  explicit?: string,
  opts: ResolveReadSessionOptions = {},
): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const envCode = process.env.CLAUDE_CODE_SESSION_ID;
  if (typeof envCode === "string" && envCode.length > 0) return envCode;
  const env = process.env.CLAUDE_SESSION_ID;
  if (typeof env === "string" && env.length > 0) return env;
  const discover = opts.discover ?? discoverNewestSessionId;
  const discovered = discover({
    ...(opts.projectsRoot !== undefined && { projectsRoot: opts.projectsRoot }),
    ...(opts.homeDir !== undefined && { homeDir: opts.homeDir }),
  });
  if (typeof discovered === "string" && discovered.length > 0) return discovered;
  return FALLBACK;
}

// ---------------------------------------------------------------------------
// Shared session-id resolver for the `harness approve` verbs.
// ---------------------------------------------------------------------------
//
// All three approve verbs (understanding, risk, branch-protection) resolve
// the target session id through the same 5-tier precedence chain; only
// `approve understanding` adds a 6th tier (newest pending persisted report).
// This section lifts that chain into one place to remove the copy-paste.
//
// The callers retain their own error-throw blocks because the error messages
// are intentionally verb-specific (they name the gate hook, the approve
// subcommand, and the recovery steps that are relevant to that verb).

/** Session-id source for the `harness approve` verbs. */
export type ApprovalSessionSource =
  | "flag"
  | "env-claude-code"
  | "env-claude"
  | "env-codex"
  | "pending-approval"
  | "newest-report";

export interface ResolveApprovalSessionIdOptions {
  /** Explicit --session flag value. Empty string is treated as absent. */
  session?: string;
  /** Path to the harness.generated/ directory; used to read .pending-approval. */
  generatedDir: string;
  /**
   * Optional 6th-tier callback. When provided and reached, it is called
   * once and should return the session id plus the file path of the
   * freshest qualifying persisted report, or null when none qualifies.
   * Only `approve understanding` supplies this; `approve risk` and
   * `approve branch-protection` omit it (they produce no persisted reports).
   */
  newestReportFallback?: () => { sessionId: string; filePath: string } | null;
  /**
   * Test seam: override the .pending-approval reader. Defaults to
   * `readPendingApproval` from pending-approval.ts. Verb-level tests use
   * real tmp directories and do not need this; unit tests for the resolver
   * itself use it to avoid creating directories.
   */
  readPending?: (dir: string) => string | null;
}

export interface ResolveApprovalSessionIdResult {
  /**
   * The resolved session id, or an empty string when no tier matched.
   * Callers MUST check for the empty string and throw a verb-specific
   * error. The empty-string path is intentional: it lets callers produce
   * messages that name their own gate hook, approve subcommand, and
   * recovery steps without the resolver needing to know about them.
   */
  sessionId: string;
  /**
   * Where the session id came from. When `sessionId` is empty this field
   * is meaningless (callers throw before returning it to the operator).
   */
  sessionSource: ApprovalSessionSource;
  /**
   * Set only when `sessionSource === "newest-report"`. The absolute path
   * of the persisted report whose `sessionId` field was adopted. Surfaced
   * in the `approve understanding` CLI warning so the operator can verify
   * the report belongs to their live session.
   */
  newestReportPath?: string;
}

/**
 * Shared session-id resolver for the `harness approve` verbs.
 *
 * Precedence:
 *   1. explicit --session flag
 *   2. $CLAUDE_CODE_SESSION_ID (the var Claude Code exports into the agent shell)
 *   3. $CLAUDE_SESSION_ID (legacy / docs name; kept for older operator recipes)
 *   4. $CODEX_SESSION_ID (set inside a live Codex session)
 *   5. .pending-approval staging file (written by the gate hook or preflight)
 *   6. newestReportFallback() result -- only understanding.ts uses this tier
 *
 * Returns `{ sessionId: "" }` when no tier resolves. The caller is
 * responsible for throwing a verb-specific HarnessExitError in that case.
 */
export function resolveApprovalSessionId(
  opts: ResolveApprovalSessionIdOptions,
): ResolveApprovalSessionIdResult {
  const readPending = opts.readPending ?? readPendingApproval;

  if (typeof opts.session === "string" && opts.session.length > 0) {
    return { sessionId: opts.session, sessionSource: "flag" };
  }
  if (
    typeof process.env.CLAUDE_CODE_SESSION_ID === "string" &&
    process.env.CLAUDE_CODE_SESSION_ID.length > 0
  ) {
    return {
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
      sessionSource: "env-claude-code",
    };
  }
  if (
    typeof process.env.CLAUDE_SESSION_ID === "string" &&
    process.env.CLAUDE_SESSION_ID.length > 0
  ) {
    return { sessionId: process.env.CLAUDE_SESSION_ID, sessionSource: "env-claude" };
  }
  if (
    typeof process.env.CODEX_SESSION_ID === "string" &&
    process.env.CODEX_SESSION_ID.length > 0
  ) {
    return { sessionId: process.env.CODEX_SESSION_ID, sessionSource: "env-codex" };
  }

  const staged = readPending(opts.generatedDir);
  if (staged !== null) {
    return { sessionId: staged, sessionSource: "pending-approval" };
  }

  if (opts.newestReportFallback !== undefined) {
    const newest = opts.newestReportFallback();
    if (newest !== null) {
      return {
        sessionId: newest.sessionId,
        sessionSource: "newest-report",
        newestReportPath: newest.filePath,
      };
    }
  }

  // Nothing resolved. Callers check sessionId === "" and throw their own
  // verb-specific error messages.
  return { sessionId: "", sessionSource: "flag" };
}
