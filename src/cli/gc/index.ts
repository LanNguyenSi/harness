// `harness gc` — retention-based cleanup of harness-owned gate state.
//
// Nothing else ever deletes terminal understanding-gate reports,
// parse-error logs, or approval markers of long-dead sessions, so the
// state dirs grow unbounded (harness-discovery M3; 103 report files
// accumulated in under a month on the originating install). Stale
// pending reports were also the raw material of the C1 stale-adoption
// bug, but pending state is deliberately NOT touched here: only
// artifacts in a terminal status age out.
//
// Safety posture (mirrors `uninstall` / `migrate-home`):
//   - Dry-run by default; `--apply` commits.
//   - Only enumerated, harness-owned locations are considered:
//       <reportsDir>            terminal-status reports (approved / expired)
//       <reportsDir>/../parse-errors   parse-error logs
//       <generatedDir>/.approvals      session / task / branch-protection markers
//     The evidence ledger (grounding-mcp) and solution-acceptance
//     verdict dirs (producer-owned) are out of scope by design.
//   - Deletion failures are surfaced loudly per file, never swallowed.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  APPROVAL_MARKER_DIRNAME,
  defaultReportsDir,
  listPersistedReports,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import { resolvePaths, type LoaderOptions } from "../loader.js";

export const DEFAULT_RETENTION_DAYS = 30;

// Same literal `harness approve understanding` uses for its parse-error
// diagnostics lookup (approve/understanding.ts).
const PARSE_ERRORS_DIRNAME = "parse-errors";

export interface GcOptions extends LoaderOptions {
  /** Artifacts older than this many days are candidates. Default 30. */
  retentionDays?: number;
  /** Delete when true; pure listing otherwise (the default). */
  apply?: boolean;
  /** Test seam: reports directory (default: env / manifest-anchored). */
  reportsDir?: string;
  /** Test seam: harness.generated directory (default: manifest-anchored). */
  generatedDir?: string;
  /** Test seam: clock anchor. */
  now?: Date;
}

export type GcCategory = "report" | "parse-error" | "approval-marker";

export interface GcCandidate {
  filePath: string;
  category: GcCategory;
  /** Why this file aged out (status + age), for the listing UI. */
  reason: string;
}

export interface GcResult {
  retentionDays: number;
  cutoffIso: string;
  reportsDir: string;
  /**
   * null when the parse-errors sweep was skipped because `reportsDir`
   * does not have the conventional `.understanding-gate/reports` shape
   * (a custom `UNDERSTANDING_GATE_REPORT_DIR` pointing elsewhere would
   * otherwise make "the sibling named parse-errors" an unrelated
   * directory and gc would age out a stranger's files).
   */
  parseErrorsDir: string | null;
  approvalsDir: string;
  candidates: GcCandidate[];
  /** Files actually deleted (apply mode only). */
  removed: string[];
  /** Per-file deletion failures (apply mode only); never silent. */
  failures: Array<{ filePath: string; reason: string }>;
  /** Count of artifacts inspected but kept (fresh or non-terminal). */
  keptCount: number;
  applied: boolean;
}

function ageDays(nowMs: number, thenMs: number): number {
  return Math.round((nowMs - thenMs) / 86_400_000);
}

/** Plain files in `dir` whose mtime is older than `cutoffMs`. */
function staleFilesByMtime(
  dir: string,
  cutoffMs: number,
  nowMs: number,
  category: GcCategory,
): { candidates: GcCandidate[]; kept: number } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { candidates: [], kept: 0 };
  }
  const candidates: GcCandidate[] = [];
  let kept = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      kept += 1;
      continue;
    }
    if (stat.mtimeMs < cutoffMs) {
      candidates.push({
        filePath: full,
        category,
        reason: `${ageDays(nowMs, stat.mtimeMs)}d old (mtime)`,
      });
    } else {
      kept += 1;
    }
  }
  return { candidates, kept };
}

export function gc(opts: GcOptions = {}): GcResult {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`retention must be a positive number of days, got ${retentionDays}`);
  }
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const cutoffMs = nowMs - retentionDays * 86_400_000;

  // Path resolution mirrors `approve understanding`: explicit opts win
  // (test injection), then env / manifest-anchored defaults. resolvePaths
  // is evaluated lazily (and once) so injected dirs don't drag the
  // loader in.
  let resolvedBase: string | undefined;
  const manifestBase = (): string => (resolvedBase ??= resolvePaths(opts).base);
  const reportsDir =
    opts.reportsDir ?? defaultReportsDir(path.dirname(manifestBase()));
  const conventionalLayout =
    path.basename(reportsDir) === "reports" &&
    path.basename(path.dirname(reportsDir)) === ".understanding-gate";
  const parseErrorsDir = conventionalLayout
    ? path.join(path.dirname(reportsDir), PARSE_ERRORS_DIRNAME)
    : null;
  const generatedDir =
    opts.generatedDir ??
    resolveGeneratedDir({
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      manifestPath: manifestBase(),
    });
  const approvalsDir = path.join(generatedDir, APPROVAL_MARKER_DIRNAME);

  const candidates: GcCandidate[] = [];
  let keptCount = 0;

  // Reports: only terminal statuses age out. A pending report is never
  // deleted regardless of age; since the C1 fix, stale pending leftovers
  // can no longer satisfy `approve understanding`, and keeping them
  // preserves the forensic trail for the producer-side investigation.
  for (const report of listPersistedReports(reportsDir)) {
    const terminal =
      report.approvalStatus === "approved" || report.approvalStatus === "expired";
    if (terminal && report.createdAtMs < cutoffMs) {
      candidates.push({
        filePath: report.filePath,
        category: "report",
        reason: `${report.approvalStatus}, created ${ageDays(nowMs, report.createdAtMs)}d ago`,
      });
    } else {
      keptCount += 1;
    }
  }

  if (parseErrorsDir !== null) {
    const parseErrors = staleFilesByMtime(parseErrorsDir, cutoffMs, nowMs, "parse-error");
    candidates.push(...parseErrors.candidates);
    keptCount += parseErrors.kept;
  }

  const markers = staleFilesByMtime(approvalsDir, cutoffMs, nowMs, "approval-marker");
  candidates.push(...markers.candidates);
  keptCount += markers.kept;

  const removed: string[] = [];
  const failures: Array<{ filePath: string; reason: string }> = [];
  if (opts.apply === true) {
    for (const c of candidates) {
      try {
        fs.unlinkSync(c.filePath);
        removed.push(c.filePath);
      } catch (err) {
        failures.push({ filePath: c.filePath, reason: (err as Error).message });
      }
    }
  }

  return {
    retentionDays,
    cutoffIso: new Date(cutoffMs).toISOString(),
    reportsDir,
    parseErrorsDir,
    approvalsDir,
    candidates,
    removed,
    failures,
    keptCount,
    applied: opts.apply === true,
  };
}
