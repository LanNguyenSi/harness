import { describe, expect, it } from "vitest";
import * as ubeShim from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";

// Pins the public export surface of the understanding-before-execution
// re-export shim (structural concentration slice 2, agent-tasks 348a4d42;
// review finding). The shim is a single `export * from
// "./understanding-before-execution/index.js"` line, so a new re-export
// added to index.ts OR to any of its 7 concern-scoped siblings silently
// widens the shim's public surface with no other signal — the reviewer
// proved this by temporarily adding `export { safeJsonParse } from
// "./persisted-reports.js";` to index.ts, which no existing test caught.
//
// This test imports the actual compiled runtime namespace object (not the
// .ts source text), so it only sees VALUE exports: type-only exports
// (interfaces, `type` aliases) are erased at transform time and never
// appear in `Object.keys()`, regardless of how many `export { ... }`
// names are written in the source. The names below were captured by
// running this exact import+Object.keys().sort() against the shim and are
// the actual, verified runtime surface — not a source-text export count.
// Widened by agent-tasks 74b4b17d, three times: first by the
// `auto_approve` helpers (auto-approve.ts), then by
// `selectNewestStrictSessionReport` (persisted-reports.ts, the
// strict-newest report selection the PreToolUse hook's auto-approval path
// uses instead of `selectReportForSession`'s sessionId-null tolerant
// fallback), then by agent-tasks 57058364 slice 2's round-2 review fix
// (`harnessAllowed`, `AUTO_APPROVE_HARNESS_VALUES`,
// `DEFAULT_AUTO_APPROVE_HARNESSES`): `src/cli/pack/auto-approve-path.ts`
// and `src/policy-packs/builtin/understanding-before-execution.ts` had
// been importing those three directly from `auto-approve.ts` instead of
// through this shim, contradicting every sibling symbol at those same
// call sites.
// Widened a fourth time by agent-tasks 37ad0b05 (ADR slice 3,
// delegation-markers.ts) by the eight VALUE exports of the delegation
// pre-authorization artifact: DELEGATION_MARKER_DIRNAME,
// delegationMarkerIdFor, delegationMarkerPathFor, hashDelegationCwd,
// buildDelegationApprovedBy, parseDelegationApprovedBy,
// writeDelegationMarker, verifyDelegation. 51 -> 59. The module's eight
// type-only exports are absent from this list on purpose: they are erased
// at transform time and never reach Object.keys(), so listing them here
// would fail the very assertion below.
// Widened a fifth time, within the same task (agent-tasks 37ad0b05 review
// fix), by the three VALUE exports of the report-scan
// max-wait parser: parseReportScanMaxWait, DEFAULT_REPORT_SCAN_MAX_WAIT_MS,
// REPORT_SCAN_MAX_WAIT_CEILING_MS. Previously imported by
// understanding-before-execution.ts directly from `auto-approve.ts`,
// contradicting the precedent every other symbol at that call site already
// followed. 59 -> 62.
// Widened a sixth time (task 3ece079d): ADOPTION_LEDGER_DIRNAME, the
// once-per-session adoption-ledger dirname `harness gc`'s new delegation
// sweep reads, moved here from `hook-pre-tool-use.ts` (its only prior
// writer) so a reader that never writes one does not need a cli-to-cli
// import. 62 -> 63.
// Widened a seventh time by task 8f637efd (D-004, "Amendment: install
// default"), by the shipped `auto_approve` default (auto-approve-default.ts).
// The module's own header exports five VALUE names, but only two are
// re-exported through the barrel: defaultAutoApproveConfig,
// renderAutoApproveSnippet. 63 -> 65. `AUTO_APPROVE_DEFAULT_WHEN`,
// `AUTO_APPROVE_DEFAULT_HARNESSES`, and `AUTO_APPROVE_COMMENT_LINES` were
// re-exported too when this widening first landed, then dropped from the
// barrel in the SAME task's review round 2 (F7): grepped and confirmed no
// caller outside auto-approve-default.ts used the bare re-export: every
// consumer wants the already-assembled config/snippet, not the raw
// pieces. The module's one type-only export (AutoApproveDefaultConfig) is
// absent from this list for the same reason the delegation module's
// eight are.
// Widened an eighth time, same task, by the four VALUE exports of the
// hook-side permission-mode observation
// (permission-mode-observations.ts): PERMISSION_MODE_OBSERVATION_DIRNAME,
// permissionModeObservationPathFor, recordPermissionModeObservation,
// listPermissionModeObservations. 65 -> 69. The module's two type-only
// exports (PermissionModeObservation, PermissionModeObservationsResult)
// are absent from this list for the same reason.
//
// Mutation-verified: temporarily re-adding `export { safeJsonParse } from
// "./persisted-reports.js";` to
// src/policy-packs/builtin/understanding-before-execution/index.ts turns
// both assertions below red (extra 41st key in the first, `true` in the
// second); reverting turns them green again.
const EXPECTED_EXPORTS = [
  "ACTIVE_CLAIM_FILENAME",
  "ADOPTION_LEDGER_DIRNAME",
  "APPROVAL_MARKER_DIRNAME",
  "APPROVAL_MARKER_TASK_PREFIX",
  "APPROVED_LEDGER_TAG_PREFIX",
  "AUTO_APPROVED_BY_PREFIX",
  "AUTO_APPROVE_HARNESS_VALUES",
  "CLAUDE_CODE_HARNESS",
  "DEFAULT_AUTO_APPROVE_HARNESSES",
  "DEFAULT_BASH_TOOL_NAMES",
  "DEFAULT_REPORT_SCAN_MAX_WAIT_MS",
  "DELEGATION_MARKER_DIRNAME",
  "REPORTS_DIR_ENV",
  "REPORT_SCAN_MAX_WAIT_CEILING_MS",
  "TOLERANT_FALLBACK_FUTURE_SKEW_MS",
  "TOLERANT_FALLBACK_MAX_AGE_MS",
  "activeClaimPathFor",
  "applyPostToolUseExpiry",
  "approvalMarkerPathFor",
  "approvedLedgerTagFor",
  "autoApprovedByFor",
  "autoApprovedLedgerTagFor",
  "bashCommandMatchesAny",
  "buildDelegationApprovedBy",
  "checkActiveClaimApprovalMarker",
  "checkApprovalMarker",
  "checkOperatorApprovalMarkers",
  "checkPersistedReport",
  "clearActiveClaim",
  "clearApprovalMarker",
  "clearTaskApprovalMarker",
  "defaultAutoApproveConfig",
  "defaultReportsDir",
  "delegationMarkerIdFor",
  "delegationMarkerPathFor",
  "describePostToolUseExpiry",
  "expirePersistedReport",
  "extractBashCommandFromToolInput",
  "extractTaskIdFromToolInput",
  "extractTasksTransitionStatusFromToolInput",
  "findLatestReportForSession",
  "harnessAllowed",
  "hashDelegationCwd",
  "isPolicyDecisionRow",
  "listPermissionModeObservations",
  "listPersistedReports",
  "matchLedgerEntries",
  "matchPostToolUseBoundary",
  "PERMISSION_MODE_OBSERVATION_DIRNAME",
  "parseApprovalLifecycle",
  "parseAutoApprove",
  "parseAutoApprovedBy",
  "parseDelegationApprovedBy",
  "parseReportScanMaxWait",
  "permissionModeAllowed",
  "permissionModeObservationPathFor",
  "readActiveClaim",
  "recordPermissionModeObservation",
  "renderAutoApproveSnippet",
  "sanitizeForDisplay",
  "reportsDirForManifest",
  "selectNewestStrictSessionReport",
  "selectReportForSession",
  "taskApprovalMarkerPathFor",
  "toolNameMatchesAny",
  "verifyDelegation",
  "writeActiveClaim",
  "writeApprovalMarker",
  "writeDelegationMarker",
  "writeTaskApprovalMarker",
] as const;

describe("understanding-before-execution-runtime shim export surface", () => {
  it("exports exactly the pinned 70-name surface, sorted", () => {
    const actual = Object.keys(ubeShim).sort();
    expect(EXPECTED_EXPORTS).toHaveLength(70);
    expect(actual).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it("does not export safeJsonParse (lives in src/io/safe-json-parse.ts, not part of the UBE surface)", () => {
    expect(Object.prototype.hasOwnProperty.call(ubeShim, "safeJsonParse")).toBe(false);
  });
});
