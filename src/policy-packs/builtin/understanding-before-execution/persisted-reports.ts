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
import { sha256Hex } from "../../../runtime/approval-signing.js";

export interface PersistedReport {
  filePath: string;
  sessionId: string | null;
  approvalStatus: string | null;
  approvedAt: string | null;
  /**
   * Event a PostToolUse boundary expired this report for
   * (`tool:<tool_name>` or `bash:/<regex>/`), stamped by
   * `expirePersistedReport`; null for a report without the field (older
   * reports, package producers, or a TTL-only lapse).
   */
  expiredBy: string | null;
  /** ISO timestamp `expirePersistedReport` stamped; null when absent. */
  expiredAt: string | null;
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

function readPersistedReport(filePath: string, mtimeMs: number, boundedRaw?: string): PersistedReport | null {
  let raw: string;
  try {
    raw = boundedRaw ?? fs.readFileSync(filePath, "utf8");
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
    expiredBy: typeof obj["expiredBy"] === "string" ? (obj["expiredBy"] as string) : null,
    expiredAt: typeof obj["expiredAt"] === "string" ? (obj["expiredAt"] as string) : null,
    createdAt,
    createdAtMs,
  };
}

/**
 * List persisted reports under `dir`, newest-first by creation time
 * (JSON `createdAt`, then the filename ISO prefix, then mtime). Missing
 * directory returns []; an I/O error on a single file skips it. Reads each
 * regular file IN FULL, so it must not list the agent-writable reports
 * directory (use {@link listPersistedReportsBoundedWithSkips}); no `src`
 * caller remains, it stays for its tests and the pack's export surface.
 *
 * Creation time, NOT mtime, is the sort key: `harness approve
 * understanding` rewrites the report it flips, which bumps mtime and
 * made an old just-approved report sort as the freshest
 * (harness-discovery C1). mtime is the last-resort fallback.
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
 * The NEWEST report whose `sessionId` strictly equals `sessionId`, or
 * `null` when the newest-first list has none. Deliberately NOT a thin
 * wrapper over {@link selectReportForSession}: it stops at the first
 * strict match and never consults the sessionId-null tolerant fallback.
 *
 * Written for the PreToolUse hook's auto-approval path
 * (agent-tasks/74b4b17d, ADR
 * docs/decisions/2026-08-27-ug-auto-mode-approval.md, Option A condition
 * 3), where both of the fallback's properties are unacceptable:
 *
 *  - A sessionId-null report is adopted by whichever session asks, so
 *    the fallback would let a report bound to no session at all mint a
 *    marker for THIS one. The auto path has no operator to confirm that
 *    adoption the way `harness approve understanding` does.
 *  - Eligibility is evaluated on the newest report ONLY. The caller
 *    checks `approvalStatus === "pending"` on whatever this returns; if
 *    the newest strict-session report was already consumed, the session
 *    is ineligible even when an older `pending` report is still on disk.
 *    Scanning further down the list for some other pending report is
 *    exactly the re-mint this design forbids.
 */
export function selectNewestStrictSessionReport(
  reports: PersistedReport[],
  sessionId: string,
): PersistedReport | null {
  for (const r of reports) {
    if (r.sessionId === sessionId) return r;
  }
  return null;
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

/** Cap applied to each interpolated value in `checkPersistedReport`'s `detail`. */
const DETAIL_VALUE_MAX_LENGTH = 120;

/**
 * `detail` is not an inert log line: both PreToolUse hooks embed it
 * verbatim into their block `reason`, and the Codex hook additionally
 * writes it to stderr, the block-reason surface an operator reads
 * directly. The report file's basename and its `approvedAt` field both
 * come from a JSON file whose content the gated agent controls (it is
 * only unsigned evidence, task 7402301d), so neither is trusted
 * verbatim here: control characters (including newlines, which could
 * forge extra `reason:`-looking lines) are replaced with a space and
 * the result is capped so one field cannot blow out the surface.
 */
export function sanitizeDetailValue(value: string): string {
  // Deliberately strips C0/DEL control characters (including newline,
  // which could otherwise forge an extra `reason:`-looking stderr line).
  const flattened = value.replace(/[\x00-\x1f\x7f]/g, " ");
  return flattened.length > DETAIL_VALUE_MAX_LENGTH
    ? `${flattened.slice(0, DETAIL_VALUE_MAX_LENGTH)}...`
    : flattened;
}

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
  trigger?: string,
): { ok: true; filePath: string; previousStatus: string | null } | { ok: false; reason: string } {
  const reports = listPersistedReportsBounded(reportsDir);
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
      reason: `latest report ${sanitizeDetailValue(path.basename(latest.filePath))} already has approvalStatus=${sanitizeDetailValue(latest.approvalStatus ?? "<missing>")}, nothing to expire`,
    };
  }
  // Bounded like the listing: the file may have been swapped since.
  const read = readReportFileBounded(latest.filePath);
  if (!read.ok) {
    return { ok: false, reason: `failed to read ${latest.filePath}: ${read.detail}` };
  }
  const raw = read.raw;
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
  if (trigger !== undefined && trigger !== "") {
    parsed["expiredBy"] = trigger;
  } else {
    // No event to record: drop a stale one from an earlier expiry.
    delete parsed["expiredBy"];
  }
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
  const reports = listPersistedReportsBounded(reportsDir);
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
  const safeFileName = sanitizeDetailValue(path.basename(latest.filePath));
  if (latest.approvalStatus !== "approved") {
    const boundaryExpiry = describeBoundaryExpiry(latest);
    const expirySuffix = boundaryExpiry !== undefined ? `; ${boundaryExpiry}` : "";
    return {
      claimsApproved: false,
      detail: `latest report ${safeFileName} has approvalStatus=${
        sanitizeDetailValue(latest.approvalStatus ?? "<missing>")
      }${expirySuffix}`,
      report: latest,
    };
  }
  const safeApprovedAt = latest.approvedAt ? sanitizeDetailValue(latest.approvedAt) : null;
  return {
    claimsApproved: true,
    detail:
      `${UNSIGNED_REPORT_APPROVAL_REJECTED}: report ${safeFileName} has ` +
      `approvalStatus=approved${safeApprovedAt ? ` (approved at ${safeApprovedAt})` : ""} ` +
      `but the persisted report is evidence, not authority; the gate opens only on a ` +
      `validly-signed approval marker written by \`harness approve understanding\``,
    report: latest,
  };
}

/**
 * `approval expired because <event> at <time>` for a report a PostToolUse
 * boundary expired (`expirePersistedReport` stamps `expiredBy` and
 * `expiredAt`), `undefined` for any other report, including an older one or
 * one a package producer wrote that carries no `expiredBy`. Both values come
 * from a JSON file the gated agent can write, so both pass
 * `sanitizeDetailValue`.
 */
export function describeBoundaryExpiry(
  report: Pick<PersistedReport, "approvalStatus" | "expiredBy" | "expiredAt">,
): string | undefined {
  if (report.approvalStatus !== "expired") return undefined;
  if (report.expiredBy === null || report.expiredBy === "") return undefined;
  const when =
    report.expiredAt !== null && report.expiredAt !== ""
      ? ` at ${sanitizeDetailValue(report.expiredAt)}`
      : "";
  return `approval expired because ${sanitizeDetailValue(report.expiredBy)}${when}`;
}

/**
 * Report fields the approval and expiry lifecycles rewrite. They are left
 * out of {@link canonicalReportHash}: `rewriteReportApproved` flips
 * `approvalStatus`/`approvedAt`/`approvedBy`, may stamp `sessionId`, and
 * drops `expiredAt`/`expiredBy`; `expirePersistedReport` later sets
 * `approvalStatus`/`expiredAt`/`expiredBy` again. The hash must survive all
 * of that for an untouched report, so it covers only the content the
 * operator actually reviewed.
 */
const LIFECYCLE_REPORT_FIELDS: ReadonlySet<string> = new Set([
  "approvalStatus",
  "approvedAt",
  "approvedBy",
  "expiredAt",
  "expiredBy",
  "sessionId",
]);

/**
 * Deepest array/object nesting {@link canonicalReportHash} serialises (the
 * report object itself is level 1). `sortKeysDeep` and `JSON.stringify`
 * recurse once per level, and any agent-written `*.json` file in the reports
 * directory reaches them through the gate-read scan, so without a bound a
 * file nested a few thousand levels deep overflows the stack and the hook
 * process dies instead of deciding. A real report nests a handful of levels.
 */
const MAX_CANONICAL_REPORT_DEPTH = 64;

/**
 * Largest report file, in bytes, the canonical hash reads from disk (1 MiB).
 * Every `*.json` entry of the reports directory reaches the hash through the
 * gate-read scan, and the agent can write that directory, so without a bound
 * a planted file of a few hundred megabytes made the hook run out of heap or
 * past its time budget instead of deciding (a hook that dies or overruns is a
 * non-blocking error for the runtime). A real report is a few kilobytes, far
 * below the cap. A file over the cap matches nothing at gate read, and both
 * producers refuse to approve such a report.
 */
export const MAX_HASHED_REPORT_BYTES = 1024 * 1024;

/** Result of {@link walkContainerDepth}. */
export interface ContainerDepthWalk {
  /** True when some array/object nests deeper than the walk's `max` levels. */
  tooDeep: boolean;
  /** Values the walk took off its stack: the root plus every array/object below it. */
  visited: number;
}

/**
 * Iterative walk over the arrays and objects of `value` (the value itself is
 * level 1) that stops at the first one nested deeper than `max` levels.
 * Iterative, so the walk itself cannot overflow the stack. Only arrays and
 * objects are pushed: a scalar child (string, number, boolean, null) cannot
 * nest, so a wide array of scalars costs no stack slot per element, and
 * `visited` counts the root plus the containers below it. Exported for tests.
 */
export function walkContainerDepth(value: unknown, max: number): ContainerDepthWalk {
  const nodes: unknown[] = [value];
  const depths: number[] = [1];
  let visited = 0;
  while (nodes.length > 0) {
    const node = nodes.pop();
    const depth = depths.pop() ?? 1;
    visited += 1;
    if (node === null || typeof node !== "object") continue;
    if (depth > max) return { tooDeep: true, visited };
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") {
        nodes.push(child);
        depths.push(depth + 1);
      }
    }
  }
  return { tooDeep: false, visited };
}

/** True when `value` nests arrays/objects deeper than `max` levels. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  return walkContainerDepth(value, max).tooDeep;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]): [string, unknown] => [k, sortKeysDeep(v)]);
    // `Object.fromEntries` defines own properties, so a report key named
    // `__proto__` stays data instead of re-parenting the copy.
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * The hash an approval marker signs as its `reportContentHash`, and the one
 * the gate recomputes at read time (task fa423e9b): sha256 over a key-sorted
 * JSON serialisation of the parsed report with the lifecycle fields in
 * `LIFECYCLE_REPORT_FIELDS` removed. A raw-bytes hash cannot do this job: the
 * producers hash before `rewriteReportApproved` re-serialises the file and
 * `expirePersistedReport` rewrites it again, so the raw bytes of an untouched
 * report never match what the marker signed. One function on purpose, shared
 * by both producers (`harness approve understanding`, the auto-approval path)
 * and the verifier.
 *
 * Total: returns null instead of throwing for a report nested deeper than
 * `MAX_CANONICAL_REPORT_DEPTH`. The verifier counts such a file as one that
 * matches nothing; both producers refuse to approve such a report, so no
 * marker is ever signed without a content binding because of it. Report
 * files reach it only after {@link readReportFileBounded} bounded their type
 * and size (the gate-read scan and `harness approve understanding` through
 * {@link hashReportFile}, the auto-approval path directly).
 */
export function canonicalReportHash(report: Record<string, unknown>): string | null {
  // `Object.fromEntries` (not `kept[key] = value`): a report key named
  // `__proto__` must stay hashed data, not re-parent the copy and vanish.
  const kept = Object.fromEntries(
    Object.entries(report).filter(([key]) => !LIFECYCLE_REPORT_FIELDS.has(key)),
  );
  if (nestsDeeperThan(kept, MAX_CANONICAL_REPORT_DEPTH)) return null;
  return sha256Hex(JSON.stringify(sortKeysDeep(kept)));
}

/** Why {@link readReportFileBounded} returned no content. */
export type ReportFileReadFailure = "unreadable" | "not-regular" | "too-large" | "grew";

export type BoundedReportRead =
  | { ok: true; raw: string; mtimeMs: number }
  | { ok: false; reason: ReportFileReadFailure; detail: string };

/** What `readReportFileBounded` returns for a symbolic link when `noFollow` is set. */
const SYMLINK_REFUSED: BoundedReportRead = {
  ok: false,
  reason: "not-regular",
  detail: "a symbolic link, not a regular file",
};

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : String(err);
}

/**
 * Read a report file for hashing, bounded by type and size. This is the one
 * read every canonical report hash goes through: the gate-read scan (via
 * {@link hashReportFile}) and both producers. The path is opened once,
 * read-only and non-blocking (`O_NONBLOCK`: opening a FIFO with no writer
 * returns at once instead of waiting for one); its type and size come from
 * `fstat` on that descriptor, and the content is read through the same
 * descriptor, so nothing can be swapped in between (no separate stat of the
 * path, which a symlink flipped to a FIFO used to race). Refused without
 * reading: anything that is not a regular file, and a file larger than
 * `MAX_HASHED_REPORT_BYTES`. The read stops one byte past the fstat size
 * (never more than the cap plus one byte); a file that grows into that byte
 * while being read is refused too. The descriptor is always closed. Never
 * throws.
 *
 * `opts.noFollow` adds `O_NOFOLLOW` to the open: a path that is a symbolic
 * link (whatever it points at, a dangling link included) is refused as
 * not-regular by the open itself (`ELOOP`), with no earlier `lstat` for a
 * swap to race. Off by default, so every hook read keeps following links
 * exactly as before; `harness approve understanding` turns it on.
 */
export function readReportFileBounded(
  filePath: string,
  opts: { noFollow?: boolean } = {},
): BoundedReportRead {
  let fd: number;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        fs.constants.O_NONBLOCK |
        (opts.noFollow === true ? fs.constants.O_NOFOLLOW : 0),
    );
  } catch (err) {
    if (opts.noFollow === true && errorCode(err) === "ELOOP") return SYMLINK_REFUSED;
    return { ok: false, reason: "unreadable", detail: `could not be opened (${errorCode(err)})` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "not-regular", detail: "not a regular file" };
    if (stat.size > MAX_HASHED_REPORT_BYTES) {
      return {
        ok: false,
        reason: "too-large",
        detail: `${stat.size} bytes, over the ${MAX_HASHED_REPORT_BYTES}-byte cap for hashing its content`,
      };
    }
    const buf = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > stat.size) return { ok: false, reason: "grew", detail: "grew while being read" };
    return { ok: true, raw: buf.toString("utf8", 0, total), mtimeMs: stat.mtimeMs };
  } catch (err) {
    return { ok: false, reason: "unreadable", detail: `could not be read (${errorCode(err)})` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone; nothing left to release.
    }
  }
}

/** Why a report file has no canonical hash. */
export type UnhashableReportReason = ReportFileReadFailure | "not-json-object" | "too-deep";

export type ReportFileHash =
  | { ok: true; hash: string }
  | { ok: false; reason: UnhashableReportReason; detail: string };

/**
 * Canonical hash of the report file at `filePath`, read through
 * {@link readReportFileBounded}, or why it has none: not a regular file, over
 * `MAX_HASHED_REPORT_BYTES`, unreadable, grown while read, not a JSON object,
 * or nested too deeply. `harness approve understanding` refuses a report on
 * any of these (the `detail` is its message); the gate-read scan counts such
 * a file as one that matches nothing. Never throws.
 */
export function hashReportFile(
  filePath: string,
  opts: { noFollow?: boolean } = {},
): ReportFileHash {
  const read = readReportFileBounded(filePath, opts);
  if (!read.ok) return read;
  const parsed = safeJsonParse(read.raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-json-object", detail: "not a JSON object" };
  }
  const hash = canonicalReportHash(parsed as Record<string, unknown>);
  if (hash === null) {
    return { ok: false, reason: "too-deep", detail: "nested too deeply to hash its content" };
  }
  return { ok: true, hash };
}

/** Canonical hash of the report file at `filePath` ({@link hashReportFile}); null when it has none. */
export function canonicalReportHashOfFile(
  filePath: string,
  opts: { noFollow?: boolean } = {},
): string | null {
  const hashed = hashReportFile(filePath, opts);
  return hashed.ok ? hashed.hash : null;
}

/** Marker kind whose signed report hash the gate checks. */
export type ApprovalMarkerKind = "task" | "session";

/** One matched marker's signed `reportContentHash`, tagged with its kind. */
export interface MarkerReportBinding {
  kind: ApprovalMarkerKind;
  reportContentHash: string | null;
}

export type ApprovedReportHashVerification =
  | { ok: true; kind: ApprovalMarkerKind }
  | { ok: false; detail: string };

interface ReportHashScan {
  /** `*.json` entries found in the directory, whether or not they hash. */
  files: number;
  /** The wanted hashes some report file hashes to. */
  matched: Set<string>;
}

/**
 * Hash every `*.json` entry of `dir` (any session, any `approvalStatus`)
 * through {@link canonicalReportHashOfFile} and report which of the `wanted`
 * hashes occur. Stops as soon as every wanted hash was found. Every entry
 * counts as a report file; one that is not a regular file, is larger than
 * `MAX_HASHED_REPORT_BYTES`, cannot be opened or read, grows while read, is
 * not a JSON object, or nests too deeply matches nothing. The cost is linear
 * in the number and size of the report files (each read at most up to the
 * cap), and the usual allow path scans nearly all of them: the directory
 * listing comes back in name order and report names start with a timestamp,
 * so the approved (newest) report tends to come last.
 */
function scanReportHashes(dir: string, wanted: ReadonlySet<string>): ReportHashScan {
  const scan: ReportHashScan = { files: 0, matched: new Set<string>() };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return scan;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    scan.files += 1;
    const hash = canonicalReportHashOfFile(full);
    if (hash !== null && wanted.has(hash)) {
      scan.matched.add(hash);
      if (scan.matched.size === wanted.size) break;
    }
  }
  return scan;
}

/**
 * Gate-read cross-check of a matched approval marker against the persisted
 * reports (task fa423e9b). Both PreToolUse hooks call it after
 * `checkOperatorApprovalMarkers` matched, through `verifyMatchedMarkerReport`.
 *
 * Rule: a marker with a non-null signed `reportContentHash` is valid iff at
 * least one parseable report file in `reportsDir` (any session, any
 * `approvalStatus`) has a canonical hash equal to it. The hash already
 * leaves the lifecycle fields out, so approving, expiring or re-approving
 * the report never changes it. The signed hash therefore proves one thing:
 * the content the operator approved is still on disk unmodified. Editing
 * that file (in place, by swap, by symlink, by an unparseable rewrite)
 * removes the only match and the marker stops opening the gate. Comparing
 * against the session's newest approved report instead would deny
 * legitimate approvals (a newer report approved for the same claim, two
 * sessions on one claim) and would let a swap pass by moving the swapped
 * report out of the selection.
 *
 * Bounded input: only a regular file of at most `MAX_HASHED_REPORT_BYTES`
 * (1 MiB) that parses as a JSON object nested at most 64 levels deep has a
 * canonical hash, read through {@link readReportFileBounded} (opened
 * non-blocking, typed and sized by `fstat` on the open descriptor, read
 * through it). Every other `*.json` entry (a FIFO, a directory, a device, a
 * symlink to one of them, a file over the cap, an unreadable, unparseable or
 * too deeply nested file) still counts as a report file but matches nothing,
 * so it can neither open the gate nor make the scan block, run out of
 * memory or die instead of deciding.
 *
 * Residuals: (1) the check proves only that some file carries the approved
 * content. Any regular `*.json` file within the size cap whose content
 * equals it keeps a match, whether it was kept before the edit (a copy) or
 * re-created after it (the agent wrote that content, so it can write it
 * again), and the marker still opens the gate. (2) A reports directory that
 * is empty, unreadable or holds no `*.json` entry at all (every report
 * deleted, the directory made unreadable, the reports renamed) falls back to
 * the "no report file" allow, the same as before this check existed. The
 * marker and the operator's approval itself are untouched in both cases;
 * only the audit trail loses its claim to be the approved content. (3) The
 * cap bounds each file, not their number: the scan time grows with the
 * total volume of report files, so an agent that plants hundreds of
 * megabytes of files just under the cap can still push one scan past the
 * hook's time budget, which the runtime treats as a non-blocking error (the
 * same allow as before this check existed).
 *
 * Removing the approved report while other report files remain is a deny:
 * nothing on disk carries the signed content any more. `harness gc --apply`
 * can do that legitimately: it ages approved reports out by their createdAt
 * but markers by their file mtime, so a report written long before its
 * approval can go while the marker stays. Re-approving recovers.
 *
 * `primary` is the marker that satisfied the gate (task-scoped first),
 * `fallback` a session marker that matched behind a task marker. The
 * fallback is consulted only when the primary fails the check, so a task
 * marker signed for another report does not hide a session marker that
 * verifies. Unchanged behaviour: a null hash on the accepted marker (no
 * report resolved, or `--force` over a report nested too deeply to hash,
 * never one over the size cap) and a reports directory with no
 * `*.json` entry at all both allow. A forced approval of a hashable report
 * signs its hash and is checked like any other.
 *
 * The `detail` is the block reason. It names the failing marker kind and the
 * one-command fix, which is also the single migration step for a marker
 * written before the canonical hash existed. It carries no report-derived
 * value, so nothing in it needs sanitising.
 */
export function verifyApprovedReportHash(
  reportsDir: string,
  primary: MarkerReportBinding,
  fallback: MarkerReportBinding | null = null,
): ApprovedReportHashVerification {
  if (primary.reportContentHash === null) return { ok: true, kind: primary.kind };
  if (fallback !== null && fallback.reportContentHash === null) {
    return { ok: true, kind: fallback.kind };
  }
  const wanted = new Set<string>([primary.reportContentHash]);
  if (fallback !== null && fallback.reportContentHash !== null) {
    wanted.add(fallback.reportContentHash);
  }
  const scan = scanReportHashes(reportsDir, wanted);
  if (scan.files === 0 || scan.matched.has(primary.reportContentHash)) {
    return { ok: true, kind: primary.kind };
  }
  if (
    fallback !== null &&
    fallback.reportContentHash !== null &&
    scan.matched.has(fallback.reportContentHash)
  ) {
    return { ok: true, kind: fallback.kind };
  }
  const kinds =
    fallback !== null
      ? `${primary.kind} and ${fallback.kind} approval markers were`
      : `${primary.kind} approval marker was`;
  return {
    ok: false,
    detail:
      `no report in the reports directory matches the content the ${kinds} signed for ` +
      `(the approved report was changed or removed after approval); re-run \`harness approve understanding\``,
  };
}

/**
 * Why a `*.json` entry of the reports directory is absent from a bounded
 * listing: it could not be read through {@link readReportFileBounded}.
 */
export interface SkippedReportEntry {
  filePath: string;
  reason: ReportFileReadFailure;
  detail: string;
}

/**
 * {@link listPersistedReports} for every read a PreToolUse hook (or the
 * PostToolUse boundary) makes of the reports directory. The directory holds
 * files the gated agent can write, so every entry is opened once through
 * {@link readReportFileBounded}: non-blocking, typed and sized by `fstat` on
 * the open descriptor, read through it. A `*.json` entry that is not a
 * regular file (a FIFO, a directory, a device, a symlink to one of them), is
 * over `MAX_HASHED_REPORT_BYTES`, cannot be opened or read, or grows while it
 * is read is left out of `reports`, as if it were not there, and recorded in
 * `skipped`: it can neither block the hook nor run it out of memory. There is
 * no separate stat of the path (a symlink flipped to a FIFO between that stat
 * and the read used to hang the read), and the modification time comes from
 * the same descriptor.
 *
 * A caller that must not let the selection fall back to an older report when
 * a newer one is unreadable (the auto-approval precondition) declines when
 * `skipped` is not empty. The operator commands read through this listing as
 * well, so a planted oversized or non-regular entry cannot crash or hang
 * them, and they still see it: `harness approve understanding` refuses
 * while `skipped` is not empty (it passes `refuseSymlinks`, which also
 * refuses a symbolic link at the open, whatever it points at), and
 * `harness gc` reports each skipped entry and leaves it in place.
 *
 * Placement: this block sits at the end of the file, and
 * {@link readPersistedReport} takes the already-read text (`boundedRaw`), so
 * the line numbers the decision record
 * docs/decisions/2026-08-27-ug-auto-mode-approval.md cites in this file stay
 * put (tests/decisions-citations-resolve.test.ts pins them).
 */
export function listPersistedReportsBoundedWithSkips(
  dir: string,
  opts: { refuseSymlinks?: boolean } = {},
): {
  reports: PersistedReport[];
  skipped: SkippedReportEntry[];
} {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No readable directory: no reports.
  }
  const reports: PersistedReport[] = [];
  const skipped: SkippedReportEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const full = path.join(dir, name);
    // `refuseSymlinks` opens with O_NOFOLLOW, so a link is recorded as skipped
    // by the open itself and no earlier lstat can race a swap.
    const read = readReportFileBounded(full, { noFollow: opts.refuseSymlinks === true });
    if (!read.ok) {
      skipped.push({ filePath: full, reason: read.reason, detail: read.detail });
      continue;
    }
    const report = readPersistedReport(full, read.mtimeMs, read.raw);
    if (report !== null) reports.push(report);
  }
  reports.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { reports, skipped };
}

/**
 * {@link listPersistedReportsBoundedWithSkips} without the skipped entries,
 * for the callers that treat a skipped entry as no evidence
 * ({@link checkPersistedReport}, {@link expirePersistedReport}). Expiry acts
 * on the newest report that was within the cap, so an oversized newest
 * approved report is left as it is and the next in-cap one is expired.
 */
export function listPersistedReportsBounded(dir: string): PersistedReport[] {
  return listPersistedReportsBoundedWithSkips(dir).reports;
}
