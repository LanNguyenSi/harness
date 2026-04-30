import { describe, expect, it } from "vitest";
import {
  decodeLedgerContent,
  encodeLedgerContent,
  payloadFromDecision,
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
