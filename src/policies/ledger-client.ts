// Phase 4 #3 — grounding-mcp client adapter.
//
// Spawns the configured grounding-mcp server, performs the standard
// init / notifications/initialized / tools/call handshake, and returns
// ledger entries normalised to harness's LedgerEntry shape (see
// src/policies/requires.ts). Any failure path resolves to
// `{ kind: "degraded", reason }` — this TRANSPORT layer never decides
// what degradation means. The policy evaluator routes a degraded result
// through `degradedOutcome` (src/runtime/intercept.ts, task f1aea826):
// `warn` policies degrade to the non-blocking `warn-degraded`,
// `block`/`require_approval` policies fail CLOSED as `deny-degraded`.
// (The original Phase 4 acceptance — unreachable ledger defaults to
// warn-equivalent for every tier — is superseded; see the note in
// docs/ROADMAP.md and docs/okf/gate-fail-posture-matrix.md.)

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LedgerEntry } from "./requires.js";
import { expandHome, expandHomeInEnv } from "../io/expand-home.js";
import { POLICY_DECISION_TYPE } from "../io/ledger-record.js";
import { VERSION } from "../version.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface LedgerClientOptions {
  /** argv[0..]: the grounding-mcp binary + flags. e.g. `["node", "/path/to/grounding-mcp/dist/server.js"]`. */
  mcpCommand: string[];
  /** Extra env merged onto process.env. */
  mcpEnv?: Record<string, string>;
  /** Working dir for the spawned server. */
  cwd?: string;
  /** Per-call timeout. Default 5 000 ms. */
  timeoutMs?: number;
}

export interface QueryLedgerOptions extends LedgerClientOptions {
  /** Required: grounding session whose entries should be returned. */
  sessionId: string;
  /**
   * Phase 5 #5 — optional ISO-8601 UTC cutoff. When the connected
   * grounding-mcp advertises support for `sinceIso` on `ledger_summary`
   * (detected via tools/list), the filter is pushed server-side and
   * the wire payload is narrowed to rows newer than the cutoff. Old
   * servers silently ignore the option and the full session is
   * returned, so consumers must continue to apply their own client-
   * side window filter (this only ever reduces wire bytes).
   */
  sinceIso?: string;
  /**
   * Phase 5 #5 — optional content-prefix filter. Same shape as
   * `sinceIso`: server-side narrowing only when supported, no
   * contract change for client-side post-filtering.
   */
  contentPrefix?: string;
}

export type LedgerQueryResult =
  | { kind: "ok"; entries: LedgerEntry[] }
  | { kind: "degraded"; reason: string };

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
}

interface PendingResponse {
  id: number;
  resolve: (value: JsonRpcResponse) => void;
}

interface RawLedgerEntry {
  id?: unknown;
  content?: unknown;
  source?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  type?: unknown;
}

function normaliseEntry(
  raw: RawLedgerEntry,
  bucketType?: string,
): LedgerEntry | null {
  if (raw.id === undefined || raw.id === null) return null;
  if (typeof raw.content !== "string") return null;
  const createdAt =
    typeof raw.createdAt === "string"
      ? raw.createdAt
      : typeof raw.created_at === "string"
        ? raw.created_at
        : undefined;
  if (createdAt === undefined) return null;
  // Prefer the bucket-derived type (Phase 5 #4 — bucket name is the
  // canonical type signal); fall back to the row's own `type` field
  // if the wire payload happens to carry it.
  const type =
    bucketType ?? (typeof raw.type === "string" ? raw.type : undefined);
  return {
    id: String(raw.id),
    content: raw.content,
    source: typeof raw.source === "string" ? raw.source : undefined,
    createdAt,
    ...(type !== undefined && { type }),
  };
}

/**
 * Flatten the bucketed arrays returned by `ledger_summary` into one list.
 * Tolerates both snake_case (`created_at`) and camelCase (`createdAt`) since
 * the MCP wire format is JSON.stringify of whatever the underlying lib emits.
 *
 * Phase 5 #4 — surfaces the wire bucket as `LedgerEntry.type`
 * (`facts` → `fact`, `policyDecisions` → `policy_decision`, etc.) so
 * downstream filters can distinguish evidence from audit records.
 * `flattenSummary` returns ALL buckets; consumers filter by type.
 *
 * Returns `null` when the payload doesn't carry an `entries` object — the
 * caller treats that as a contract-drift degraded path.
 */
const BUCKET_TO_TYPE: Record<string, string> = {
  facts: "fact",
  hypotheses: "hypothesis",
  rejected: "rejected",
  unknowns: "unknown",
  policyDecisions: POLICY_DECISION_TYPE,
};

function flattenSummary(payload: unknown): LedgerEntry[] | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { entries?: unknown };
  const entries = root.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return null;
  }
  const buckets = entries as Record<string, unknown>;
  const out: LedgerEntry[] = [];
  for (const [bucketKey, type] of Object.entries(BUCKET_TO_TYPE)) {
    const arr = buckets[bucketKey];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const norm = normaliseEntry(raw as RawLedgerEntry, type);
      if (norm) out.push(norm);
    }
  }
  return out;
}

interface CallResult {
  child: ChildProcessWithoutNullStreams;
  stderrBuf: { value: string };
  pending: Map<number, PendingResponse>;
  /**
   * Sends a JSON-RPC request; resolves on response, child close, or timeout.
   * `timeoutMsOverride` (task 2026-07-18 subprocess-test-deflake, T-003) is
   * optional and per-call: omitted, this call uses the connection's own
   * `timeoutMs` (from `LedgerClientOptions`) exactly as before.
   */
  call: (
    id: number,
    method: string,
    params: Record<string, unknown>,
    timeoutMsOverride?: number,
  ) => Promise<JsonRpcResponse | "exit" | "timeout">;
  notify: (method: string, params?: Record<string, unknown>) => void;
  exited: () => boolean;
  exitCode: () => number | null;
  exitSignal: () => NodeJS.Signals | null;
  spawnError: () => Error | null;
  cleanup: () => void;
}

function startSubprocess(
  opts: LedgerClientOptions,
): { ok: true; ctl: CallResult } | { ok: false; reason: string } {
  const list = opts.mcpCommand;
  if (!list || list.length === 0) {
    return { ok: false, reason: "grounding-mcp command is empty" };
  }
  const exe = expandHome(list[0]!);
  const args = list.slice(1).map((p) => expandHome(p));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(exe, args, {
      cwd: opts.cwd,
      // Defense-in-depth parity with `recordPolicyDecision`
      // (agent-tasks/973596d7): expand leading `~/` in env values so a
      // manifest that bypassed validate cannot scatter cwd-relative
      // `./~/…` paths through the query path either.
      env: { ...process.env, ...(expandHomeInEnv(opts.mcpEnv) ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      ok: false,
      reason: `grounding-mcp spawn failed: ${(err as Error).message}`,
    };
  }

  const stderrBuf = { value: "" };
  let stdoutBuf = "";
  let processExited = false;
  let processClosed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const pending = new Map<number, PendingResponse>();
  const timers = new Set<NodeJS.Timeout>();

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf.value += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {
    /* EPIPE on shutdown; surfaced via the close listener. */
  });
  let spawnError: Error | null = null;
  child.on("error", (err: Error) => {
    // Spawn failure (ENOENT etc.). Setting `processClosed = true` is safe
    // because the child never executed, so there is no stdio buffer to drain;
    // the exit-promise short-circuit reaches `exitDiagnostic` and reports the
    // spawn error directly.
    spawnError = err;
    processExited = true;
    processClosed = true;
  });
  child.on("exit", (code, signal) => {
    processExited = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.on("close", () => {
    // Node fires `close` only after every stdio pipe has drained. Racing
    // on `exit` would surface `(no stderr)` whenever the kernel buffer
    // hadn't been flushed yet, which is the symptom the v0.8.1 review caught.
    processClosed = true;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl = stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number") {
            const handler = pending.get(msg.id);
            if (handler) {
              pending.delete(msg.id);
              handler.resolve(msg);
            }
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }
      nl = stdoutBuf.indexOf("\n");
    }
  });

  const exitPromise = new Promise<"exit">((resolve) => {
    if (processClosed) {
      resolve("exit");
      return;
    }
    const done = (): void => resolve("exit");
    child.once("close", done);
    child.once("error", done);
  });

  function timeoutPromise(
    ms: number,
  ): { promise: Promise<"timeout">; timer: NodeJS.Timeout } {
    let timer!: NodeJS.Timeout;
    const promise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timers.delete(timer);
        resolve("timeout");
      }, ms);
      timer.unref();
      timers.add(timer);
    });
    return { promise, timer };
  }

  function send(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    return new Promise((resolve) => {
      pending.set(id, { id, resolve });
      try {
        if (!processExited && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
        }
      } catch {
        /* server closed stdin; the exit-promise race resolves the call */
      }
    });
  }

  async function call(
    id: number,
    method: string,
    params: Record<string, unknown>,
    timeoutMsOverride?: number,
  ): Promise<JsonRpcResponse | "exit" | "timeout"> {
    const timeout = timeoutPromise(timeoutMsOverride ?? timeoutMs);
    try {
      return await Promise.race([
        send(id, method, params),
        exitPromise,
        timeout.promise,
      ]);
    } finally {
      // A pooled session issues many calls on one subprocess; without
      // settling-time cleanup the timer set and pending map grow O(calls)
      // until dispose. Keep both O(in-flight) instead.
      clearTimeout(timeout.timer);
      timers.delete(timeout.timer);
      pending.delete(id);
    }
  }

  function notify(method: string, params: Record<string, unknown> = {}): void {
    try {
      if (!processExited && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
        );
      }
    } catch {
      /* best effort */
    }
  }

  function cleanup(): void {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (!processExited) child.kill("SIGTERM");
  }

  return {
    ok: true,
    ctl: {
      child,
      stderrBuf,
      pending,
      call,
      notify,
      exited: () => processExited,
      exitCode: () => exitCode,
      exitSignal: () => exitSignal,
      spawnError: () => spawnError,
      cleanup,
    },
  };
}

/**
 * Phase 5 #5 — read the inputSchema for `ledger_summary` from a
 * `tools/list` response and project the set of advertised property
 * names (which are the args harness can send without tripping a zod
 * rejection on an older server).
 *
 * Defensive: any unexpected shape (timeout, exit, non-array, missing
 * inputSchema) returns the conservative `{ "sessionId" }` set so the
 * caller falls back to client-side filtering instead of speculatively
 * including args that an old server would reject.
 */
async function detectLedgerSummaryArgs(
  ctl: CallResult,
  requestId: number,
): Promise<Set<string>> {
  const fallback = new Set(["sessionId"]);
  const result = await ctl.call(requestId, "tools/list", {});
  if (result === "exit" || result === "timeout") return fallback;
  if (result.error) return fallback;
  const r = result.result as { tools?: unknown } | undefined;
  if (!r || !Array.isArray(r.tools)) return fallback;
  for (const tool of r.tools) {
    const t = tool as { name?: unknown; inputSchema?: unknown };
    if (t.name !== "ledger_summary") continue;
    const schema = t.inputSchema as { properties?: unknown } | undefined;
    if (!schema || !schema.properties || typeof schema.properties !== "object") {
      return fallback;
    }
    return new Set(Object.keys(schema.properties as Record<string, unknown>));
  }
  return fallback;
}

function exitDiagnostic(ctl: CallResult): string {
  const err = ctl.spawnError();
  if (err) return `spawn failed: ${err.message}`;
  const tail = ctl.stderrBuf.value.trim().split("\n").pop()?.trim() || "(no stderr)";
  const code = ctl.exitCode();
  const sig = ctl.exitSignal();
  const status = code !== null ? `exit ${code}` : sig ? `signal ${sig}` : "exited";
  return `${status}: ${tail}`;
}

function extractToolPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") return null;
  const r = result as { content?: unknown; structuredContent?: unknown };
  if (r.structuredContent && typeof r.structuredContent === "object") {
    return r.structuredContent;
  }
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        try {
          return JSON.parse(b.text);
        } catch {
          /* not JSON; fall through */
        }
      }
    }
  }
  return null;
}

/** Arguments to `LedgerSession.querySummary` — per-call, unlike the
 *  connection-scoped `LedgerClientOptions`. */
export interface LedgerSessionQuery {
  sessionId: string;
  sinceIso?: string;
  contentPrefix?: string;
  /**
   * Optional per-call override of the session's `timeoutMs` (task
   * 2026-07-18 subprocess-test-deflake, T-003). Applies only to this
   * call's `ledger_summary` round-trip (the `tools/list` capability
   * probe, only run when `sinceIso`/`contentPrefix` is set, still uses
   * the session default). Omitted, behaviour is byte-for-byte identical
   * to before this option existed: the session's own `timeoutMs` is
   * used. A timeout on an overridden call still sets the session-wide
   * latch exactly like a timeout on the session default would — see
   * `LedgerSession.callTool`'s `options.timeoutMs` doc for the shared
   * latch contract and the enforcement-path cost-bound caveat.
   */
  timeoutMs?: number;
}

/**
 * Result of a generic `LedgerSession.callTool` round-trip. Three-way so a
 * caller can distinguish a server-side JSON-RPC error (retryable with a
 * different payload — the `policy_decision` → `fact` fallback) from a
 * degraded transport (spawn failure / exit / timeout — nothing to retry).
 */
export type LedgerSessionCallResult =
  | { status: "ok"; payload: unknown }
  | { status: "error"; errorMessage: string }
  | { status: "degraded"; reason: string };

/**
 * One grounding-mcp connection serving multiple calls.
 *
 * The PreToolUse runtime gate evaluates K policies per tool event, and each
 * used to spawn its own subprocess for the query plus a second one for the
 * audit record — 2K sequential spawns per event, the fail-open-under-load
 * risk the 2026-07-01 review flagged against the 30s hook budget. A session
 * spawns ONE subprocess lazily on first use, performs the initialize
 * handshake once, and multiplexes every subsequent `ledger_summary` /
 * `ledger_add` over the same stdio pipe. `dispose()` terminates the child;
 * the owner (e.g. the intercept CLI wrapper) MUST call it when done.
 */
export interface LedgerSession {
  querySummary(query: LedgerSessionQuery): Promise<LedgerQueryResult>;
  /**
   * `options.timeoutMs` (task 2026-07-18 subprocess-test-deflake, T-003)
   * is an optional per-call override of the session's `timeoutMs` for
   * THIS call only; every other call on the session keeps using the
   * session default. Omitted, behaviour is byte-for-byte identical to
   * before this option existed. Fail-open/degrade semantics and the
   * session-wide timeout latch are unchanged either way: a timeout on an
   * overridden call latches the session exactly like a timeout on the
   * session default does — every subsequent call (on this session, with
   * or without its own override) short-circuits to `degraded` without a
   * new round-trip.
   *
   * Cost-bound caveat (OKF gate-fail-posture-matrix): the latch's promise
   * that a dead ledger costs a session at most ~1× its `timeoutMs` holds
   * only while per-call overrides on the enforcement critical path stay
   * ≤ the session default. The override exists for tests and non-critical
   * callers; do not pass a LARGER override on the PreToolUse gate path.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<LedgerSessionCallResult>;
  dispose(): void;
}

export function openLedgerSession(opts: LedgerClientOptions): LedgerSession {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let ctl: CallResult | null = null;
  let startFailure: string | null = null;
  // Resolves to null on success, or the degraded reason. Cached so the
  // handshake happens exactly once per session; a failed init stays failed
  // (retrying per call would reintroduce the very fan-out this removes).
  let initPromise: Promise<string | null> | null = null;
  // Session-level timeout latch: once ANY call times out, every subsequent
  // call short-circuits to degraded without a new round-trip. Without this
  // a slow-but-responsive server could cost timeoutMs PER call — with K
  // policies each awaiting a record on the enforcement critical path,
  // ~(K+1)×timeoutMs can still blow the 30s hook budget the pooling exists
  // to protect. The latch bounds total session timeout cost at ~1×timeoutMs.
  // Ledger calls are best-effort by contract (degraded never blocks), so
  // giving up on a server that already blew one deadline is the intended
  // fail-open direction, not a new failure mode.
  let timedOut = false;
  // The budget actually in effect when the latch tripped (task
  // 2026-07-18 subprocess-test-deflake, T-003): the session default
  // unless a per-call `timeoutMs` override was the one that timed out.
  // Tracked separately so `latchedReason()` reports the real number
  // instead of always the session default.
  let timedOutAtMs = timeoutMs;
  let nextId = 1;

  function ensureStarted(): CallResult | null {
    if (ctl !== null || startFailure !== null) return ctl;
    const start = startSubprocess(opts);
    if (!start.ok) {
      startFailure = start.reason;
      return null;
    }
    ctl = start.ctl;
    return ctl;
  }

  function ensureInitialized(): Promise<string | null> {
    if (initPromise !== null) return initPromise;
    initPromise = (async () => {
      const c = ensureStarted();
      if (c === null) return startFailure;
      const initResult = await c.call(nextId++, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "harness-policies", version: VERSION },
      });
      if (initResult === "exit") return `grounding-mcp ${exitDiagnostic(c)}`;
      if (initResult === "timeout") {
        timedOut = true;
        timedOutAtMs = timeoutMs;
        return `grounding-mcp timeout after ${timeoutMs}ms`;
      }
      if (initResult.error) {
        return `grounding-mcp initialize error: ${initResult.error.message ?? "unknown"}`;
      }
      c.notify("notifications/initialized");
      return null;
    })();
    return initPromise;
  }

  const latchedReason = (): string =>
    `grounding-mcp timed out earlier in this session (${timedOutAtMs}ms); skipping further ledger calls`;

  return {
    async querySummary(query: LedgerSessionQuery): Promise<LedgerQueryResult> {
      if (timedOut) return { kind: "degraded", reason: latchedReason() };
      const initError = await ensureInitialized();
      if (initError !== null) return { kind: "degraded", reason: initError };
      const c = ctl!;

      // Phase 5 #5 — capability detection only when we actually want to
      // push a filter server-side. Older grounding-mcp builds accept only
      // `sessionId` on `ledger_summary`; harness spawns a binary path
      // chosen by the operator, so we cannot assume a version. Skipping
      // tools/list when no filter is requested keeps the unfiltered hot
      // path one round-trip fewer.
      const wantsFilter =
        query.sinceIso !== undefined || query.contentPrefix !== undefined;
      const supportedArgs = wantsFilter
        ? await detectLedgerSummaryArgs(c, nextId++)
        : new Set(["sessionId"]);
      const callArgs: Record<string, unknown> = { sessionId: query.sessionId };
      if (query.sinceIso !== undefined && supportedArgs.has("sinceIso")) {
        callArgs.sinceIso = query.sinceIso;
      }
      if (
        query.contentPrefix !== undefined &&
        supportedArgs.has("contentPrefix")
      ) {
        callArgs.contentPrefix = query.contentPrefix;
      }

      const effectiveTimeoutMs = query.timeoutMs ?? timeoutMs;
      const callResult = await c.call(
        nextId++,
        "tools/call",
        { name: "ledger_summary", arguments: callArgs },
        effectiveTimeoutMs,
      );
      if (callResult === "exit") {
        return {
          kind: "degraded",
          reason: `grounding-mcp ${exitDiagnostic(c)}`,
        };
      }
      if (callResult === "timeout") {
        timedOut = true;
        timedOutAtMs = effectiveTimeoutMs;
        return {
          kind: "degraded",
          reason: `grounding-mcp timeout after ${effectiveTimeoutMs}ms`,
        };
      }
      if (callResult.error) {
        return {
          kind: "degraded",
          reason: `ledger_summary error: ${callResult.error.message ?? "unknown"}`,
        };
      }

      const payload = extractToolPayload(callResult.result);
      if (payload === null) {
        return {
          kind: "degraded",
          reason: "ledger_summary returned no parseable payload",
        };
      }
      const entries = flattenSummary(payload);
      if (entries === null) {
        return {
          kind: "degraded",
          reason: "ledger_summary payload missing `entries` shape",
        };
      }
      return { kind: "ok", entries };
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ): Promise<LedgerSessionCallResult> {
      if (timedOut) return { status: "degraded", reason: latchedReason() };
      const initError = await ensureInitialized();
      if (initError !== null) return { status: "degraded", reason: initError };
      const c = ctl!;
      const effectiveTimeoutMs = options?.timeoutMs ?? timeoutMs;
      const result = await c.call(
        nextId++,
        "tools/call",
        { name, arguments: args },
        effectiveTimeoutMs,
      );
      if (result === "exit") {
        return { status: "degraded", reason: `grounding-mcp ${exitDiagnostic(c)}` };
      }
      if (result === "timeout") {
        timedOut = true;
        timedOutAtMs = effectiveTimeoutMs;
        return {
          status: "degraded",
          reason: `grounding-mcp timeout after ${effectiveTimeoutMs}ms`,
        };
      }
      if (result.error) {
        return {
          status: "error",
          errorMessage: result.error.message ?? "unknown",
        };
      }
      return { status: "ok", payload: extractToolPayload(result.result) };
    },

    dispose(): void {
      ctl?.cleanup();
    },
  };
}

export async function queryLedgerByTag(
  opts: QueryLedgerOptions,
): Promise<LedgerQueryResult> {
  // One-shot convenience wrapper: open a session, run the single summary
  // query, tear the subprocess down. Callers with more than one ledger
  // round-trip per event (the runtime intercept) hold a session instead.
  const session = openLedgerSession(opts);
  try {
    return await session.querySummary({
      sessionId: opts.sessionId,
      ...(opts.sinceIso !== undefined && { sinceIso: opts.sinceIso }),
      ...(opts.contentPrefix !== undefined && {
        contentPrefix: opts.contentPrefix,
      }),
    });
  } finally {
    session.dispose();
  }
}
