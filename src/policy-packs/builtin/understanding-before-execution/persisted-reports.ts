// Persisted JSON report handling (`.understanding-gate/reports/`), split
// out of the former monolithic understanding-before-execution-runtime.ts
// (structural concentration slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.
//
// `safeJsonParse` used to be defined and exported here (module-private in
// the monolith, then exported so markers.ts could reuse it for
// marker-body parsing). It has since moved to src/io/safe-json-parse.ts
// (task 9bc0d546) so both call sites import a shared helper instead of one
// importing it from the other -- import/export mechanics only, no
// behavior change.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { safeJsonParse } from "../../../io/safe-json-parse.js";

export interface PersistedReport {
  filePath: string;
  sessionId: string | null;
  approvalStatus: string | null;
  approvedAt: string | null;
  /**
   * ISO timestamp the producer stamped when it wrote the report; null
   * for legacy reports without the field.
   */
  createdAt: string | null;
  /**
   * Effective creation time in epoch ms, resolved `createdAt` →
   * filename ISO prefix → file mtime. Unlike mtime alone this survives
   * the approval rewrite (which bumps mtime and would otherwise make a
   * weeks-old report sort as the freshest, harness-discovery C1).
   */
  createdAtMs: number;
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

/**
 * Parse the ISO prefix of a producer filename
 * (`2026-05-24T06-16-39-409Z-<slug>-<hash>.json`) into epoch ms. The
 * producer flattens `:` and `.` to `-` for filesystem safety; undo that
 * before `Date.parse`. null when the name does not carry the prefix.
 */
function parseFilenameIsoMs(name: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function readPersistedReport(filePath: string, mtimeMs: number): PersistedReport | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const createdAt = typeof obj["createdAt"] === "string" ? (obj["createdAt"] as string) : null;
  const createdAtJsonMs = createdAt !== null ? Date.parse(createdAt) : Number.NaN;
  const createdAtMs = !Number.isNaN(createdAtJsonMs)
    ? createdAtJsonMs
    : (parseFilenameIsoMs(path.basename(filePath)) ?? mtimeMs);
  return {
    filePath,
    sessionId: typeof obj["sessionId"] === "string" ? (obj["sessionId"] as string) : null,
    approvalStatus:
      typeof obj["approvalStatus"] === "string" ? (obj["approvalStatus"] as string) : null,
    approvedAt: typeof obj["approvedAt"] === "string" ? (obj["approvedAt"] as string) : null,
    createdAt,
    createdAtMs,
  };
}

/**
 * List persisted reports under `dir`, newest-first by creation time
 * (JSON `createdAt`, falling back to the filename ISO prefix, falling
 * back to mtime). Missing directory returns []. Any I/O error on a
 * single file is silently skipped; the caller falls through to the
 * ledger result.
 *
 * Creation time, NOT mtime, is the sort key: `harness approve
 * understanding` rewrites the report it flips, which bumps mtime and
 * made an old just-approved report sort as the freshest
 * (harness-discovery C1). mtime survives only as the last-resort
 * fallback for files that carry neither timestamp.
 */
export function listPersistedReports(dir: string): PersistedReport[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const reports: PersistedReport[] = [];
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
    const report = readPersistedReport(full, stat.mtimeMs);
    if (!report) continue;
    reports.push(report);
  }
  reports.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return reports;
}

/**
 * Maximum age a sessionId-null report may have for the tolerant
 * fallback to adopt it on the `harness approve understanding` path.
 * Sized for the real flow (Stop hook persists at turn end, operator
 * approves within minutes) with slack for a slow read-through. Live
 * repro that motivated it: a 17-day-old pending report got adopted,
 * validated, and stamped for a fresh session because the producer had
 * silently failed to persist the fresh report (harness-discovery C1,
 * friction-log #67).
 */
export const TOLERANT_FALLBACK_MAX_AGE_MS = 15 * 60_000;

/**
 * Tolerance for a sessionId-less candidate whose `createdAt` lies in
 * the FUTURE relative to the approve-time clock. A future creation
 * time is suspect either way: a forged `createdAt` (the producer's
 * Metadata block lets the agent author it) or serious clock skew.
 * Beyond this skew the fallback rejects the candidate just like a
 * stale one rather than trusting a timestamp that cannot be right.
 */
export const TOLERANT_FALLBACK_FUTURE_SKEW_MS = 5 * 60_000;

export interface FindReportOptions {
  /**
   * Behaviour of the sessionId-null tolerant fallback (older Stop-hook
   * package versions write reports without a `sessionId` field):
   *  - `"any"` (default): adopt the freshest sessionId-null report
   *    regardless of its `approvalStatus`. The gate read path
   *    (`checkPersistedReport`) and post-tool-use expiry
   *    (`expirePersistedReport`) rely on this so they keep finding the
   *    session's own report.
   *  - `"uncompleted"`: skip sessionId-null reports whose
   *    `approvalStatus` is a terminal `approved` / `expired`. Such a
   *    report belongs to a prior, finished approval cycle (often from
   *    a different task days ago) and must not be silently re-adopted
   *    as the current session's approval. `harness approve
   *    understanding` passes this so it never flips a stale unrelated
   *    report into the live session (harness/0dce3880 friction #1).
   */
  tolerantFallback?: "any" | "uncompleted";
  /**
   * Maximum age (relative to `now`) of a sessionId-null candidate the
   * tolerant fallback may adopt; older candidates are skipped and
   * surfaced via `FindReportSelection.staleRejected`. Strict sessionId
   * matches are never age-limited. Unset means no limit (the legacy
   * gate-read / expiry contract).
   */
  maxFallbackAgeMs?: number;
  /** Clock anchor for the age computation; defaults to the wall clock. */
  now?: Date;
}

export interface FindReportSelection {
  report: PersistedReport | null;
  /**
   * True when `report` was adopted via the sessionId-null tolerant
   * fallback rather than a strict sessionId match. Callers that bind
   * the report to a session (the approve flow) surface this loudly so
   * the operator can verify the adoption.
   */
  fallbackAdopted: boolean;
  /**
   * sessionId-null candidates skipped for exceeding `maxFallbackAgeMs`,
   * newest first. Lets the caller distinguish "no report at all" from
   * "only stale candidates existed", which are different failures: the
   * latter usually means the producer failed to persist the fresh
   * report (harness-discovery C1).
   */
  staleRejected: PersistedReport[];
}

/**
 * Select the freshest report for a given session_id, or the freshest
 * applicable report when the persisted file lacks a sessionId field
 * (older package versions). `report: null` when nothing matches.
 *
 * The strict (sessionId-equals) match always wins. The tolerant
 * fallback's appetite is controlled by `opts.tolerantFallback` and
 * `opts.maxFallbackAgeMs` — see `FindReportOptions`. The selection
 * result carries enough context (`fallbackAdopted`, `staleRejected`)
 * for the caller to be loud about non-strict adoptions.
 */
export function selectReportForSession(
  reports: PersistedReport[],
  sessionId: string,
  opts: FindReportOptions = {},
): FindReportSelection {
  // Strict match first.
  for (const r of reports) {
    if (r.sessionId === sessionId) {
      return { report: r, fallbackAdopted: false, staleRejected: [] };
    }
  }
  // Tolerant fallback: a report without sessionId is treated as
  // applicable to whichever session is asking. Only kicks in when no
  // matching sessionId-tagged report exists — which includes the case
  // where the producer Stop hook silently failed to persist the live
  // session's report, so the candidates here may be entirely unrelated
  // leftovers. `maxFallbackAgeMs` is the guard against adopting those.
  const mode = opts.tolerantFallback ?? "any";
  const nowMs = (opts.now ?? new Date()).getTime();
  const staleRejected: PersistedReport[] = [];
  for (const r of reports) {
    if (r.sessionId !== null) continue;
    if (
      mode === "uncompleted" &&
      (r.approvalStatus === "approved" || r.approvalStatus === "expired")
    ) {
      // A completed-cycle report from another session/task; skipping it
      // here is what stops `harness approve understanding` from binding
      // the live session to a stale, unrelated report.
      continue;
    }
    if (opts.maxFallbackAgeMs !== undefined) {
      const ageMs = nowMs - r.createdAtMs;
      if (ageMs > opts.maxFallbackAgeMs || ageMs < -TOLERANT_FALLBACK_FUTURE_SKEW_MS) {
        staleRejected.push(r);
        continue;
      }
    }
    return { report: r, fallbackAdopted: true, staleRejected };
  }
  return { report: null, fallbackAdopted: false, staleRejected };
}

/**
 * Back-compat wrapper around `selectReportForSession` for callers that
 * only need the report (the gate read and expiry paths).
 */
export function findLatestReportForSession(
  reports: PersistedReport[],
  sessionId: string,
  opts: FindReportOptions = {},
): PersistedReport | null {
  return selectReportForSession(reports, sessionId, opts).report;
}

/**
 * Distinct, greppable audit phrase for the case where the persisted report
 * on disk says `approvalStatus: "approved"` but no validly-signed approval
 * marker backs it (task 7402301d). The counterpart of the marker path's
 * `forged/unsigned marker rejected` phrase: both PreToolUse hooks embed
 * `PersistedReportEvidence.detail` in their block reason, so this phrase
 * is what an operator or auditor greps for to tell "someone dropped an
 * approved-looking report into the reports directory" (or: a report was
 * approved through a path that never wrote the signed marker, e.g. the
 * standalone `understanding-gate approve` CLI) apart from the routine
 * "never approved" case. Module-private on purpose: the tests that pin
 * the phrase spell it out literally, so a change here turns them red
 * instead of silently following the constant.
 */
const UNSIGNED_REPORT_APPROVAL_REJECTED = "unsigned persisted-report approval rejected";

/**
 * What the gate learns from the persisted report: EVIDENCE, never
 * authority (task 7402301d). Until that task the report was the second
 * of two equal approval sources ("either source approves"), consulted
 * right after a forged marker had been rejected, and it was unsigned: an
 * attacker with any write primitive the `Edit|Write|Bash` blocker
 * matcher does not cover forged an approval with ONE unsigned JSON write
 * (no session id, no key read needed, since the gate-read fallback adopts
 * a sessionId-less report for any session). Gate-time approval authority
 * now flows ONLY through the HMAC-signed marker (`checkOperatorApprovalMarkers`);
 * this shape deliberately has no `approved` field so a hook cannot read
 * an allow decision out of it by accident.
 */
export interface PersistedReportEvidence {
  /**
   * True when the selected report's on-disk `approvalStatus` is
   * `"approved"`. Diagnostic only: an approved-looking report with no
   * signed marker behind it is exactly the forgery shape this field must
   * never be allowed to open the gate for. `detail` carries the
   * `UNSIGNED_REPORT_APPROVAL_REJECTED` phrase in that case.
   */
  claimsApproved: boolean;
  detail: string;
  report: PersistedReport | null;
}

/**
 * Flip the latest matching persisted report's approvalStatus to
 * `expired` so the audit record agrees with the cleared marker
 * (harness/1ee26e77 follow-up: post-tool-use expiry was marker-only; the
 * persisted report at .understanding-gate/reports/ silently kept
 * satisfying the gate even after task_finish deleted the marker. Since
 * task 7402301d the report carries no gate authority at all, so this flip
 * is audit hygiene rather than a second gate closure).
 *
 * Atomic rewrite. Preserves the rest of the report body so the audit
 * trail (the operator's actual Understanding text + previous approval
 * timestamps) stays intact; only the status fields change.
 *
 * Returns `{ ok: true, filePath, previousStatus }` on success,
 * `{ ok: false, reason }` when no matching report exists or rewrite
 * failed. Non-throwing: caller (post-tool-use hook) uses this as a
 * best-effort cleanup so a missing report dir or unrelated I/O issue
 * does not escalate into a session-breaking hook failure.
 */
export function expirePersistedReport(
  reportsDir: string,
  sessionId: string,
  now: Date = new Date(),
): { ok: true; filePath: string; previousStatus: string | null } | { ok: false; reason: string } {
  const reports = listPersistedReports(reportsDir);
  if (reports.length === 0) {
    return { ok: false, reason: `no reports under ${reportsDir}` };
  }
  const latest = findLatestReportForSession(reports, sessionId);
  if (!latest) {
    return {
      ok: false,
      reason: `no report matched session_id=${sessionId} (${reports.length} report(s) for other sessions)`,
    };
  }
  if (latest.approvalStatus !== "approved") {
    return {
      ok: false,
      reason: `latest report ${path.basename(latest.filePath)} already has approvalStatus=${latest.approvalStatus ?? "<missing>"}, nothing to expire`,
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(latest.filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: `failed to read ${latest.filePath}: ${(err as Error).message}` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `failed to parse ${latest.filePath}: ${(err as Error).message}` };
  }
  const previousStatus =
    typeof parsed["approvalStatus"] === "string" ? (parsed["approvalStatus"] as string) : null;
  parsed["approvalStatus"] = "expired";
  parsed["expiredAt"] = now.toISOString();
  try {
    atomicWriteFile(latest.filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      reason: `failed to rewrite ${latest.filePath}: ${(err as Error).message}`,
    };
  }
  return { ok: true, filePath: latest.filePath, previousStatus };
}

/**
 * Gate-side EVIDENCE probe of the persisted report (task 7402301d). Both
 * PreToolUse hooks call this after the signed-marker check has NOT
 * matched, purely to (a) put a precise reason into the block diagnostic
 * and (b) tell "no report at all" (`report: null`, which gates the
 * parse-error lookup) apart from "a report exists but is pending".
 *
 * It never returns an approval. The selection still uses the tolerant
 * sessionId-null fallback (`"any"`, no age limit) so the diagnostic keeps
 * naming a legacy session's own sessionId-less report; that leniency is
 * harmless now because nothing here can open the gate. A report whose
 * on-disk status is `approved` yields `claimsApproved: true` with the
 * `UNSIGNED_REPORT_APPROVAL_REJECTED` phrase in `detail`, the distinct
 * audit signal for a report-side forgery attempt (or an approval that
 * bypassed `harness approve understanding`, e.g. the standalone
 * `understanding-gate approve` CLI, which writes no signed marker).
 */
export function checkPersistedReport(
  reportsDir: string,
  sessionId: string,
): PersistedReportEvidence {
  const reports = listPersistedReports(reportsDir);
  if (reports.length === 0) {
    return {
      claimsApproved: false,
      detail: `no reports found at ${reportsDir}`,
      report: null,
    };
  }
  const latest = findLatestReportForSession(reports, sessionId);
  if (!latest) {
    return {
      claimsApproved: false,
      detail: `no report matched session_id=${sessionId} (${reports.length} report(s) for other sessions)`,
      report: null,
    };
  }
  if (latest.approvalStatus !== "approved") {
    return {
      claimsApproved: false,
      detail: `latest report ${path.basename(latest.filePath)} has approvalStatus=${
        latest.approvalStatus ?? "<missing>"
      }`,
      report: latest,
    };
  }
  return {
    claimsApproved: true,
    detail:
      `${UNSIGNED_REPORT_APPROVAL_REJECTED}: report ${path.basename(latest.filePath)} has ` +
      `approvalStatus=approved${latest.approvedAt ? ` (approved at ${latest.approvedAt})` : ""} ` +
      `but the persisted report is evidence, not authority; the gate opens only on a ` +
      `validly-signed approval marker written by \`harness approve understanding\``,
    report: latest,
  };
}
