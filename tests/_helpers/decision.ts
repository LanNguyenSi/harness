// Phase 5 #6 — shared `PolicyDecision` + ledger-entry test fixture.
//
// audit, explain, and (now) intercept-cli all needed near-identical
// `decisionEntry()` builders. Centralising the shape here keeps the
// defaults consistent (one place to update when, e.g., the
// `requiresEval.matchedCount` default changes) and removes ~20 lines
// of boilerplate per test file.

import type { LedgerEntry } from "../../src/policies/index.js";
import type { PolicyDecision } from "../../src/runtime/intercept.js";
import {
  encodeLedgerContent,
  payloadFromDecision,
} from "../../src/io/ledger-record.js";

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
 * Build the `LedgerEntry` shape that audit/explain consume — a fact
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
