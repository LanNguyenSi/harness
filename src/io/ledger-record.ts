// `policy_decision` ledger-row codec.
//
// Older harness versions wrote one ledger entry per policy decision via
// grounding-mcp's `ledger_add` verb. The verb only accepts the four
// fact/hypothesis/rejected/unknown types, so the structured payload was
// stashed as JSON inside `content` behind a `policy_decision:` prefix. The
// policy engine that wrote those rows is gone; this module keeps only the
// read side (encode/decode, sort key, the shared row-type constant) that
// `harness audit` and the ledger client use to read the rows that already
// exist in a ledger.

// Type-only on purpose: `policies/ledger-client.ts` and
// `policies/requires.ts` value-import POLICY_DECISION_TYPE from this
// module, so a VALUE import of LedgerEntry back would
// re-create the TDZ cycle pinned absent by
// tests/io/ledger-record-no-cycle.test.ts. `import type` is erased
// at compile time and adds no runtime edge.
import type { LedgerEntry } from "../policies/requires.js";
import { parseLedgerTimestamp } from "../policies/timestamp.js";

/**
 * Canonical ledger-entry `type` for harness-emitted policy decisions.
 * Owned here because this module also owns the encode/decode prefix.
 * Every site that filters policy-decision rows MUST go through
 * this constant, so a typo at any one site does not silently disable the
 * substring-pollution guard. See PR #47 review for the failure mode.
 */
export const POLICY_DECISION_TYPE = "policy_decision";
const PREFIX = POLICY_DECISION_TYPE;

/**
 * Shape of a decoded `policy_decision` row payload. Structural and local:
 * it covers what the readers (`harness audit`, the ledger client) decode,
 * and stays independent of any policy evaluator type.
 */
export interface PolicyDecisionPayload {
  name: string;
  outcome:
    | "allow"
    | "warn"
    | "require_approval"
    | "deny"
    | "warn-degraded"
    | "deny-degraded";
  enforcement: "block" | "warn" | "require_approval";
  reason: string;
  ledgerTag: string;
  extractValues: Record<string, string>;
  requiresEval?: { matchedCount: number; reason: string };
  evaluatedAt: string;
}

export function encodeLedgerContent(payload: PolicyDecisionPayload): string {
  return `${PREFIX}:${payload.name}:${payload.outcome} ${JSON.stringify(payload)}`;
}

/**
 * Phase 5 #9 — preferred sort key for policy_decision rows.
 *
 * `evidence-ledger` stores `createdAt` at 1-second precision (SQLite
 * `datetime('now')`), so two decisions evaluated within the same wall-
 * clock second tie at `bt - at === 0`, and a stable sort returns the
 * earliest entry as "latest". The decoded payload's `evaluatedAt` is
 * `Date.toISOString()` (millisecond precision), which actually
 * distinguishes back-to-back fires. Use it as the primary key, with a
 * `createdAt` fallback for any future encoding that lacks `evaluatedAt`.
 *
 * Returns `NaN` only when both fields are unparseable; callers should
 * tolerate ties by treating equal results as preserve-order.
 */
export function decisionSortKey(
  entry: LedgerEntry,
  payload: PolicyDecisionPayload,
): number {
  const evaluatedMs = parseLedgerTimestamp(payload.evaluatedAt);
  if (!Number.isNaN(evaluatedMs)) return evaluatedMs;
  if (entry.createdAt instanceof Date) return entry.createdAt.getTime();
  return parseLedgerTimestamp(entry.createdAt);
}

export function decodeLedgerContent(content: string): PolicyDecisionPayload | null {
  if (!content.startsWith(`${PREFIX}:`)) return null;
  const space = content.indexOf(" ");
  if (space === -1) return null;
  try {
    const obj = JSON.parse(content.slice(space + 1)) as PolicyDecisionPayload;
    return obj;
  } catch {
    return null;
  }
}
