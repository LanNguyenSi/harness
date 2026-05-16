// `harness session-start branch-check` — SessionStart hook entrypoint
// for the `branch-protection` policy pack.
//
// Reads `.git/HEAD` for the cwd and, when the current branch is NOT in
// the operator's protected list, writes a `branch:non-protected:<branch>`
// fact to the evidence ledger so the pack's PreToolUse blocker has a
// fresh tag to satisfy its 5-minute freshness window.
//
// SessionStart contract: `blocking:false`. Every failure path (no git
// dir, manifest load fails, no grounding-mcp wired, ledger write
// fails) logs one line to stderr and exits 0. The only observable
// effect of a failure is that the blocker stays closed, which is the
// safe default: a session that can't prove it's NOT on a protected
// branch is treated as if it might be.
//
// Detached HEAD (`branch === ""`) is treated as PROTECTED: we can't
// audit-by-name what the agent might commit. The producer leaves the
// tag unwritten and stderr-notes the reason.
//
// Re-runnable on demand from the operator's `!` shell with no event
// JSON piped on stdin — same CLI verb, no SessionStart event needed.

import {
  addLedgerFact,
  resolveGitContext,
} from "../../runtime/index.js";
import {
  resolveReadSessionId,
  type ResolveReadSessionOptions,
} from "../../runtime/session-id.js";
import {
  isProtectedBranch,
  NON_PROTECTED_TAG_PREFIX,
  PACK_NAME,
  resolveProtectedBranches,
} from "../../policy-packs/builtin/branch-protection-runtime.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const FALLBACK_SESSION = "default";
const LEDGER_SOURCE = "harness-session-start-branch-check";

interface SessionStartEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

export interface SessionStartBranchCheckOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (SessionStart). */
  stderr?: NodeJS.WritableStream;
  /** Explicit session id (overrides every other source). */
  session?: string;
  /** Override the cwd resolution (test injection). Falls back to event.cwd then process.cwd(). */
  cwd?: string;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject the ledger writer (tests). */
  writeLedger?: (args: {
    sessionId: string;
    content: string;
    source: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** Inject the read-path session resolver (env + transcript discovery). Test seam. */
  resolveSession?: (explicit: string | undefined, opts: ResolveReadSessionOptions) => string;
  /** Inject a manifest (tests). Bypasses loadManifest. */
  manifest?: Manifest;
}

export interface SessionStartBranchCheckResult {
  /** Always 0 — SessionStart hooks must never break the session loop. */
  exitCode: number;
  /** Whether the `branch:non-protected` ledger fact was written. */
  wrote: boolean;
  /** Resolved branch name ("" when detached or outside a repo). */
  branch: string;
  /** True when the resolved branch matched the protected list. */
  protected: boolean;
  /** Resolved session id. */
  sessionId: string;
  sessionSource: "flag" | "stdin" | "env" | "transcript" | "default";
  /** Human-readable explanation of a non-write outcome (when applicable). */
  reason?: string;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

function mcpCommandList(server: McpServer): string[] {
  return Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
}

export async function runSessionStartBranchCheck(
  opts: SessionStartBranchCheckOptions = {},
): Promise<SessionStartBranchCheckResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const note = (msg: string): void => {
    stderr.write(`harness session-start branch-check: ${msg}\n`);
  };
  const done = (
    wrote: boolean,
    branch: string,
    isProtected: boolean,
    sessionId: string,
    sessionSource: SessionStartBranchCheckResult["sessionSource"],
    reason?: string,
  ): SessionStartBranchCheckResult => ({
    exitCode: 0,
    wrote,
    branch,
    protected: isProtected,
    sessionId,
    sessionSource,
    ...(reason !== undefined && { reason }),
  });

  let event: SessionStartEvent;
  try {
    event = JSON.parse((await readStdin(stdin)).trim() || "{}") as SessionStartEvent;
  } catch (err) {
    const reason = `malformed event JSON: ${(err as Error).message}`;
    note(reason);
    return done(false, "", false, FALLBACK_SESSION, "default", reason);
  }

  const cwd =
    typeof opts.cwd === "string" && opts.cwd.length > 0
      ? opts.cwd
      : typeof event.cwd === "string" && event.cwd.length > 0
        ? event.cwd
        : process.cwd();
  const { branch } = resolveGitContext(cwd);

  // Load manifest to resolve the pack's protected_branches override.
  // Fallback to defaults on any load failure (the producer's job is
  // best-effort; an unresolvable manifest still permits a sane gate).
  let manifest: Manifest | null = null;
  if (opts.manifest) {
    manifest = opts.manifest;
  } else {
    try {
      manifest = loadManifest(opts).manifest;
    } catch (err) {
      note(`manifest load failed: ${(err as Error).message}; falling back to default protected list`);
    }
  }
  const pack = manifest?.policy_packs.find((p) => p.name === PACK_NAME);
  const { branches: protectedList, warning: protectedWarning } = pack
    ? resolveProtectedBranches(pack)
    : { branches: [...["master", "main", "develop"]], warning: null };
  if (protectedWarning) note(protectedWarning);

  // Resolve session id with the same precedence chain as
  // session-start/preflight so the two producers stay symmetric.
  const explicit =
    typeof opts.session === "string" && opts.session.length > 0
      ? opts.session
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? event.session_id
        : undefined;
  const resolveSession = opts.resolveSession ?? resolveReadSessionId;
  const sessionId = resolveSession(explicit, {});
  const sessionSource: SessionStartBranchCheckResult["sessionSource"] =
    typeof opts.session === "string" && opts.session.length > 0
      ? "flag"
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? "stdin"
        : sessionId === FALLBACK_SESSION
          ? "default"
          : typeof process.env.CLAUDE_SESSION_ID === "string" &&
              process.env.CLAUDE_SESSION_ID === sessionId
            ? "env"
            : "transcript";

  if (branch === "") {
    const reason = `cwd is not on a named branch (detached HEAD or outside a git work tree); leaving the gate closed (treated as protected)`;
    note(reason);
    return done(false, "", true, sessionId, sessionSource, reason);
  }

  const isProtected = isProtectedBranch(branch, protectedList);
  if (isProtected) {
    const reason = `branch "${branch}" is in the protected list (${protectedList.join(", ")}); leaving the gate closed`;
    note(reason);
    return done(false, branch, true, sessionId, sessionSource, reason);
  }

  // Branch is non-protected: write the tag.
  const content = `${NON_PROTECTED_TAG_PREFIX}:${branch}`;

  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    if (!manifest) {
      const reason = `manifest unavailable; cannot record ${content}`;
      note(reason);
      return done(false, branch, false, sessionId, sessionSource, reason);
    }
    const server = findGroundingMcp(manifest);
    if (!server) {
      const reason = `grounding-mcp not declared in manifest; cannot record ${content}`;
      note(reason);
      return done(false, branch, false, sessionId, sessionSource, reason);
    }
    const command = mcpCommandList(server);
    const env = server.env ?? undefined;
    const timeoutMs = opts.ledgerTimeoutMs ?? server.health?.timeout_ms ?? 5_000;
    writeLedger = (args) =>
      addLedgerFact({
        mcpCommand: command,
        ...(env && { mcpEnv: env }),
        timeoutMs,
        ...args,
      });
  }

  const result = await writeLedger({ sessionId, content, source: LEDGER_SOURCE });
  if (!result.ok) {
    const reason = `ledger write failed: ${result.reason ?? "unknown error"}`;
    note(reason);
    return done(false, branch, false, sessionId, sessionSource, reason);
  }
  note(`recorded ${content} for session ${sessionId}`);
  if (sessionSource === "default") {
    note(
      "WARNING: session resolved to the literal \"default\". The blocker queries the real Claude Code session id and will NOT see this tag. Pipe SessionStart event JSON on stdin, export $CLAUDE_SESSION_ID, or pass --session <id>.",
    );
  }
  return done(true, branch, false, sessionId, sessionSource);
}
