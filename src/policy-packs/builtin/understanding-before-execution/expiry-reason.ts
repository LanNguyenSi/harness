// Block-reason text for an approval that lapsed, shared by the Claude and
// Codex PreToolUse hooks so the two runtimes cannot word it differently.
//
// Two ways an approval stops opening the gate, kept textually apart:
//  - boundary expiry: a PostToolUse event (`expire_on_tool_match` /
//    `expire_on_bash_match`) deleted the marker and flipped the persisted
//    report to `expired`. The reason lives in the report and is rendered by
//    `checkPersistedReport` ("approval expired because <event> at <time>").
//  - TTL expiry: `approval_lifecycle.max_age` elapsed while the marker is
//    still on disk. The reason is the marker check's own detail, rendered
//    here ("approval expired because max_age <dur> elapsed (approved at
//    <time>)").
// Only wording lives here; no gate decision reads any of it.

import { sanitizeDetailValue } from "./persisted-reports.js";

/** Matches the detail `checkApprovalMarker` writes for an aged-out marker. */
const MARKER_TTL_DETAIL_RE = /expired: age \d+m > max (\d+)m \(approved at ([^)]*)\)/;

/**
 * `approval expired because max_age <n>m elapsed (approved at <time>)` when
 * the unmatched marker check reported a max_age expiry (the task-scoped or
 * the session-scoped marker), `undefined` otherwise. The values come out of
 * a marker detail built from a signature-verified marker, and still pass
 * `sanitizeDetailValue`.
 */
export function describeMarkerTtlExpiry(markers: {
  expired: boolean;
  detail: string;
  taskCheckDetail: string;
}): string | undefined {
  if (!markers.expired) return undefined;
  for (const detail of [markers.detail, markers.taskCheckDetail]) {
    const m = MARKER_TTL_DETAIL_RE.exec(detail);
    if (m !== null) {
      return `approval expired because max_age ${sanitizeDetailValue(m[1] as string)}m elapsed (approved at ${sanitizeDetailValue(m[2] as string)})`;
    }
  }
  return undefined;
}

/**
 * The routine "no approval marker" block reason, with the TTL-expiry
 * sentence ahead of the report and ledger details when one applies.
 * `suffix` is the Claude hook's subagent sentence (empty for Codex).
 */
export function noApprovalMarkerReason(
  sessionId: string,
  ttlExpiry: string | undefined,
  reportDetail: string,
  ledgerDetail: string,
  suffix = "",
): string {
  const expiry = ttlExpiry !== undefined ? `${ttlExpiry}; ` : "";
  return `no approval marker for session ${sessionId}; ${expiry}${reportDetail}; ${ledgerDetail}${suffix}`;
}
