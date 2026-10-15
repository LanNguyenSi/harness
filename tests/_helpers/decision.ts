// Shared `policy_decision` ledger-entry test fixture.
//
// The tests that read old policy-decision rows (audit) need near-identical
// `decisionEntry()` builders. Centralising the shape here keeps the
// defaults consistent (one place to update when, e.g., the
// `requiresEval.matchedCount` default changes).

import type { LedgerEntry } from "../../src/policies/index.js";
import {
  encodeLedgerContent,
  type PolicyDecisionPayload,
} from "../../src/io/ledger-record.js";

/** The fields of a decision a fixture sets; `policyName` becomes the row's `name`. */
export interface PolicyDecision {
  policyName: string;
  enforcement: PolicyDecisionPayload["enforcement"];
  outcome: PolicyDecisionPayload["outcome"];
  reason: string;
  extractValues: Record<string, string>;
  ledgerTag: string;
  requiresEval?: { matchedCount: number; reason: string };
  evaluatedAt: string;
}

function payloadFromDecision(decision: PolicyDecision): PolicyDecisionPayload {
  return {
    name: decision.policyName,
    outcome: decision.outcome,
    enforcement: decision.enforcement,
    reason: decision.reason,
    ledgerTag: decision.ledgerTag,
    extractValues: decision.extractValues,
    ...(decision.requiresEval && { requiresEval: decision.requiresEval }),
    evaluatedAt: decision.evaluatedAt,
  };
}

const DEFAULTS: Omit<PolicyDecision, "policyName"> = {
  enforcement: "block",
  outcome: "deny",
  reason: "no matching ledger entry for tag `review:42`",
  extractValues: { PR_NUMBER: "42" },
  ledgerTag: "review:42",
  requiresEval: {
    matchedCount: 0,
    reason: "no matching ledger entry for tag `review:42`",
  },
  evaluatedAt: "2026-04-30T12:00:00.000Z",
};

export function makeDecision(
  overrides: Partial<PolicyDecision> & Pick<PolicyDecision, "policyName">,
): PolicyDecision {
  return { ...DEFAULTS, ...overrides };
}

/**
 * Build the `LedgerEntry` shape that audit consumes — a fact
 * row whose `content` is the encoded `policy_decision:` payload.
 *
 * `evaluatedAt` defaults to `createdAt` so a test that doesn't care
 * about Phase 5 #9's ms-precision ordering doesn't need to think
 * about it. Pass an explicit `evaluatedAt` override to exercise the
 * sub-second-collision path.
 */
export function makeDecisionEntry(
  overrides: Partial<PolicyDecision> & Pick<PolicyDecision, "policyName">,
  createdAt: string,
): LedgerEntry {
  const decision = makeDecision({ evaluatedAt: createdAt, ...overrides });
  return {
    id: createdAt,
    content: encodeLedgerContent(payloadFromDecision(decision)),
    source: "harness-policy-intercept",
    createdAt,
  };
}
