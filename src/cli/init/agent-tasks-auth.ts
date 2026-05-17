// Post-install auth probe + login dispatcher for the agent-tasks MCP
// bridge. After `npm i -g @agent-tasks/mcp-bridge` succeeds the binary
// is on PATH but the MCP itself is non-functional until a token is
// stored. This module wraps the bridge's `status` verb so the wizard
// can offer the operator a login / signup / skip dialog before the
// session ends with a wired but broken MCP.
//
// The bridge's status verb (mcp-bridge/src/login.ts:188 in agent-tasks)
// exits 0 when a token validates against the backend, exits 1 with
// stderr "No token stored" when no token is configured, exits 1 with
// stderr "Token present" + "validation failed" when a token exists but
// the backend is unreachable or rejects it. We discriminate the three
// branches by stderr-text matching so the wizard can react
// differently: only "no token" warrants a blocking dialog; the other
// two are informational.

import { spawn } from "node:child_process";

const BRIDGE_BIN = "agent-tasks-mcp-bridge";

export type AuthProbeOutcome =
  | { kind: "ok" }
  | { kind: "no_token" }
  | { kind: "validation_failed"; message: string }
  | { kind: "binary_missing" }
  | { kind: "probe_error"; message: string };

export interface ProbeSpawn {
  (cmd: string, args: string[]): Promise<{ code: number; stderr: string }>;
}

export interface LoginSpawn {
  (cmd: string, args: string[]): Promise<{ code: number }>;
}

function realProbeSpawn(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stderr: `spawn failed: ${(err as Error).message}` });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 127, stderr: `${stderr}\n${(err as Error).message}` });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

function realLoginSpawn(cmd: string, args: string[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "inherit" });
    } catch {
      resolve({ code: 127 });
      return;
    }
    child.on("error", () => resolve({ code: 127 }));
    child.on("exit", (code) => resolve({ code: code ?? 1 }));
  });
}

export async function probeAgentTasksAuth(opts: { spawn?: ProbeSpawn } = {}): Promise<AuthProbeOutcome> {
  const run = opts.spawn ?? realProbeSpawn;
  const { code, stderr } = await run(BRIDGE_BIN, ["status"]);
  if (code === 0) return { kind: "ok" };
  if (code === 127 || /\bENOENT\b|spawn failed/i.test(stderr)) {
    return { kind: "binary_missing" };
  }
  if (/No token stored/i.test(stderr)) {
    return { kind: "no_token" };
  }
  if (/Token present/i.test(stderr) && /validation failed/i.test(stderr)) {
    return { kind: "validation_failed", message: stderr.trim() };
  }
  return { kind: "probe_error", message: stderr.trim() || `bridge status exit ${code}` };
}

export async function runBridgeLogin(opts: { spawn?: LoginSpawn } = {}): Promise<{ ok: boolean }> {
  const run = opts.spawn ?? realLoginSpawn;
  const { code } = await run(BRIDGE_BIN, ["login"]);
  return { ok: code === 0 };
}
