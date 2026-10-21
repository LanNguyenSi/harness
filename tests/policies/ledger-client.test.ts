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
    // task e9b4b5c3 (review fix round): hoisted so the fixture template's
    // env read and every mcpEnv object below (both the positive-control and
    // the hot-path test) key off one literal. Renaming the env var only
    // here — with nothing left to independently rename in either test —
    // closes the gap where the hot-path test's own `mcpEnv` copy of the
    // name could silently drift from the fixture's without either test
    // going red.
    const LIST_MARKER_ENV = "LIST_MARKER_FILE";

    /**
     * Capability-aware fake: implements tools/list with a configurable
     * inputSchema for ledger_summary. tools/call records the args it
     * received so the test can assert what got pushed server-side.
     *
     * task e9b4b5c3 (review follow-up on task dc578d67): also writes
     * `process.env[LIST_MARKER_ENV]` (when set) from inside the tools/list
     * branch, before deciding whether to answer it. This is the marker-file
     * pin: the "falls back to client-side filtering..." test below asserts
     * the marker file exists (tools/list is advertised and answered), while
     * the back-compat hot-path test — which reuses this same fixture via
     * `respondToList: false` — asserts it does NOT exist (tools/list is
     * recorded but deliberately never answered). Both tests now share one
     * fixture and one env-var constant, so neither a renamed env var nor a
     * deleted marker write can defuse one test without also failing the
     * other.
     */
    const captureServer = (
      payload: object,
      supportedArgs: string[] = ["sessionId"],
      respondToList = true,
    ): string => {
      const listBranch = respondToList
        ? `const props = {};
      for (const k of ${JSON.stringify(supportedArgs)}) props[k] = { type: "string" };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ledger_summary", inputSchema: { type: "object", properties: props } }] } }) + "\\n");`
        : `// Record only. Deliberately no response, so a detector that runs here
      // still hangs exactly as it did before this marker was added.`;
      return `#!/usr/bin/env node
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
      if (process.env[${JSON.stringify(LIST_MARKER_ENV)}]) fs.writeFileSync(process.env[${JSON.stringify(LIST_MARKER_ENV)}], "1");
      ${listBranch}
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_summary") {
      if (captureFile) fs.writeFileSync(captureFile, JSON.stringify(msg.params.arguments));
      const payload = ${JSON.stringify(payload)};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) + "\\n");
    }
    nl = buf.indexOf("\\n");
  }
});
`;
    };

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
        // Explicit empty string (not omitted) so a real LIST_MARKER_FILE
        // sitting in the ambient process.env cannot leak into this child —
        // mcpEnv is spread onto {...process.env, ...mcpEnv}, and the
        // fixture's write guard treats an empty string as unset.
        mcpEnv: { CAPTURE_FILE: captureFile, [LIST_MARKER_ENV]: "" },
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
      // Sits next to captureFile, so the same cleanup covers it. This
      // fixture's tools/list branch actually ANSWERS (unlike the
      // back-compat hot-path test's fixture below, which deliberately
      // never responds — both now share this same `captureServer` fixture
      // via the `respondToList` flag), so it is the positive half of the
      // marker-file pin (task e9b4b5c3): asserting `toBe(true)` here pins
      // the LIST_MARKER_ENV env-var name and the write path from the side
      // where tools/list fires, pairing with that test's `toBe(false)`
      // from the side where it must not.
      const listMarker = path.join(path.dirname(captureFile), "tools-list-seen");
      const script = makeScript(
        captureServer(
          { sessionId: "sess-1", counts: {}, entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } },
          ["sessionId"], // old server, no new args
        ),
      );
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        mcpEnv: { CAPTURE_FILE: captureFile, [LIST_MARKER_ENV]: listMarker },
        sessionId: "sess-1",
        sinceIso: "2026-05-01T08:00:00Z",
        contentPrefix: "policy_decision:",
        timeoutMs: 8000,
      });
      expect(result.kind).toBe("ok");
      expect(fs.existsSync(listMarker)).toBe(true);
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
      // Sits next to captureFile, so the same cleanup covers it.
      const listMarker = path.join(path.dirname(captureFile), "tools-list-seen");
      // The server RECORDS a tools/list request but never answers it, so the
      // hot path is observable directly: if the capability detector ran, the
      // marker exists. Asserting on the marker rather than on elapsed
      // wall-clock time keeps this deterministic under load — the previous
      // `elapsed < 2000` budget measured 2113ms once on a loaded machine and
      // failed spuriously.
      //
      // task e9b4b5c3 (review fix round): reuses the shared `captureServer`
      // fixture above (`respondToList: false`) instead of an inline copy of
      // the same script, and the shared `LIST_MARKER_ENV` constant instead
      // of a locally-typed env-var name. Deleting the marker write, or
      // renaming the env var, now breaks this test AND the positive-control
      // test above together — neither can be silently defused alone.
      //
      // The per-test timeout below is load-bearing for the DIAGNOSTIC, not for
      // the happy path (which takes well under a second). A regressed run
      // issues tools/list, gets no answer, and burns the full 8000ms client
      // budget. Under vitest's 5000ms default testTimeout the test would then
      // die with a bare "Test timed out in 5000ms" and never reach the marker
      // assertion, so the failure would say nothing about tools/list. Giving
      // the test more room than the client budget lets the probe complete and
      // fail on the marker with a message that names the actual regression.
      const script = makeScript(
        captureServer(
          { sessionId: "sess-1", counts: {}, entries: { facts: [], hypotheses: [], rejected: [], unknowns: [] } },
          ["sessionId"],
          false, // respondToList: hot path must never advertise tools/list
        ),
      );
      const result = await queryLedgerByTag({
        mcpCommand: [script],
        mcpEnv: { CAPTURE_FILE: captureFile, [LIST_MARKER_ENV]: listMarker },
        sessionId: "sess-1",
        timeoutMs: 8000,
      });
      expect(result.kind).toBe("ok");
      expect(fs.existsSync(listMarker)).toBe(false);
      const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      expect(captured).toEqual({ sessionId: "sess-1" });
    }, 12000);
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
