import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealMcpProbe } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-probe-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "server.sh");
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

describe("RealMcpProbe", () => {
  it("returns disabled outcome for an enabled:false server without spawning", async () => {
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "x",
      command: ["/nonexistent/binary"],
      enabled: false,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("disabled");
  });

  it("returns missing-verb when health is absent", async () => {
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "x",
      command: ["/usr/bin/true"],
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("missing-verb");
  });

  it("returns error with stderr message when the server exits immediately", async () => {
    const script = makeScript(
      "#!/bin/sh\necho 'Cannot find module sqlite-vec' >&2\nexit 1\n",
    );
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "broken-oracle",
      command: [script],
      health: { verb: "ping", timeout_ms: 8000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.message).toContain("Cannot find module sqlite-vec");
      expect(result.outcome.message).toMatch(/exit 1/);
    }
  });

  it("returns no-response (not error) when the server exits cleanly without responding", async () => {
    // Surfaced during v0.1.0 dogfood: agent-tasks exits 0 from the doctor
    // probe because it is launched without a token and shuts down quietly.
    // Reporting that as "FAILED" misleads; surface it as a distinct outcome.
    //
    // timeout_ms raised 2000->8000 (task 2026-07-18 subprocess-test-deflake,
    // T-002): this outcome depends on the child's `exit` event winning a
    // `Promise.race` against the init timeout (src/probes/mcp.ts ~228-238).
    // The script exits immediately, so on an idle machine `exit` always
    // wins; under full-suite CPU contention the event loop can be slow to
    // observe/process that `exit` event before the timer fires, flipping
    // the outcome to "error"/timed-out instead — exactly the flake the
    // reviewer's re-validation caught here. Raising the budget only gives
    // the (already-fast) exit event more headroom to win the race; it does
    // not make this an intentional-timeout test, so the assertions below
    // (outcome.kind, outcome.phase) are unchanged.
    const script = makeScript("#!/bin/sh\nexit 0\n");
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "agent-tasks",
      command: [script],
      health: { verb: "ping", timeout_ms: 8000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("no-response");
    if (result.outcome.kind === "no-response") {
      expect(result.outcome.phase).toBe("initialize");
    }
  });

  it("returns error with timeout message when the server hangs and never responds", async () => {
    const script = makeScript("#!/bin/sh\nsleep 10\n");
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "hung",
      command: [script],
      health: { verb: "ping", timeout_ms: 250 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.message).toMatch(/timed out/);
    }
  });

  it("returns healthy when the server completes the init + tools/call handshake", async () => {
    const script = makeScript(`#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
      } else if (msg.method === "tools/call") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
      }
    } catch {}
    nl = buf.indexOf("\\n");
  }
});
`);
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "fake-mcp",
      command: ["node", script],
      health: { verb: "ping", timeout_ms: 8000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("healthy");
  });

  /**
   * Verb-phase coverage block: server passes initialize but the verb
   * call goes wrong in three different ways. These exercise probe code
   * paths that PR #11 (v0.1.0) shipped but did not have direct
   * test coverage for.
   */

  it("surfaces a verb-call timeout (server hangs after initialize)", async () => {
    // The probe arms the SAME timeout_ms=250 for the initialize phase at
    // spawn time (src/probes/mcp.ts, the init Promise.race), so anything
    // that slows the child from spawn to its init answer races that timer
    // and yields "initialize timed out after 250ms" instead of the asserted
    // verb-phase message (the exact full-suite baseline failure). The cause
    // reproduced everywhere is node interpreter startup (100-135 ms) inside
    // that shared window, so the server is a POSIX sh script (init answered
    // in ~5 ms). The first exec of a freshly written script can also be slow
    // (measured 52-277 ms in some environments, e.g. under a sandbox or heavy
    // parallel load, and not reproduced in others), so the script is exec'd
    // once on the exact path before the timed call: spawn it, close stdin,
    // let the read-EOF end it. The 250 ms budget then only has to cover the
    // verb-phase timeout of a server that hangs after initialize.
    const script = makeScript(`#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\\n'
      ;;
  esac
done
# tools/call: deliberately do not respond; probe must time out.
`);
    const warm = spawn(script, { stdio: ["pipe", "ignore", "ignore"] });
    warm.stdin.end();
    await new Promise<void>((resolve, reject) => {
      warm.once("exit", () => resolve());
      warm.once("error", reject);
    });
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "lazy-mcp",
      command: [script],
      health: { verb: "ping", timeout_ms: 250 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.message).toMatch(/ping timed out after 250ms/);
    }
  });

  it("surfaces a verb-call JSON-RPC error response distinct from a process exit", async () => {
    const script = makeScript(`#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
      } else if (msg.method === "tools/call") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
      }
    } catch {}
    nl = buf.indexOf("\\n");
  }
});
`);
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "verb-error",
      command: ["node", script],
      health: { verb: "ping", timeout_ms: 8000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.message).toBe("Method not found");
    }
  });

  it("renders a non-zero verb-phase exit as error with the stderr tail", async () => {
    const script = makeScript(`#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
      } else if (msg.method === "tools/call") {
        process.stderr.write("backend down\\n");
        process.exit(2);
      }
    } catch {}
    nl = buf.indexOf("\\n");
  }
});
`);
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "verb-crash",
      command: ["node", script],
      health: { verb: "ping", timeout_ms: 8000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.message).toMatch(/process exited during ping/);
      expect(result.outcome.message).toContain("backend down");
    }
  });

  it("returns a graceful error (never an unhandled exception) when the binary is unresolvable (spawn ENOENT)", async () => {
    // Dogfood regression (harness/7f8fb4bc): a declared MCP whose binary is
    // not on PATH used to crash the whole `harness doctor` run with an
    // unhandled 'error' event on the ChildProcess. If the fix regresses,
    // this test process itself crashes (the exception is unhandled at the
    // Node level), not just this one `it` block.
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "ghost-mcp",
      command: ["definitely-not-a-real-binary-harness-7f8fb4bc"],
      health: { verb: "ping", timeout_ms: 2000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.message).toMatch(/not found on PATH/);
      expect(result.outcome.enoent).toBe(true);
    }
  });

  it("renders a clean verb-phase exit as no-response with phase=verb and the verb name", async () => {
    const script = makeScript(`#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
      } else if (msg.method === "tools/call") {
        process.exit(0);
      }
    } catch {}
    nl = buf.indexOf("\\n");
  }
});
`);
    const probe = new RealMcpProbe();
    const server: McpServer = {
      name: "verb-clean-exit",
      command: ["node", script],
      health: { verb: "ping", timeout_ms: 8000 },
      enabled: true,
    };
    const result = await probe.call(server);
    expect(result.outcome.kind).toBe("no-response");
    if (result.outcome.kind === "no-response") {
      expect(result.outcome.phase).toBe("verb");
      expect(result.outcome.verb).toBe("ping");
    }
  });
});
