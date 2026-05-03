import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeLedgerContent,
  encodeLedgerContent,
  payloadFromDecision,
  recordPolicyDecision,
} from "../../src/runtime/ledger-record.js";
import type { PolicyDecision } from "../../src/runtime/intercept.js";

const decision: PolicyDecision = {
  policyName: "review-before-merge",
  enforcement: "block",
  outcome: "deny",
  reason: "no matching ledger entry for tag `review:42`",
  extractValues: { PR_NUMBER: "42", SESSION_ID: "sess-1" },
  ledgerTag: "review:42",
  requiresEval: { matchedCount: 0, reason: "no matching ledger entry for tag `review:42`" },
  evaluatedAt: "2026-04-30T12:00:00.000Z",
};

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/**
 * Phase 5 #4 — script-fake server that mirrors the
 * `tests/policies/ledger-client.test.ts` capture-pattern. The server logs
 * every inbound JSON-RPC line to `logPath` so the test can later inspect
 * exactly which `ledger_add` calls landed (and in which order).
 *
 * `behavior: "reject-policy-decision"` simulates a pre-Phase-5-#4
 * grounding-mcp that does not know the new `policy_decision` enum value
 * and returns a zod / CHECK error (`code: -32602`) for that type only,
 * while still accepting the legacy `fact` type. `behavior: "always-ok"`
 * is the new-server happy path.
 */
function makeCaptureServer(opts: {
  behavior: "reject-policy-decision" | "always-ok";
}): { script: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, "calls.log");
  const file = path.join(dir, "server.js");
  const rejectBranch = `if (args.type === "policy_decision") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid type 'policy_decision'" } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
      }`;
  const acceptBranch = `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");`;
  const body = `#!/usr/bin/env node
const fs = require("node:fs");
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
    fs.appendFileSync(${JSON.stringify(logPath)}, line + "\\n");
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "ledger_add") {
      const args = msg.params.arguments;
      ${opts.behavior === "reject-policy-decision" ? rejectBranch : acceptBranch}
    }
    nl = buf.indexOf("\\n");
  }
});
`;
  fs.writeFileSync(file, body, "utf8");
  fs.chmodSync(file, 0o755);
  return { script: file, logPath };
}

describe("policy_decision encoding", () => {
  it("round-trips decision payloads through encode/decode", () => {
    const payload = payloadFromDecision(decision);
    const content = encodeLedgerContent(payload);
    expect(content.startsWith("policy_decision:review-before-merge:deny ")).toBe(true);
    const decoded = decodeLedgerContent(content);
    expect(decoded).toEqual(payload);
  });

  it("returns null for content that is not a policy_decision entry", () => {
    expect(decodeLedgerContent("review:42:approved")).toBeNull();
    expect(decodeLedgerContent("policy_decision:no-space")).toBeNull();
    expect(decodeLedgerContent("policy_decision:foo:bar not-json")).toBeNull();
  });

  it("omits requiresEval from the payload when not present (warn-degraded)", () => {
    const warnDecision: PolicyDecision = {
      ...decision,
      outcome: "warn-degraded",
      reason: "ledger db missing",
    };
    delete (warnDecision as { requiresEval?: unknown }).requiresEval;
    const payload = payloadFromDecision(warnDecision);
    expect(payload.requiresEval).toBeUndefined();
    const decoded = decodeLedgerContent(encodeLedgerContent(payload));
    expect(decoded?.requiresEval).toBeUndefined();
  });
});

describe("recordPolicyDecision writer fallback", () => {
  /**
   * Reads the capture log and returns just the `ledger_add` requests in
   * the order the server received them. Skips `initialize` and any
   * non-tools/call frames.
   */
  function readLedgerAddCalls(logPath: string): Array<{
    type: string;
    content: string;
    source?: string;
    sessionId?: string;
  }> {
    const raw = fs.readFileSync(logPath, "utf8");
    const calls: Array<{ type: string; content: string; source?: string; sessionId?: string }> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as {
        method?: string;
        params?: { name?: string; arguments?: { type?: string; content?: string; source?: string; sessionId?: string } };
      };
      if (msg.method === "tools/call" && msg.params?.name === "ledger_add") {
        const a = msg.params.arguments ?? {};
        calls.push({
          type: a.type ?? "",
          content: a.content ?? "",
          source: a.source,
          sessionId: a.sessionId,
        });
      }
    }
    return calls;
  }

  it("retries with type='fact' when an old server rejects 'policy_decision'", async () => {
    const { script, logPath } = makeCaptureServer({ behavior: "reject-policy-decision" });
    const result = await recordPolicyDecision(decision, "sess-1", {
      mcpCommand: [script],
      timeoutMs: 4000,
    });
    expect(result.ok).toBe(true);

    const calls = readLedgerAddCalls(logPath);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.type).toBe("policy_decision");
    expect(calls[1]!.type).toBe("fact");
    // The fallback content is the same prefix-encoded payload so audit-time
    // grep keeps finding it under either type.
    expect(calls[1]!.content.startsWith("policy_decision:review-before-merge:deny ")).toBe(true);
    expect(calls[1]!.sessionId).toBe("sess-1");
  });

  it("does not send a second ledger_add when the new server accepts 'policy_decision'", async () => {
    const { script, logPath } = makeCaptureServer({ behavior: "always-ok" });
    const result = await recordPolicyDecision(decision, "sess-1", {
      mcpCommand: [script],
      timeoutMs: 4000,
    });
    expect(result.ok).toBe(true);

    const calls = readLedgerAddCalls(logPath);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe("policy_decision");
  });
});
