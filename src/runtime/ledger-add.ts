// Phase 6 #4 — generic `ledger_add` writer for harness-side runtime tags.
//
// Smaller cousin of `recordPolicyDecision`: writes one fact-typed
// ledger row via grounding-mcp's `ledger_add` verb, with a caller-
// supplied content string and source. The pack-side approval flow
// uses this to write `understanding-approved:${SESSION_ID}` tags.
//
// All failure paths resolve to `{ ok: false, reason }` so callers can
// degrade gracefully rather than throw mid-CLI.

import { spawn } from "node:child_process";
import { expandHome, expandHomeInEnv } from "./expand-home.js";
import { VERSION } from "../version.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface AddLedgerFactOptions {
  mcpCommand: string[];
  mcpEnv?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  sessionId: string;
  content: string;
  source: string;
}

export type AddLedgerFactResult = { ok: true } | { ok: false; reason: string };

export async function addLedgerFact(
  opts: AddLedgerFactOptions,
): Promise<AddLedgerFactResult> {
  if (opts.mcpCommand.length === 0) {
    return { ok: false, reason: "grounding-mcp command is empty" };
  }
  // Defense-in-depth (agent-tasks/973596d7): expand leading `~/` in
  // command tokens AND env values. Node's `spawn` does not
  // shell-interpolate; a literal `~/...` would otherwise become a
  // cwd-relative rogue path. ledger-record.ts does the same; the
  // shared helper lives in ./expand-home.ts.
  const exe = expandHome(opts.mcpCommand[0]!);
  const args = opts.mcpCommand.slice(1).map((p) => expandHome(p));
  const expandedEnv = expandHomeInEnv(opts.mcpEnv);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<AddLedgerFactResult>((resolve) => {
    let settled = false;
    const settle = (result: AddLedgerFactResult): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
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

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutBuf += chunk;
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
            if (msg.id === 1) {
              // Initialize done; send notifications/initialized + add.
              try {
                child.stdin!.write(
                  `${JSON.stringify({
                    jsonrpc: "2.0",
                    method: "notifications/initialized",
                  })}\n`,
                );
                child.stdin!.write(
                  `${JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: {
                      name: "ledger_add",
                      arguments: {
                        sessionId: opts.sessionId,
                        type: "fact",
                        content: opts.content,
                        source: opts.source,
                      },
                    },
                  })}\n`,
                );
              } catch (err) {
                settle({ ok: false, reason: `add write failed: ${(err as Error).message}` });
              }
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
    child.stderr!.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on("error", (err: Error) => {
      settle({ ok: false, reason: `spawn failed: ${err.message}` });
    });
    child.on("exit", () => {
      const tail = stderrBuf.trim().split("\n").pop()?.trim() || "(no stderr)";
      settle({ ok: false, reason: `grounding-mcp exited: ${tail}` });
    });
    child.stdin!.on("error", () => {
      /* EPIPE handled by exit listener */
    });

    try {
      child.stdin!.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "harness-ledger-add", version: VERSION },
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
