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
import { readRegularFileRejectingSymlink } from "../../io/read-regular-file.js";
import { InvalidDurationError, parseDurationSeconds, type LedgerEntry } from "../../policies/index.js";
import { POLICY_DECISION_TYPE } from "../../runtime/ledger-record.js";
import { rejectMalformedSessionId } from "../../runtime/reject-malformed-session-id.js";

export const APPROVED_LEDGER_TAG_PREFIX = "understanding-approved:";

export const APPROVAL_MARKER_DIRNAME = ".approvals";

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
  rejectMalformedSessionId(sessionId);
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
  /**
   * True when `matched` is false SPECIFICALLY because a readable marker
   * existed but its `approvedAt` exceeded `opts.maxAgeMs`
   * (agent-tasks/d8ee60ca) — as opposed to the marker being absent
   * (never approved, or cleared by a task-completion boundary tool via
   * `clearApprovalMarker`), corrupted, or the session id malformed.
   * False whenever `matched` is true. This is the signal task 6e888423's
   * recovery-git-commit exemption keys off: "this session/task DID have
   * a real operator approval and it merely aged out" is safe to treat
   * differently from "this session/task was never approved" or "a task
   * boundary just cleared it for a new task" — see
   * src/runtime/recovery-git-commit.ts for the full argument.
   */
  expired: boolean;
}

export interface CheckApprovalMarkerOptions {
  /**
   * Max marker age in milliseconds (agent-tasks/d8ee60ca). When set,
   * a marker whose `approvedAt` is older than `now - maxAgeMs` is
   * treated as expired and returns `matched:false` with an
   * "expired" detail. When omitted, the marker has no TTL — the
   * legacy contract (one approval per session, no expiry).
   *
   * A marker whose body is unreadable (malformed JSON, missing
   * `approvedAt`) is treated as approved-but-undateable: the
   * existence-only contract documented above wins, so an operator
   * who hand-wrote an empty marker file still gets through. This
   * matters because the legacy DoS-resistance argument still holds.
   */
  maxAgeMs?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
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
 *
 * `opts.maxAgeMs` (agent-tasks/d8ee60ca): when set, a marker whose
 * `approvedAt` is older than the cutoff returns `matched:false` with
 * an "expired" detail so the agent gets the same "no approval" UX as
 * a never-approved session and must re-approve. A marker with no
 * readable `approvedAt` (body corrupted) skips the freshness check
 * and is treated as approved — same DoS-resistance rationale as the
 * body-unreadable branch below.
 */
export function checkApprovalMarker(
  generatedDir: string,
  sessionId: string,
  opts: CheckApprovalMarkerOptions = {},
): MarkerCheck {
  // Construct the path defensively: a malformed sessionId must fail CLOSED
  // here (no valid marker, so the gate blocks and demands approval), not
  // throw out of the gate hook, which the top-level handler turns into a
  // non-blocking exit that would let the gated tool proceed.
  let filePath: string;
  try {
    filePath = approvalMarkerPathFor(generatedDir, sessionId);
  } catch (err) {
    return {
      matched: false,
      detail: `invalid sessionId for approval marker: ${
        err instanceof Error ? err.message : String(err)
      }`,
      marker: null,
      expired: false,
    };
  }
  // Shared symlink-rejecting read (src/io/read-regular-file.ts): the lstat
  // reject is defense-in-depth against a planted symlink
  // (agent-tasks/d39f160e); each failure mode keeps its distinct detail.
  const read = readRegularFileRejectingSymlink(filePath);
  if (read.kind === "missing") {
    return {
      matched: false,
      detail: `no approval marker at ${filePath}`,
      marker: null,
      expired: false,
    };
  }
  if (read.kind === "symlink") {
    return {
      matched: false,
      detail: `approval marker is a symlink, refusing for safety: ${filePath}`,
      marker: null,
      expired: false,
    };
  }
  if (read.kind === "not-regular") {
    return {
      matched: false,
      detail: `approval marker path is not a regular file: ${filePath}`,
      marker: null,
      expired: false,
    };
  }
  let marker: ApprovalMarker | null = null;
  if (read.kind === "ok") {
    const parsed = safeJsonParse(read.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const approvedAt = typeof obj["approvedAt"] === "string" ? obj["approvedAt"] : "";
      const approvedBy = typeof obj["approvedBy"] === "string" ? obj["approvedBy"] : "";
      if (approvedAt.length > 0 && approvedBy.length > 0) {
        marker = { approvedAt, approvedBy };
      }
    }
  }
  // read.kind === "unreadable" keeps marker:null; existence already
  // satisfied the gate.
  if (opts.maxAgeMs !== undefined && marker !== null) {
    const approvedAtMs = Date.parse(marker.approvedAt);
    if (Number.isFinite(approvedAtMs)) {
      const nowMs = (opts.now ?? new Date()).getTime();
      const ageMs = nowMs - approvedAtMs;
      if (ageMs > opts.maxAgeMs) {
        const ageMin = Math.round(ageMs / 60_000);
        const maxMin = Math.round(opts.maxAgeMs / 60_000);
        return {
          matched: false,
          detail: `approval marker ${path.basename(filePath)} expired: age ${ageMin}m > max ${maxMin}m (approved at ${marker.approvedAt})`,
          marker,
          expired: true,
        };
      }
    }
  }
  const provenance = marker
    ? `approved at ${marker.approvedAt} by ${marker.approvedBy}`
    : "marker present, body unreadable (existence still satisfies the gate)";
  return {
    matched: true,
    detail: `approved via marker ${path.basename(filePath)}: ${provenance}`,
    marker,
    expired: false,
  };
}

// approval_lifecycle (agent-tasks/d8ee60ca, harness/f54e0ecb): per-task
// expiry of the approval marker. The legacy contract was one approval
// per session for the session's lifetime; multi-task sessions silently
// let a stale interpretation drive the next task's edits. The new
// config block expires the marker on three boundary kinds:
//
//   1. expire_on_tool_match: a list of MCP tool name patterns. When a
//      tool whose exact name appears in the list runs (PostToolUse hook),
//      the marker is deleted. Used to mark task-completion boundaries
//      for agent-tasks workflows (task_finish, task_abandon,
//      pull_requests_merge).
//   2. expire_on_bash_match: a list of regex patterns matched against
//      the Bash tool's command string. Same expiry semantics. Used by
//      gh-CLI / pure-Bash workflows where the task boundary is a shell
//      command (gh pr merge, git push origin master, etc.). Compiled
//      once at parse time; an invalid regex is skipped with a warning
//      so a typo in one pattern does not break the others.
//   3. max_age: a duration string. checkApprovalMarker treats a marker
//      older than this as expired. Safety net so a session that never
//      hits a listed tool / command still re-approves after the window.
//
// All three fields are optional. An empty list means no per-tool or
// per-command expiry; an omitted max_age means no TTL. `{ mode: "session" }`
// is the documented opt-out for operators who want the legacy behaviour.

export interface ApprovalLifecycle {
  /** Tool-name patterns whose successful PostToolUse expires the marker. */
  expireOnToolMatch: string[];
  /** Pre-compiled regex patterns matched against `Bash` tool_input.command. */
  expireOnBashMatch: RegExp[];
  /** Max marker age in milliseconds. Undefined means no TTL. */
  maxAgeMs?: number;
  /** Whether the operator explicitly opted out via `{ mode: "session" }`. */
  legacyMode: boolean;
}

const DEFAULT_LIFECYCLE: ApprovalLifecycle = {
  expireOnToolMatch: [],
  expireOnBashMatch: [],
  legacyMode: false,
};

/**
 * Parse the optional `approval_lifecycle` block from a pack config.
 * Best-effort: malformed values fall back to the default (no expiry,
 * legacyMode=false) and write a one-line warning to the supplied
 * stderr. The PreToolUse / PostToolUse hooks must keep working even
 * when the operator typed a typo in the YAML.
 */
export function parseApprovalLifecycle(
  raw: unknown,
  stderr?: { write: (s: string) => void } | null,
): ApprovalLifecycle {
  if (raw === undefined || raw === null) return DEFAULT_LIFECYCLE;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle ignored (expected object, got ${typeof raw})\n`,
    );
    return DEFAULT_LIFECYCLE;
  }
  const obj = raw as Record<string, unknown>;
  if (obj["mode"] === "session") {
    return { expireOnToolMatch: [], expireOnBashMatch: [], legacyMode: true };
  }
  const expireOnToolMatch: string[] = [];
  const list = obj["expire_on_tool_match"];
  if (Array.isArray(list)) {
    for (const v of list) {
      if (typeof v === "string" && v.length > 0) expireOnToolMatch.push(v);
    }
  } else if (list !== undefined) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle.expire_on_tool_match ignored (expected string[], got ${typeof list})\n`,
    );
  }
  const expireOnBashMatch: RegExp[] = [];
  const bashList = obj["expire_on_bash_match"];
  if (Array.isArray(bashList)) {
    for (const v of bashList) {
      if (typeof v !== "string" || v.length === 0) continue;
      try {
        expireOnBashMatch.push(new RegExp(v));
      } catch (err) {
        stderr?.write(
          `harness pack hook: config.approval_lifecycle.expire_on_bash_match entry ignored ("${v}"): ${(err as Error).message}\n`,
        );
      }
    }
  } else if (bashList !== undefined) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle.expire_on_bash_match ignored (expected string[], got ${typeof bashList})\n`,
    );
  }
  let maxAgeMs: number | undefined;
  const maxAgeRaw = obj["max_age"];
  if (typeof maxAgeRaw === "string" && maxAgeRaw.length > 0) {
    try {
      maxAgeMs = parseDurationSeconds(maxAgeRaw) * 1_000;
    } catch (err) {
      const msg = err instanceof InvalidDurationError ? err.message : String(err);
      stderr?.write(`harness pack hook: config.approval_lifecycle.max_age ignored: ${msg}\n`);
    }
  } else if (maxAgeRaw !== undefined) {
    stderr?.write(
      `harness pack hook: config.approval_lifecycle.max_age ignored (expected duration string like "4h", got ${typeof maxAgeRaw})\n`,
    );
  }
  return {
    expireOnToolMatch,
    expireOnBashMatch,
    ...(maxAgeMs !== undefined && { maxAgeMs }),
    legacyMode: false,
  };
}

/**
 * Flip the latest matching persisted report's approvalStatus to
 * `expired` so it no longer satisfies the gate's persisted-report
 * fallback (harness/1ee26e77 follow-up: post-tool-use expiry was
 * marker-only; the persisted report at .understanding-gate/reports/
 * silently kept satisfying the gate even after task_finish deleted
 * the marker).
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

/** Clear the per-session marker (used by `harness approve --revoke` and tests). */
export function clearApprovalMarker(generatedDir: string, sessionId: string): void {
  try {
    fs.rmSync(approvalMarkerPathFor(generatedDir, sessionId));
  } catch {
    /* already gone */
  }
}

// Task-scoped approval markers (harness/1ee26e77). When the operator
// passes `--task <id>` to `harness approve understanding`, a second
// marker file is written next to the session marker, keyed by the
// agent-tasks task id and prefixed `task-` so a directory scan can
// distinguish them from session-keyed markers (UUIDs do not start with
// `task-`). Either marker satisfies the gate; the session marker
// remains for back-compat with operators who don't pass --task and for
// non-agent-tasks workflows.
//
// Why task-scope: a session can span many distinct tasks; the operator's
// Understanding Report for task A doesn't transfer trust to task B
// (different surface, different acceptance criteria). Without per-task
// markers a multi-task session re-uses the first task's approval for
// every subsequent task. The expire_on_tool_match PostToolUse hook
// already deletes the session marker on `task_finish`, but if delivery
// is unreliable (e.g. PostToolUse skipped for an MCP tool) the marker
// silently persists. A task-keyed marker side-steps that delivery
// concern because the next task's id is different even if the previous
// marker file outlives its scope.

export const APPROVAL_MARKER_TASK_PREFIX = "task-";

/**
 * Reject taskIds that would escape the approvals/ namespace via path
 * traversal or directory separators. The operator's --task flag value
 * lands here verbatim; an accidental shell-expanded `..` or `/` would
 * otherwise write to a sibling directory. This is defensive — the
 * caller is the operator's own shell — but pins the trust boundary.
 */
function rejectMalformedTaskId(taskId: string): void {
  if (taskId.length === 0) {
    throw new Error("taskId is empty");
  }
  if (taskId.includes("/") || taskId.includes("\\") || taskId.includes("..")) {
    throw new Error(
      `taskId contains path-separator or traversal characters: ${JSON.stringify(taskId)}`,
    );
  }
}

/** Filesystem path of a per-task approval marker. */
export function taskApprovalMarkerPathFor(generatedDir: string, taskId: string): string {
  rejectMalformedTaskId(taskId);
  return path.join(generatedDir, APPROVAL_MARKER_DIRNAME, `${APPROVAL_MARKER_TASK_PREFIX}${taskId}`);
}

/**
 * Operator-side: write a task-scoped marker file. Atomic. Caller is
 * `harness approve understanding --task <id>`. The session marker is
 * written separately by the same caller for back-compat.
 */
export function writeTaskApprovalMarker(
  generatedDir: string,
  taskId: string,
  marker: ApprovalMarker,
): string {
  const filePath = taskApprovalMarkerPathFor(generatedDir, taskId);
  atomicWriteFile(filePath, `${JSON.stringify(marker, null, 2)}\n`);
  return filePath;
}

/**
 * Gate-side: resolve the active agent-tasks claim (via `active-claim`)
 * and check ONLY that task's approval marker. When no active claim is
 * recorded, this returns `matched:false` so the caller falls through
 * to the session marker — preserving the legacy contract for solo /
 * non-agent-tasks workflows that never call `task_start`.
 *
 * Replaces the v1 "any task marker satisfies the gate" behaviour
 * (PR #198): a stale approval from a different, already-completed task
 * was silently authorising every Edit/Write/Bash in the next session
 * because the scan returned the first existing marker regardless of
 * which task the agent had actually claimed.
 *
 * Same safety filters as `checkApprovalMarker` (existence-is-enough,
 * symlink rejection, optional freshness via `maxAgeMs`); the only
 * difference is the filename suffix derived from `active-claim`.
 */
export function checkActiveClaimApprovalMarker(
  generatedDir: string,
  opts: CheckApprovalMarkerOptions = {},
): MarkerCheck {
  const claim = readActiveClaim(generatedDir);
  if (claim === null) {
    return {
      matched: false,
      detail: `no active-claim recorded; task-scoped check skipped`,
      marker: null,
      expired: false,
    };
  }
  const markerName = `${APPROVAL_MARKER_TASK_PREFIX}${claim}`;
  const check = checkApprovalMarker(generatedDir, markerName, opts);
  if (check.matched) {
    return {
      matched: true,
      detail: `task-scoped marker for active-claim ${claim}: ${check.detail}`,
      marker: check.marker,
      expired: false,
    };
  }
  return {
    matched: false,
    detail: `active-claim ${claim} has no fresh task marker (${check.detail})`,
    marker: null,
    expired: check.expired,
  };
}

export interface OperatorMarkerApproval {
  matched: boolean;
  /** Which marker satisfied the gate; null when neither matched. */
  source: "task" | "session" | null;
  /** Detail of the decisive check (the match, or the session-scoped miss). */
  detail: string;
  /** Task-scoped check detail, for callers that trace the fall-through. */
  taskCheckDetail: string;
  /**
   * True when EITHER the task-scoped or the session-scoped marker
   * existed but aged past `approval_lifecycle.max_age` (task 6e888423).
   * False when `matched` is true, and false when a marker was simply
   * absent (never approved, or cleared by a task-completion boundary
   * tool) — distinguishing "this identity had a real approval that
   * merely expired" from "this identity was never approved" / "a new
   * task just started". PreToolUse hooks use this (never on its own —
   * always alongside `isRecoveryGitCommit`) to decide whether a bare
   * recovery `git commit` may proceed without a fresh Understanding
   * Report; see src/runtime/recovery-git-commit.ts.
   */
  expired: boolean;
}

/**
 * Shared marker resolution for the Claude and Codex understanding-gate
 * PreToolUse hooks (task e7c2ec3c): parse `approval_lifecycle` from the
 * pack config, consult the task-scoped (active-claim) marker first and
 * the session-scoped marker second, both under the same TTL. One code
 * path on purpose — the Codex hook previously called the bare session
 * check, so `max_age` and task-scoping silently applied only to Claude
 * sessions.
 */
export function checkOperatorApprovalMarkers(
  generatedDir: string,
  sessionId: string,
  packConfig: unknown,
  stderr?: { write: (s: string) => void } | null,
): OperatorMarkerApproval {
  const lifecycleRaw =
    packConfig !== null && typeof packConfig === "object" && !Array.isArray(packConfig)
      ? (packConfig as Record<string, unknown>)["approval_lifecycle"]
      : undefined;
  const lifecycle = parseApprovalLifecycle(lifecycleRaw, stderr);
  const ageOpts =
    lifecycle.maxAgeMs !== undefined ? { maxAgeMs: lifecycle.maxAgeMs } : {};
  const taskMarker = checkActiveClaimApprovalMarker(generatedDir, ageOpts);
  if (taskMarker.matched) {
    return {
      matched: true,
      source: "task",
      detail: taskMarker.detail,
      taskCheckDetail: taskMarker.detail,
      expired: false,
    };
  }
  const sessionMarker = checkApprovalMarker(generatedDir, sessionId, ageOpts);
  if (sessionMarker.matched) {
    return {
      matched: true,
      source: "session",
      detail: sessionMarker.detail,
      taskCheckDetail: taskMarker.detail,
      expired: false,
    };
  }
  return {
    matched: false,
    source: null,
    detail: sessionMarker.detail,
    taskCheckDetail: taskMarker.detail,
    // `expired` is computed ONLY on this non-matched path, preserving the
    // "false when matched is true" invariant (task 6e888423 review):
    // e.g. a FRESH session marker (matched:true, returned above) must not
    // read expired:true just because a STALE sibling task marker also
    // exists — that sibling is irrelevant once the session marker itself
    // satisfied the gate. Either marker aged out counts here: a
    // task-scoped approval that expired (even though the session-scoped
    // check may simply have never existed) is just as legitimate a "this
    // had approval, it lapsed" signal as a session-scoped expiry.
    expired: taskMarker.expired || sessionMarker.expired,
  };
}

/** Clear a specific task-scoped marker. Used by the post-tool-use hook. */
export function clearTaskApprovalMarker(generatedDir: string, taskId: string): void {
  try {
    fs.rmSync(taskApprovalMarkerPathFor(generatedDir, taskId));
  } catch {
    /* already gone */
  }
}

// Active-claim tracking (harness/494fd1e5). When the agent calls
// `mcp__agent-tasks__task_start`, a PostToolUse hook writes the claimed
// task id to a stable file. `harness approve understanding` reads it
// when --task is absent and auto-supplies it as the task-scoped marker
// target. This closes the v1 ergonomics gap from PR #184 where the
// operator had to type the taskId by hand.
//
// File contract: a single line containing just the taskId. No JSON,
// no metadata. Operators can `cat` it to debug. The post-tool-use
// hook on task_finish / task_abandon removes the file.

export const ACTIVE_CLAIM_FILENAME = "active-claim";

export function activeClaimPathFor(generatedDir: string): string {
  return path.join(generatedDir, ACTIVE_CLAIM_FILENAME);
}

function rejectMalformedClaimId(taskId: string): void {
  if (taskId.length === 0) {
    throw new Error("taskId is empty");
  }
  if (
    taskId.includes("\n") ||
    taskId.includes("\r") ||
    taskId.includes("/") ||
    taskId.includes("\\") ||
    taskId.includes("..")
  ) {
    throw new Error(
      `taskId contains forbidden characters (newline / path-separator / traversal): ${JSON.stringify(taskId)}`,
    );
  }
}

/**
 * Hook-side: write the active claim file. Atomic. Called from the
 * track-active-claim PostToolUse hook on `task_start`. The body is
 * just the taskId (no JSON) so an operator running
 * `cat ~/.claude/harness.generated/active-claim` sees the id directly.
 */
export function writeActiveClaim(generatedDir: string, taskId: string): string {
  rejectMalformedClaimId(taskId);
  const filePath = activeClaimPathFor(generatedDir);
  atomicWriteFile(filePath, `${taskId}\n`);
  return filePath;
}

/**
 * Operator-side: read the active claim file. Returns the taskId or
 * null when the file is absent / unreadable / empty. `harness approve
 * understanding` calls this when --task is absent, then passes the
 * resolved id to writeTaskApprovalMarker.
 *
 * Defense-in-depth: if the on-disk content fails the same
 * path-traversal / newline check that gates writes, the read returns
 * null instead of surfacing a poisoned id. The write side guards
 * against a malformed taskId reaching the file in the first place,
 * but a stale file authored before this guard (or hand-edited)
 * shouldn't escalate into a forged task-marker write downstream.
 */
export function readActiveClaim(generatedDir: string): string | null {
  const filePath = activeClaimPathFor(generatedDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    rejectMalformedClaimId(trimmed);
  } catch {
    return null;
  }
  return trimmed;
}

/** Hook-side: remove the active claim file. Idempotent. */
export function clearActiveClaim(generatedDir: string): void {
  try {
    fs.rmSync(activeClaimPathFor(generatedDir));
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
