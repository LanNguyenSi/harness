// Doctor visibility half of ADR docs/decisions/2026-08-27-ug-auto-mode-approval.md
// slice 1 (agent-tasks 74b4b17d): the "auto approvals in the last N
// sessions" listing named in the ADR's "Audit and doctor" section and
// slice 1 acceptance criterion 7.
//
// Scans `<generatedDir>/.approvals/` for SESSION markers (skips the
// per-task markers named `task-<id>` and the branch-protection markers
// named `branch-protection-<sid>`, neither of which is a session
// approval), sorts the readable ones newest-first by `approvedAt`,
// takes the newest `recentSessions` of them, and reports how many of
// THOSE were minted by the auto path (`approvedBy` starting with
// `auto-mode:`, see auto-approve.ts's `parseAutoApprovedBy`).
//
// This is an AUDIT SURFACE, not a security check: it never verifies a
// marker's HMAC signature (that is `checkApprovalMarker`'s job at gate
// time; a forged marker still gets rejected there regardless of what
// this listing shows) and it never blocks or writes anything.

import * as path from "node:path";
import { readJsonDirEntriesRejectingSymlinks } from "../../io/read-json-dir-entries.js";
import { BRANCH_PROTECTION_MARKER_PREFIX } from "../../policy-packs/builtin/branch-protection-runtime.js";
import {
  APPROVAL_MARKER_DIRNAME,
  APPROVAL_MARKER_TASK_PREFIX,
  parseAutoApprovedBy,
} from "../../policy-packs/builtin/understanding-before-execution/index.js";

/** Default doctor window when `--recent-sessions` is not passed. */
export const DEFAULT_RECENT_SESSIONS = 20;

export interface AutoApprovalListingEntry {
  sessionId: string;
  mode: string;
  harness: string;
  approvedAt: string;
}

export interface UgAutoApprovalsSection {
  /** Whether `<generatedDir>/.approvals/` exists at all. */
  approvalsDirPresent: boolean;
  /** The `recentSessions` window that was applied. */
  windowSize: number;
  /** Auto approvals among the newest `windowSize` session markers. */
  autoApprovedCount: number;
  /** Per-mode breakdown of `autoApprovedCount` (e.g. `{bypassPermissions: 3}`). */
  byMode: Record<string, number>;
  /** Per-harness breakdown of `autoApprovedCount` (e.g. `{"claude-code": 3}`). */
  byHarness: Record<string, number>;
  /** `(sessionId, mode, approvedAt)` for each auto approval in the window, newest first. */
  entries: AutoApprovalListingEntry[];
  /**
   * Session markers whose body could not be read as JSON with a
   * parseable `approvedAt` (corrupt file, non-JSON content, missing
   * `approvedAt`). Excluded from the window (there is no timestamp to
   * sort them by) and never counted as auto approvals; surfaced as a
   * single summary count instead of per-file noise.
   */
  unreadableCount: number;
}

function emptySection(windowSize: number): UgAutoApprovalsSection {
  return {
    approvalsDirPresent: false,
    windowSize,
    autoApprovedCount: 0,
    byMode: {},
    byHarness: {},
    entries: [],
    unreadableCount: 0,
  };
}

/**
 * Build the auto-approval listing + last-N metric. Pure filesystem read;
 * never throws for ordinary "nothing to see" states (missing
 * `.approvals/`, empty directory, every marker unreadable) — those all
 * resolve to an empty-ish section rather than an exception, mirroring
 * the rest of doctor's read-only checks.
 */
export function buildUgAutoApprovals(
  generatedDir: string,
  opts: { recentSessions: number },
): UgAutoApprovalsSection {
  const windowSize = opts.recentSessions;
  const dir = path.join(generatedDir, APPROVAL_MARKER_DIRNAME);

  // A symlink / non-regular / raced-away entry is not a session marker this
  // listing owns an opinion about; the shared reader skips it silently
  // rather than counting it as "unreadable" (that count is for a FILE we
  // expected to be a marker but could not parse).
  const { dirPresent, entries: readable, unreadableCount } = readJsonDirEntriesRejectingSymlinks<{
    sessionId: string;
    approvedAt: string;
    approvedBy: unknown;
  }>(dir, {
    skip: (name) =>
      name.startsWith(APPROVAL_MARKER_TASK_PREFIX) || name.startsWith(BRANCH_PROTECTION_MARKER_PREFIX),
    parse: (raw, name) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const obj = raw as Record<string, unknown>;
      const approvedAt = obj["approvedAt"];
      if (typeof approvedAt !== "string" || Number.isNaN(Date.parse(approvedAt))) return null;
      return { sessionId: name, approvedAt, approvedBy: obj["approvedBy"] };
    },
  });

  if (!dirPresent) return emptySection(windowSize);

  readable.sort((a, b) => Date.parse(b.approvedAt) - Date.parse(a.approvedAt));
  const windowed = readable.slice(0, windowSize);

  const byMode: Record<string, number> = {};
  const byHarness: Record<string, number> = {};
  const entries: AutoApprovalListingEntry[] = [];
  for (const m of windowed) {
    const parsedAuto = parseAutoApprovedBy(m.approvedBy);
    if (parsedAuto === null) continue;
    byMode[parsedAuto.mode] = (byMode[parsedAuto.mode] ?? 0) + 1;
    byHarness[parsedAuto.harness] = (byHarness[parsedAuto.harness] ?? 0) + 1;
    entries.push({
      sessionId: m.sessionId,
      mode: parsedAuto.mode,
      harness: parsedAuto.harness,
      approvedAt: m.approvedAt,
    });
  }

  return {
    approvalsDirPresent: true,
    windowSize,
    autoApprovedCount: entries.length,
    byMode,
    byHarness,
    entries,
    unreadableCount,
  };
}
