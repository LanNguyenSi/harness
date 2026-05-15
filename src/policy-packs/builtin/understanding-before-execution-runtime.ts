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

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../io/atomic-write.js";
import { type LedgerEntry } from "../../policies/index.js";
import { POLICY_DECISION_TYPE } from "../../runtime/ledger-record.js";

export const APPROVED_LEDGER_TAG_PREFIX = "understanding-approved:";

export const APPROVAL_MARKER_DIRNAME = ".approvals";

export type ApprovalSource = "marker" | "ledger" | "persisted-report" | "none";

export interface ApprovalCheckResult {
  approved: boolean;
  source: ApprovalSource;
  detail: string;
}

export interface PersistedReport {
  filePath: string;
  sessionId: string | null;
  approvalStatus: string | null;
  approvedAt: string | null;
}

const DEFAULT_REPORTS_DIRNAME = ".understanding-gate";
const REPORTS_SUBDIR = "reports";

/**
 * Env var the persisted-report directory can be set from. Honored by
 * harness (`defaultReportsDir` below + emitted by `harness apply` onto
 * the pack-contributed hook commands) AND by `@lannguyensi/understanding-gate`
 * (its `core/persistence.js:resolveReportDir` reads the same name), so
 * the three actors that touch the directory — Stop hook (package),
 * PreToolUse blocker (harness), `harness approve understanding` — can
 * agree on the path regardless of each process's cwd.
 */
export const REPORTS_DIR_ENV = "UNDERSTANDING_GATE_REPORT_DIR";

/**
 * Resolve the persisted-report directory. Precedence:
 *   1. `UNDERSTANDING_GATE_REPORT_DIR` (taken verbatim — apply emits an
 *      absolute path, operator-exported values are shell-expanded before
 *      we see them).
 *   2. `<cwd>/.understanding-gate/reports` — backward-compat fallback.
 *      Callers that have a stable anchor (the manifest directory) pass
 *      it as `cwd` so the fallback agrees with whatever path apply
 *      baked into the hook commands.
 */
export function defaultReportsDir(cwd: string = process.cwd()): string {
  const fromEnv = process.env[REPORTS_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return path.join(cwd, DEFAULT_REPORTS_DIRNAME, REPORTS_SUBDIR);
}

/**
 * Project root anchor for the reports directory: `<dir-of-manifest>/.understanding-gate/reports`.
 * Used by `harness apply` to bake an absolute, manifest-anchored value into
 * the pack-contributed hook commands' env, and by `harness approve` as the
 * fallback when `UNDERSTANDING_GATE_REPORT_DIR` is unset.
 */
export function reportsDirForManifest(manifestPath: string): string {
  return path.join(path.dirname(manifestPath), DEFAULT_REPORTS_DIRNAME, REPORTS_SUBDIR);
}

/** Build the per-session ledger tag the pack searches for. */
export function approvedLedgerTagFor(sessionId: string): string {
  return `${APPROVED_LEDGER_TAG_PREFIX}${sessionId}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readPersistedReport(filePath: string): PersistedReport | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    filePath,
    sessionId: typeof obj["sessionId"] === "string" ? (obj["sessionId"] as string) : null,
    approvalStatus:
      typeof obj["approvalStatus"] === "string" ? (obj["approvalStatus"] as string) : null,
    approvedAt: typeof obj["approvedAt"] === "string" ? (obj["approvedAt"] as string) : null,
  };
}

/**
 * List persisted reports under `dir`, newest-first by mtime. Missing
 * directory returns []. Any I/O error on a single file is silently
 * skipped; the caller falls through to the ledger result. The package
 * writes filenames as `<iso>-<slug>-<hash>.json` so the alphabetical
 * sort would also work for ISO prefixes, but mtime is robust against
 * the package changing its naming convention later.
 */
export function listPersistedReports(dir: string): PersistedReport[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const reports: Array<{ report: PersistedReport; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const report = readPersistedReport(full);
    if (!report) continue;
    reports.push({ report, mtimeMs: stat.mtimeMs });
  }
  reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return reports.map((r) => r.report);
}

/**
 * Return the freshest report for a given session_id, or the freshest
 * report overall when the persisted file lacks a sessionId field
 * (older package versions). null when nothing matches.
 */
export function findLatestReportForSession(
  reports: PersistedReport[],
  sessionId: string,
): PersistedReport | null {
  // Strict match first.
  for (const r of reports) {
    if (r.sessionId === sessionId) return r;
  }
  // Tolerant fallback: a report without sessionId is treated as
  // applicable to whichever session is asking. Only kicks in when no
  // sessionId-tagged report exists, so harnessed sessions with proper
  // tagging never hit this path.
  for (const r of reports) {
    if (r.sessionId === null) return r;
  }
  return null;
}

export interface PersistedReportApprovalCheck {
  approved: boolean;
  detail: string;
  report: PersistedReport | null;
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

/** Filesystem path of the per-session approval marker. */
export function approvalMarkerPathFor(generatedDir: string, sessionId: string): string {
  return path.join(generatedDir, APPROVAL_MARKER_DIRNAME, sessionId);
}

export interface ApprovalMarker {
  approvedAt: string;
  approvedBy: string;
}

/**
 * Operator-side: write the marker file the gate consults. Atomic so a
 * crash mid-write cannot leave a half-empty file the gate would accept
 * as approved. Caller is `harness approve understanding`, which the
 * operator runs from their un-hooked shell; if the agent could call
 * this path the gate's value would collapse, so it lives behind the
 * approve CLI rather than as a generally importable verb.
 */
export function writeApprovalMarker(
  generatedDir: string,
  sessionId: string,
  marker: ApprovalMarker,
): string {
  const filePath = approvalMarkerPathFor(generatedDir, sessionId);
  atomicWriteFile(filePath, `${JSON.stringify(marker, null, 2)}\n`);
  return filePath;
}

export interface MarkerCheck {
  matched: boolean;
  detail: string;
  marker: ApprovalMarker | null;
}

/**
 * Gate-side: is the per-session marker file present and readable?
 * Returns `matched: true` even if the marker JSON is malformed: the
 * file's *existence* is the operator's intent. Corrupted contents
 * surface as `marker: null` in the diagnostic but do not invalidate the
 * approval, since invalidating on a parse error would hand a denial-
 * of-service vector to anyone (including the agent) who could append a
 * stray byte to the file. Edit / Write / Bash are gated, so writing
 * stray bytes from inside Claude is not possible today, but the
 * existence-only contract is the defensible boundary regardless.
 */
export function checkApprovalMarker(generatedDir: string, sessionId: string): MarkerCheck {
  const filePath = approvalMarkerPathFor(generatedDir, sessionId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      matched: false,
      detail: `no approval marker at ${filePath}`,
      marker: null,
    };
  }
  if (!stat.isFile()) {
    return {
      matched: false,
      detail: `approval marker path is not a regular file: ${filePath}`,
      marker: null,
    };
  }
  let marker: ApprovalMarker | null = null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const approvedAt = typeof obj["approvedAt"] === "string" ? obj["approvedAt"] : "";
      const approvedBy = typeof obj["approvedBy"] === "string" ? obj["approvedBy"] : "";
      if (approvedAt.length > 0 && approvedBy.length > 0) {
        marker = { approvedAt, approvedBy };
      }
    }
  } catch {
    /* keep marker:null; existence already satisfied the gate */
  }
  const provenance = marker
    ? `approved at ${marker.approvedAt} by ${marker.approvedBy}`
    : "marker present, body unreadable (existence still satisfies the gate)";
  return {
    matched: true,
    detail: `approved via marker ${path.basename(filePath)}: ${provenance}`,
    marker,
  };
}

/** Clear the per-session marker (used by `harness approve --revoke` and tests). */
export function clearApprovalMarker(generatedDir: string, sessionId: string): void {
  try {
    fs.rmSync(approvalMarkerPathFor(generatedDir, sessionId));
  } catch {
    /* already gone */
  }
}

export function checkPersistedReport(
  reportsDir: string,
  sessionId: string,
): PersistedReportApprovalCheck {
  const reports = listPersistedReports(reportsDir);
  if (reports.length === 0) {
    return {
      approved: false,
      detail: `no reports found at ${reportsDir}`,
      report: null,
    };
  }
  const latest = findLatestReportForSession(reports, sessionId);
  if (!latest) {
    return {
      approved: false,
      detail: `no report matched session_id=${sessionId} (${reports.length} report(s) for other sessions)`,
      report: null,
    };
  }
  if (latest.approvalStatus !== "approved") {
    return {
      approved: false,
      detail: `latest report ${path.basename(latest.filePath)} has approvalStatus=${
        latest.approvalStatus ?? "<missing>"
      }`,
      report: latest,
    };
  }
  return {
    approved: true,
    detail: `approved via persisted report ${path.basename(latest.filePath)}${
      latest.approvedAt ? ` (approved at ${latest.approvedAt})` : ""
    }`,
    report: latest,
  };
}
