// Signed in-flight records for Agent-tool subagents (slice 1 of the
// subagent-gate work, docs/decisions/2026-08-27-ug-auto-mode-approval.md
// "Invariants", "Threat model", "Delegation marker shape").
//
// THE PROBLEM THIS CLOSES. An Agent-tool subagent shares its parent's
// `session_id`; it has no way to call `harness approve understanding`
// itself. The understanding gate's own boundary-expiry mechanism
// (`applyPostToolUseExpiry`) deletes the parent's session marker the
// moment the parent crosses a task boundary, even while a subagent it
// spawned is still mid-flight — stranding that subagent with no
// approval it can present. An in-flight record is what lets a
// subagent keep the approval its parent held at the moment the
// subagent STARTED, independent of what happens to the parent's own
// marker afterwards.
//
// WHY ITS OWN DIRECTORY, NOT `.approvals/`. Exactly the delegation
// precedent (`delegation-markers.ts`'s module header): a record is
// evidence that a parent was once approved, not itself an approval a
// human granted, so it stays out of every `.approvals/` scan (the
// doctor `approvedBy`-prefix listing, `checkApprovalMarker`'s own
// directory) and out of `.delegations/` (a different artifact kind,
// scoped to `claude -p` children, not Agent-tool subagents). A record
// copied onto either of those directories fails signature verification
// there on markerId mismatch, mirroring the delegation module's own
// two-way argument.
//
// CONTAINMENT: `verifyInflightRecord` lstats both the `.inflight/` root
// and the session directory before ever touching the leaf file, so a
// symlinked root or session directory (reached only by following a link
// out of `.inflight/`) reads as no record rather than being followed.
// `.approvals/`'s own reader has the same pre-existing gap (it lstats
// neither its root nor a session-scoped subdirectory the same way); left
// as a follow-up there rather than fixed in this module.
//
// WHY EVERY BINDING TRAVELS INSIDE `approvedBy`. `signMarker` signs
// exactly the tuple `(markerId, approvedAt, approvedBy,
// reportContentHash)`; adding a signed field is a `SIGNING_ALG` bump.
// So the one thing this record signs beyond the marker id and the
// issue timestamp — which parent authority actually matched — rides in
// `approvedBy` as `inflight:<agentType>:parent=<task|session>`, the
// same shape choice `delegation-markers.ts` and the auto-approval path
// already made for their own extra bindings.
//
// SIGNATURE SCOPE, DELIBERATELY NARROW. The signed tuple binds
// `markerId` (which is itself `inflight:<sessionId>:<agentId>`),
// `approvedAt`, `approvedBy`, and a `null` report hash; it does NOT
// cover the `sessionId`/`agentId` fields stored in the body for
// convenience. A verifier that only recomputed the signature could
// therefore be fooled by a record left in place with its own body
// fields edited to claim a different agent id than the path it lives
// at — the signature over `inflight:<sessionId>:<agentId>` would still
// verify because `markerId` is derived from the REQUESTED ids, not
// from the body. `verifyInflightRecord` closes that gap with an
// explicit equality check between the body's own `sessionId`/`agentId`
// and the ids the caller is asking about, independent of the signature
// check: a record copied onto a different id's path recomputes the
// SAME signature (the markerId is derived from the requested ids, which
// still match its new path), so this equality check is the only thing
// that catches that shape of forgery.
//
// UNSIGNED CONVENIENCE FIELDS ARE NEVER LOAD-BEARING ON THEIR OWN. The
// body also carries `startedAt`, `agentType` and `parentSource` outside
// the signed tuple, for display and for readers (`listInflightRecords`,
// `harness gc`) that intentionally skip signature verification because
// they are deciding retention, not trust. `verifyInflightRecord` treats
// every one of those unsigned fields as untrustworthy on its own: it
// requires `startedAt` to equal the SIGNED `approvedAt` byte-for-byte
// (the writer always sets them to the same instant), and it requires
// `agentType`/`parentSource` to equal the values parsed back out of the
// SIGNED `approvedBy` string. Either disagreement is `forged`, never a
// silent fallback to the signed value — an editable field that could
// diverge from its signed twin without consequence would be exactly the
// same hole as trusting the unsigned field outright. Staleness itself is
// therefore computed from `approvedAt` (signed), not `startedAt`
// (unsigned): reviving an expired record by rewriting its unsigned
// timestamp is closed by verification failing outright, not merely by
// picking "the right" field to trust.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { readRegularFileRejectingSymlink } from "../../../io/read-regular-file.js";
import { safeJsonParse } from "../../../io/safe-json-parse.js";
import { signMarker, verifyMarkerSignature } from "../../../runtime/approval-signing.js";
import { rejectMalformedSessionId } from "../../../runtime/reject-malformed-session-id.js";
import type { OperatorMarkerApproval } from "./task-markers.js";

/** Directory holding in-flight records, a sibling of `.approvals/` and `.delegations/` under `generatedDir`. */
export const INFLIGHT_RECORD_DIRNAME = ".inflight";

/** Default staleness window: a record older than this is treated as dead weight even though nothing ever cleared it. */
export const DEFAULT_INFLIGHT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Prefix of the signed markerId, mirroring `delegation-<child-sid>`. */
const INFLIGHT_MARKER_ID_PREFIX = "inflight:";

/**
 * An agent id is a value Claude Code hands the hook, never one the
 * repository's own path-traversal-sensitive session ids need to share
 * a shape with, but it lands in `path.join` the same way, so it gets
 * its own narrow allowlist rather than reusing
 * `rejectMalformedSessionId`'s looser "no `/`, `\`, `..`" rule: 1..128
 * characters, first character alphanumeric (so it can never literally
 * be `.` or `..`), every other character one of
 * `[A-Za-z0-9._-]` (no control characters, no path separators).
 */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Rejects an agent id outside the allowlist above. Throws; never returns a value. */
export function rejectMalformedAgentId(agentId: string): void {
  if (agentId.length === 0) {
    throw new Error("agentId is empty");
  }
  if (agentId.length > 128) {
    throw new Error(`agentId exceeds 128 characters (got ${agentId.length})`);
  }
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `agentId must start with an alphanumeric character and contain only letters, digits, ".", "_", or "-": ${JSON.stringify(agentId)}`,
    );
  }
}

/**
 * The signed markerId for a record: `inflight:<sessionId>:<agentId>`.
 * Binding both ids into the signed payload is what stops a validly
 * signed record from being copied onto another agent id, or another
 * session, and still verifying.
 */
export function inflightMarkerIdFor(sessionId: string, agentId: string): string {
  return `${INFLIGHT_MARKER_ID_PREFIX}${sessionId}:${agentId}`;
}

/**
 * Filesystem path of a subagent's in-flight record:
 * `<generatedDir>/.inflight/<sessionId>/<agentId>`. Validates both ids
 * before they reach `path.join`, the same defensive posture every
 * other marker path function in this pack takes.
 */
export function inflightRecordPathFor(generatedDir: string, sessionId: string, agentId: string): string {
  rejectMalformedSessionId(sessionId);
  rejectMalformedAgentId(agentId);
  return path.join(generatedDir, INFLIGHT_RECORD_DIRNAME, sessionId, agentId);
}

/** The `parentSource` values a record's `approvedBy` can name. */
export type InflightParentSource = "task" | "session";

/**
 * `agentType` is a Claude-Code-supplied label (e.g. `general-purpose`)
 * that rides inside the signed `approvedBy` string as a `:`-delimited
 * segment, so it gets the narrowest allowlist that keeps it from ever
 * introducing a `:` (which `parseInflightApprovedBy` relies on to find
 * the `:parent=` boundary) or a control character: 1..64 characters,
 * first character alphanumeric, every other character one of
 * `[A-Za-z0-9._-]`.
 */
const AGENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Clock-skew tolerance for a record's signed `approvedAt`: an approval
 * timestamp more than this far in the future cannot come from a clock
 * this process trusts, so it is never matched — but unlike a forgery it
 * is not evidence of tampering (a clock can simply be wrong), so it is
 * reported as `stale`, the same bucket `harness gc` and the doctor
 * listing already sweep on the aged side of the window.
 */
const INFLIGHT_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The exact shape `writeInflightRecord` signs into `approvedBy`. */
const INFLIGHT_APPROVED_BY_RE = /^inflight:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):parent=(task|session)$/;

/**
 * Parse a signed `approvedBy` string back into the bindings it carries.
 * `null` on anything that does not match the exact shape
 * `writeInflightRecord` produces — this is the reader half of "every
 * binding travels inside `approvedBy`" (see the module header): a
 * value the writer could not have produced is never trusted as a source
 * of bindings, even though its bytes passed HMAC verification (a valid
 * signature only proves the bytes were signed by this key, not that
 * they match the shape a caller can safely destructure).
 */
function parseInflightApprovedBy(
  approvedBy: string,
): { agentType: string; parentSource: InflightParentSource } | null {
  const match = INFLIGHT_APPROVED_BY_RE.exec(approvedBy);
  if (match === null) return null;
  const [, agentType, parentSource] = match;
  return { agentType: agentType as string, parentSource: parentSource as InflightParentSource };
}

export interface WriteInflightRecordOptions {
  generatedDir: string;
  sessionId: string;
  agentId: string;
  /** Claude Code's `agent_type` for this subagent, e.g. `general-purpose`. */
  agentType: string;
  /** The parent's own marker check; a record is written only when this matched. */
  parent: OperatorMarkerApproval;
  /** Override the issue timestamp for deterministic tests. */
  now?: Date;
}

export type WriteInflightRecordResult =
  | { ok: true; filePath: string }
  | {
      ok: false;
      reason: "parent_not_approved" | "malformed_agent_type" | "invalid-input" | "write-failed";
      detail: string;
    };

/**
 * Write a signed in-flight record, but only when `parent` names a
 * MATCHED operator approval — a record is a copy of authority the
 * parent already had, never a new grant, so an unmatched parent
 * refuses outright with nothing written: the guard below is the entire
 * enforcement point, not a redundant belt-and-suspenders check on top
 * of some other gate. Atomic and mode 0600, like every other marker
 * write in this pack.
 */
export function writeInflightRecord(opts: WriteInflightRecordOptions): WriteInflightRecordResult {
  if (!opts.parent.matched || opts.parent.source === null) {
    return {
      ok: false,
      reason: "parent_not_approved",
      detail: "refusing to write an in-flight record: the parent has no matched operator approval",
    };
  }
  if (!AGENT_TYPE_RE.test(opts.agentType)) {
    return {
      ok: false,
      reason: "malformed_agent_type",
      detail: `agentType must be 1-64 characters, first character alphanumeric, every other character one of letters, digits, ".", "_", or "-": ${JSON.stringify(opts.agentType)}`,
    };
  }
  let filePath: string;
  try {
    filePath = inflightRecordPathFor(opts.generatedDir, opts.sessionId, opts.agentId);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-input",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const parentSource: InflightParentSource = opts.parent.source;
  const startedAt = (opts.now ?? new Date()).toISOString();
  const markerId = inflightMarkerIdFor(opts.sessionId, opts.agentId);
  const signed = signMarker(opts.generatedDir, markerId, {
    approvedAt: startedAt,
    approvedBy: `inflight:${opts.agentType}:parent=${parentSource}`,
    reportContentHash: null,
  });
  const body = {
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    agentType: opts.agentType,
    startedAt,
    parentSource,
    parentDetail: opts.parent.detail,
    ...signed,
  };
  try {
    atomicWriteFile(filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      reason: "write-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, filePath };
}

export interface VerifyInflightRecordOptions {
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Override the staleness window; defaults to {@link
   * DEFAULT_INFLIGHT_STALE_AFTER_MS}. Test seam only: no production
   * caller overrides this, since the runtime gate always trusts the
   * fixed default (mirroring `harness gc`'s own fixed 24h sweep window
   * in `src/cli/gc/index.ts`, which cannot be `--retention-days`-tuned
   * either).
   */
  staleAfterMs?: number;
}

export interface InflightRecordVerification {
  matched: boolean;
  /** True when a record existed but failed signature verification, or disagreed with its own path. */
  forged: boolean;
  /** True SPECIFICALLY when a validly-signed, path-consistent record aged past the staleness window. */
  stale: boolean;
  detail: string;
}

/**
 * Consult the in-flight record for `(sessionId, agentId)`. Checks, in
 * order: the `.inflight/` root and the session directory are real
 * directories, not symlinks (module header, "CONTAINMENT"); the
 * requested `agentId` names an EXACT directory entry, not merely a path
 * that resolves (guards a case-insensitive filesystem); the file is
 * present and JSON-readable; its signature verifies against
 * `inflight:<sessionId>:<agentId>` RECOMPUTED FROM THE REQUESTED ids
 * (never from anything stored in the body); its own `sessionId`/`agentId`
 * fields agree with those requested ids (the check the signature alone
 * cannot make, see the module header); it is not older than the
 * staleness window.
 *
 * Fail-closed shape mirrors `verifyDelegation`: every refusal names a
 * distinct reason, `forged` and `stale` are reachable only from the
 * branches documented above, and there is no branch that turns a
 * missing, malformed, moved, or aged record into `matched: true`.
 */
export function verifyInflightRecord(
  generatedDir: string,
  sessionId: string,
  agentId: string,
  opts: VerifyInflightRecordOptions = {},
): InflightRecordVerification {
  let filePath: string;
  try {
    filePath = inflightRecordPathFor(generatedDir, sessionId, agentId);
  } catch (err) {
    return {
      matched: false,
      forged: false,
      stale: false,
      detail: `invalid sessionId/agentId for in-flight record: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // lstat the root and the session directory before ever reading the
  // leaf, mirroring `listInflightRecords`' own guard: a `readdirSync` or
  // `readFileSync` reached only by following a symlink out of
  // `.inflight/` would let a linked root or session directory smuggle a
  // record from elsewhere on disk. Absent, a symlink, or not a directory
  // all read as "no record" here, never `forged`: none of them is
  // evidence of a tampered signature, only that the expected containment
  // does not hold.
  const rootDir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME);
  const sessionDir = path.join(rootDir, sessionId);
  for (const dir of [rootDir, sessionDir]) {
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      return { matched: false, forged: false, stale: false, detail: `no in-flight record at ${filePath}` };
    }
    if (!dirStat.isDirectory()) {
      return {
        matched: false,
        forged: false,
        stale: false,
        detail: `no in-flight record at ${filePath} (${dir} is not a plain directory)`,
      };
    }
  }

  // The requested agentId must name an EXACT entry in the session
  // directory, not merely a path `path.join` can resolve to. On a
  // case-insensitive filesystem the read below would happily open a
  // differently-cased sibling's record; its signature — recomputed from
  // the REQUESTED, case-variant id — would then fail to verify and be
  // classified forged, even though nothing was tampered with. A
  // case-variant request simply names no record; `readdirSync` lists
  // literal entry names regardless of the filesystem's own case
  // sensitivity, so this is the one check that can tell the two apart.
  //
  // ONLY the agentId segment gets this exact-entry check. The sessionId
  // segment (the `sessionDir` lstat above) inherits whatever the
  // underlying filesystem does with `path.join` + `lstatSync`: on a
  // case-insensitive volume a case-variant sessionId still resolves to
  // the same directory, so the lstat passes, and the record is read and
  // signature-checked against the REQUESTED (case-variant) sessionId —
  // which the SIGNED body never matches, so it comes back `forged`, not
  // "no record". This is the same fail-closed outcome the module header
  // argues for generally; it is merely a less precise diagnostic than
  // the agentId case gets (see the ADR's "TTL, cwd, and subagents"
  // section for the write side that never produces one anyway: session
  // ids are runtime-generated UUIDs, not operator-chosen strings, so a
  // case collision is not a realistic write-time input).
  let sessionEntries: string[];
  try {
    sessionEntries = fs.readdirSync(sessionDir);
  } catch {
    return { matched: false, forged: false, stale: false, detail: `no in-flight record at ${filePath}` };
  }
  if (!sessionEntries.includes(agentId)) {
    return {
      matched: false,
      forged: false,
      stale: false,
      detail: `no in-flight record at ${filePath} (no exact entry named ${JSON.stringify(agentId)} in ${sessionDir})`,
    };
  }

  const read = readRegularFileRejectingSymlink(filePath);
  if (read.kind === "missing") {
    return { matched: false, forged: false, stale: false, detail: `no in-flight record at ${filePath}` };
  }
  if (read.kind === "symlink") {
    return {
      matched: false,
      forged: false,
      stale: false,
      detail: `in-flight record is a symlink, refusing for safety: ${filePath}`,
    };
  }
  if (read.kind === "not-regular") {
    return {
      matched: false,
      forged: false,
      stale: false,
      detail: `in-flight record path is not a regular file: ${filePath}`,
    };
  }
  if (read.kind === "unreadable") {
    return {
      matched: false,
      forged: false,
      stale: false,
      detail: `in-flight record at ${filePath} exists but could not be read (I/O error); treating as absent since its signature cannot be verified`,
    };
  }

  const parsed = safeJsonParse(read.content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      matched: false,
      forged: false,
      stale: false,
      detail: `unparsable in-flight record body at ${filePath}`,
    };
  }
  const body = parsed as Record<string, unknown>;

  const markerId = inflightMarkerIdFor(sessionId, agentId);
  const verification = verifyMarkerSignature(generatedDir, markerId, body);
  if (!verification.ok) {
    if (verification.kind === "key-unavailable") {
      // Fail-closed I/O problem, not evidence of tampering — same
      // distinction `verifyDelegation` draws for its own `unreadable`.
      return {
        matched: false,
        forged: false,
        stale: false,
        detail: `in-flight record at ${filePath} could not be verified: ${verification.reason}`,
      };
    }
    return {
      matched: false,
      forged: true,
      stale: false,
      detail: `forged/unsigned in-flight record rejected: ${verification.reason} (${filePath})`,
    };
  }

  const bodySessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : undefined;
  const bodyAgentId = typeof body["agentId"] === "string" ? body["agentId"] : undefined;
  if (bodySessionId !== sessionId || bodyAgentId !== agentId) {
    return {
      matched: false,
      forged: true,
      stale: false,
      detail:
        `in-flight record at ${filePath} disagrees with its own path (body sessionId=${JSON.stringify(
          bodySessionId,
        )}, agentId=${JSON.stringify(bodyAgentId)}, expected ${sessionId}/${agentId})`,
    };
  }

  // `verifyMarkerSignature` already rejected a non-string/empty
  // `approvedAt` before returning `ok: true`, so this cast is safe; the
  // finite-instant check below still guards against a signed-but-garbage
  // value (e.g. a non-date string that happens to be non-empty).
  const approvedAt = body["approvedAt"] as string;
  const approvedAtMs = Date.parse(approvedAt);
  if (!Number.isFinite(approvedAtMs)) {
    return {
      matched: false,
      forged: true,
      stale: false,
      detail: `in-flight record at ${filePath} has a signed approvedAt that is not a valid instant: ${JSON.stringify(approvedAt)}`,
    };
  }

  // The unsigned `startedAt` convenience field must agree with the
  // SIGNED `approvedAt` byte-for-byte (the writer always sets them to
  // the same instant). Divergence means the unsigned copy was edited
  // after signing — the shape that would revive an aged, genuinely
  // stale record by rewriting only its unsigned timestamp.
  const startedAt = typeof body["startedAt"] === "string" ? body["startedAt"] : undefined;
  if (startedAt !== approvedAt) {
    return {
      matched: false,
      forged: true,
      stale: false,
      detail: `in-flight record at ${filePath} has an unsigned startedAt that disagrees with its signed approvedAt (startedAt=${JSON.stringify(startedAt)}, approvedAt=${JSON.stringify(approvedAt)})`,
    };
  }

  // `approvedBy` is likewise guaranteed a non-empty string by
  // `verifyMarkerSignature`. Its parsed bindings must agree with the
  // unsigned `agentType`/`parentSource` fields the body carries for
  // display — an attacker who could edit only the unsigned pair (the
  // signed `approvedBy` unchanged) would otherwise reach the success
  // detail below with a body/approvedBy that disagree.
  const approvedBy = body["approvedBy"] as string;
  const bindings = parseInflightApprovedBy(approvedBy);
  const bodyAgentType = typeof body["agentType"] === "string" ? body["agentType"] : undefined;
  const bodyParentSource = typeof body["parentSource"] === "string" ? body["parentSource"] : undefined;
  if (bindings === null || bindings.agentType !== bodyAgentType || bindings.parentSource !== bodyParentSource) {
    return {
      matched: false,
      forged: true,
      stale: false,
      detail: `in-flight record at ${filePath} has an approvedBy binding that disagrees with its own body (approvedBy=${JSON.stringify(approvedBy)}, body agentType=${JSON.stringify(bodyAgentType)}, parentSource=${JSON.stringify(bodyParentSource)})`,
    };
  }

  const nowMs = (opts.now ?? new Date()).getTime();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_INFLIGHT_STALE_AFTER_MS;

  // A clock this process trusts would never see its own signed approval
  // land more than a few minutes in the future; treat it like staleness
  // (not a forgery) since a clock skew is not evidence of tampering.
  if (approvedAtMs - nowMs > INFLIGHT_FUTURE_SKEW_MS) {
    return {
      matched: false,
      forged: false,
      stale: true,
      detail: `in-flight record at ${filePath} is dated more than ${INFLIGHT_FUTURE_SKEW_MS / 60_000} minutes in the future: approved at ${approvedAt}`,
    };
  }

  // `nowMs - approvedAtMs > staleAfterMs`, not the reverse: swapping the
  // comparison would mark a fresh record stale and a genuinely stale one
  // fresh.
  if (nowMs - approvedAtMs > staleAfterMs) {
    return {
      matched: false,
      forged: false,
      stale: true,
      detail: `in-flight record at ${filePath} is stale: approved at ${approvedAt}`,
    };
  }

  return {
    matched: true,
    forged: false,
    stale: false,
    detail: `in-flight record matched: agent ${agentId} (${bindings.agentType}), parent=${bindings.parentSource}, approved at ${approvedAt}`,
  };
}

/**
 * Remove a subagent's in-flight record, then best-effort remove its
 * now-possibly-empty session directory. Never throws when the record,
 * or the session directory, is already gone — mirrors
 * `clearApprovalMarker` / `clearTaskApprovalMarker`.
 */
export function clearInflightRecord(generatedDir: string, sessionId: string, agentId: string): void {
  let filePath: string;
  try {
    filePath = inflightRecordPathFor(generatedDir, sessionId, agentId);
  } catch {
    return;
  }
  try {
    fs.rmSync(filePath);
  } catch {
    /* already gone */
  }
  try {
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    /* not empty, or already gone */
  }
}

export interface InflightRecordsSummary {
  /** Records found and readable, across every session directory. */
  total: number;
  /**
   * Of `total`, how many have an `approvedAt` older than the staleness
   * window, OR dated implausibly far in the future (beyond the same
   * future-skew tolerance `verifyInflightRecord` applies): both count
   * as stale here, since a record this listing does not verify cannot
   * tell "clock skew" from "tampered" apart, and neither is fresh.
   */
  stale: number;
  sessions: Array<{ sessionId: string; agentIds: string[] }>;
  /** Entries that were not a readable, parseable record: filesystem debris, unreadable files, missing/bad `approvedAt`. */
  skipped: string[];
}

/**
 * Read-only audit listing of every in-flight record on disk, mirroring
 * `buildUgDelegations`'s own shape: no signature check (this is
 * evidence for `harness doctor` and `harness gc`, not a trust
 * decision), tolerant of a missing `.inflight/` directory (empty
 * result rather than an error), and an entry gc/doctor cannot make
 * sense of is `skipped` rather than silently dropped.
 *
 * lstat the root itself first, not a bare `readdirSync`-then-catch: a
 * `readdirSync` on a symlinked `.inflight/` would happily follow it and
 * list whatever real directory it points at, the same trap
 * `sweepInflightRecords` in `src/cli/gc/index.ts` already guards
 * against one level up. A symlinked or non-directory root reads as
 * absent here too, for the same reason `buildUgInflight` already lstats
 * before calling this function: it must not report on records reached
 * only by following a link out of `.inflight/`.
 */
export function listInflightRecords(
  generatedDir: string,
  now?: Date,
  staleAfterMs?: number,
): InflightRecordsSummary {
  const dir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME);
  const nowMs = (now ?? new Date()).getTime();
  const effectiveStaleAfterMs = staleAfterMs ?? DEFAULT_INFLIGHT_STALE_AFTER_MS;

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(dir);
  } catch {
    return { total: 0, stale: 0, sessions: [], skipped: [] };
  }
  if (!rootStat.isDirectory()) {
    return { total: 0, stale: 0, sessions: [], skipped: [] };
  }

  let sessionDirents: fs.Dirent[];
  try {
    sessionDirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total: 0, stale: 0, sessions: [], skipped: [] };
  }

  let total = 0;
  let stale = 0;
  const sessions: Array<{ sessionId: string; agentIds: string[] }> = [];
  const skipped: string[] = [];

  for (const sessionDirent of sessionDirents) {
    const sessionPath = path.join(dir, sessionDirent.name);
    if (!sessionDirent.isDirectory()) {
      skipped.push(sessionPath);
      continue;
    }
    try {
      rejectMalformedSessionId(sessionDirent.name);
    } catch {
      skipped.push(sessionPath);
      continue;
    }

    let agentDirents: fs.Dirent[];
    try {
      agentDirents = fs.readdirSync(sessionPath, { withFileTypes: true });
    } catch {
      skipped.push(sessionPath);
      continue;
    }

    const agentIds: string[] = [];
    for (const agentDirent of agentDirents) {
      const full = path.join(sessionPath, agentDirent.name);
      if (!agentDirent.isFile()) {
        skipped.push(full);
        continue;
      }
      try {
        rejectMalformedAgentId(agentDirent.name);
      } catch {
        skipped.push(full);
        continue;
      }
      const read = readRegularFileRejectingSymlink(full);
      if (read.kind !== "ok") {
        skipped.push(full);
        continue;
      }
      const parsed = safeJsonParse(read.content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        skipped.push(full);
        continue;
      }
      const body = parsed as Record<string, unknown>;
      // No signature check here (audit listing, not a trust decision —
      // see the function doc), so this reads the SAME `approvedAt`
      // field `verifyInflightRecord` trusts only once it has verified
      // the signature: an unsigned `startedAt` copy is never consulted,
      // by either reader, for a staleness decision.
      const approvedAt = typeof body["approvedAt"] === "string" ? body["approvedAt"] : undefined;
      const approvedAtMs = approvedAt !== undefined ? Date.parse(approvedAt) : NaN;
      if (approvedAt === undefined || !Number.isFinite(approvedAtMs)) {
        skipped.push(full);
        continue;
      }
      total += 1;
      agentIds.push(agentDirent.name);
      // Aged past the window, or dated implausibly far in the future
      // (clock skew, or a tampered field this listing does not verify):
      // both count as `stale` here, mirroring `verifyInflightRecord`'s
      // own future-skew handling.
      if (nowMs - approvedAtMs > effectiveStaleAfterMs || approvedAtMs - nowMs > INFLIGHT_FUTURE_SKEW_MS) {
        stale += 1;
      }
    }
    if (agentIds.length > 0) {
      sessions.push({ sessionId: sessionDirent.name, agentIds });
    }
  }

  return { total, stale, sessions, skipped };
}
