// Phase 6 #4 — runtime helpers for the understanding-before-execution pack.
//
// Two-source approval check that the harness-side PreToolUse blocker
// consults:
//
//   1. Evidence ledger via `grounding-mcp` (canonical for harnessed
//      sessions). Tags shaped like `understanding-approved:${SESSION_ID}`.
//   2. Persisted JSON report under `.understanding-gate/reports/`
//      (canonical for solo `@lannguyensi/understanding-gate` users).
//      The package writes one file per session; the latest with
//      `approvalStatus: "approved"` matching the session_id wins.
//
// Either source approves. The persisted-report fallback is what makes a
// solo user without grounding-mcp wired still able to approve via the
// package's CLI; the ledger path is what makes a harnessed session see
// the approval immediately on the next tool call.

import * as fs from "node:fs";
import * as path from "node:path";
import { type LedgerEntry } from "../../policies/index.js";
import { POLICY_DECISION_TYPE } from "../../runtime/ledger-record.js";

export const APPROVED_LEDGER_TAG_PREFIX = "understanding-approved:";

export type ApprovalSource = "ledger" | "persisted-report" | "none";

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
 * Match a ledger fetch against the per-session approval tag. Returns
 * `{matched: true, detail}` on the first non-policy_decision row whose
 * content includes the wanted tag; otherwise `{matched: false, detail}`
 * naming how many rows were scanned. Stable across Claude Code and
 * Codex blockers so their diagnostic strings stay identical.
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
        detail: `approved via ledger tag ${wanted} at ${e.createdAt}`,
      };
    }
  }
  return {
    matched: false,
    detail: `no ledger entry matched ${wanted} (scanned ${scanned} non-policy_decision row(s))`,
  };
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
