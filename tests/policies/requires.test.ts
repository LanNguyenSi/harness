import { describe, expect, it } from "vitest";
import {
  buildRecordHint,
  evaluateRequires,
  RequiresEvaluationError,
  type LedgerEntry,
} from "../../src/policies/index.js";

const NOW = new Date("2026-04-30T12:00:00.000Z");

function entry(partial: Partial<LedgerEntry> & { id: string; content: string }): LedgerEntry {
  return {
    createdAt: NOW,
    ...partial,
  };
}

describe("evaluateRequires — ledger_tag (substring match)", () => {
  it("matches when an entry's content contains the tag as a substring", () => {
    const result = evaluateRequires(
      { ledger_tag: "review:42" },
      [entry({ id: "e1", content: "review:42:approved" })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedCount).toBe(1);
    expect(result.traceData.matchedEntryIds).toEqual(["e1"]);
    expect(result.traceData.windowSeconds).toBeNull();
    expect(result.traceData.countBound).toBeNull();
  });

  it("matches against the source column too", () => {
    const result = evaluateRequires(
      { ledger_tag: "preflight:harness" },
      [entry({ id: "e1", content: "ready", source: "preflight:harness" })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
  });

  it("fails with the documented reason when nothing matches", () => {
    const result = evaluateRequires(
      { ledger_tag: "review:42" },
      [entry({ id: "e1", content: "review:99:approved" })],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no matching ledger entry for tag `review:42`");
    expect(result.matchedCount).toBe(0);
  });

  it("fails on an empty ledger", () => {
    const result = evaluateRequires({ ledger_tag: "x" }, [], { now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.matchedCount).toBe(0);
    expect(result.traceData.totalEntries).toBe(0);
  });
});

describe("evaluateRequires — within (recency window)", () => {
  it("matches an entry within the window", () => {
    const ts23h = new Date(NOW.getTime() - 23 * 60 * 60 * 1000);
    const result = evaluateRequires(
      { ledger_tag: "dogfood:foo", within: "24h" },
      [entry({ id: "e1", content: "dogfood:foo:ok", createdAt: ts23h })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.traceData.windowSeconds).toBe(24 * 60 * 60);
  });

  it("excludes an entry older than the window with the documented reason", () => {
    const ts25h = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const result = evaluateRequires(
      { ledger_tag: "dogfood:foo", within: "24h" },
      [entry({ id: "e1", content: "dogfood:foo:ok", createdAt: ts25h })],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no matching entry within 24h");
    expect(result.matchedCount).toBe(0);
  });

  it("falls back to the no-tag reason when nothing matches the tag at all", () => {
    const result = evaluateRequires(
      { ledger_tag: "dogfood:foo", within: "24h" },
      [entry({ id: "e1", content: "unrelated", createdAt: NOW })],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no matching ledger entry for tag `dogfood:foo`");
  });

  it("accepts ISO-8601 durations", () => {
    const tsP1H = new Date(NOW.getTime() - 30 * 60 * 1000);
    const result = evaluateRequires(
      { ledger_tag: "x", within: "PT1H" },
      [entry({ id: "e1", content: "x", createdAt: tsP1H })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.traceData.windowSeconds).toBe(60 * 60);
  });

  it("rejects an invalid duration at evaluation time", () => {
    expect(() =>
      evaluateRequires(
        { ledger_tag: "x", within: "yesterday" },
        [entry({ id: "e1", content: "x" })],
        { now: NOW },
      ),
    ).toThrow(RequiresEvaluationError);
  });

  it("accepts ISO timestamps as createdAt strings", () => {
    const result = evaluateRequires(
      { ledger_tag: "x", within: "1h" },
      [entry({ id: "e1", content: "x", createdAt: NOW.toISOString() })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
  });

  it("Phase 5 #8: accepts SQL DATETIME createdAt as UTC for within evaluation", () => {
    // Pins the per-call-site contract that `entryTime` routes SQL
    // DATETIME strings through `parseLedgerTimestamp`. Without the
    // fix, `Date.parse("2026-04-30 11:59:30")` on a non-UTC host
    // would land outside a 60s window relative to NOW.
    const sqlDatetime = "2026-04-30 11:59:30"; // 30s before NOW (UTC)
    const result = evaluateRequires(
      { ledger_tag: "x", within: "60s" },
      [entry({ id: "e1", content: "x", createdAt: sqlDatetime })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedCount).toBe(1);
  });

  it("Phase 5 #8: a SQL DATETIME entry just outside the window is excluded", () => {
    const sqlDatetimeOld = "2026-04-30 11:58:00"; // 120s before NOW
    const result = evaluateRequires(
      { ledger_tag: "x", within: "60s" },
      [entry({ id: "e1", content: "x", createdAt: sqlDatetimeOld })],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.matchedCount).toBe(0);
  });

  it("throws on an unparseable createdAt when a window is in play", () => {
    expect(() =>
      evaluateRequires(
        { ledger_tag: "x", within: "24h" },
        [entry({ id: "bad", content: "x", createdAt: "not-a-date" })],
        { now: NOW },
      ),
    ).toThrow(/unparseable createdAt/);
  });
});

describe("evaluateRequires — Phase 5 #4: policy_decision rows are not evidence", () => {
  it("ignores policy_decision-typed entries even when their content matches the tag", () => {
    // The Phase 5 #1 dogfood symptom: a past deny's serialised payload
    // contains "ledgerTag":"review:42", which under the old substring
    // filter inflated matchedCount when the policy fired again with
    // the same tag. Post-Phase-5-#4, those rows carry type='policy_decision'
    // and are skipped at entryMatches.
    const policyDecisionContent =
      'policy_decision:review-before-merge:deny {"ledgerTag":"review:42","matched":0}';
    const result = evaluateRequires(
      { ledger_tag: "review:42" },
      [
        entry({
          id: "audit-1",
          content: policyDecisionContent,
          type: "policy_decision",
        }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.matchedCount).toBe(0);
  });

  it("legacy backstop: drops rows with policy_decision: prefix even when type='fact'", () => {
    // Pre-Phase-5-#4 audit entries were written as type='fact' with the
    // content prefix. The bucket-derived type for them is 'fact', so the
    // type guard alone wouldn't catch them. The content-prefix backstop
    // ensures upgrading users don't keep paying the pollution tax until
    // their dev ledger ages out.
    const result = evaluateRequires(
      { ledger_tag: "review:42" },
      [
        entry({
          id: "legacy-deny",
          content: 'policy_decision:review-before-merge:deny {"ledgerTag":"review:42"}',
          type: "fact",
        }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.matchedCount).toBe(0);
  });

  it("counts genuine evidence entries while ignoring colocated policy_decisions", () => {
    const result = evaluateRequires(
      { ledger_tag: "review:42" },
      [
        entry({
          id: "audit-1",
          content: 'policy_decision:review-before-merge:deny {"ledgerTag":"review:42"}',
          type: "policy_decision",
        }),
        entry({
          id: "fact-1",
          content: "review:42 approved by phase5-smoke",
          type: "fact",
        }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedCount).toBe(1);
  });
});

describe("evaluateRequires — count", () => {
  const tag = "x";

  it("passes when min is met", () => {
    const result = evaluateRequires(
      { ledger_tag: tag, count: { min: 2 } },
      [
        entry({ id: "a", content: tag }),
        entry({ id: "b", content: tag }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedCount).toBe(2);
    expect(result.traceData.countBound).toEqual({ min: 2 });
  });

  it("fails with `n of required N entries found` when min is not met", () => {
    const result = evaluateRequires(
      { ledger_tag: tag, count: { min: 2 } },
      [entry({ id: "a", content: tag })],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("1 of required 2 entries found");
  });

  it("fails when max is exceeded", () => {
    const result = evaluateRequires(
      { ledger_tag: tag, count: { max: 1 } },
      [
        entry({ id: "a", content: tag }),
        entry({ id: "b", content: tag }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("2 matching entries exceeds count.max 1");
  });

  it("describes a min..max range bound on success", () => {
    const result = evaluateRequires(
      { ledger_tag: tag, count: { min: 1, max: 3 } },
      [entry({ id: "a", content: tag }), entry({ id: "b", content: tag })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("count bound: 1..3");
    expect(result.traceData.countBound).toEqual({ min: 1, max: 3 });
  });

  it("describes a max-only bound on success", () => {
    const result = evaluateRequires(
      { ledger_tag: tag, count: { max: 5 } },
      [entry({ id: "a", content: tag })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("count bound: ≤5");
  });

  it("supports exact count", () => {
    const pass = evaluateRequires(
      { ledger_tag: tag, count: { exact: 2 } },
      [
        entry({ id: "a", content: tag }),
        entry({ id: "b", content: tag }),
      ],
      { now: NOW },
    );
    expect(pass.allowed).toBe(true);

    const fail = evaluateRequires(
      { ledger_tag: tag, count: { exact: 2 } },
      [entry({ id: "a", content: tag })],
      { now: NOW },
    );
    expect(fail.allowed).toBe(false);
    expect(fail.reason).toBe("1 of required 2 entries found");
  });

  it("rejects count.min:0 at evaluation time", () => {
    expect(() =>
      evaluateRequires(
        { ledger_tag: tag, count: { min: 0 as unknown as number } },
        [],
        { now: NOW },
      ),
    ).toThrow(/count\.min must be > 0/);
  });
});

describe("evaluateRequires — composition (within + count)", () => {
  const tag = "x";
  it("filters by window before counting", () => {
    const fresh = new Date(NOW.getTime() - 30 * 60 * 1000);
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const result = evaluateRequires(
      { ledger_tag: tag, within: "24h", count: { min: 2 } },
      [
        entry({ id: "fresh", content: tag, createdAt: fresh }),
        entry({ id: "stale", content: tag, createdAt: stale }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("1 of required 2 entries found");
    expect(result.traceData.matchedEntryIds).toEqual(["fresh"]);
  });

  it("with a `count` bound and zero tag matches, the count message wins (the within message is suppressed)", () => {
    // Pinned behavior: when count is declared, count failure dominates so the
    // user sees the same shape regardless of why matching is empty.
    const result = evaluateRequires(
      { ledger_tag: tag, within: "24h", count: { min: 1 } },
      [entry({ id: "unrelated", content: "other" })],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("0 of required 1 entries found");
  });
});

describe("buildRecordHint / recordHint plumbing (agent-tasks/32ed47cb)", () => {
  it("bare ledger_tag: hint names the content the operator must log", () => {
    expect(buildRecordHint({ ledger_tag: "review:42" }, "review:42")).toBe(
      "record an evidence-ledger entry containing `review:42`",
    );
  });

  it("with `within`: hint advertises the freshness window", () => {
    expect(
      buildRecordHint({ ledger_tag: "preflight:harness", within: "1h" }, "preflight:harness"),
    ).toBe("record an evidence-ledger entry containing `preflight:harness` within 1h");
  });

  it("with `count.min`: hint pluralises the entry count", () => {
    expect(
      buildRecordHint(
        { ledger_tag: "review:42", count: { min: 2 } },
        "review:42",
      ),
    ).toBe("record 2 evidence-ledger entries containing `review:42`");
  });

  it("with `count.exact: 1`: hint uses singular `entry`", () => {
    expect(
      buildRecordHint({ ledger_tag: "x", count: { exact: 1 } }, "x"),
    ).toBe("record 1 evidence-ledger entry containing `x`");
  });

  it("evaluateRequires surfaces the same hint on the deny path", () => {
    const result = evaluateRequires({ ledger_tag: "review:42" }, [], { now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.recordHint).toBe(
      "record an evidence-ledger entry containing `review:42`",
    );
  });

  it("evaluateRequires also carries the hint on the allow path so consumers can render the contract uniformly", () => {
    const result = evaluateRequires(
      { ledger_tag: "review:42" },
      [entry({ id: "e1", content: "review:42:approved" })],
      { now: NOW },
    );
    expect(result.allowed).toBe(true);
    expect(result.recordHint).toBe(
      "record an evidence-ledger entry containing `review:42`",
    );
  });

  it("hint accepts the un-substituted tag template (explain non-trace path)", () => {
    expect(
      buildRecordHint(
        { ledger_tag: "review:${PR_NUMBER}", within: "1h" },
        "review:${PR_NUMBER}",
      ),
    ).toBe("record an evidence-ledger entry containing `review:${PR_NUMBER}` within 1h");
  });

  it("with `count.max` only: hint flips to bound-phrasing, not record-phrasing (agent-tasks/aee9c085)", () => {
    // The "record N entries" shape is exactly wrong for count.max-only:
    // the deny is "you already have too many", recording more would
    // deny harder. The hint flips to a keep-at-or-below phrasing.
    expect(
      buildRecordHint({ ledger_tag: "review:42", count: { max: 1 } }, "review:42"),
    ).toBe("keep evidence-ledger entries containing `review:42` at or below 1");
  });

  it("with `count.max` + `within`: the bound-phrasing carries the freshness window too", () => {
    expect(
      buildRecordHint(
        { ledger_tag: "dogfood:foo", count: { max: 3 }, within: "24h" },
        "dogfood:foo",
      ),
    ).toBe("keep evidence-ledger entries containing `dogfood:foo` at or below 3 within 24h");
  });

  it("with `count.min` AND `count.max`: the min branch wins (the under-count case is the actionable failure)", () => {
    // When both bounds are declared, count.min failure dominates the
    // hint because recording more is the satisfying action; count.max
    // failure on top of that would be a different deny.
    expect(
      buildRecordHint(
        { ledger_tag: "review:42", count: { min: 2, max: 5 } },
        "review:42",
      ),
    ).toBe("record 2 evidence-ledger entries containing `review:42`");
  });

  it("evaluateRequires count.max deny surfaces the bound-phrased hint", () => {
    const result = evaluateRequires(
      { ledger_tag: "review:42", count: { max: 1 } },
      [
        entry({ id: "e1", content: "review:42:approved" }),
        entry({ id: "e2", content: "review:42:approved-again" }),
      ],
      { now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("2 matching entries exceeds count.max 1");
    expect(result.recordHint).toBe(
      "keep evidence-ledger entries containing `review:42` at or below 1",
    );
  });
});

describe("evaluateRequires — traceData", () => {
  it("captures all trace fields", () => {
    const result = evaluateRequires(
      { ledger_tag: "review:42", within: "24h", count: { min: 1 } },
      [entry({ id: "e1", content: "review:42:ok" })],
      { now: NOW },
    );
    expect(result.traceData).toEqual({
      ledgerTag: "review:42",
      windowSeconds: 24 * 60 * 60,
      totalEntries: 1,
      matchedEntryIds: ["e1"],
      countBound: { min: 1 },
      evaluatedAt: NOW.toISOString(),
    });
  });
});
