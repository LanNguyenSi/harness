import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServer } from "../schema/index.js";

export type McpProbeOutcome =
  | { kind: "healthy"; latencyMs: number }
  | { kind: "error"; latencyMs: number; message: string }
  | { kind: "missing-verb" }
  | { kind: "disabled" };

export interface McpProbeResult {
  name: string;
  outcome: McpProbeOutcome;
}

export interface McpProbe {
  call(server: McpServer): Promise<McpProbeResult>;
}

export interface RealMcpProbeOptions {
  cwd?: string;
}

interface PendingResponse {
  id: number;
  resolve: (value: unknown) => void;
}

function expandHomePath(p: string): string {
  if (p === "~") return process.env.HOME ?? "";
  if (p.startsWith("~/")) return `${process.env.HOME ?? ""}/${p.slice(2)}`;
  return p;
}

function commandToArgs(server: McpServer): { exe: string; args: string[] } {
  const list = Array.isArray(server.command)
    ? server.command
    : server.command.trim().split(/\s+/);
  const exe = expandHomePath(list[0] ?? "");
  const args = list.slice(1).map(expandHomePath);
  return { exe, args };
}

async function runRealProbe(
  server: McpServer,
  opts: RealMcpProbeOptions,
): Promise<McpProbeResult> {
  if (server.enabled === false) {
    return { name: server.name, outcome: { kind: "disabled" } };
  }
  if (!server.health) {
    return { name: server.name, outcome: { kind: "missing-verb" } };
  }
  const { exe, args } = commandToArgs(server);
  const timeoutMs = server.health.timeout_ms ?? 5000;
  const start = Date.now();

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(exe, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      name: server.name,
      outcome: {
        kind: "error",
        latencyMs: Date.now() - start,
        message: `spawn failed: ${(err as Error).message}`,
      },
    };
  }

  const pending = new Map<number, PendingResponse>();
  let stderrBuf = "";
  let stdoutBuf = "";
  let processExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {
    /* server closed stdin (EPIPE); the exit listener below handles the diagnostic */
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
          const msg = JSON.parse(line) as { id?: number };
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

  function send(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      pending.set(id, { id, resolve });
      try {
        if (!processExited && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        }
      } catch {
        /* server already closed; the waitForExit branch will resolve the race */
      }
    });
  }

  function waitForExit(): Promise<"exit"> {
    return new Promise((resolve) => {
      if (processExited) resolve("exit");
      else child.once("exit", () => resolve("exit"));
    });
  }

  const timers = new Set<NodeJS.Timeout>();
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
  function clearTimers(): void {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  try {
    const initResult = await Promise.race([
      send(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "harness-doctor", version: "0.3.0" },
      }),
      waitForExit(),
      timeoutPromise(),
    ]);
    if (initResult === "exit") {
      const trimmed = stderrBuf.trim().split("\n").pop()?.trim() || "(no stderr)";
      const status =
        exitCode !== null ? `exit ${exitCode}` : exitSignal ? `signal ${exitSignal}` : "exited";
      return {
        name: server.name,
        outcome: {
          kind: "error",
          latencyMs: Date.now() - start,
          message: `process ${status}: ${trimmed}`,
        },
      };
    }
    if (initResult === "timeout") {
      return {
        name: server.name,
        outcome: {
          kind: "error",
          latencyMs: Date.now() - start,
          message: `initialize timed out after ${timeoutMs}ms`,
        },
      };
    }

    try {
      if (!processExited && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
      }
    } catch {
      /* server already closed */
    }

    const verbResult = await Promise.race([
      send(2, "tools/call", {
        name: server.health.verb,
        arguments: {},
      }),
      waitForExit(),
      timeoutPromise(),
    ]);
    if (verbResult === "exit") {
      const trimmed = stderrBuf.trim().split("\n").pop()?.trim() || "(no stderr)";
      return {
        name: server.name,
        outcome: {
          kind: "error",
          latencyMs: Date.now() - start,
          message: `process exited during ${server.health.verb}: ${trimmed}`,
        },
      };
    }
    if (verbResult === "timeout") {
      return {
        name: server.name,
        outcome: {
          kind: "error",
          latencyMs: Date.now() - start,
          message: `${server.health.verb} timed out after ${timeoutMs}ms`,
        },
      };
    }

    const response = verbResult as { result?: unknown; error?: { message?: string } };
    if (response.error) {
      return {
        name: server.name,
        outcome: {
          kind: "error",
          latencyMs: Date.now() - start,
          message: response.error.message ?? "unknown MCP error",
        },
      };
    }
    return {
      name: server.name,
      outcome: { kind: "healthy", latencyMs: Date.now() - start },
    };
  } finally {
    clearTimers();
    if (!processExited) child.kill("SIGTERM");
  }
}

export class RealMcpProbe implements McpProbe {
  constructor(private readonly opts: RealMcpProbeOptions = {}) {}
  call(server: McpServer): Promise<McpProbeResult> {
    return runRealProbe(server, this.opts);
  }
}

export async function probeAll(
  servers: McpServer[],
  probe: McpProbe,
): Promise<McpProbeResult[]> {
  return Promise.all(servers.map((s) => probe.call(s)));
}
