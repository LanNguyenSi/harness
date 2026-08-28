import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit } from "../../src/cli/audit.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  approvedLedgerTagFor,
  autoApprovedLedgerTagFor,
} from "../../src/policy-packs/builtin/understanding-before-execution/index.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { makeDecisionEntry as decisionEntry } from "../_helpers/decision.js";

/** agent-tasks 5ad63b01: a raw ledger fact entry, the shape the audit
 * approvals section reads directly (never `decodeLedgerContent`-parsed). */
function factEntry(content: string, createdAt: string, source = "test-fixture"): LedgerEntry {
  return { id: createdAt + content, content, source, createdAt };
}

// The session-id resolver reads $CLAUDE_CODE_SESSION_ID ahead of the
// legacy $CLAUDE_SESSION_ID (task 6562b9f6); clear both so the dev
// host's exported canonical var doesn't shadow per-test legacy-env reads.
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
beforeEach(() => {
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});
afterEach(() => {
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
});

const NOW = new Date("2026-04-30T12:00:00.000Z");

const FIXTURE = [
  decisionEntry({ policyName: "review-before-merge", outcome: "deny", reason: "missing review" }, "2026-04-30T08:00:00.000Z"),
  decisionEntry({ policyName: "review-before-merge", outcome: "allow", reason: "1 matching entry" }, "2026-04-30T11:00:00.000Z"),
  decisionEntry({ policyName: "dogfood-before-release", outcome: "warn-degraded", reason: "ledger db missing" }, "2026-04-30T11:30:00.000Z"),
  decisionEntry({ policyName: "two-reviewers-required", outcome: "deny", reason: "1 of required 2 entries found" }, "2026-04-30T11:45:00.000Z"),
  // Unrelated entry that decodeLedgerContent ignores.
  {
    id: "unrelated",
    content: "review:42:approved",
    createdAt: "2026-04-30T11:00:00.000Z",
  },
];

const MANIFEST_PATH =
  // any valid manifest works since fetchLedger is injected.
  new URL("../../docs/examples/full-manifest.yaml", import.meta.url).pathname;

describe("audit — happy path", () => {
  it("lists every policy decision in the default 24h window with table output", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(4);
    const headerLine = result.output.split("\n", 1)[0]!;
    expect(headerLine).toMatch(/timestamp\s+policy\s+outcome\s+reason/);
    expect(result.output).toContain("review-before-merge");
    expect(result.output).toContain("dogfood-before-release");
    // Sorted ascending by timestamp.
    const idxFirst = result.output.indexOf("08:00");
    const idxLast = result.output.indexOf("11:45");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxLast).toBeGreaterThan(idxFirst);
  });

  it("emits parseable JSON under --json", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      json: true,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.decisions).toHaveLength(4);
    expect(parsed.decisions[0].name).toBe("review-before-merge");
  });
});

describe("audit — M7 whenUnclassifiedFallback render", () => {
  // One fail-closed (unclassified) deny carrying the flag, one ordinary
  // classified deny without it. Both timestamps sit inside NOW's 24h window.
  const M7_FIXTURE = [
    decisionEntry(
      {
        policyName: "gate-risk-unscoped",
        outcome: "deny",
        reason: "unclassified action",
        whenUnclassifiedFallback: true,
      },
      "2026-04-30T10:00:00.000Z",
    ),
    decisionEntry(
      { policyName: "review-before-merge", outcome: "deny", reason: "missing review" },
      "2026-04-30T11:00:00.000Z",
    ),
  ];

  it("--json carries whenUnclassifiedFallback on a fail-closed row and omits it on a classified row", async () => {
    // Mutation guard: removing the rowsFromEntries spread in audit.ts makes the
    // flagged assertion go red (the field is absent after decode); injecting it
    // unconditionally makes the classified (negative-control) assertion go red.
    const result = await audit({
      configPath: MANIFEST_PATH,
      json: true,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: M7_FIXTURE }),
    });
    const parsed = JSON.parse(result.output);
    const flagged = parsed.decisions.find(
      (d: { name: string }) => d.name === "gate-risk-unscoped",
    );
    const classified = parsed.decisions.find(
      (d: { name: string }) => d.name === "review-before-merge",
    );
    expect(flagged.whenUnclassifiedFallback).toBe(true);
    expect(classified.whenUnclassifiedFallback).toBeUndefined();
  });

  it("table output annotates the reason cell with [unclassified-fallback] only for a fail-closed row", async () => {
    // Mutation guard: removing the formatTable annotation in audit.ts makes the
    // first assertion go red; annotating unconditionally makes the second red.
    const result = await audit({
      configPath: MANIFEST_PATH,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: M7_FIXTURE }),
    });
    const lines = result.output.split("\n");
    const flaggedLine = lines.find((l) => l.includes("gate-risk-unscoped"))!;
    const classifiedLine = lines.find((l) => l.includes("review-before-merge"))!;
    expect(flaggedLine).toContain("[unclassified-fallback]");
    expect(classifiedLine).not.toContain("[unclassified-fallback]");
  });
});

describe("audit — filters", () => {
  it("--since 1h drops entries older than 1h before now", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "1h",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    // Only the entries between 11:00 and 12:00 (i.e. 11:00, 11:30, 11:45).
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.every((d) => Date.parse(d.timestamp) >= NOW.getTime() - 60 * 60 * 1000)).toBe(true);
  });

  it("--policy filters to a single policy name", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      policy: "review-before-merge",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((d) => d.name === "review-before-merge")).toBe(true);
  });

  it("--outcome deny filters to denials only", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      outcome: "deny",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every((d) => d.outcome === "deny")).toBe(true);
  });

  it("--outcome deny-degraded is a valid filter and matches seeded rows (task f1aea826)", async () => {
    // Pins the VALID_OUTCOMES sync: before this row existed, passing the
    // new outcome value returned EX_USAGE while the runtime happily
    // recorded such rows.
    const withDegradedDeny = [
      ...FIXTURE,
      decisionEntry(
        {
          policyName: "review-before-merge",
          outcome: "deny-degraded",
          reason: "grounding-mcp timeout after 1ms",
        },
        "2026-04-30T11:50:00.000Z",
      ),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      outcome: "deny-degraded",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: withDegradedDeny }),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny-degraded");
  });

  it("filters compose: --policy + --outcome + --since", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      policy: "review-before-merge",
      outcome: "allow",
      since: "2h",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: FIXTURE }),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
  });
});

describe("audit — Phase 5 #8: SQL DATETIME timestamp filtering", () => {
  // Regression for the bug surfaced by `dogfood/phase5/run-smoke.sh`:
  // SQLite's `datetime('now')` writes UTC text in `YYYY-MM-DD HH:MM:SS`
  // form (no `T`, no `Z`). Pre-fix `Date.parse` interpreted that as
  // local time, so on any non-UTC host a `--since` window narrower than
  // the local TZ offset silently filtered out fresh entries. The
  // production fix (parseLedgerTimestamp) treats the space-separated
  // form as UTC; this test pins that contract.
  const NOW_SQL = new Date("2026-05-01T08:34:00.000Z");

  it("--since 5m includes entries written ~10s before now in SQL DATETIME form", async () => {
    const sqlDatetime = "2026-05-01 08:33:50"; // 10s before NOW_SQL, UTC
    const entries = [
      decisionEntry(
        { policyName: "review-before-merge", outcome: "deny", reason: "no matching" },
        sqlDatetime,
      ),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "5m",
      now: NOW_SQL,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.timestamp).toBe(sqlDatetime);
  });

  it("--since 60s drops a SQL DATETIME entry that is older than 60s", async () => {
    const sqlDatetimeOld = "2026-05-01 08:32:30"; // 90s before NOW_SQL
    const entries = [
      decisionEntry(
        { policyName: "review-before-merge", outcome: "allow", reason: "ok" },
        sqlDatetimeOld,
      ),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "60s",
      now: NOW_SQL,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.decisions).toHaveLength(0);
  });

  it("sorts SQL DATETIME and ISO-with-Z entries onto the same axis", async () => {
    const entries = [
      decisionEntry(
        { policyName: "review-before-merge", outcome: "allow", reason: "second" },
        "2026-05-01T08:33:55.000Z",
      ),
      decisionEntry(
        { policyName: "review-before-merge", outcome: "deny", reason: "first" },
        "2026-05-01 08:33:50",
      ),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "5m",
      now: NOW_SQL,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.decisions.map((d) => d.outcome)).toEqual(["deny", "allow"]);
  });
});

describe("audit — Phase 5 #9: order by ms-precision evaluatedAt", () => {
  // Pre-fix the audit table sorted by ledger createdAt (1-second
  // precision), so two decisions evaluated within the same SQL second
  // appeared in stable insertion order rather than chronological order.
  // The fix uses the decoded payload's evaluatedAt (ms precision) as
  // the sort key while keeping createdAt as the displayed timestamp.
  const NOW_TIE = new Date("2026-05-01T08:34:00.000Z");

  it("orders sub-second-collision entries by evaluatedAt, not by ledger createdAt", async () => {
    const sameSecond = "2026-05-01 08:33:24";
    // Insertion order: allow (later evaluatedAt) before deny (earlier).
    // A sort by createdAt would tie-break to insertion order and
    // mis-display the allow as the earlier row.
    const entries = [
      decisionEntry(
        {
          policyName: "review-before-merge",
          outcome: "allow",
          reason: "second fire",
          evaluatedAt: "2026-05-01T08:33:24.668Z",
        },
        sameSecond,
      ),
      decisionEntry(
        {
          policyName: "review-before-merge",
          outcome: "deny",
          reason: "first fire",
          evaluatedAt: "2026-05-01T08:33:23.780Z",
        },
        sameSecond,
      ),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      now: NOW_TIE,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.map((d) => d.outcome)).toEqual(["deny", "allow"]);
  });
});

describe("audit — Phase 5 #2: sessionId env fallback", () => {
  it("uses $CLAUDE_SESSION_ID when --session is not given", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "env-session-77";
    try {
      let observedSessionId: string | undefined;
      await audit({
        configPath: MANIFEST_PATH,
        now: NOW,
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return { kind: "ok", entries: [] };
        },
      });
      expect(observedSessionId).toBe("env-session-77");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("explicit --session beats $CLAUDE_SESSION_ID", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "env-session-77";
    try {
      let observedSessionId: string | undefined;
      await audit({
        configPath: MANIFEST_PATH,
        now: NOW,
        sessionId: "flag-session-99",
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return { kind: "ok", entries: [] };
        },
      });
      expect(observedSessionId).toBe("flag-session-99");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("falls back to 'default' when env, flag, and transcript discovery all miss", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      let observedSessionId: string | undefined;
      await audit({
        configPath: MANIFEST_PATH,
        now: NOW,
        // Stub the transcript scan so the test stays hermetic.
        sessionDiscovery: { discover: () => null },
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return { kind: "ok", entries: [] };
        },
      });
      expect(observedSessionId).toBe("default");
    } finally {
      if (saved !== undefined) process.env.CLAUDE_SESSION_ID = saved;
    }
  });

  it("prefers $CLAUDE_CODE_SESSION_ID over legacy $CLAUDE_SESSION_ID (task 6562b9f6)", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "code-env-sess";
    process.env.CLAUDE_SESSION_ID = "legacy-env-sess";
    let observedSessionId: string | undefined;
    await audit({
      configPath: MANIFEST_PATH,
      now: NOW,
      fetchLedger: async (sid) => {
        observedSessionId = sid;
        return { kind: "ok", entries: [] };
      },
    });
    expect(observedSessionId).toBe("code-env-sess");
  });

  it("discovers the live session from the newest transcript when no env or flag", async () => {
    const saved = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      let observedSessionId: string | undefined;
      await audit({
        configPath: MANIFEST_PATH,
        now: NOW,
        sessionDiscovery: { discover: () => "discovered-session-88" },
        fetchLedger: async (sid) => {
          observedSessionId = sid;
          return { kind: "ok", entries: [] };
        },
      });
      expect(observedSessionId).toBe("discovered-session-88");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = saved;
    }
  });
});

describe("audit — empty window", () => {
  it("prints the documented empty-window message and exits 0", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      since: "30m",
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: [] }),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.output).toBe("no policy decisions in the last 30m\n");
  });
});

describe("audit — degraded ledger", () => {
  it("throws EX_UNAVAILABLE when the ledger client returns degraded", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        now: NOW,
        fetchLedger: async () => ({
          kind: "degraded",
          reason: "grounding-mcp not declared",
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(69);
    expect(err.message).toMatch(/ledger unreachable: grounding-mcp not declared/);
  });
});

describe("audit — input validation", () => {
  it("rejects a bad --since duration with EX_USAGE", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        since: "yesterday",
        fetchLedger: async () => ({ kind: "ok", entries: [] }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
  });

  it("rejects an invalid --outcome with EX_USAGE", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        outcome: "maybe" as never,
        fetchLedger: async () => ({ kind: "ok", entries: [] }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(64);
  });
});

describe("audit: approvals section", () => {
  // A fixed session id (not `--session`-omitted) so every test here is
  // hermetic against the real `resolveReadSessionId` discovery fallback:
  // the approvals section matches tags built from the resolved session
  // id, so an un-pinned id would make the fixture tags a moving target.
  //
  // M2: deliberately does NOT contain the word "approvals", a fixture id
  // like the earlier `sess-approvals` makes a bare `toContain("approvals")`
  // assertion pass even with the audit's own `approvals` header deleted,
  // since the session id string itself supplies the match.
  const SID = "sess-ug-1";
  const AUTO_TAG = autoApprovedLedgerTagFor(SID);
  const HUMAN_TAG = approvedLedgerTagFor(SID);

  it("renders a raw understanding-auto-approved fact in both text and --json output, with the exact rendered section shape", async () => {
    const entries = [factEntry(AUTO_TAG, "2026-04-30T11:00:00.000Z", "auto-approve-path")];

    const textResult = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(textResult.approvals).toHaveLength(1);
    // M2 mutation guard: assert the rendered shape, not mere substring
    // presence. Deleting the `\napprovals\n` header in audit.ts must make
    // this go red; it cannot, with a fixture sid containing "approvals",
    // under the old `toContain("approvals")` assertion.
    expect(
      textResult.output.startsWith("no policy decisions in the last 24h\n\napprovals\ntimestamp"),
    ).toBe(true);
    const section = textResult.output.slice(textResult.output.indexOf("\napprovals\n"));
    const secLines = section.split("\n");
    expect(secLines[1]).toBe("approvals");
    expect(secLines[2]).toMatch(/^timestamp\s+tag\s+source$/);
    expect(secLines[3]).toMatch(/^-+\s+-+\s+-+$/); // renderTable's separator row
    expect(secLines[4]).toContain(AUTO_TAG);
    expect(secLines[4]).toContain("auto-approve-path");
    // Exactly one data row: nothing else non-empty after it.
    expect(secLines.slice(5).filter((l) => l.length > 0)).toHaveLength(0);

    const jsonResult = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      json: true,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    const parsed = JSON.parse(jsonResult.output);
    expect(parsed.approvals).toHaveLength(1);
    expect(parsed.approvals[0].tag).toBe(AUTO_TAG);
    expect(parsed.approvals[0].source).toBe("auto-approve-path");
    expect(parsed.approvals[0].timestamp).toBe("2026-04-30T11:00:00.000Z");
  });

  it("never renders the pre-existing review:42:approved fixture, even alongside a real approval fact (mutation guard A)", async () => {
    const entries = [
      { id: "unrelated", content: "review:42:approved", createdAt: "2026-04-30T11:00:00.000Z" },
      factEntry(AUTO_TAG, "2026-04-30T11:05:00.000Z", "auto-approve-path"),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.tag).toBe(AUTO_TAG);
    expect(result.output).not.toContain("review:42:approved");
  });

  it("carries an empty approvals array in --json, and omits the section in text, when there are no approval facts", async () => {
    const jsonResult = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      json: true,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: [] }),
    });
    const parsed = JSON.parse(jsonResult.output);
    expect(parsed.approvals).toEqual([]);

    const textResult = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: [] }),
    });
    expect(textResult.output).toBe("no policy decisions in the last 24h\n");
    expect(textResult.output).not.toContain("approvals");
  });

  it("excludes an approval fact older than the --since window (mutation guard B)", async () => {
    const entries = [
      // 36h before NOW: outside the default 24h window.
      factEntry(HUMAN_TAG, "2026-04-29T00:00:00.000Z", "harness-approve-understanding"),
      // 1h before NOW: inside.
      factEntry(AUTO_TAG, "2026-04-30T11:00:00.000Z", "auto-approve-path"),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.tag).toBe(AUTO_TAG);
  });

  it("--session filters the approvals section to the matching <sid> in the tag", async () => {
    const otherSid = "sess-other";
    const entries = [
      factEntry(
        autoApprovedLedgerTagFor(otherSid),
        "2026-04-30T11:00:00.000Z",
        "auto-approve-path",
      ),
      factEntry(AUTO_TAG, "2026-04-30T11:05:00.000Z", "auto-approve-path"),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.tag).toBe(AUTO_TAG);
  });

  it("renders a forced human approval tag (`:forced:<field>` suffix) in the approvals section", async () => {
    const forcedTag = `${HUMAN_TAG}:forced:priorArt`;
    const entries = [
      factEntry(forcedTag, "2026-04-30T11:00:00.000Z", "harness-approve-understanding"),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.tag).toBe(forcedTag);
  });

  it("drops an approval fact with an unparseable createdAt, consistent with the decisions path", async () => {
    // parseLedgerTimestamp("not-a-timestamp") is NaN, so the `--since`
    // cutoff comparison (`>= cutoffMs`) is false and the row is dropped , 
    // the same fate decodeLedgerContent-parsed decision rows get. Pinned
    // here as a test rather than a code change: no explicit handling
    // needed, the existing filter already covers it.
    const entries: LedgerEntry[] = [
      { id: "bad", content: AUTO_TAG, source: "auto-approve-path", createdAt: "not-a-timestamp" },
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.approvals).toEqual([]);
    expect(result.output).not.toContain("approvals");
  });
});

describe("audit: approvals section: server fetch shape (M1)", () => {
  const SID = "sess-ug-1";
  const AUTO_TAG = autoApprovedLedgerTagFor(SID);

  it("issues exactly two ledger fetches: the policy_decision fetch, then a second contentPrefix: 'understanding-' fetch reusing the same sinceIso", async () => {
    // Call-recording fake: pushes every (sessionId, filters) pair it is
    // called with. A single-fetch regression (reusing the first fetch's
    // result instead of issuing a second, approvals-scoped fetch) would
    // collapse this to one recorded call.
    const calls: { sessionId: string; filters?: { sinceIso?: string; contentPrefix?: string } }[] =
      [];
    const entries = [factEntry(AUTO_TAG, "2026-04-30T11:00:00.000Z", "auto-approve-path")];
    await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async (sessionId, filters) => {
        calls.push({ sessionId, filters });
        return { kind: "ok", entries };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.filters?.contentPrefix).toBe("policy_decision:");
    expect(calls[1]?.filters?.contentPrefix).toBe("understanding-");
    expect(calls[1]?.filters?.sinceIso).toBeDefined();
    expect(calls[1]?.filters?.sinceIso).toBe(calls[0]?.filters?.sinceIso);
  });

  it("regression guard: a fetchLedger fake that HONOURS contentPrefix still renders the approval fact (would go empty if the second fetch were dropped)", async () => {
    // This fake filters its return set by contentPrefix the way a real
    // capability-detecting grounding-mcp does. If audit.ts is ever changed
    // to skip the second fetch and reuse the first (policy_decision-scoped)
    // fetch's result for approvals too, no entry survives the
    // "understanding-" prefix filter under that fake and this test goes
    // red, verified by temporarily reverting to a single fetch below.
    const decisionEntries = [
      decisionEntry(
        { policyName: "review-before-merge", outcome: "deny", reason: "x" },
        "2026-04-30T11:00:00.000Z",
      ),
    ];
    const approvalEntries = [factEntry(AUTO_TAG, "2026-04-30T11:05:00.000Z", "auto-approve-path")];
    const all = [...decisionEntries, ...approvalEntries];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async (_sid, filters) => {
        const prefix = filters?.contentPrefix;
        const matched = prefix ? all.filter((e) => e.content.startsWith(prefix)) : all;
        return { kind: "ok", entries: matched };
      },
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]?.tag).toBe(AUTO_TAG);
  });
});

describe("audit: approvals section: untrusted content flattening and capping (M3)", () => {
  const SID = "sess-ug-1";
  const AUTO_TAG = autoApprovedLedgerTagFor(SID);
  const HUMAN_TAG = approvedLedgerTagFor(SID);

  it("flattens a newline-carrying tag into a single rendered row instead of a forged-looking second row", async () => {
    // Matching is exact-or-forced-prefix (`rowsFromApprovalEntries`), so
    // the newline has to sit inside the `:forced:<field>` suffix to still
    // be recognised as an approval fact at all.
    const forgedTag = `${HUMAN_TAG}:forced:field\nfake-second-row:approved`;
    const entries = [factEntry(forgedTag, "2026-04-30T11:00:00.000Z", "auto-approve-path")];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    const section = result.output.slice(result.output.indexOf("\napprovals\n"));
    const nonEmptyLines = section.split("\n").filter((l) => l.length > 0);
    // "approvals" header + column header + dash separator + exactly one
    // data row, never a fifth line the forged newline could have added.
    expect(nonEmptyLines).toHaveLength(4);
    expect(nonEmptyLines[3]).toContain("fake-second-row:approved");
    expect(nonEmptyLines[3]?.includes("\n")).toBe(false);
  });

  it("caps an overlong tag at MAX_CELL_LEN with an ellipsis marker", async () => {
    const overlong = "x".repeat(500);
    const forcedTag = `${HUMAN_TAG}:forced:${overlong}`;
    const entries = [
      factEntry(forcedTag, "2026-04-30T11:00:00.000Z", "harness-approve-understanding"),
    ];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries }),
    });
    expect(result.output).toContain("…");
    expect(result.output).not.toContain(forcedTag);
  });
});

describe("audit: approvals section: degraded approvals fetch degrades softly (M4)", () => {
  const SID = "sess-ug-1";

  it("text: renders the decisions table plus one 'approvals unavailable' line, and writes one stderr line, when only the approvals fetch degrades", async () => {
    const stderrLines: string[] = [];
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      stderr: (s) => stderrLines.push(s),
      fetchLedger: async (_sid, filters) => {
        if (filters?.contentPrefix === "understanding-") {
          return { kind: "degraded", reason: "grounding-mcp timeout" };
        }
        return { kind: "ok", entries: FIXTURE };
      },
    });
    expect(result.decisions).toHaveLength(4);
    expect(result.approvals).toEqual([]);
    expect(result.approvalsUnavailable).toBe("grounding-mcp timeout");
    expect(result.output).toContain("review-before-merge");
    expect(result.output).toContain("approvals unavailable: grounding-mcp timeout");
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toBe("approvals unavailable: grounding-mcp timeout\n");
  });

  it("json: carries approvalsUnavailable and an empty approvals array when only the approvals fetch degrades", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      json: true,
      now: NOW,
      stderr: () => {},
      fetchLedger: async (_sid, filters) => {
        if (filters?.contentPrefix === "understanding-") {
          return { kind: "degraded", reason: "grounding-mcp timeout" };
        }
        return { kind: "ok", entries: FIXTURE };
      },
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.decisions).toHaveLength(4);
    expect(parsed.approvals).toEqual([]);
    expect(parsed.approvalsUnavailable).toBe("grounding-mcp timeout");
  });

  it("the policy-decision fetch degrading still throws EX_UNAVAILABLE (exit code stays tied to that fetch only)", async () => {
    let caught: unknown;
    try {
      await audit({
        configPath: MANIFEST_PATH,
        sessionId: SID,
        now: NOW,
        fetchLedger: async (_sid, filters) => {
          if (filters?.contentPrefix === "understanding-") {
            return { kind: "ok", entries: [] };
          }
          return { kind: "degraded", reason: "grounding-mcp not declared" };
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const err = caught as HarnessExitError;
    expect(err.exitCode).toBe(69);
  });
});

describe("audit: approvals section: sessionId in JSON (L2)", () => {
  const SID = "sess-ug-1";

  it("--json carries the resolved sessionId", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      json: true,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: [] }),
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.sessionId).toBe(SID);
  });

  it("text output stays byte-identical to the documented empty-window message when the approvals section is empty", async () => {
    const result = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async () => ({ kind: "ok", entries: [] }),
    });
    expect(result.output).toBe("no policy decisions in the last 24h\n");
  });
});

describe("audit: decisions table + approvals section combined", () => {
  const SID = "sess-ug-1";
  const AUTO_TAG = autoApprovedLedgerTagFor(SID);

  it("renders the decisions table byte-identical to the decisions-only rendering, followed by exactly one blank line then the approvals section", async () => {
    const decisionOnly = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async (_sid, filters) =>
        filters?.contentPrefix === "understanding-"
          ? { kind: "ok", entries: [] }
          : { kind: "ok", entries: FIXTURE },
    });

    const approvalEntries = [factEntry(AUTO_TAG, "2026-04-30T11:05:00.000Z", "auto-approve-path")];
    const combined = await audit({
      configPath: MANIFEST_PATH,
      sessionId: SID,
      now: NOW,
      fetchLedger: async (_sid, filters) =>
        filters?.contentPrefix === "understanding-"
          ? { kind: "ok", entries: approvalEntries }
          : { kind: "ok", entries: FIXTURE },
    });

    const decisionsPortion = combined.output.slice(0, decisionOnly.output.length);
    expect(decisionsPortion).toBe(decisionOnly.output);
    const rest = combined.output.slice(decisionOnly.output.length);
    // decisionOnly.output already ends with the table's own trailing "\n";
    // `rest` starting with exactly one more "\n" before "approvals" is the
    // one blank line the spec calls for, two would show as "\n\n" here.
    expect(rest.startsWith("\napprovals\n")).toBe(true);
    expect(rest.startsWith("\n\n")).toBe(false);
  });
});
