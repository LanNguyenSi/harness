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
// names are written in the source. The 51 names below were captured by
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
//
// Mutation-verified: temporarily re-adding `export { safeJsonParse } from
// "./persisted-reports.js";` to
// src/policy-packs/builtin/understanding-before-execution/index.ts turns
// both assertions below red (extra 41st key in the first, `true` in the
// second); reverting turns them green again.
const EXPECTED_EXPORTS = [
  "ACTIVE_CLAIM_FILENAME",
  "APPROVAL_MARKER_DIRNAME",
  "APPROVAL_MARKER_TASK_PREFIX",
  "APPROVED_LEDGER_TAG_PREFIX",
  "AUTO_APPROVED_BY_PREFIX",
  "AUTO_APPROVE_HARNESS_VALUES",
  "CLAUDE_CODE_HARNESS",
  "DEFAULT_AUTO_APPROVE_HARNESSES",
  "DEFAULT_BASH_TOOL_NAMES",
  "REPORTS_DIR_ENV",
  "TOLERANT_FALLBACK_FUTURE_SKEW_MS",
  "TOLERANT_FALLBACK_MAX_AGE_MS",
  "activeClaimPathFor",
  "applyPostToolUseExpiry",
  "approvalMarkerPathFor",
  "approvedLedgerTagFor",
  "autoApprovedByFor",
  "autoApprovedLedgerTagFor",
  "bashCommandMatchesAny",
  "checkActiveClaimApprovalMarker",
  "checkApprovalMarker",
  "checkOperatorApprovalMarkers",
  "checkPersistedReport",
  "clearActiveClaim",
  "clearApprovalMarker",
  "clearTaskApprovalMarker",
  "defaultReportsDir",
  "describePostToolUseExpiry",
  "expirePersistedReport",
  "extractBashCommandFromToolInput",
  "extractTaskIdFromToolInput",
  "extractTasksTransitionStatusFromToolInput",
  "findLatestReportForSession",
  "harnessAllowed",
  "isPolicyDecisionRow",
  "listPersistedReports",
  "matchLedgerEntries",
  "matchPostToolUseBoundary",
  "parseApprovalLifecycle",
  "parseAutoApprove",
  "parseAutoApprovedBy",
  "permissionModeAllowed",
  "readActiveClaim",
  "reportsDirForManifest",
  "selectNewestStrictSessionReport",
  "selectReportForSession",
  "taskApprovalMarkerPathFor",
  "toolNameMatchesAny",
  "writeActiveClaim",
  "writeApprovalMarker",
  "writeTaskApprovalMarker",
] as const;

describe("understanding-before-execution-runtime shim export surface", () => {
  it("exports exactly the pinned 51-name surface, sorted", () => {
    const actual = Object.keys(ubeShim).sort();
    expect(actual).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it("does not export safeJsonParse (lives in src/io/safe-json-parse.ts, not part of the UBE surface)", () => {
    expect(Object.prototype.hasOwnProperty.call(ubeShim, "safeJsonParse")).toBe(false);
  });
});
