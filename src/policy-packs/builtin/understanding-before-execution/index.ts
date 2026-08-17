// Phase 6 #4 — runtime helpers for the understanding-before-execution pack.
//
// Two-source approval check that the harness-side PreToolUse blocker
// consults:
//
//   1. Filesystem marker `<generatedDir>/.approvals/<sessionId>` written
//      by `harness approve understanding` from the operator's shell.
//      Canonical for harnessed sessions. Replaces the ledger-substring
//      check that shipped through v0.13.0 (agent-tasks/88ca4bb3): the
//      agent has direct MCP access to the same ledger that gate path
//      consulted, so any agent could write `understanding-approved:<sid>`
//      itself and self-approve. Edit / Write / Bash are all gated by
//      this same PreToolUse hook, and the configured MCP servers do not
//      expose filesystem writes, so the marker file is reachable only
//      from a process the operator launched (their `!`-shell or any
//      other un-hooked terminal). Operator-side: writeApprovalMarker
//      below. Forensics: the ledger row is still written by
//      `harness approve understanding`, for audit only.
//   2. Persisted JSON report under `.understanding-gate/reports/`
//      (canonical for solo `@lannguyensi/understanding-gate` users).
//      The package writes one file per session; the latest with
//      `approvalStatus: "approved"` matching the session_id wins. The
//      report is flipped to "approved" by `harness approve`; the
//      agent's Stop hook only writes `pending` reports and cannot flip
//      them (Edit/Write/Bash gated), so this source is also operator-
//      authored.
//
// Either source approves. The persisted-report fallback is what makes a
// solo user without grounding-mcp wired still able to approve via the
// package's CLI; the marker path is what makes a harnessed session see
// the approval immediately on the next tool call.

export type ApprovalSource =
  | "marker"
  | "ledger"
  | "persisted-report"
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
  type PersistedReportApprovalCheck,
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
