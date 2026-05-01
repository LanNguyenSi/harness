import { describe, expect, it } from "vitest";
import { intercept, type LedgerClient, type ToolEvent } from "../../src/runtime/index.js";
import type { ExtractBuiltins, LedgerEntry, LedgerQueryResult } from "../../src/policies/index.js";
import type { Policy } from "../../src/schema/index.js";
import { makeManifest, makePolicy as policy } from "../_helpers/manifest.js";

const NOW = new Date("2026-04-30T12:00:00.000Z");

const BUILTINS: ExtractBuiltins = {
  SESSION_ID: "sess-1",
  REPO: "harness",
  BRANCH: "master",
  TOOL_NAME: "mcp__agent-tasks__pull_requests_merge",
  CWD: "/home/lan/git/pandora/harness",
};

const manifest = (policies: Policy[]) => makeManifest({ policies });

function makeLedger(
  result: LedgerQueryResult,
  recordSink?: { calls: Array<{ tag: string; sessionId: string }> },
): LedgerClient & {
  queryCalls: Array<{ tag: string; sessionId: string }>;
  recordCalls: Array<{ decisionName: string; sessionId: string }>;
} {
  const queryCalls: Array<{ tag: string; sessionId: string }> = [];
  const recordCalls: Array<{ decisionName: string; sessionId: string }> = [];
  return {
    queryCalls,
    recordCalls,
    async query(tag, sessionId) {
      queryCalls.push({ tag, sessionId });
      if (recordSink) recordSink.calls.push({ tag, sessionId });
      return result;
    },
    async record(decision, sessionId) {
      recordCalls.push({ decisionName: decision.policyName, sessionId });
    },
  };
}

const REVIEW_POLICY: Policy = {
  name: "review-before-merge",
  description: "block merges without review evidence",
  trigger: {
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_merge",
    extract: { PR_NUMBER: "toolArgs.prNumber" },
  },
  requires: { ledger_tag: "review:${PR_NUMBER}" },
  hook: "h",
  enforcement: "block",
} as Policy;

const MERGE_EVENT: ToolEvent = {
  hook_event_name: "PreToolUse",
  tool_name: "mcp__agent-tasks__pull_requests_merge",
  tool_input: { prNumber: 42 },
  session_id: "sess-1",
};

const matchingEntry: LedgerEntry = {
  id: "1",
  content: "review:42:approved",
  createdAt: NOW.toISOString(),
};

describe("intercept — match + allow", () => {
  it("returns no block when ledger has a matching entry", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).toBeNull();
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.decisions[0]?.ledgerTag).toBe("review:42");
    expect(result.decisions[0]?.extractValues.PR_NUMBER).toBe("42");
    expect(ledger.queryCalls).toEqual([{ tag: "review:42", sessionId: "sess-1" }]);
  });
});

describe("intercept — match + deny", () => {
  it("emits Claude Code deny JSON when the ledger is empty", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).toEqual({
      decision: "deny",
      reason: "review-before-merge: no matching ledger entry for tag `review:42`",
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
  });
});

describe("intercept — multiple policies, deny if any", () => {
  it("denies when one of two matching policies fails", async () => {
    const second: Policy = {
      ...REVIEW_POLICY,
      name: "two-reviewers-required",
      requires: { ledger_tag: "review:${PR_NUMBER}", count: { min: 2 } },
    };
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY, second]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.decisions[1]?.outcome).toBe("deny");
    expect(result.blockJson?.reason).toContain("two-reviewers-required");
    expect(result.blockJson?.reason).toContain("1 of required 2");
  });

  it("warn enforcement does not block even on deny", async () => {
    const warnPolicy: Policy = { ...REVIEW_POLICY, enforcement: "warn" };
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([warnPolicy]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blockJson).toBeNull();
  });
});

describe("intercept — non-matching trigger", () => {
  it("skips policies whose trigger.match does not match the tool name", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, tool_name: "Bash" },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blockJson).toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });

  it("skips policies whose trigger.event does not match", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, hook_event_name: "PostToolUse" },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
  });
});

describe("intercept — bash_match", () => {
  const dogfoodPolicy: Policy = policy({
    name: "dogfood-before-release",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "^npm publish",
    },
    requires: { ledger_tag: "dogfood:${SESSION_ID}", within: "24h" },
    hook: "h",
  });

  it("matches a bash command that fits the regex and denies on missing evidence", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([dogfoodPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm publish" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blockJson).not.toBeNull();
  });

  it("skips when bash command does not match", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([dogfoodPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
  });
});

describe("intercept — degraded ledger", () => {
  it("returns warn-degraded outcome and does NOT block", async () => {
    const ledger = makeLedger({ kind: "degraded", reason: "ledger db missing" });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.decisions[0]?.reason).toBe("ledger db missing");
    expect(result.blockJson).toBeNull();
  });
});

describe("intercept — unresolved template variables", () => {
  it("flags warn-degraded when an extract source is missing", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, tool_input: {} }, // no prNumber
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.decisions[0]?.reason).toContain("PR_NUMBER");
    expect(result.blockJson).toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });
});

describe("intercept — audit log", () => {
  it("records one ledger entry per matching policy", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const second: Policy = { ...REVIEW_POLICY, name: "second" };
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY, second]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(2);
    expect(ledger.recordCalls).toHaveLength(2);
    expect(ledger.recordCalls[0]?.decisionName).toBe("review-before-merge");
    expect(ledger.recordCalls[1]?.decisionName).toBe("second");
  });

  it("does not crash if audit-write throws", async () => {
    const ledger: LedgerClient = {
      async query() {
        return { kind: "ok", entries: [] };
      },
      async record() {
        throw new Error("ledger_add failed");
      },
    };
    await expect(
      intercept({
        manifest: manifest([REVIEW_POLICY]),
        event: MERGE_EVENT,
        ledger,
        builtins: BUILTINS,
        now: NOW,
      }),
    ).resolves.toBeDefined();
  });
});
