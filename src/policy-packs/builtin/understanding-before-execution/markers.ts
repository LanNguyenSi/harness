// Session-scoped approval marker file (filesystem source of the
// two-source approval check), split out of the former monolithic
// understanding-before-execution-runtime.ts (structural concentration
// slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { readRegularFileRejectingSymlink } from "../../../io/read-regular-file.js";
import { signMarker, verifyMarkerSignature } from "../../../runtime/approval-signing.js";
import { rejectMalformedSessionId } from "../../../runtime/reject-malformed-session-id.js";
import { safeJsonParse } from "../../../io/safe-json-parse.js";

export const APPROVAL_MARKER_DIRNAME = ".approvals";

/** Filesystem path of the per-session approval marker. */
export function approvalMarkerPathFor(generatedDir: string, sessionId: string): string {
  rejectMalformedSessionId(sessionId);
  return path.join(generatedDir, APPROVAL_MARKER_DIRNAME, sessionId);
}

export interface ApprovalMarker {
  approvedAt: string;
  approvedBy: string;
  /**
   * sha256 hex of the persisted-report content this approval is bound to
   * at sign-time (harness/f9485cc7). Optional on write (defaults to
   * `null` — a marker with no report to bind, e.g. `harness approve
   * branch-protection`, or a ledger-only approval); always present
   * (possibly `null`) on a marker `checkApprovalMarker` returns.
   */
  reportContentHash?: string | null;
}

/**
 * Operator-side: write the marker file the gate consults. Atomic so a
 * crash mid-write cannot leave a half-empty file the gate would accept
 * as approved. Caller is `harness approve understanding`, which the
 * operator runs from their un-hooked shell; if the agent could call
 * this path the gate's value would collapse, so it lives behind the
 * approve CLI rather than as a generally importable verb.
 *
 * The marker is HMAC-signed (harness/f9485cc7) over (sessionId,
 * approvedAt, approvedBy, reportContentHash) using an operator-side key
 * lazily generated at `<generatedDir>/.approval-signing.key` — see
 * `src/runtime/approval-signing.ts` for the key-management contract and
 * the honest trust model. Mode 0600 on the marker file itself, best-
 * effort (matches the signing key's own permission convention); this is
 * defense-in-depth alongside the signature, not a substitute for it.
 */
export function writeApprovalMarker(
  generatedDir: string,
  sessionId: string,
  marker: ApprovalMarker,
): string {
  const filePath = approvalMarkerPathFor(generatedDir, sessionId);
  const signed = signMarker(generatedDir, sessionId, marker);
  atomicWriteFile(filePath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
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
  /**
   * True when a marker FILE existed at the expected path but failed
   * signature verification (harness/f9485cc7): missing `signature`/`alg`
   * fields (a legacy pre-signing marker, or a marker planted without the
   * operator-side key), a mismatched `alg`, or a signature that does not
   * verify against the current key. Distinct from the marker being
   * simply absent (`forged: false`, `matched: false`) so a caller can
   * log/alert on an active forgery attempt instead of the routine
   * "nobody has approved yet" case. `matched` is always false when
   * `forged` is true — a forged marker never satisfies the gate,
   * regardless of `approval_lifecycle.max_age`. A transient I/O read
   * failure (`forged: false`, `matched: false`) is kept distinct from
   * both: it is neither "no marker" nor evidence of tampering, just a
   * marker whose integrity cannot be proven right now.
   */
  forged: boolean;
}

export interface CheckApprovalMarkerOptions {
  /**
   * Max marker age in milliseconds (agent-tasks/d8ee60ca). When set,
   * a marker whose `approvedAt` is older than `now - maxAgeMs` is
   * treated as expired and returns `matched:false` with an
   * "expired" detail. When omitted, the marker has no TTL — the
   * legacy contract (one approval per session, no expiry).
   */
  maxAgeMs?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/**
 * Gate-side: is the per-session marker file present, readable, AND
 * validly signed? (harness/f9485cc7 — this replaced the earlier
 * "existence is enough" contract: a marker's mere presence used to
 * satisfy the gate even with a malformed or corrupted body, on the
 * theory that Edit/Write/Bash being gated meant only the operator could
 * ever create the file. That theory holds only as long as no OTHER
 * write primitive reaches `harness.generated/` — exactly the invariant
 * this signing scheme no longer has to trust blindly.) A marker with no
 * `signature`, a wrong `alg`, or a signature that fails to verify is
 * REJECTED — see `MarkerCheck.forged` — with the SAME `matched: false`
 * outcome as no marker at all, but a distinct, forgery-specific detail
 * string so callers can tell the two apart for audit.
 *
 * `opts.maxAgeMs` (agent-tasks/d8ee60ca): when set, a validly-signed
 * marker whose `approvedAt` is older than the cutoff returns
 * `matched:false` with an "expired" detail so the agent gets the same
 * "no approval" UX as a never-approved session and must re-approve.
 * Expiry is only evaluated AFTER signature verification succeeds — an
 * unsigned/forged marker is rejected outright, never "expired".
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
      forged: false,
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
      forged: false,
    };
  }
  if (read.kind === "symlink") {
    return {
      matched: false,
      detail: `approval marker is a symlink, refusing for safety: ${filePath}`,
      marker: null,
      expired: false,
      forged: false,
    };
  }
  if (read.kind === "not-regular") {
    return {
      matched: false,
      detail: `approval marker path is not a regular file: ${filePath}`,
      marker: null,
      expired: false,
      forged: false,
    };
  }
  if (read.kind === "unreadable") {
    // A genuine I/O error reading an existing regular file (permissions
    // changed mid-flight, etc.) — not evidence of tampering, but its
    // signature cannot be proven either, so fail closed. Kept distinct
    // from `forged` (no claim of an active forgery attempt).
    return {
      matched: false,
      detail: `approval marker at ${filePath} exists but could not be read (I/O error); treating as unapproved since its signature cannot be verified`,
      marker: null,
      expired: false,
      forged: false,
    };
  }
  // read.kind === "ok"
  const parsed = safeJsonParse(read.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      matched: false,
      detail: `forged/unsigned marker rejected: marker body at ${filePath} is not a JSON object`,
      marker: null,
      expired: false,
      forged: true,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const verification = verifyMarkerSignature(generatedDir, sessionId, obj);
  if (!verification.ok) {
    if (verification.kind === "key-unavailable") {
      // Fail-closed I/O problem (permission error / disk issue reading or
      // creating the signing key), NOT evidence of an active forgery
      // attempt — a marker written by the operator with a perfectly valid
      // signature would also fail this exact check if the key file became
      // unreadable. Kept distinct from `forged` (review LOW 1,
      // harness/f9485cc7) so a broken key file doesn't read as an attack
      // in audit output, mirroring the `read.kind === "unreadable"` branch
      // above.
      return {
        matched: false,
        detail: `approval marker at ${filePath} could not be verified: ${verification.reason}; treating as unapproved`,
        marker: null,
        expired: false,
        forged: false,
      };
    }
    return {
      matched: false,
      detail: `forged/unsigned marker rejected: ${verification.reason} (${filePath})`,
      marker: null,
      expired: false,
      forged: true,
    };
  }
  const approvedAt = obj["approvedAt"] as string;
  const approvedBy = obj["approvedBy"] as string;
  const reportContentHash =
    typeof obj["reportContentHash"] === "string" ? (obj["reportContentHash"] as string) : null;
  const marker: ApprovalMarker = { approvedAt, approvedBy, reportContentHash };

  if (opts.maxAgeMs !== undefined) {
    const approvedAtMs = Date.parse(approvedAt);
    if (Number.isFinite(approvedAtMs)) {
      const nowMs = (opts.now ?? new Date()).getTime();
      const ageMs = nowMs - approvedAtMs;
      if (ageMs > opts.maxAgeMs) {
        const ageMin = Math.round(ageMs / 60_000);
        const maxMin = Math.round(opts.maxAgeMs / 60_000);
        return {
          matched: false,
          detail: `approval marker ${path.basename(filePath)} expired: age ${ageMin}m > max ${maxMin}m (approved at ${approvedAt})`,
          marker,
          expired: true,
          forged: false,
        };
      }
    }
  }
  return {
    matched: true,
    detail: `approved via marker ${path.basename(filePath)}: approved at ${approvedAt} by ${approvedBy}, signature verified`,
    marker,
    expired: false,
    forged: false,
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
