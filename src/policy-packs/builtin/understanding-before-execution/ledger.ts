// Ledger audit/forensics helpers, split out of the former monolithic
// understanding-before-execution-runtime.ts (structural concentration
// slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import { POLICY_DECISION_TYPE } from "../../../io/ledger-record.js";
import { type LedgerEntry } from "../../../policies/index.js";
import { APPROVAL_MARKER_DIRNAME } from "./markers.js";

export const APPROVED_LEDGER_TAG_PREFIX = "understanding-approved:";

/** Build the per-session ledger tag the pack searches for. */
export function approvedLedgerTagFor(sessionId: string): string {
  return `${APPROVED_LEDGER_TAG_PREFIX}${sessionId}`;
}

/**
 * Phase 6 #6 — substring-pollution defence shared by every PreToolUse
 * blocker (Claude Code + Codex). Drops policy_decision rows so a
 * `understanding-approved:<sess>` substring inside an audit row's
 * JSON-encoded `reason` cannot accidentally satisfy the gate.
 */
export function isPolicyDecisionRow(e: LedgerEntry): boolean {
  if (e.type === POLICY_DECISION_TYPE) return true;
  if (typeof e.content === "string" && e.content.startsWith(`${POLICY_DECISION_TYPE}:`)) {
    return true;
  }
  return false;
}

/**
 * Match a ledger fetch against the per-session approval tag. Kept for
 * the audit / forensics path only: a ledger entry tagged
 * `understanding-approved:<sid>` is no longer a sufficient signal to
 * unblock the gate (agent-tasks/88ca4bb3: the agent has the same MCP
 * surface and could self-write the row). Use `checkApprovalMarker`
 * for the gate decision; this helper now serves `harness audit` /
 * `harness explain --trace` style read paths that surface the
 * historic ledger trail without granting approval power.
 */
export function matchLedgerEntries(
  entries: LedgerEntry[],
  sessionId: string,
): { matched: boolean; detail: string } {
  const wanted = approvedLedgerTagFor(sessionId);
  let scanned = 0;
  for (const e of entries) {
    if (isPolicyDecisionRow(e)) continue;
    scanned += 1;
    if (typeof e.content === "string" && e.content.includes(wanted)) {
      return {
        matched: true,
        detail: `audit: ledger tag ${wanted} present at ${e.createdAt} (no longer satisfies the gate; see harness.generated/${APPROVAL_MARKER_DIRNAME}/${sessionId})`,
      };
    }
  }
  return {
    matched: false,
    detail: `no ledger entry matched ${wanted} (scanned ${scanned} non-policy_decision row(s))`,
  };
}
