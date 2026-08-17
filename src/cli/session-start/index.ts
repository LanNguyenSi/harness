// `harness session-start preflight` — SessionStart hook entrypoint.
//
// Wired by the Full template's `git-preflight` SessionStart hook. Reads
// the SessionStart event JSON from stdin, runs `agent-preflight`
// (`preflight run --json <cwd>`), and on a `ready:true` result writes a
// `preflight:${REPO}` fact to the evidence ledger so the
// `preflight-before-investigation` / `preflight-before-push` policies
// have a fresh tag to match within their `within` windows.
//
// SessionStart hooks are `blocking:false`: this command MUST NOT break
// the session loop. Every failure path — `preflight` not on PATH, a
// timeout, a non-`ready` result, an unreachable ledger — logs one line
// to stderr and exits 0. The only observable effect of a failure is
// that the preflight policies stay closed (which is the safe default).
//
// `ready:false` deliberately does NOT write the tag: the policy intent
// is "block investigative git reads until agent-preflight ran cleanly",
// so a failing preflight must leave the gate shut, not satisfy it.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveGitContext,
} from "../../runtime/index.js";
import { resolveManifestLedgerWriter } from "../../runtime/ledger-writer.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import {
  resolveReadSessionId,
  type ResolveReadSessionOptions,
} from "../../runtime/session-id.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, resolvePaths, type LoaderOptions } from "../loader.js";

const FALLBACK_SESSION = "default";

const PREFLIGHT_BIN = "preflight";
// Default upper bound on `preflight run --json <cwd>` for the
// SessionStart producer. Was 25s through v0.17.4; bumped to 60s after
// the agent-grounding dogfood (agent-tasks/7265599e) where a healthy
// preflight took ~28s, just past the old ceiling. The wrapper still
// kills runaway invocations; this only widens the window for honest
// medium-size repos. Operators with even larger preflights can still
// override per-call via `harness preflight --timeout <ms>`.
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60_000;
const LEDGER_SOURCE = "harness-session-start-preflight";

// Not-ready diagnostic log: the raw `preflight run --json` payload is
// persisted so an operator (or a follow-up session) can see the FULL
// check output, not just the capped first-N detail lines this producer
// surfaces on stderr. `keep-last-20` rotation bounds the directory —
// it is shared across every repo the operator preflights from this
// host, so unbounded growth would be a slow disk leak.
const FAIL_LOG_KEEP_LAST = 20;
const FAIL_LOG_PREFIX = "preflight-";

interface SessionStartEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

/** The slice of `preflight run --json` output this producer reads. */
export interface PreflightJson {
  ready?: boolean;
  confidence?: number;
  checks?: Array<{
    name?: string;
    status?: string;
    message?: string;
    details?: string[];
  }>;
}

export type RunPreflightResult =
  | { ok: true; json: PreflightJson }
  | { ok: false; reason: string };

export interface SessionStartPreflightOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (SessionStart). */
  stderr?: NodeJS.WritableStream;
  /**
   * Explicit session id (overrides every other source). Wired to the
   * `--session <id>` CLI flag for manual / scripted invocations where
   * no SessionStart event JSON is being piped on stdin.
   */
  session?: string;
  /** `preflight` subprocess timeout in ms. */
  preflightTimeoutMs?: number;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject the preflight runner (tests). */
  runPreflight?: (cwd: string, timeoutMs: number) => Promise<RunPreflightResult>;
  /**
   * Directory the not-ready diagnostic JSON is persisted to (task
   * T-001). Test seam — production defaults to `<home>/logs`, resolved
   * via `resolvePaths()` (task 80f49922), which throws unless `homeDir`
   * or `configPath` is also injected (loader.ts:45-64). Always pass a
   * tmp dir in tests so nothing ever touches the operator's real
   * `~/.harness/logs/` (or the legacy `~/.claude/logs/`).
   */
  logDir?: string;
  /** Inject the ledger writer (tests). */
  writeLedger?: (args: {
    sessionId: string;
    content: string;
    source: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Inject the read-path session resolver (env + transcript discovery).
   * Test seam — production uses `resolveReadSessionId` from
   * `runtime/session-id` so we get the same precedence chain as
   * `harness audit` and `harness explain --trace`.
   */
  resolveSession?: (explicit: string | undefined, opts: ResolveReadSessionOptions) => string;
  /**
   * Inject the `.pending-approval` writer. Opt-in: staging only happens
   * when the caller explicitly passes a writer. The CLI entry points
   * (`harness preflight` and `harness session-start preflight`) wire
   * `writePendingApproval` from `runtime/pending-approval`, so operators
   * get the bootstrap fix; library callers that import this function
   * directly do not pollute the real `~/.claude/harness.generated/`
   * unless they opt in. Hotfix for v0.21.0 which defaulted to ON and
   * caused vitest runs to clobber the operator's pending-approval file
   * via the `npm-test` preflight check (agent-tasks/<this hotfix>).
   * Pass `null` to make the opt-out explicit; `undefined` (the default)
   * is the same no-op.
   */
  stagePendingApproval?:
    | ((generatedDir: string, sessionId: string) => void)
    | null;
}

export interface SessionStartPreflightResult {
  /** Always 0 — a SessionStart hook must never break the session loop. */
  exitCode: number;
  /** Whether the `preflight:` ledger fact was written. */
  wrote: boolean;
  /** Resolved repo name (the `${REPO}` a tag is namespaced by). */
  repo: string;
  /** Resolved branch (the `${BRANCH}` a tag is namespaced by; "" if detached). */
  branch: string;
  /**
   * Which tier the session id came from. Surfaced so the CLI can
   * loud-warn when the resolved id is the literal `"default"` (a tag
   * recorded under that id will not satisfy any `preflight-before-*`
   * gate, which queries by the real Claude Code session id).
   */
  sessionSource: "flag" | "stdin" | "env" | "transcript" | "default";
  /** Resolved session id. */
  sessionId: string;
  /** Human-readable explanation of a non-write outcome, for diagnostics. */
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

/**
 * Environment for the spawned `preflight` child: the parent env minus
 * HARNESS_ALLOW_REAL_GENERATED_DIR. The launcher sets that flag so the
 * real harness binary may fall back to the operator's home dir, but the
 * preflight child runs the repo's own test suite (its `npm-test` check),
 * and an inherited flag re-enables the implicit real-homedir fallback
 * INSIDE those test processes. With non-empty operator state (e.g. a
 * `harness pause` sentinel) that broke 110 tests and surfaced as a false
 * `failing: npm-test`, keeping the preflight gate shut. Third incident
 * of the operator-state-isolation class PR #199 pinned; the flag must
 * stay scoped to the process the operator actually invoked.
 */
export function preflightChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  delete env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  return env;
}

/**
 * Default `preflight` runner: spawn `preflight run --json <cwd>` and
 * parse its stdout. Resolves `{ ok: false }` (never throws) for the
 * not-installed / timeout / unparseable cases so the caller can degrade.
 */
function spawnPreflight(cwd: string, timeoutMs: number): Promise<RunPreflightResult> {
  return new Promise((resolve) => {
    execFile(
      PREFLIGHT_BIN,
      ["run", "--json", cwd],
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: preflightChildEnv(),
      },
      (err, stdout) => {
        // `preflight` may exit non-zero on a not-ready result while still
        // emitting valid JSON, so a parseable stdout wins over the exit
        // code. Only a missing binary / timeout / unparseable output is a
        // genuine "could not run".
        const text = (stdout ?? "").trim();
        if (text.length > 0) {
          try {
            return resolve({ ok: true, json: JSON.parse(text) as PreflightJson });
          } catch {
            /* fall through to the error path */
          }
        }
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") {
            return resolve({
              ok: false,
              reason: `\`${PREFLIGHT_BIN}\` not on PATH (npm i -g @lannguyensi/agent-preflight)`,
            });
          }
          // maxBuffer overflow also sets `killed:true`; check it first so
          // an over-budget output is not mis-reported as a timeout.
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            return resolve({
              ok: false,
              reason: `\`${PREFLIGHT_BIN} run --json\` output exceeded the read buffer`,
            });
          }
          if (e.killed) {
            return resolve({
              ok: false,
              reason: `\`${PREFLIGHT_BIN} run\` timed out after ${timeoutMs}ms`,
            });
          }
          return resolve({ ok: false, reason: `\`${PREFLIGHT_BIN} run\` failed: ${e.message}` });
        }
        return resolve({
          ok: false,
          reason: `\`${PREFLIGHT_BIN} run --json\` produced no parseable JSON`,
        });
      },
    );
  });
}

// Up to this many valid detail lines are surfaced per failing check.
// Was 1 (the check's first detail line only) through v0.2x; a bare
// check name plus a single truncated line once cost a long false-
// negative diagnosis because the actual FAIL line (test name) sat
// past the first line the producer looked at. Task T-001.
const MAX_DETAIL_LINES_PER_CHECK = 3;
const DETAIL_LINE_CHAR_CAP = 140;

function capDetailLine(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > DETAIL_LINE_CHAR_CAP
    ? `${trimmed.slice(0, DETAIL_LINE_CHAR_CAP - 1)}…`
    : trimmed;
}

function describeNotReady(json: PreflightJson, logPath?: string): string {
  const failing = (json.checks ?? [])
    .filter((c) => c.status === "fail" || c.status === "error")
    .map((c) => {
      const name = c.name ?? "(unnamed)";
      // Surface up to MAX_DETAIL_LINES_PER_CHECK of the check's own detail
      // lines: a bare check name ("failing: npm-test") once cost a long
      // false-negative diagnosis because the actual reason never left the
      // child JSON. The typeof guards matter: this is untrusted subprocess
      // JSON behind a cast, and a SessionStart producer must never throw
      // (blocking:false, exit-0 contract above), so a malformed element is
      // filtered out instead of crashing; a check with no valid detail
      // line at all degrades to its bare name.
      const validDetails = Array.isArray(c.details)
        ? c.details.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        : [];
      const lines =
        validDetails.length > 0
          ? validDetails.slice(0, MAX_DETAIL_LINES_PER_CHECK)
          : typeof c.message === "string" && c.message.trim().length > 0
            ? [c.message]
            : [];
      if (lines.length === 0) return name;
      const capped = lines.map(capDetailLine).join(" | ");
      return `${name} (${capped})`;
    });
  const confidence =
    typeof json.confidence === "number" ? json.confidence.toFixed(2) : "?";
  const failSuffix = failing.length > 0 ? `; failing: ${failing.join(", ")}` : "";
  const logSuffix = logPath ? `; log: ${logPath}` : "";
  return `preflight not ready (confidence ${confidence})${failSuffix}${logSuffix}`;
}

/**
 * Default not-ready log directory: `<home>/logs` (task T-001). Routed
 * through `resolvePaths()` — the same idiom `defaultReportsDir`'s caller
 * uses in approve/understanding.ts — instead of hardcoding
 * `path.join(os.homedir(), ".harness", "logs")` directly (task 80f49922,
 * reviewer finding on a48b9729). Two effects: (1) this now respects the
 * real home-dir precedence chain ($HARNESS_HOME, then `~/.harness/`,
 * then the legacy `~/.claude/` fallback) instead of silently diverging
 * from the rest of the harness state (regression from 31fbf856); (2) it
 * inherits the throw-on-real-home-dir guard in `resolvePaths()`
 * (loader.ts:45-64), which previously protected this seam only via a
 * suite-local `vi.mock("node:os")` pin in preflight.test.ts — a caller
 * that forgot to inject `logDir` from any OTHER test or child process
 * would still silently write into the operator's real home dir.
 * Evaluated lazily from the `opts.logDir ?? defaultFailLogDir(opts)`
 * call site, so injecting `logDir` alone still bypasses the guard.
 */
function defaultFailLogDir(opts: LoaderOptions): string {
  return path.join(path.dirname(resolvePaths(opts).base), "logs");
}

/** Repo names land in a filename; strip anything not filename-safe. */
function sanitizeForFilename(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return cleaned.length > 0 ? cleaned : "repo";
}

/**
 * Rotate `logDir` down to the `FAIL_LOG_KEEP_LAST` most recently modified
 * `preflight-*.json` files, oldest first. Best-effort: any single stat/
 * unlink failure is swallowed so one unreadable entry cannot block
 * rotation of the rest. The directory is shared across every repo the
 * operator preflights from this host, so filename order is not a
 * reliable time proxy — mtime is.
 */
function rotateFailLogDir(logDir: string): void {
  const names = fs
    .readdirSync(logDir)
    .filter((name) => name.startsWith(FAIL_LOG_PREFIX) && name.endsWith(".json"));
  if (names.length <= FAIL_LOG_KEEP_LAST) return;
  const withMtime = names
    .map((name) => {
      const full = path.join(logDir, name);
      try {
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { full: string; mtimeMs: number } => e !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = withMtime.length - FAIL_LOG_KEEP_LAST;
  for (let i = 0; i < excess; i++) {
    const entry = withMtime[i];
    if (!entry) continue;
    try {
      fs.unlinkSync(entry.full);
    } catch {
      /* best-effort rotation; a stray leftover file is not fatal */
    }
  }
}

/**
 * Persist the not-ready `preflight run --json` payload (pretty-printed)
 * to `<logDir>/preflight-<repo>-<timestamp>-<hex4>.json`, then rotate the
 * directory. The 4-hex suffix disambiguates writes that land in the same
 * millisecond (the ISO timestamp's resolution), where the second write
 * would otherwise silently overwrite the first. Never throws: a write or
 * rotation failure degrades to `{ ok: false, reason }` so the caller can
 * note() and keep going — the SessionStart producer must exit 0 on every
 * path.
 */
function persistFailLog(
  json: PreflightJson,
  repo: string,
  logDir: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  let filePath: string;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const unique = randomBytes(2).toString("hex");
    // Cap the sanitized basename so a very long repo/worktree name can't blow past filesystem name-length limits.
    filePath = path.join(
      logDir,
      `${FAIL_LOG_PREFIX}${sanitizeForFilename(repo).slice(0, 100)}-${timestamp}-${unique}.json`,
    );
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  try {
    rotateFailLogDir(logDir);
  } catch {
    /* rotation failure must not undo an already-successful log write */
  }
  return { ok: true, path: filePath };
}

export async function runSessionStartPreflight(
  opts: SessionStartPreflightOptions = {},
): Promise<SessionStartPreflightResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const preflightTimeoutMs = opts.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const note = (msg: string): void => {
    stderr.write(`harness session-start preflight: ${msg}\n`);
  };
  const done = (
    wrote: boolean,
    repo: string,
    branch: string,
    sessionId: string,
    sessionSource: SessionStartPreflightResult["sessionSource"],
    reason?: string,
  ): SessionStartPreflightResult => ({
    exitCode: 0,
    wrote,
    repo,
    branch,
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
    return done(false, "", "", FALLBACK_SESSION, "default", reason);
  }

  const cwd = typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd : process.cwd();
  const { repo, branch, sha } = resolveGitContext(cwd);
  if (repo === "") {
    const reason = `cwd is not inside a git work tree (${cwd}); nothing to preflight`;
    note(reason);
    return done(false, "", "", FALLBACK_SESSION, "default", reason);
  }

  // Session-id resolution chain. The hook-driven path (Claude Code feeds
  // SessionStart event JSON on stdin) lands at tier "stdin" and is the
  // common case. Manual invocations from an operator's `!`-shell — where
  // there is no event JSON — fall back through env, then transcript
  // discovery (same heuristic `harness audit` / `harness explain --trace`
  // use), and only as a last resort to the literal `"default"`. Tags
  // recorded under `"default"` will never satisfy a `preflight-before-*`
  // gate, so we loud-warn rather than letting the success line read as
  // if the producer worked.
  const explicit =
    typeof opts.session === "string" && opts.session.length > 0
      ? opts.session
      : typeof event.session_id === "string" && event.session_id.length > 0
        ? event.session_id
        : undefined;
  const resolveSession = opts.resolveSession ?? resolveReadSessionId;
  const sessionId = resolveSession(explicit, {});
  const sessionSource: SessionStartPreflightResult["sessionSource"] =
    typeof opts.session === "string" && opts.session.length > 0
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

  // Stage `.pending-approval` as soon as we resolve a real session id so
  // `harness approve understanding` (no flags) works from the operator's
  // `!`-shell without needing a prior PreToolUse gate-block. Producer
  // hand-off matches the PreToolUse hook's existing one (same writer,
  // same path, same single-line content). Skipped when the session id
  // is the literal "default", since pointing approve at "default" would
  // never satisfy any task-scoped gate. Best-effort: a write failure
  // must NOT break the session loop, so any error is silently swallowed
  // (the operator can always fall back to `--session <id>` as before).
  // Multi-session caveat: two parallel Claude sessions on the same host
  // will clobber each other's `.pending-approval` (single-slot file).
  // Acceptable for the one-Claude-per-repo operator pattern; the worst
  // case is approve resolving to the wrong session id, which the operator
  // catches via the canonical-gate-signal line in the approve output.
  // OPT-IN: only fires when the caller explicitly passes a writer. The
  // CLI entry points wire `writePendingApproval`; library callers (and
  // every existing vitest case) get the no-op default, so the producer
  // never pollutes the real `~/.claude/harness.generated/` from a test.
  // Hotfix for v0.21.0 which defaulted to ON and caused the npm-test
  // preflight check to clobber the operator's pending-approval file.
  if (
    sessionSource !== "default" &&
    typeof opts.stagePendingApproval === "function"
  ) {
    try {
      const generatedDir = resolveGeneratedDir({
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
        manifestPath: resolvePaths(opts).base,
      });
      opts.stagePendingApproval(generatedDir, sessionId);
    } catch {
      /* best-effort, never escalate into a hook error */
    }
  }

  const runPreflight = opts.runPreflight ?? spawnPreflight;
  const preflight = await runPreflight(cwd, preflightTimeoutMs);
  if (!preflight.ok) {
    note(preflight.reason);
    return done(false, repo, branch, sessionId, sessionSource, preflight.reason);
  }
  if (preflight.json.ready !== true) {
    // defaultFailLogDir() now routes through resolvePaths(), which throws
    // when neither homeDir nor configPath is injected and the real binary
    // has not set HARNESS_ALLOW_REAL_GENERATED_DIR=1 (loader.ts:45-64,
    // task 80f49922). Fold that into the same { ok: false, reason } shape
    // persistFailLog already returns for a write failure — this producer
    // must degrade, never throw (see file header).
    let persisted: { ok: true; path: string } | { ok: false; reason: string };
    try {
      const logDir = opts.logDir ?? defaultFailLogDir(opts);
      persisted = persistFailLog(preflight.json, repo, logDir);
    } catch (err) {
      persisted = { ok: false, reason: (err as Error).message };
    }
    if (!persisted.ok) {
      note(`preflight fail-log write failed: ${persisted.reason}`);
    }
    const reason = describeNotReady(preflight.json, persisted.ok ? persisted.path : undefined);
    note(`${reason} — leaving the preflight tag unwritten so the gate stays closed`);
    return done(false, repo, branch, sessionId, sessionSource, reason);
  }

  const confidence =
    typeof preflight.json.confidence === "number"
      ? preflight.json.confidence.toFixed(2)
      : "?";
  // Emit BOTH per-repo and per-branch tags in one fact: the requires
  // evaluator substring-matches, so a single entry containing
  // `preflight:${REPO}` and `preflight:${BRANCH}` satisfies both
  // `preflight-before-investigation` (REPO, within 1h) and
  // `preflight-before-push` (BRANCH, within 10m). Caveat: a SessionStart
  // producer cannot keep the 10m push window fresh through a long
  // session — a push-time refresh is a separate concern (see task notes).
  // On a detached HEAD `branch` is "" — only the REPO tag is written.
  // `head:<sha>` is appended when resolveGitContext returned a sha (loose
  // ref read or packed-refs fallback succeeded, or detached HEAD held a
  // raw sha). The at_head requires-flag relies on this token to satisfy
  // the gate at the recorded HEAD regardless of `within`; consumers that
  // ignore the flag continue to work because the token is ignored by
  // substring-match logic.
  const tags = branch.length > 0 ? `preflight:${repo} preflight:${branch}` : `preflight:${repo}`;
  const headSuffix = sha.length > 0 ? ` head:${sha}` : "";
  const content = `${tags} ready:true confidence:${confidence}${headSuffix}`;

  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    let manifest: Manifest;
    try {
      manifest = loadManifest(opts).manifest;
    } catch (err) {
      const reason = `manifest load failed: ${(err as Error).message}`;
      note(reason);
      return done(false, repo, branch, sessionId, sessionSource, reason);
    }
    const resolved = resolveManifestLedgerWriter(manifest, {
      ...(opts.ledgerTimeoutMs !== undefined ? { ledgerTimeoutMs: opts.ledgerTimeoutMs } : {}),
    });
    if (!resolved.ok) {
      const reason = `${resolved.reason}; cannot record preflight tag`;
      note(reason);
      return done(false, repo, branch, sessionId, sessionSource, reason);
    }
    writeLedger = resolved.write;
  }

  const result = await writeLedger({ sessionId, content, source: LEDGER_SOURCE });
  if (!result.ok) {
    const reason = `ledger write failed: ${result.reason ?? "unknown error"}`;
    note(reason);
    return done(false, repo, branch, sessionId, sessionSource, reason);
  }
  note(`recorded ${content} for session ${sessionId}`);
  if (sessionSource === "default") {
    // Loud-warn: the tag landed under the literal "default" session, which
    // no `preflight-before-*` policy ever queries. The recorded line above
    // can read as success; this second line is the actionable corrective.
    note(
      "WARNING: session resolved to the literal \"default\". preflight-before-* gates query " +
        "the real Claude Code session id and will NOT see this tag. Pipe SessionStart event JSON " +
        "on stdin, export $CLAUDE_SESSION_ID, or pass --session <id> for manual / scripted use.",
    );
  }
  return done(true, repo, branch, sessionId, sessionSource);
}
