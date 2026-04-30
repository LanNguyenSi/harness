// Phase 4 #5 — `policy_decision` audit-log writer.
//
// Writes one ledger entry per policy decision via grounding-mcp's
// `ledger_add` verb. The verb only accepts the four fact/hypothesis/rejected/
// unknown types, so we stash the structured payload as JSON inside `content`
// behind a `policy_decision:` prefix that `harness audit` and
// `harness explain --trace` (Phase 4 #6/#7) grep for.

import { spawn } from "node:child_process";
import type { PolicyDecision } from "./intercept.js";

export interface LedgerRecordOptions {
  mcpCommand: string[];
  mcpEnv?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const SOURCE = "harness-policy-intercept";
const PREFIX = "policy_decision";

function expandHomePath(p: string): string {
  if (p === "~") return process.env.HOME ?? "";
  if (p.startsWith("~/")) return `${process.env.HOME ?? ""}/${p.slice(2)}`;
  return p;
}

export interface PolicyDecisionPayload {
  name: string;
  outcome: PolicyDecision["outcome"];
  enforcement: PolicyDecision["enforcement"];
  reason: string;
  ledgerTag: string;
  extractValues: Record<string, string>;
  requiresEval?: { matchedCount: number; reason: string };
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
    evaluatedAt: decision.evaluatedAt,
  };
}

export function encodeLedgerContent(payload: PolicyDecisionPayload): string {
  return `${PREFIX}:${payload.name}:${payload.outcome} ${JSON.stringify(payload)}`;
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

export async function recordPolicyDecision(
  decision: PolicyDecision,
  sessionId: string,
  opts: LedgerRecordOptions,
): Promise<{ ok: boolean; reason?: string }> {
  const list = opts.mcpCommand;
  if (!list || list.length === 0) {
    return { ok: false, reason: "grounding-mcp command is empty" };
  }
  const exe = expandHomePath(list[0]!);
  const args = list.slice(1).map(expandHomePath);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = payloadFromDecision(decision);
  const content = encodeLedgerContent(payload);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.mcpEnv ?? {}) },
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
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
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
              recordSent = true;
            } else if (msg.id === 2) {
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
            clientInfo: { name: "harness-policy-intercept", version: "0.3.0" },
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
