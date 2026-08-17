// Phase 4 #5 — `policy_decision` audit-log writer.
//
// Writes one ledger entry per policy decision via grounding-mcp's
// `ledger_add` verb. The verb only accepts the four fact/hypothesis/rejected/
// unknown types, so we stash the structured payload as JSON inside `content`
// behind a `policy_decision:` prefix that `harness audit` and
// `harness explain --trace` (Phase 4 #6/#7) grep for.

import { spawn } from "node:child_process";
// Type-only on purpose: `policies/ledger-client.ts` value-imports
// POLICY_DECISION_TYPE from this module, so a VALUE import back would
// re-create the TDZ cycle pinned absent by
// tests/io/ledger-record-no-cycle.test.ts. `import type` is erased
// at compile time and adds no runtime edge.
import type { LedgerSession } from "../policies/ledger-client.js";
import type { LedgerEntry } from "../policies/requires.js";
import { parseLedgerTimestamp } from "../policies/timestamp.js";
import { expandHome, expandHomeInEnv } from "./expand-home.js";
import type { PolicyDecision } from "../runtime/intercept.js";
import { VERSION } from "../version.js";

export interface LedgerRecordOptions {
  mcpCommand: string[];
  mcpEnv?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const SOURCE = "harness-policy-intercept";

/**
 * Canonical ledger-entry `type` for harness-emitted policy decisions.
 * Owned here because this module also owns the encode/decode prefix.
 * Every site that filters or writes policy-decision rows MUST go through
 * this constant, so a typo at any one site does not silently disable the
 * substring-pollution guard. See PR #47 review for the failure mode.
 */
export const POLICY_DECISION_TYPE = "policy_decision";
const PREFIX = POLICY_DECISION_TYPE;

export interface PolicyDecisionPayload {
  name: string;
  outcome: PolicyDecision["outcome"];
  enforcement: PolicyDecision["enforcement"];
  reason: string;
  ledgerTag: string;
  extractValues: Record<string, string>;
  requiresEval?: { matchedCount: number; reason: string };
  /**
   * Risk Gate verdicts for the action (Phase 7 #5). Present only when
   * the Risk Gate was active for the event; absent for a pure Phase-4
   * manifest, and absent on any `policy_decision` row recorded before
   * Phase 7 #5 — `harness explain --trace` renders them only when present.
   */
  risk?: PolicyDecision["risk"];
  environment?: PolicyDecision["environment"];
  /**
   * See `PolicyDecision.whenUnclassifiedFallback`. Present only when
   * the match was a fail-closed unclassified hit (M7). Absent on rows
   * recorded before M7 or on rows where the action was classified.
   */
  whenUnclassifiedFallback?: boolean;
  evaluatedAt: string;
}

export function payloadFromDecision(
  decision: PolicyDecision,
): PolicyDecisionPayload {
  return {
    name: decision.policyName,
    outcome: decision.outcome,
    enforcement: decision.enforcement,
    reason: decision.reason,
    ledgerTag: decision.ledgerTag,
    extractValues: decision.extractValues,
    ...(decision.requiresEval && { requiresEval: decision.requiresEval }),
    ...(decision.risk && { risk: decision.risk }),
    ...(decision.environment && { environment: decision.environment }),
    // M7: carry the fail-closed unclassified flag into the serialised
    // audit row so `harness audit` / `explain --trace` can surface it.
    // Absent (not `false`) when the action was classified or the policy
    // had no `when:` block, keeping pre-M7 rows byte-identical.
    ...(decision.whenUnclassifiedFallback === true && {
      whenUnclassifiedFallback: true,
    }),
    evaluatedAt: decision.evaluatedAt,
  };
}

export function encodeLedgerContent(payload: PolicyDecisionPayload): string {
  return `${PREFIX}:${payload.name}:${payload.outcome} ${JSON.stringify(payload)}`;
}

/**
 * Phase 5 #9 — preferred sort key for policy_decision rows.
 *
 * `evidence-ledger` stores `createdAt` at 1-second precision (SQLite
 * `datetime('now')`), so two decisions evaluated within the same wall-
 * clock second tie at `bt - at === 0`, and a stable sort returns the
 * earliest entry as "latest". The decoded payload's `evaluatedAt` is
 * `Date.toISOString()` (millisecond precision), which actually
 * distinguishes back-to-back fires. Use it as the primary key, with a
 * `createdAt` fallback for any future encoding that lacks `evaluatedAt`.
 *
 * Returns `NaN` only when both fields are unparseable; callers should
 * tolerate ties by treating equal results as preserve-order.
 */
export function decisionSortKey(
  entry: LedgerEntry,
  payload: PolicyDecisionPayload,
): number {
  const evaluatedMs = parseLedgerTimestamp(payload.evaluatedAt);
  if (!Number.isNaN(evaluatedMs)) return evaluatedMs;
  if (entry.createdAt instanceof Date) return entry.createdAt.getTime();
  return parseLedgerTimestamp(entry.createdAt);
}

export function decodeLedgerContent(content: string): PolicyDecisionPayload | null {
  if (!content.startsWith(`${PREFIX}:`)) return null;
  const space = content.indexOf(" ");
  if (space === -1) return null;
  try {
    const obj = JSON.parse(content.slice(space + 1)) as PolicyDecisionPayload;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Record a `policy_decision` row over an already-open {@link LedgerSession}
 * instead of spawning a dedicated grounding-mcp subprocess per decision.
 * This is the runtime intercept's hot path: K matching policies per tool
 * event share ONE connection for all their audit writes (plus the summary
 * query), instead of the 2K sequential spawns the 2026-07-01 review flagged
 * as a fail-open-under-load risk against the 30s hook budget.
 *
 * Same retry contract as {@link recordPolicyDecision}: a server-side error
 * on `type: "policy_decision"` (old grounding-mcp without that enum value)
 * retries once with the legacy `type: "fact"` prefix-encoded row. A degraded
 * transport is terminal — the session's process is gone, nothing to retry.
 */
export async function recordPolicyDecisionOnSession(
  session: LedgerSession,
  decision: PolicyDecision,
  sessionId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const payload = payloadFromDecision(decision);
  const content = encodeLedgerContent(payload);
  const first = await session.callTool("ledger_add", {
    sessionId,
    type: POLICY_DECISION_TYPE,
    content,
    source: SOURCE,
  });
  if (first.status === "ok") return { ok: true };
  if (first.status === "degraded") return { ok: false, reason: first.reason };
  // Likely an old grounding-mcp without the policy_decision enum value —
  // retry once with the legacy fact-with-prefix encoding.
  const fallback = await session.callTool("ledger_add", {
    sessionId,
    type: "fact",
    content,
    source: SOURCE,
  });
  if (fallback.status === "ok") return { ok: true };
  return {
    ok: false,
    reason:
      fallback.status === "error"
        ? `ledger_add error: ${fallback.errorMessage}`
        : fallback.reason,
  };
}

export async function recordPolicyDecision(
  decision: PolicyDecision,
  sessionId: string,
  opts: LedgerRecordOptions,
): Promise<{ ok: boolean; reason?: string }> {
  const list = opts.mcpCommand;
  if (!list || list.length === 0) {
    return { ok: false, reason: "grounding-mcp command is empty" };
  }
  const exe = expandHome(list[0]!);
  const args = list.slice(1).map((p) => expandHome(p));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = payloadFromDecision(decision);
  const content = encodeLedgerContent(payload);
  // Defense-in-depth (agent-tasks/973596d7): expand leading `~/` in
  // every env value before merging into the spawned process env. The
  // validate-time warning still fires for operators with the literal
  // tilde in their manifest, but a manifest that bypassed validate
  // (or the warning was ignored on) cannot now scatter a rogue
  // cwd-relative `./~/…` path. See expandHome doc for scope.
  const expandedEnv = expandHomeInEnv(opts.mcpEnv);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(expandedEnv ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, reason: `spawn failed: ${(err as Error).message}` });
      return;
    }

    let settled = false;
    const settle = (r: { ok: boolean; reason?: string }): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    let stdoutBuf = "";
    let stderrBuf = "";
    let recordSent = false;
    let fallbackSent = false;

    /**
     * Phase 5 #4 — write attempt with type='policy_decision'. When
     * the connected grounding-mcp pre-dates that change, the call
     * returns a zod / CHECK constraint error; we then retry with the
     * legacy type='fact' + prefix-encoded content path.
     */
    const sendInitialAdd = (): void => {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "ledger_add",
            arguments: {
              sessionId,
              type: POLICY_DECISION_TYPE,
              content,
              source: SOURCE,
            },
          },
        })}\n`,
      );
    };

    const sendFallbackAdd = (): void => {
      fallbackSent = true;
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "ledger_add",
            arguments: {
              sessionId,
              type: "fact",
              content,
              source: SOURCE,
            },
          },
        })}\n`,
      );
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as {
              id?: number;
              error?: { message?: string };
            };
            if (msg.id === 1 && !recordSent) {
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                })}\n`,
              );
              sendInitialAdd();
              recordSent = true;
            } else if (msg.id === 2) {
              if (msg.error) {
                // Likely an old grounding-mcp without the
                // policy_decision enum value — retry once with the
                // legacy fact-with-prefix encoding.
                if (!fallbackSent) {
                  sendFallbackAdd();
                  return;
                }
                settle({
                  ok: false,
                  reason: `ledger_add error: ${msg.error.message ?? "unknown"}`,
                });
                return;
              }
              settle({ ok: true });
              return;
            } else if (msg.id === 3) {
              if (msg.error) {
                settle({
                  ok: false,
                  reason: `ledger_add error: ${msg.error.message ?? "unknown"}`,
                });
                return;
              }
              settle({ ok: true });
              return;
            }
          } catch {
            /* ignore non-JSON */
          }
        }
        nl = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf8");
    });
    child.on("error", (err: Error) => {
      settle({ ok: false, reason: `spawn failed: ${err.message}` });
    });
    child.on("exit", () => {
      const tail = stderrBuf.trim().split("\n").pop()?.trim() || "(no stderr)";
      settle({ ok: false, reason: `grounding-mcp exited: ${tail}` });
    });
    child.stdin.on("error", () => {
      /* EPIPE; exit listener handles */
    });

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "harness-policy-intercept", version: VERSION },
          },
        })}\n`,
      );
    } catch (err) {
      settle({ ok: false, reason: `init write failed: ${(err as Error).message}` });
      return;
    }

    const t = setTimeout(() => {
      settle({ ok: false, reason: `grounding-mcp timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    t.unref();
  });
}
