// Phase 4 #3 — grounding-mcp client adapter.
//
// Spawns the configured grounding-mcp server, performs the standard
// init / notifications/initialized / tools/call handshake, and returns
// ledger entries normalised to harness's LedgerEntry shape (see
// src/policies/requires.ts). Any failure path resolves to
// `{ kind: "degraded", reason }` so the policy evaluator can fall back to
// warn-mode per ROADMAP §"Phase 4 — Policy layer" acceptance: "When the
// evidence ledger is unreachable, policy evaluation defaults to
// enforcement: warn-equivalent behaviour".

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LedgerEntry } from "./requires.js";

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

function expandHomePath(p: string): string {
  if (p === "~") return process.env.HOME ?? "";
  if (p.startsWith("~/")) return `${process.env.HOME ?? ""}/${p.slice(2)}`;
  return p;
}

interface RawLedgerEntry {
  id?: unknown;
  content?: unknown;
  source?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  type?: unknown;
}

function normaliseEntry(raw: RawLedgerEntry): LedgerEntry | null {
  if (raw.id === undefined || raw.id === null) return null;
  if (typeof raw.content !== "string") return null;
  const createdAt =
    typeof raw.createdAt === "string"
      ? raw.createdAt
      : typeof raw.created_at === "string"
        ? raw.created_at
        : undefined;
  if (createdAt === undefined) return null;
  return {
    id: String(raw.id),
    content: raw.content,
    source: typeof raw.source === "string" ? raw.source : undefined,
    createdAt,
  };
}

/**
 * Flatten the four bucketed arrays returned by `ledger_summary` into one list.
 * Tolerates both snake_case (`created_at`) and camelCase (`createdAt`) since
 * the MCP wire format is JSON.stringify of whatever the underlying lib emits.
 *
 * Returns `null` when the payload doesn't carry an `entries` object — the
 * caller treats that as a contract-drift degraded path. The bucket order
 * (facts, hypotheses, rejected, unknowns) is irrelevant to downstream
 * consumers; evaluateRequires re-filters by `createdAt`.
 */
function flattenSummary(payload: unknown): LedgerEntry[] | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { entries?: unknown };
  const entries = root.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return null;
  }
  const buckets = entries as Record<string, unknown>;
  const out: LedgerEntry[] = [];
  for (const k of ["facts", "hypotheses", "rejected", "unknowns"]) {
    const arr = buckets[k];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const norm = normaliseEntry(raw as RawLedgerEntry);
      if (norm) out.push(norm);
    }
  }
  return out;
}

interface CallResult {
  child: ChildProcessWithoutNullStreams;
  stderrBuf: { value: string };
  pending: Map<number, PendingResponse>;
  /** Sends a JSON-RPC request; resolves on response, "exit", or "timeout". */
  call: (
    id: number,
    method: string,
    params: Record<string, unknown>,
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
  const exe = expandHomePath(list[0]!);
  const args = list.slice(1).map(expandHomePath);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(exe, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.mcpEnv ?? {}) },
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
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const pending = new Map<number, PendingResponse>();
  const timers = new Set<NodeJS.Timeout>();

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf.value += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {
    /* EPIPE on shutdown; surfaced via the exit listener. */
  });
  let spawnError: Error | null = null;
  child.on("error", (err: Error) => {
    spawnError = err;
    processExited = true;
  });
  child.on("exit", (code, signal) => {
    processExited = true;
    exitCode = code;
    exitSignal = signal;
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
    if (processExited) {
      resolve("exit");
      return;
    }
    const done = (): void => resolve("exit");
    child.once("exit", done);
    child.once("error", done);
  });

  function timeoutPromise(): Promise<"timeout"> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve("timeout");
      }, timeoutMs);
      t.unref();
      timers.add(t);
    });
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

  function call(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse | "exit" | "timeout"> {
    return Promise.race([send(id, method, params), exitPromise, timeoutPromise()]);
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

export async function queryLedgerByTag(
  opts: QueryLedgerOptions,
): Promise<LedgerQueryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = startSubprocess(opts);
  if (!start.ok) return { kind: "degraded", reason: start.reason };

  const ctl = start.ctl;
  try {
    const initResult = await ctl.call(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "harness-policies", version: "0.3.0" },
    });
    if (initResult === "exit") {
      return {
        kind: "degraded",
        reason: `grounding-mcp ${exitDiagnostic(ctl)}`,
      };
    }
    if (initResult === "timeout") {
      return {
        kind: "degraded",
        reason: `grounding-mcp timeout after ${timeoutMs}ms`,
      };
    }
    if (initResult.error) {
      return {
        kind: "degraded",
        reason: `grounding-mcp initialize error: ${
          initResult.error.message ?? "unknown"
        }`,
      };
    }

    ctl.notify("notifications/initialized");

    const callResult = await ctl.call(2, "tools/call", {
      name: "ledger_summary",
      arguments: { sessionId: opts.sessionId },
    });
    if (callResult === "exit") {
      return {
        kind: "degraded",
        reason: `grounding-mcp ${exitDiagnostic(ctl)}`,
      };
    }
    if (callResult === "timeout") {
      return {
        kind: "degraded",
        reason: `grounding-mcp timeout after ${timeoutMs}ms`,
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
  } finally {
    ctl.cleanup();
  }
}
