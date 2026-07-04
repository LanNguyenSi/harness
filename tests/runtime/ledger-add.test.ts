// Tests for addLedgerFact error paths (src/runtime/ledger-add.ts).
//
// Uses the fake-script approach from tests/policies/ledger-client.test.ts:
// each scenario plants a small Node.js stub in a tmp dir, passes its path
// as `mcpCommand`, and asserts the resolved AddLedgerFactResult.
//
// Home-dir isolation: addLedgerFact is a pure subprocess caller (spawn +
// JSON-RPC over stdio). It does not read or write the harness home dir, so
// no HARNESS_HOME / homeDir override is needed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addLedgerFact } from "../../src/runtime/ledger-add.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-add-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "server.js");
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

// Minimal MCP stub: responds to initialize (id=1) and accepts ledger_add (id=2).
const OK_SERVER = `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) { nl = buf.indexOf("\\n"); continue; }
    let msg;
    try { msg = JSON.parse(line); } catch { nl = buf.indexOf("\\n"); continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_add") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;

// Stub that returns a JSON-RPC error for any tools/call.
function errorServer(errMessage: string): string {
  return `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) { nl = buf.indexOf("\\n"); continue; }
    let msg;
    try { msg = JSON.parse(line); } catch { nl = buf.indexOf("\\n"); continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
    } else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: ${JSON.stringify(errMessage)} } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;
}

// Stub that hangs indefinitely (simulates a non-responsive MCP server).
const HANG_SERVER = `#!/usr/bin/env node
// keep the process alive without responding
setInterval(() => {}, 1000);
`;

// Stub that writes to stderr and exits immediately (simulates a crashed MCP).
const CRASH_SERVER = `#!/usr/bin/env node
process.stderr.write("grounding-mcp connection refused\\n");
process.exit(1);
`;

const COMMON_OPTS = {
  sessionId: "sess-add-test-1",
  content: "understanding-approved:sess-add-test-1",
  source: "harness-test",
};

describe("addLedgerFact — error paths", () => {
  it("returns ok:false when mcpCommand is empty", async () => {
    const result = await addLedgerFact({
      ...COMMON_OPTS,
      mcpCommand: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("grounding-mcp command is empty");
    }
  });

  it("returns ok:false on spawn ENOENT (binary does not exist)", async () => {
    const result = await addLedgerFact({
      ...COMMON_OPTS,
      mcpCommand: ["/nonexistent-harness-test-ledger-add-binary-xyz"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // child.on("error") fires for ENOENT; settle() sets reason "spawn failed: ..."
      expect(result.reason).toMatch(/spawn failed|ENOENT/);
    }
  });

  it("returns ok:false with timeout reason when server hangs, and child is killed (cleanup verified by quick return)", async () => {
    const script = makeScript(HANG_SERVER);
    const start = Date.now();
    const result = await addLedgerFact({
      ...COMMON_OPTS,
      mcpCommand: [script],
      timeoutMs: 250,
    });
    const elapsed = Date.now() - start;
    // The promise must resolve in ~250 ms, not 1 s+ (proves child was killed)
    expect(elapsed).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/timeout after 250ms/);
    }
  });

  it("returns ok:false and surfaces the last stderr line when the server exits without responding", async () => {
    const script = makeScript(CRASH_SERVER);
    const result = await addLedgerFact({
      ...COMMON_OPTS,
      mcpCommand: [script],
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The stderr capture now happens on "close" (fires only after every
      // stdio pipe has drained), not "exit" (race-prone: exit can fire
      // before the stderr "data" event delivers the buffered chunk). That
      // makes the captured tail deterministic, so assert the exact reason
      // instead of tolerating the "(no stderr)" race fallback.
      expect(result.reason).toBe("grounding-mcp exited: grounding-mcp connection refused");
    }
  });

  it("returns ok:false with ledger_add error reason when the server returns a JSON-RPC error", async () => {
    const script = makeScript(errorServer("unknown session id"));
    const result = await addLedgerFact({
      ...COMMON_OPTS,
      mcpCommand: [script],
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ledger_add error: unknown session id");
    }
  });

  it("returns ok:true on a successful round-trip (baseline / sanity)", async () => {
    const script = makeScript(OK_SERVER);
    const result = await addLedgerFact({
      ...COMMON_OPTS,
      mcpCommand: [script],
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
  });
});
