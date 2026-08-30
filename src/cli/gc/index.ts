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
//       <generatedDir>/.delegations       signed delegation markers (slice 3)
//       <generatedDir>/.delegation-adoptions   once-per-session adoption ledgers
//       <generatedDir>/.permission-mode-observations   per-session PreToolUse
//                                          permission_mode observations (task 8f637efd)
//     The evidence ledger (grounding-mcp) and solution-acceptance
//     verdict dirs (producer-owned) are out of scope by design.
//   - Deletion failures are surfaced loudly per file, never swallowed.
//
// DELEGATIONS SWEEP (task 3ece079d, follow-up from UG auto-mode slice 3,
// agent-tasks 37ad0b05): a delegation marker is refused once expired
// (`verifyDelegation`'s "expired" reason), but nothing ever removed the
// FILE, so `.delegations/` grows the same way `.approvals/` used to. The
// adoption ledger at `.delegation-adoptions/<sid>` is worse: it is
// appended to once per captured transcript entry and never cleared at
// all, delegation expiry or not. Both sweep under one `"delegation"`
// category, on the SAME retention/grace window as everything else in this
// file (`retentionDays` / `cutoffMs`): a delegation marker is a candidate
// once its own `expires` segment (read via `parseDelegationApprovedBy`,
// no signature check needed for a retention decision) is older than
// `cutoffMs`, and its ledger sibling is a candidate once the marker for
// that session id is gone or itself a candidate. A marker whose content
// cannot be parsed is never a deletion candidate (fail closed, same as a
// pending report): it is surfaced separately in `GcResult.unparseable` so
// an operator can see it, but `--apply` never touches it, and its ledger
// sibling (if any) stays too, since "this delegation is dead" cannot be
// established for one gc cannot read.
//
// PERMISSION-MODE OBSERVATIONS SWEEP (task 8f637efd review round 2 F5):
// `.permission-mode-observations/` (one small per-session file, see
// permission-mode-observations.ts) grows the same way `.approvals/` and
// `.delegations/` do (nothing else ever removes an entry), and gc had
// not been taught about it. Swept under its own `"permission-mode-
// observation"` category by mtime, same `staleFilesByMtime` helper and
// `retentionDays` window every mtime-aged category here already uses (no
// signed `expires` to key off, unlike the delegation sweep: this is a
// plain observation record, not an approval artifact).

import * as fs from "node:fs";
import * as path from "node:path";
import { readRegularFileRejectingSymlink } from "../../io/read-regular-file.js";
import { safeJsonParse } from "../../io/safe-json-parse.js";
import {
  ADOPTION_LEDGER_DIRNAME,
  APPROVAL_MARKER_DIRNAME,
  DELEGATION_MARKER_DIRNAME,
  PERMISSION_MODE_OBSERVATION_DIRNAME,
  defaultReportsDir,
  listPersistedReports,
  parseDelegationApprovedBy,
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

export type GcCategory =
  | "report"
  | "parse-error"
  | "approval-marker"
  | "delegation"
  | "permission-mode-observation";

export interface GcCandidate {
  filePath: string;
  category: GcCategory;
  /** Why this file aged out (status + age), for the listing UI. */
  reason: string;
}

/** A delegation-sweep file gc could not parse: reported, never a deletion candidate. */
export interface GcUnparseable {
  filePath: string;
  category: GcCategory;
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
  delegationsDir: string;
  adoptionLedgerDir: string;
  permissionModeObservationsDir: string;
  candidates: GcCandidate[];
  /** Delegation-sweep files inspected but left in place because they could not be parsed. */
  unparseable: GcUnparseable[];
  /** Files actually deleted (apply mode only). */
  removed: string[];
  /** Per-file deletion failures (apply mode only); never silent. */
  failures: Array<{ filePath: string; reason: string }>;
  /** Count of artifacts inspected but kept (fresh, non-terminal, or unparseable). */
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

/**
 * A delegation filename is always a session id (mirrors
 * `doctor/ug-delegations.ts`'s own filter and rationale): filtering on
 * this shape before reading keeps filesystem debris that happens to sit
 * next to `.delegations/` or `.delegation-adoptions/` (macOS's
 * `.DS_Store`, a stray dotfile) from ever becoming an "unparseable"
 * candidate gc reports on. Not shared code with that module (see its own
 * header for why); `check:duplication` is the backstop if that stops
 * being a coincidence.
 */
const SESSION_ID_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type DelegationFileStatus =
  | { kind: "expired"; reason: string }
  | { kind: "valid" }
  | { kind: "unparseable"; reason: string };

/**
 * Read a `.delegations/<sid>` marker and classify it against `cutoffMs`,
 * WITHOUT verifying its signature: gc is deciding whether to delete a
 * file, not whether to trust it as an approval, and `parseDelegationApprovedBy`
 * is the same reader `harness doctor`'s delegations metric uses read-only.
 * Any failure to read the file, parse it as JSON, or parse its
 * `approvedBy`/`expires` segment is `unparseable`, never `expired`: a
 * marker gc cannot understand is never deleted (mutation probe M2).
 */
function readDelegationStatus(filePath: string, cutoffMs: number, nowMs: number): DelegationFileStatus {
  const read = readRegularFileRejectingSymlink(filePath);
  if (read.kind !== "ok") {
    return { kind: "unparseable", reason: `could not read ${filePath} (${read.kind})` };
  }
  const parsed = safeJsonParse(read.content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unparseable", reason: "not a JSON object" };
  }
  const segments = parseDelegationApprovedBy((parsed as Record<string, unknown>)["approvedBy"]);
  if (!segments.ok) {
    return { kind: "unparseable", reason: segments.reason };
  }
  const expiresMs = Date.parse(segments.value.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return {
      kind: "unparseable",
      reason: `expires segment is not a valid instant: ${JSON.stringify(segments.value.expiresAt)}`,
    };
  }
  // The expiry comparison itself: mutation probe M1 skips this and treats
  // every parseable marker as expired, which flips a "valid delegation is
  // kept" test red.
  if (expiresMs < cutoffMs) {
    return {
      kind: "expired",
      reason: `expired ${ageDays(nowMs, expiresMs)}d ago (past the ${ageDays(nowMs, cutoffMs)}d grace)`,
    };
  }
  return { kind: "valid" };
}

/**
 * Sweep `.delegations/` (expired markers) and `.delegation-adoptions/`
 * (ledgers orphaned once their marker is gone or expired). One shared
 * category (`"delegation"`), mirroring the approval-marker sweep's
 * dry-run/candidate/kept shape but keyed off the marker's OWN `expires`
 * segment instead of file mtime, since a delegation's age on disk and its
 * validity window are two different things.
 */
function sweepDelegations(
  generatedDir: string,
  cutoffMs: number,
  nowMs: number,
): { candidates: GcCandidate[]; unparseable: GcUnparseable[]; kept: number } {
  const delegationsDir = path.join(generatedDir, DELEGATION_MARKER_DIRNAME);
  const ledgerDir = path.join(generatedDir, ADOPTION_LEDGER_DIRNAME);

  const candidates: GcCandidate[] = [];
  const unparseable: GcUnparseable[] = [];
  let kept = 0;

  // Session id -> status, for every delegation marker actually present
  // and session-id-shaped, so the ledger pass below can tell "expired"
  // from "absent" from "still valid" without re-reading the file.
  const statusBySessionId = new Map<string, DelegationFileStatus>();

  let delegationNames: string[];
  try {
    delegationNames = fs.readdirSync(delegationsDir);
  } catch {
    delegationNames = [];
  }
  for (const name of delegationNames) {
    if (!SESSION_ID_BASENAME_RE.test(name)) continue;
    const full = path.join(delegationsDir, name);
    const status = readDelegationStatus(full, cutoffMs, nowMs);
    statusBySessionId.set(name, status);
    if (status.kind === "expired") {
      candidates.push({ filePath: full, category: "delegation", reason: status.reason });
    } else if (status.kind === "unparseable") {
      unparseable.push({ filePath: full, category: "delegation", reason: status.reason });
      kept += 1;
    } else {
      kept += 1;
    }
  }

  let ledgerNames: string[];
  try {
    ledgerNames = fs.readdirSync(ledgerDir);
  } catch {
    ledgerNames = [];
  }
  for (const name of ledgerNames) {
    if (!SESSION_ID_BASENAME_RE.test(name)) continue;
    const full = path.join(ledgerDir, name);
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
    const status = statusBySessionId.get(name);
    if (status === undefined) {
      // No marker for this session id at all: only a candidate once the
      // LEDGER's own age clears the cutoff. Without this check a ledger
      // written seconds ago (its marker legitimately not written yet, or
      // already cleaned up by something else) would be swept regardless
      // of age, contradicting the "older than the retention window"
      // posture documented on the command and the listing header; it
      // also closes the TOCTOU window between the two readdir calls
      // above, since a ledger written between them is newer than cutoff.
      if (stat.mtimeMs < cutoffMs) {
        candidates.push({
          filePath: full,
          category: "delegation",
          reason: "orphaned adoption ledger (no delegation marker for this session)",
        });
      } else {
        kept += 1;
      }
    } else if (status.kind === "expired") {
      candidates.push({
        filePath: full,
        category: "delegation",
        reason: `orphaned adoption ledger (delegation ${status.reason})`,
      });
    } else {
      // Marker still valid, or unparseable (gc cannot prove it is dead):
      // keep the ledger either way, same fail-closed posture as the
      // marker itself.
      kept += 1;
    }
  }

  return { candidates, unparseable, kept };
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
  const delegationsDir = path.join(generatedDir, DELEGATION_MARKER_DIRNAME);
  const adoptionLedgerDir = path.join(generatedDir, ADOPTION_LEDGER_DIRNAME);
  const permissionModeObservationsDir = path.join(
    generatedDir,
    PERMISSION_MODE_OBSERVATION_DIRNAME,
  );

  const candidates: GcCandidate[] = [];
  const unparseable: GcUnparseable[] = [];
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

  const delegations = sweepDelegations(generatedDir, cutoffMs, nowMs);
  candidates.push(...delegations.candidates);
  unparseable.push(...delegations.unparseable);
  keptCount += delegations.kept;

  const permissionModeObservations = staleFilesByMtime(
    permissionModeObservationsDir,
    cutoffMs,
    nowMs,
    "permission-mode-observation",
  );
  candidates.push(...permissionModeObservations.candidates);
  keptCount += permissionModeObservations.kept;

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
    delegationsDir,
    adoptionLedgerDir,
    permissionModeObservationsDir,
    candidates,
    unparseable,
    removed,
    failures,
    keptCount,
    applied: opts.apply === true,
  };
}
