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
import {
  addLedgerFact,
  resolveGitContext,
  resolveSessionId,
} from "../../runtime/index.js";
import type { Manifest, McpServer } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const PREFLIGHT_BIN = "preflight";
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 25_000;
const LEDGER_SOURCE = "harness-session-start-preflight";

interface SessionStartEvent {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

/** The slice of `preflight run --json` output this producer reads. */
export interface PreflightJson {
  ready?: boolean;
  confidence?: number;
  checks?: Array<{ name?: string; status?: string; message?: string }>;
}

export type RunPreflightResult =
  | { ok: true; json: PreflightJson }
  | { ok: false; reason: string };

export interface SessionStartPreflightOptions extends LoaderOptions {
  /** Defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Defaults to process.stderr. stdout is never written (SessionStart). */
  stderr?: NodeJS.WritableStream;
  /** `preflight` subprocess timeout in ms. */
  preflightTimeoutMs?: number;
  /** Per-call ledger timeout in ms. */
  ledgerTimeoutMs?: number;
  /** Inject the preflight runner (tests). */
  runPreflight?: (cwd: string, timeoutMs: number) => Promise<RunPreflightResult>;
  /** Inject the ledger writer (tests). */
  writeLedger?: (args: {
    sessionId: string;
    content: string;
    source: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
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

function findGroundingMcp(manifest: Manifest): McpServer | null {
  return manifest.tools.mcp.find((m) => m.name === "grounding-mcp") ?? null;
}

function mcpCommandList(server: McpServer): string[] {
  return Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
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
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
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

function describeNotReady(json: PreflightJson): string {
  const failing = (json.checks ?? [])
    .filter((c) => c.status === "fail" || c.status === "error")
    .map((c) => c.name ?? "(unnamed)");
  const confidence =
    typeof json.confidence === "number" ? json.confidence.toFixed(2) : "?";
  const failSuffix = failing.length > 0 ? `; failing: ${failing.join(", ")}` : "";
  return `preflight not ready (confidence ${confidence})${failSuffix}`;
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
    reason?: string,
  ): SessionStartPreflightResult => ({
    exitCode: 0,
    wrote,
    repo,
    branch,
    ...(reason !== undefined && { reason }),
  });

  let event: SessionStartEvent;
  try {
    event = JSON.parse((await readStdin(stdin)).trim() || "{}") as SessionStartEvent;
  } catch (err) {
    const reason = `malformed event JSON: ${(err as Error).message}`;
    note(reason);
    return done(false, "", "", reason);
  }

  const cwd = typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd : process.cwd();
  const { repo, branch } = resolveGitContext(cwd);
  if (repo === "") {
    const reason = `cwd is not inside a git work tree (${cwd}); nothing to preflight`;
    note(reason);
    return done(false, "", "", reason);
  }
  const sessionId = resolveSessionId(
    typeof event.session_id === "string" ? event.session_id : undefined,
  );

  const runPreflight = opts.runPreflight ?? spawnPreflight;
  const preflight = await runPreflight(cwd, preflightTimeoutMs);
  if (!preflight.ok) {
    note(preflight.reason);
    return done(false, repo, branch, preflight.reason);
  }
  if (preflight.json.ready !== true) {
    const reason = describeNotReady(preflight.json);
    note(`${reason} — leaving the preflight tag unwritten so the gate stays closed`);
    return done(false, repo, branch, reason);
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
  const tags = branch.length > 0 ? `preflight:${repo} preflight:${branch}` : `preflight:${repo}`;
  const content = `${tags} ready:true confidence:${confidence}`;

  let writeLedger = opts.writeLedger;
  if (!writeLedger) {
    let manifest: Manifest;
    try {
      manifest = loadManifest(opts).manifest;
    } catch (err) {
      const reason = `manifest load failed: ${(err as Error).message}`;
      note(reason);
      return done(false, repo, branch, reason);
    }
    const server = findGroundingMcp(manifest);
    if (!server) {
      const reason = "grounding-mcp not declared in manifest; cannot record preflight tag";
      note(reason);
      return done(false, repo, branch, reason);
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
    return done(false, repo, branch, reason);
  }
  note(`recorded ${content} for session ${sessionId}`);
  return done(true, repo, branch);
}
