import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queryLedgerByTag } from "../../src/policies/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-client-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "server.sh");
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

const happyServer = (payload: object): string => `#!/usr/bin/env node
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
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_summary") {
      const payload = ${JSON.stringify(payload)};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;

const errorServer = (errMessage: string): string => `#!/usr/bin/env node
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

describe("queryLedgerByTag", () => {
  it("returns parsed entries on a successful round-trip", async () => {
    const script = makeScript(
      happyServer({
        sessionId: "sess-1",
        counts: { facts: 1, hypotheses: 0, rejected: 0, unknowns: 0 },
        entries: {
          facts: [
            {
              id: 42,
              type: "fact",
              content: "review:42:approved",
              source: "review-bot",
              session: "sess-1",
              createdAt: "2026-04-30T12:00:00.000Z",
            },
          ],
          hypotheses: [],
          rejected: [],
          unknowns: [],
        },
      }),
    );
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        id: "42",
        content: "review:42:approved",
        source: "review-bot",
        type: "fact",
        createdAt: "2026-04-30T12:00:00.000Z",
      });
    }
  });

  it("flattens facts/hypotheses/rejected/unknowns into one list", async () => {
    const script = makeScript(
      happyServer({
        entries: {
          facts: [{ id: 1, content: "f1", createdAt: "2026-04-30T00:00:00Z" }],
          hypotheses: [{ id: 2, content: "h1", createdAt: "2026-04-30T00:00:01Z" }],
          rejected: [{ id: 3, content: "r1", createdAt: "2026-04-30T00:00:02Z" }],
          unknowns: [{ id: 4, content: "u1", createdAt: "2026-04-30T00:00:03Z" }],
        },
      }),
    );
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries.map((e) => e.content)).toEqual(["f1", "h1", "r1", "u1"]);
    }
  });

  it("returns ok with empty list when ledger has no matching entries", async () => {
    const script = makeScript(
      happyServer({
        entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] },
      }),
    );
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result).toEqual({ kind: "ok", entries: [] });
  });

  it("accepts snake_case created_at on the wire", async () => {
    const script = makeScript(
      happyServer({
        entries: {
          facts: [{ id: 1, content: "x", created_at: "2026-04-30T00:00:00Z" }],
          hypotheses: [],
          rejected: [],
          unknowns: [],
        },
      }),
    );
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries[0]?.createdAt).toBe("2026-04-30T00:00:00Z");
    }
  });

  it("degrades when the subprocess fails to spawn (ENOENT)", async () => {
    const result = await queryLedgerByTag({
      mcpCommand: ["/nonexistent/grounding-mcp"],
      sessionId: "sess-1",
      timeoutMs: 1000,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toMatch(/grounding-mcp.*(spawn failed|ENOENT|exit)/);
    }
  });

  it("degrades when the server returns a JSON-RPC error", async () => {
    const script = makeScript(errorServer("invalid sessionId"));
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toBe("ledger_summary error: invalid sessionId");
    }
  });

  it("degrades when the server hangs past the timeout", async () => {
    const script = makeScript("#!/bin/sh\nsleep 10\n");
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 250,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toMatch(/timeout after 250ms/);
    }
  });

  it("degrades when the server exits without responding", async () => {
    const script = makeScript("#!/bin/sh\necho 'ledger db missing' >&2\nexit 2\n");
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 2000,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toContain("ledger db missing");
      expect(result.reason).toMatch(/exit 2/);
    }
  });

  it("captures stderr deterministically across 20 repeats (was flaky pre-close-event fix)", async () => {
    // Regression net for the race where `exit` fired before stderr drained,
    // surfacing `(no stderr)` instead of the last stderr line. The fix races
    // on `close` (guaranteed post-stdio-drain) rather than `exit`. Twenty
    // serial iterations make the race window cumulative enough to catch a
    // re-regression without ballooning suite time.
    const script = makeScript("#!/bin/sh\necho 'ledger db missing' >&2\nexit 2\n");
    for (let i = 0; i < 20; i++) {
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        sessionId: "sess-1",
        timeoutMs: 2000,
      });
      expect(result.kind).toBe("degraded");
      if (result.kind === "degraded") {
        expect(result.reason, `iteration ${i}`).toContain("ledger db missing");
        expect(result.reason, `iteration ${i}`).toMatch(/exit 2/);
      }
    }
  });

  describe("Phase 5 #4: policy_decision bucket flattening", () => {
    it("flattens the policyDecisions bucket and tags entries with type='policy_decision'", async () => {
      const script = makeScript(
        happyServer({
          sessionId: "sess-1",
          counts: { facts: 1, hypotheses: 0, rejected: 0, unknowns: 0, policyDecisions: 1 },
          entries: {
            facts: [
              {
                id: 1,
                content: "review:42 approved",
                createdAt: "2026-05-01T08:00:00.000Z",
                source: "agent",
              },
            ],
            hypotheses: [],
            rejected: [],
            unknowns: [],
            policyDecisions: [
              {
                id: 2,
                content: 'policy_decision:review-before-merge:deny {"ledgerTag":"review:42"}',
                createdAt: "2026-05-01T08:01:00.000Z",
                source: "harness-policy-intercept",
              },
            ],
          },
        }),
      );
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        sessionId: "sess-1",
        timeoutMs: 8000,
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.entries).toHaveLength(2);
        const fact = result.entries.find((e) => e.id === "1");
        const policy = result.entries.find((e) => e.id === "2");
        expect(fact?.type).toBe("fact");
        expect(policy?.type).toBe("policy_decision");
      }
    });

    it("legacy ledgers without a policyDecisions bucket continue to work", async () => {
      const script = makeScript(
        happyServer({
          sessionId: "sess-1",
          counts: { facts: 1, hypotheses: 0, rejected: 0, unknowns: 0 },
          entries: {
            facts: [
              {
                id: 1,
                content: "agent fact",
                createdAt: "2026-05-01T08:00:00.000Z",
              },
            ],
            hypotheses: [],
            rejected: [],
            unknowns: [],
            // no policyDecisions key — old grounding-mcp
          },
        }),
      );
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        sessionId: "sess-1",
        timeoutMs: 8000,
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.type).toBe("fact");
      }
    });
  });

  describe("Phase 5 #5: server-side filter pushdown", () => {
    /**
     * Capability-aware fake: implements tools/list with a configurable
     * inputSchema for ledger_summary. tools/call records the args it
     * received so the test can assert what got pushed server-side.
     */
    const captureServer = (
      payload: object,
      supportedArgs: string[] = ["sessionId"],
    ): string => `#!/usr/bin/env node
const fs = require("fs");
const captureFile = process.env.CAPTURE_FILE;
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
    } else if (msg.method === "tools/list") {
      const props = {};
      for (const k of ${JSON.stringify(supportedArgs)}) props[k] = { type: "string" };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ledger_summary", inputSchema: { type: "object", properties: props } }] } }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_summary") {
      if (captureFile) fs.writeFileSync(captureFile, JSON.stringify(msg.params.arguments));
      const payload = ${JSON.stringify(payload)};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;

    it("pushes sinceIso + contentPrefix server-side when advertised by tools/list", async () => {
      const captureFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "harness-capture-")),
        "args.json",
      );
      cleanups.push(() => fs.rmSync(path.dirname(captureFile), { recursive: true, force: true }));
      const script = makeScript(
        captureServer(
          { sessionId: "sess-1", counts: {}, entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } },
          ["sessionId", "sinceIso", "contentPrefix"],
        ),
      );
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        mcpEnv: { CAPTURE_FILE: captureFile },
        sessionId: "sess-1",
        sinceIso: "2026-05-01T08:00:00Z",
        contentPrefix: "policy_decision:",
        timeoutMs: 8000,
      });
      expect(result.kind).toBe("ok");
      const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      expect(captured.sinceIso).toBe("2026-05-01T08:00:00Z");
      expect(captured.contentPrefix).toBe("policy_decision:");
    });

    it("falls back to client-side filtering when tools/list does not advertise the new args", async () => {
      const captureFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "harness-capture-")),
        "args.json",
      );
      cleanups.push(() => fs.rmSync(path.dirname(captureFile), { recursive: true, force: true }));
      const script = makeScript(
        captureServer(
          { sessionId: "sess-1", counts: {}, entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } },
          ["sessionId"], // old server, no new args
        ),
      );
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        mcpEnv: { CAPTURE_FILE: captureFile },
        sessionId: "sess-1",
        sinceIso: "2026-05-01T08:00:00Z",
        contentPrefix: "policy_decision:",
        timeoutMs: 8000,
      });
      expect(result.kind).toBe("ok");
      const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      // The unsupported args must NOT be sent — old server would zod-reject them.
      expect(captured.sinceIso).toBeUndefined();
      expect(captured.contentPrefix).toBeUndefined();
      expect(captured.sessionId).toBe("sess-1");
    });

    it("skips tools/list entirely when no filter is requested (back-compat hot path)", async () => {
      const captureFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "harness-capture-")),
        "args.json",
      );
      cleanups.push(() => fs.rmSync(path.dirname(captureFile), { recursive: true, force: true }));
      // Server intentionally does NOT respond to tools/list. If the
      // capability detector ran, this test would hang to the timeout.
      const script = makeScript(`#!/usr/bin/env node
const fs = require("fs");
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
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_summary") {
      fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(msg.params.arguments));
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ sessionId: "sess-1", counts: {}, entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } }) }] } }) + "\\n");
    }
    // Note: no tools/list handler.
    nl = buf.indexOf("\\n");
  }
});
`);
      const start = Date.now();
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        mcpEnv: { CAPTURE_FILE: captureFile },
        sessionId: "sess-1",
        timeoutMs: 8000,
      });
      const elapsed = Date.now() - start;
      expect(result.kind).toBe("ok");
      expect(elapsed).toBeLessThan(2000); // would be ~8s if tools/list ran and timed out
      const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      expect(captured).toEqual({ sessionId: "sess-1" });
    });
  });

  it("degrades when an empty command is given", async () => {
    const result = await queryLedgerByTag({
      mcpCommand: [],
      sessionId: "sess-1",
      timeoutMs: 1000,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toMatch(/command is empty/);
    }
  });

  it("degrades when payload is not parseable JSON", async () => {
    const noisyServer = `#!/usr/bin/env node
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
      // result.content[0].text is not JSON
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "this is not json" }] } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;
    const script = makeScript(noisyServer);
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toMatch(/no parseable payload/);
    }
  });

  it("degrades when payload is JSON but lacks the entries shape", async () => {
    const script = makeScript(happyServer({ foo: "bar" }));
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("degraded");
    if (result.kind === "degraded") {
      expect(result.reason).toMatch(/missing `entries` shape/);
    }
  });

  it("skips entries missing required fields in the wire payload", async () => {
    const script = makeScript(
      happyServer({
        entries: {
          facts: [
            { id: 1, content: "ok", createdAt: "2026-04-30T00:00:00Z" },
            { id: 2 /* missing content */, createdAt: "2026-04-30T00:00:00Z" },
            { content: "no id", createdAt: "2026-04-30T00:00:00Z" },
            { id: 3, content: "no time" },
          ],
          hypotheses: [],
          rejected: [],
          unknowns: [],
        },
      }),
    );
    const result = await queryLedgerByTag({
      mcpCommand: [script],
      sessionId: "sess-1",
      timeoutMs: 8000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.id).toBe("1");
    }
  });
});

// task a2589fa3 (2026-07-01 review): one grounding-mcp connection serves
// multiple calls. The single-init server responds with a JSON-RPC error to
// any SECOND initialize, so both assertions below fail if the session ever
// re-handshakes per call — the exact regression that would silently
// reintroduce the per-policy subprocess fan-out.
describe("openLedgerSession", () => {
  const singleInitServer = (): string => `#!/usr/bin/env node
let initCount = 0;
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
      initCount += 1;
      if (initCount > 1) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "second initialize" } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
      }
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_summary") {
      const payload = { entries: { facts: [{ id: 1, content: "review:42 ok", createdAt: "2026-04-30T00:00:00Z" }], hypotheses: [], rejected: [], unknowns: [] } };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    } else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;

  it("initializes once across multiple querySummary calls on the same session", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(singleInitServer());
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    try {
      const first = await session.querySummary({ sessionId: "sess-1" });
      const second = await session.querySummary({ sessionId: "sess-1" });
      expect(first.kind).toBe("ok");
      // A re-handshaking session would hit the single-init server's error
      // branch and degrade here.
      expect(second.kind).toBe("ok");
    } finally {
      session.dispose();
    }
  });

  it("callTool surfaces a JSON-RPC error as status 'error' (drives the record fallback)", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(singleInitServer());
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    try {
      const result = await session.callTool("ledger_add", { sessionId: "s" });
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorMessage).toBe("unknown tool");
      }
    } finally {
      session.dispose();
    }
  });

  it("degrades every call with the same reason after a failed spawn", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const session = openLedgerSession({
      mcpCommand: ["/nonexistent/grounding-mcp"],
      timeoutMs: 1000,
    });
    try {
      const query = await session.querySummary({ sessionId: "s" });
      const call = await session.callTool("ledger_add", { sessionId: "s" });
      expect(query.kind).toBe("degraded");
      expect(call.status).toBe("degraded");
    } finally {
      session.dispose();
    }
  });
});

// Reviewer follow-ups on the pooled session (task a2589fa3): the timeout
// latch, mid-session death isolation, and dispose idempotence.
describe("openLedgerSession — timeout latch and death isolation", () => {
  // Answers init + ledger_summary promptly, then goes silent on every
  // ledger_add: the first add times out, subsequent calls must be latched.
  const slowAddServer = (): string => `#!/usr/bin/env node
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
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_summary") {
      const payload = { entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    }
    // ledger_add: never respond -> caller times out.
    nl = buf.indexOf("\\n");
  }
});
`;

  // Answers init + the FIRST ledger_add, then exits the process.
  const dieAfterFirstAddServer = (): string => `#!/usr/bin/env node
let adds = 0;
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
      adds += 1;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }) + "\\n");
      if (adds === 1) { setTimeout(() => process.exit(0), 10); }
    }
    nl = buf.indexOf("\\n");
  }
});
`;

  it("latches after one timeout: subsequent calls degrade immediately without a round-trip", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(slowAddServer());
    // DECOUPLED (task 2026-07-18 subprocess-test-deflake, T-003): the
    // success sub-path (`query` below, which must absorb a cold child
    // spawn — on macOS a first-ever exec of a fresh temp script can alone
    // eat several hundred ms) and the intentional timeout trigger
    // (`first`, whose server never answers ledger_add) used to share one
    // session-level timeoutMs, so widening the success budget also
    // widened the deliberate-timeout wait. `callTool`'s new optional
    // per-call `options.timeoutMs` override (src/policies/ledger-client.ts)
    // splits them: the session itself gets the same generous default as
    // every other test in this file (absorbs contention-driven cold-spawn
    // latency), while `first` overrides down to a tight budget so it still
    // actually exercises the timeout branch and stays fast. This is
    // exactly T-003's "unit coverage for the override" case (b)+(c) in
    // spirit: session default for the ok path, a real per-call override
    // for the trigger, and the trigger's timeout still latches the
    // session for `second` below.
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    try {
      const query = await session.querySummary({ sessionId: "s" });
      expect(query.kind).toBe("ok");
      const first = await session.callTool(
        "ledger_add",
        { sessionId: "s" },
        { timeoutMs: 250 },
      );
      expect(first.status).toBe("degraded");
      if (first.status === "degraded") {
        expect(first.reason).toContain("timeout after 250ms");
      }
      // The latch: this must NOT wait another 250ms (let alone 8000ms).
      const t0 = performance.now();
      const second = await session.callTool("ledger_add", { sessionId: "s" });
      const elapsed = performance.now() - t0;
      expect(second.status).toBe("degraded");
      if (second.status === "degraded") {
        expect(second.reason).toContain("timed out earlier in this session");
      }
      expect(elapsed).toBeLessThan(500);
    } finally {
      session.dispose();
    }
  });

  it("isolates a mid-session death: later calls degrade, earlier results stand, nothing throws", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(dieAfterFirstAddServer());
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    try {
      const first = await session.callTool("ledger_add", { sessionId: "s" });
      expect(first.status).toBe("ok");
      // Give the child a moment to exit.
      await new Promise((r) => setTimeout(r, 100));
      const second = await session.callTool("ledger_add", { sessionId: "s" });
      expect(second.status).toBe("degraded");
      if (second.status === "degraded") {
        expect(second.reason).toContain("grounding-mcp");
      }
    } finally {
      session.dispose();
    }
  });

  it("dispose is a safe no-op when called twice", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(singleUseHappyServer());
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    const result = await session.querySummary({ sessionId: "s" });
    expect(result.kind).toBe("ok");
    session.dispose();
    expect(() => session.dispose()).not.toThrow();
  });

  function singleUseHappyServer(): string {
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
      const payload = { entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;
  }
});

// Task 2026-07-18 subprocess-test-deflake, T-003: dedicated unit coverage
// for `LedgerSession.callTool`'s optional per-call `options.timeoutMs`
// override (src/policies/ledger-client.ts). The "latches after one
// timeout" test above already exercises the override end-to-end in a
// realistic scenario; these three tests isolate each individual contract
// point the override is supposed to satisfy.
describe("openLedgerSession — callTool per-call timeoutMs override", () => {
  // Answers init promptly; on ledger_add, waits `delayMs` before
  // responding successfully (never hangs forever, unlike slowAddServer).
  const delayedAddServer = (delayMs: number): string => `#!/usr/bin/env node
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
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }) + "\\n");
      }, ${delayMs});
    }
    nl = buf.indexOf("\\n");
  }
});
`;

  // Never responds to ledger_add at all (reused shape of slowAddServer
  // above, duplicated locally so this describe block is self-contained).
  const neverRespondsAddServer = (): string => `#!/usr/bin/env node
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
    }
    // ledger_add: never respond -> caller times out.
    nl = buf.indexOf("\\n");
  }
});
`;

  it("(a) a short per-call override times out even though the session default would have absorbed the delay", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    // The server answers ledger_add after 300ms — comfortably inside the
    // session's own 8000ms default, so if the override weren't actually
    // taking effect this call would resolve "ok". A 100ms override must
    // still fire first.
    const script = makeScript(delayedAddServer(300));
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    try {
      const result = await session.callTool(
        "ledger_add",
        { sessionId: "s" },
        { timeoutMs: 100 },
      );
      expect(result.status).toBe("degraded");
      if (result.status === "degraded") {
        expect(result.reason).toContain("timeout after 100ms");
      }
    } finally {
      session.dispose();
    }
  });

  // (b) is a default-behaviour characterization, not a regression guard for
  // the override code path: it also passes without the T-003 src change
  // (an extra options argument is ignored in JS). (a) and (c) are the
  // guards that would go red on a revert.
  it("(b) without an override, callTool uses the session's own timeoutMs (default-behaviour characterization)", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(neverRespondsAddServer());
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 250 });
    try {
      const result = await session.callTool("ledger_add", { sessionId: "s" });
      expect(result.status).toBe("degraded");
      if (result.status === "degraded") {
        expect(result.reason).toContain("timeout after 250ms");
      }
    } finally {
      session.dispose();
    }
  });

  it("(c) a timeout triggered via a per-call override still latches the session for later calls", async () => {
    const { openLedgerSession } = await import("../../src/policies/ledger-client.js");
    const script = makeScript(neverRespondsAddServer());
    // Session default is generous; only the per-call override is tight.
    const session = openLedgerSession({ mcpCommand: [script], timeoutMs: 8000 });
    try {
      const first = await session.callTool(
        "ledger_add",
        { sessionId: "s" },
        { timeoutMs: 100 },
      );
      expect(first.status).toBe("degraded");
      if (first.status === "degraded") {
        expect(first.reason).toContain("timeout after 100ms");
      }
      // The latch must fire from the override-triggered timeout too, and
      // this second call (no override) must not wait out any budget at
      // all — proving the latch, not a second independent timeout, is
      // what resolved it.
      const t0 = performance.now();
      const second = await session.callTool("ledger_add", { sessionId: "s" });
      const elapsed = performance.now() - t0;
      expect(second.status).toBe("degraded");
      if (second.status === "degraded") {
        expect(second.reason).toContain("timed out earlier in this session");
        expect(second.reason).toContain("(100ms)");
      }
      expect(elapsed).toBeLessThan(500);
    } finally {
      session.dispose();
    }
  });
});
