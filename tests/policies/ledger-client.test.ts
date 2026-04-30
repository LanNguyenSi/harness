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
      timeoutMs: 4000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        id: "42",
        content: "review:42:approved",
        source: "review-bot",
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
      timeoutMs: 4000,
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
      timeoutMs: 4000,
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
      timeoutMs: 4000,
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
      timeoutMs: 4000,
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
      timeoutMs: 4000,
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
      timeoutMs: 4000,
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
      timeoutMs: 4000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.id).toBe("1");
    }
  });
});
