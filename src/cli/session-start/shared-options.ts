// Shared plumbing for the `harness session-start` producers
// (preflight, toolchain-parity, stale-base-check) and the
// top-level `preflight` alias: the SessionStart event type, the stdin
// read, the cwd and session-source resolution, the options every
// producer takes, and the commander options every subcommand declares.
//
// Pure extraction: each producer used to carry its own copy of these
// pieces, and every copy behaved the same. Nothing here changes what a
// producer reads, writes or prints.

import type { Command } from "commander";
import type { ResolveReadSessionOptions } from "../../runtime/session-id.js";
import type { Manifest } from "../../schema/index.js";
import { readStdinBounded, STDIN_IDLE_TIMEOUT_MS, stdinTimeoutNote } from "../bounded-stdin.js";
import type { LoaderOptions } from "../loader.js";

/** The literal session id every producer falls back to when none is known. */
export const FALLBACK_SESSION = "default";

/** Which tier of the session-id resolution chain produced the id. */
export type SessionSource = "flag" | "stdin" | "env" | "transcript" | "default";

/** The slice of the SessionStart hook event JSON the producers read. */
export interface SessionStartEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

/** The ledger-writer seam every producer exposes to tests. */
export type SessionStartLedgerWriter = (args: {
  sessionId: string;
  content: string;
  source: string;
}) => Promise<{ ok: boolean; reason?: string }>;

/** Options every session-start producer takes. */
export interface SessionStartCommonOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (SessionStart). */
  stderr?: NodeJS.WritableStream;
  /** Explicit session id (overrides every other source). */
  session?: string;
  /**
   * Idle bound, in ms, for the stdin read (default STDIN_IDLE_TIMEOUT_MS).
   * Tests inject a short value.
   */
  stdinIdleTimeoutMs?: number;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject the ledger writer (tests). */
  writeLedger?: SessionStartLedgerWriter;
  /** Inject the read-path session resolver (env + transcript discovery). Test seam. */
  resolveSession?: (explicit: string | undefined, opts: ResolveReadSessionOptions) => string;
  /** Inject a manifest (tests). Bypasses loadManifest. */
  manifest?: Manifest;
}

/** Common options plus the `--cwd` override, for the producers that take one. */
export interface SessionStartCwdOptions extends SessionStartCommonOptions {
  /** Override the cwd resolution (test injection). Falls back to event.cwd then process.cwd(). */
  cwd?: string;
}

/** Parse the text of a SessionStart event (empty text is an empty event). */
export function parseSessionStartEvent(text: string): SessionStartEvent {
  return JSON.parse(text.trim() || "{}") as SessionStartEvent;
}

/**
 * Read and parse the SessionStart event JSON from a stream. The read is
 * idle-bounded (see bounded-stdin.ts): when stdin never closes, the text read
 * so far is parsed (empty text is an empty event) and `onTimeout` receives the
 * stderr note the producer logs.
 */
export async function readSessionStartEvent(
  stream: NodeJS.ReadableStream,
  opts: { idleTimeoutMs?: number; onTimeout?: (note: string) => void } = {},
): Promise<SessionStartEvent> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? STDIN_IDLE_TIMEOUT_MS;
  const read = await readStdinBounded(stream, idleTimeoutMs);
  if (read.timedOut) opts.onTimeout?.(stdinTimeoutNote(read, idleTimeoutMs));
  return parseSessionStartEvent(read.text);
}

/** The reason line a producer logs when the event JSON does not parse. */
export function malformedEventReason(err: unknown): string {
  return `malformed event JSON: ${(err as Error).message}`;
}

/** `--cwd` first, then the event's cwd, then the process cwd. */
export function resolveEventCwd(optCwd: unknown, event: SessionStartEvent): string {
  return typeof optCwd === "string" && optCwd.length > 0
    ? optCwd
    : typeof event.cwd === "string" && event.cwd.length > 0
      ? event.cwd
      : process.cwd();
}

/** The session id handed to the resolver: the flag, else the event's, else none. */
export function explicitSessionId(
  optSession: unknown,
  event: SessionStartEvent,
): string | undefined {
  return typeof optSession === "string" && optSession.length > 0
    ? optSession
    : typeof event.session_id === "string" && event.session_id.length > 0
      ? event.session_id
      : undefined;
}

/**
 * Classify where a resolved session id came from: the flag, the stdin
 * event, an env var, a discovered transcript, or the literal default.
 * `resolverThrew` forces "default" (the id recorded is the fallback even
 * when the flag or event carried one).
 */
export function classifySessionSource(
  optSession: unknown,
  event: SessionStartEvent,
  sessionId: string,
  resolverThrew = false,
): SessionSource {
  return resolverThrew
    ? "default"
    : typeof optSession === "string" && optSession.length > 0
      ? "flag"
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? "stdin"
        : sessionId === FALLBACK_SESSION
          ? "default"
          : (typeof process.env.CLAUDE_CODE_SESSION_ID === "string" &&
              process.env.CLAUDE_CODE_SESSION_ID === sessionId) ||
              (typeof process.env.CLAUDE_SESSION_ID === "string" &&
                process.env.CLAUDE_SESSION_ID === sessionId)
            ? "env"
            : "transcript";
}

// ---------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------

/** The option bag commander hands the action of a session-start subcommand. */
export interface SessionStartCliOptions {
  config?: string;
  project?: string;
  session?: string;
  cwd?: string;
  ledgerTimeout?: string;
}

/** `--config` and `--project`, then `--session` with the caller's description. */
export function addIdentityOptions(cmd: Command, sessionDescription: string): Command {
  return cmd
    .option(
      "--config <path>",
      "manifest path (default: ~/.harness/harness.yaml; legacy fallback ~/.claude/harness.yaml)",
    )
    .option("--project <name>", "apply per-project overrides")
    .option("--session <id>", sessionDescription);
}

/** `--cwd`. */
export function addCwdOption(cmd: Command): Command {
  return cmd.option(
    "--cwd <path>",
    "override cwd resolution (default: stdin event.cwd then process.cwd())",
  );
}

/** `--ledger-timeout`. */
export function addLedgerTimeoutOption(cmd: Command): Command {
  return cmd.option("--ledger-timeout <ms>", "per-call ledger timeout in milliseconds");
}

/** The `run*` options a parsed CLI option bag fills in. */
export interface SessionStartCliTarget {
  configPath?: string;
  project?: string;
  session?: string;
  cwd?: string;
  ledgerTimeoutMs?: number;
}

/**
 * Copy the shared CLI options into a producer's options. A value that is
 * absent is left unset; a `--ledger-timeout` that is not a positive
 * integer is ignored (the producer's default timeout applies).
 */
export function applyCliOptions(options: SessionStartCliOptions, target: SessionStartCliTarget): void {
  if (options.config) target.configPath = options.config;
  if (options.project) target.project = options.project;
  if (options.session) target.session = options.session;
  if (options.cwd) target.cwd = options.cwd;
  if (options.ledgerTimeout) {
    const n = Number.parseInt(options.ledgerTimeout, 10);
    if (Number.isFinite(n) && n > 0) target.ledgerTimeoutMs = n;
  }
}
