import { describe, expect, it } from "vitest";
import {
  decisionSortKey,
  decodeLedgerContent,
  encodeLedgerContent,
  POLICY_DECISION_TYPE,
  type PolicyDecisionPayload,
} from "../../src/io/ledger-record.js";

const payload: PolicyDecisionPayload = {
  name: "review-before-merge",
  enforcement: "block",
  outcome: "deny",
  reason: "no matching ledger entry for tag `review:42`",
  extractValues: { PR_NUMBER: "42", SESSION_ID: "sess-1" },
  ledgerTag: "review:42",
  requiresEval: { matchedCount: 0, reason: "no matching ledger entry for tag `review:42`" },
  evaluatedAt: "2026-04-30T12:00:00.000Z",
};

describe("policy_decision encoding", () => {
  it("round-trips decision payloads through encode/decode", () => {
    const content = encodeLedgerContent(payload);
    expect(content.startsWith("policy_decision:review-before-merge:deny ")).toBe(true);
    const decoded = decodeLedgerContent(content);
    expect(decoded).toEqual(payload);
  });

  it("owns the canonical row type the ledger client and audit filter on", () => {
    expect(POLICY_DECISION_TYPE).toBe("policy_decision");
  });

  it("returns null for content that is not a policy_decision entry", () => {
    expect(decodeLedgerContent("review:42:approved")).toBeNull();
    expect(decodeLedgerContent("policy_decision:no-space")).toBeNull();
    expect(decodeLedgerContent("policy_decision:foo:bar not-json")).toBeNull();
  });

  it("omits requiresEval from a decoded payload that never carried it (warn-degraded)", () => {
    const { requiresEval: _omitted, ...withoutEval } = payload;
    const warn: PolicyDecisionPayload = {
      ...withoutEval,
      outcome: "warn-degraded",
      reason: "ledger db missing",
    };
    const decoded = decodeLedgerContent(encodeLedgerContent(warn));
    expect(decoded).toEqual(warn);
    expect(decoded?.requiresEval).toBeUndefined();
  });

  it("decodes a row recorded with the removed risk fields and ignores them", () => {
    // Rows written by an earlier release carry `risk`, `environment` and
    // `whenUnclassifiedFallback`. They must still decode.
    const oldContent =
      "policy_decision:gate-risk-unscoped:deny " +
      JSON.stringify({
        name: "gate-risk-unscoped",
        outcome: "deny",
        enforcement: "block",
        reason: "unclassified action",
        ledgerTag: "risk-override:s1",
        extractValues: {},
        risk: { severity: "critical" },
        environment: { name: "production" },
        whenUnclassifiedFallback: true,
        evaluatedAt: "2026-04-30T10:00:00.000Z",
      });
    const decoded = decodeLedgerContent(oldContent);
    expect(decoded?.name).toBe("gate-risk-unscoped");
    expect(decoded?.outcome).toBe("deny");
    expect(decoded?.enforcement).toBe("block");
    expect(decoded?.reason).toBe("unclassified action");
    expect(decoded?.ledgerTag).toBe("risk-override:s1");
    expect(decoded?.extractValues).toEqual({});
    expect(decoded?.evaluatedAt).toBe("2026-04-30T10:00:00.000Z");
  });
});

describe("decisionSortKey", () => {
  const entry = {
    id: "e1",
    content: "x",
    createdAt: "2026-04-30T12:00:00Z",
  };

  it("prefers the millisecond-precision evaluatedAt of the payload", () => {
    expect(decisionSortKey(entry, payload)).toBe(Date.parse("2026-04-30T12:00:00.000Z"));
    const later = { ...payload, evaluatedAt: "2026-04-30T12:00:00.500Z" };
    expect(decisionSortKey(entry, later)).toBe(decisionSortKey(entry, payload) + 500);
  });

  it("falls back to the entry's createdAt when evaluatedAt is unparseable", () => {
    const broken = { ...payload, evaluatedAt: "not a date" };
    expect(decisionSortKey(entry, broken)).toBe(Date.parse("2026-04-30T12:00:00Z"));
    const dated = { ...entry, createdAt: new Date("2026-05-01T00:00:00Z") };
    expect(decisionSortKey(dated, broken)).toBe(Date.parse("2026-05-01T00:00:00Z"));
  });
});
