// Phase 6 #4 — runtime helpers for the understanding-before-execution pack.
//
// Single-authority approval check that the harness-side PreToolUse
// blockers (Claude and Codex) consult, plus two evidence-only probes:
//
//   AUTHORITY. Filesystem marker `<generatedDir>/.approvals/<sessionId>`
//      (or `task-<id>`) written by `harness approve understanding` from
//      the operator's shell and HMAC-signed with the operator-side key
//      (harness/f9485cc7). Replaces the ledger-substring check that
//      shipped through v0.13.0 (agent-tasks/88ca4bb3): the agent has
//      direct MCP access to the same ledger that gate path consulted, so
//      any agent could write `understanding-approved:<sid>` itself and
//      self-approve. Edit / Write / Bash are all gated by this same
//      PreToolUse hook, and the configured MCP servers do not expose
//      filesystem writes, so the marker file is reachable only from a
//      process the operator launched; the signature is what keeps that
//      true even if a future write primitive the blocker matcher does
//      not cover appears. Operator-side: writeApprovalMarker below.
//   EVIDENCE. Persisted JSON report under `.understanding-gate/reports/`
//      (owned by `@lannguyensi/understanding-gate`). Flipped to
//      `approved` by the same `harness approve understanding` call and to
//      `expired` by the post-tool-use boundary hook, so the audit record
//      tracks the marker. Until task 7402301d this was a SECOND, equal
//      approval source, and it was unsigned: under the very threat model
//      that motivated marker signing, one unsigned JSON write into the
//      reports directory forged an approval with less effort than the
//      old marker forgery (no session id, no key read). Gate-time
//      approval authority now flows only through the signed marker; the
//      report is consulted for the block diagnostic only
//      (`checkPersistedReport` returns evidence, never an approval).
//   EVIDENCE. The evidence-ledger row `understanding-approved:<sid>`,
//      still written by `harness approve understanding` for forensics.
//
// Consequence for solo `@lannguyensi/understanding-gate` users running
// under harness: the package's own `understanding-gate approve` flips
// the report but writes no signed marker, so it no longer opens the
// harness gate; `harness approve understanding` is the approval path.

export type ApprovalSource =
  | "marker"
  | "ledger"
  | "none"
  | "recovery-commit";

export interface ApprovalCheckResult {
  approved: boolean;
  source: ApprovalSource;
  detail: string;
}

export {
  APPROVED_LEDGER_TAG_PREFIX,
  approvedLedgerTagFor,
  isPolicyDecisionRow,
  matchLedgerEntries,
} from "./ledger.js";

export {
  APPROVAL_MARKER_DIRNAME,
  approvalMarkerPathFor,
  type ApprovalMarker,
  writeApprovalMarker,
  type MarkerCheck,
  type CheckApprovalMarkerOptions,
  checkApprovalMarker,
  clearApprovalMarker,
} from "./markers.js";

export {
  type PersistedReport,
  REPORTS_DIR_ENV,
  defaultReportsDir,
  reportsDirForManifest,
  listPersistedReports,
  TOLERANT_FALLBACK_MAX_AGE_MS,
  TOLERANT_FALLBACK_FUTURE_SKEW_MS,
  type FindReportOptions,
  type FindReportSelection,
  selectReportForSession,
  findLatestReportForSession,
  type PersistedReportEvidence,
  expirePersistedReport,
  checkPersistedReport,
} from "./persisted-reports.js";

export { type ApprovalLifecycle, parseApprovalLifecycle } from "./lifecycle.js";

export {
  APPROVAL_MARKER_TASK_PREFIX,
  taskApprovalMarkerPathFor,
  writeTaskApprovalMarker,
  checkActiveClaimApprovalMarker,
  type OperatorMarkerApproval,
  checkOperatorApprovalMarkers,
  clearTaskApprovalMarker,
} from "./task-markers.js";

export {
  DEFAULT_BASH_TOOL_NAMES,
  toolNameMatchesAny,
  bashCommandMatchesAny,
  extractBashCommandFromToolInput,
  extractTaskIdFromToolInput,
  extractTasksTransitionStatusFromToolInput,
  type PostToolUseBoundaryMatch,
  matchPostToolUseBoundary,
  type ApplyPostToolUseExpiryResult,
  applyPostToolUseExpiry,
  describePostToolUseExpiry,
} from "./post-tool-use-boundary.js";

export {
  ACTIVE_CLAIM_FILENAME,
  activeClaimPathFor,
  writeActiveClaim,
  readActiveClaim,
  clearActiveClaim,
} from "./active-claim.js";
