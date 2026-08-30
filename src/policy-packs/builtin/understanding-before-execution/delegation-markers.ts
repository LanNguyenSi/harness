// Signed DELEGATION markers for `claude -p` child sessions: slice 3 of
// docs/decisions/2026-08-27-ug-auto-mode-approval.md ("Delegation marker
// shape", "TTL, cwd, and subagents", "Audit and doctor").
//
// A delegation is a PRE-AUTHORIZATION, not an approval. It is key one of
// the ADR's two-key design: the parent, already approved, hands the child
// session a signed artifact that supplies the trusted signal and the
// parent linkage. Key two (the child's own Understanding Report) is
// checked elsewhere; nothing in this module ever opens a gate on its own.
//
// WHY ITS OWN DIRECTORY AND ITS OWN VERIFIER. The file lives at
// `<generatedDir>/.delegations/<child-sid>`, never in `.approvals/`:
// keeping pre-authorizations out of the approvals directory keeps every
// existing marker scan and the doctor `approvedBy`-prefix listing free of
// artifacts that never opened a gate. `checkApprovalMarker` cannot consume
// a delegation anyway: the signature is computed over the markerId
// `delegation-<child-sid>`, so a delegation copied onto `.approvals/<sid>`
// fails that reader's signature check exactly like a forgery, and an
// approval marker copied into `.delegations/` fails this module's check
// for the mirror-image reason. Both directions are pinned by
// tests/policy-packs/understanding-before-execution-delegation.test.ts.
//
// WHY EVERY BINDING TRAVELS INSIDE `approvedBy`. The signing primitive
// signs exactly the tuple (markerId, approvedAt, approvedBy,
// reportContentHash) (src/runtime/approval-signing.ts), and adding a
// signed field would change `canonicalPayload`, which under that module's
// strict no-migration precedent means a `SIGNING_ALG` bump and forced
// re-approval on every install. So the delegation packs parent, cwd, task
// and expiry into `approvedBy`, the one free-text field inside the signed
// tuple:
//
//   delegated:<parent-sid>;cwd=<sha256|->;task=<id|->;expires=<iso>[;report=<sha256>]
//
// All of it is therefore tamper-evident with no schema change. The cwd is
// hashed rather than written literally so the file carries no machine
// path. `approvedAt` records ISSUE time only, never the expiry:
// `verifyMarkerSignature` rejects a marker with a missing/empty
// `approvedAt` before it computes any HMAC, so the field must be there,
// and the marker readers keep no `expiresAt` field for anything to
// enforce, which is exactly why the lifetime rides in the `expires`
// segment above and why this module ships its own verifier.
//
// FAIL CLOSED THROUGHOUT. Every refusal in `verifyDelegation` carries a
// distinct reason; no branch turns a missing, malformed, unparseable or
// unbound delegation into an `ok` result. `parseDelegationApprovedBy`
// never fills in a default for an absent segment: a delegation whose
// bindings cannot be read in full is not a delegation.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { readRegularFileRejectingSymlink } from "../../../io/read-regular-file.js";
import { safeJsonParse } from "../../../io/safe-json-parse.js";
import {
  sha256Hex,
  signMarker,
  signingKeyExists,
  signingKeyPathFor,
  verifyMarkerSignature,
} from "../../../runtime/approval-signing.js";
import { rejectMalformedSessionId } from "../../../runtime/reject-malformed-session-id.js";

/** Directory holding delegation markers, a sibling of `.approvals/` under `generatedDir`. */
export const DELEGATION_MARKER_DIRNAME = ".delegations";

/**
 * Directory holding the per-child ADOPTED-ENTRY ledgers (once-per-session
 * transcript-capture bookkeeping written by the PreToolUse hook,
 * `hook-pre-tool-use.ts`), a SIBLING of `.delegations/` itself rather than
 * a subdirectory of it: `<generatedDir>/.delegation-adoptions/<sid>`.
 *
 * Defined here (not in `hook-pre-tool-use.ts`, the only writer) so that a
 * reader that never writes a ledger, such as `harness gc`'s delegation
 * sweep, can name the directory without importing a `cli/` module: this
 * file already owns `DELEGATION_MARKER_DIRNAME`, the sibling constant an
 * adoption-ledger reader also needs, and both dirnames traveling together
 * keeps `.delegations/` and its ledger sibling from drifting apart.
 */
export const ADOPTION_LEDGER_DIRNAME = ".delegation-adoptions";

/** Prefix of the signed markerId, mirroring `task-<id>` for task markers. */
const DELEGATION_MARKER_ID_PREFIX = "delegation-";

/** The `approvedBy` segment carrying the parent linkage. Colon-separated, unlike the `key=value` segments after it. */
const DELEGATED_SEGMENT_PREFIX = "delegated:";

/** Literal written for a binding the delegation deliberately leaves open (`cwd=-`, `task=-`). */
const UNBOUND = "-";

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Control characters (including NUL and DEL) are rejected from the parent
// linkage in both directions: the writer refuses to encode one and the
// reader refuses to accept one it finds, mirroring `;`/`=`.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Deliberately narrower than `Date.parse`, which accepts plenty of
// non-ISO input ("March 3 2026") and, worse, timezone-less strings whose
// meaning depends on the reader's local zone. An expiry must mean the
// same instant in the parent's process and in the child's.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The signed markerId for a child session: `delegation-<child-sid>`.
 * Binding it into the signed payload is what stops a validly signed
 * delegation from being copied onto another child id, or onto a session
 * marker's id, and still verifying (`task-markers.ts` precedent).
 */
export function delegationMarkerIdFor(childSessionId: string): string {
  return `${DELEGATION_MARKER_ID_PREFIX}${childSessionId}`;
}

/**
 * Filesystem path of a child session's delegation marker. Rejects a
 * malformed session id the same way `approvalMarkerPathFor` does (the
 * value lands in a `path.join` verbatim).
 */
export function delegationMarkerPathFor(generatedDir: string, childSessionId: string): string {
  rejectMalformedSessionId(childSessionId);
  return path.join(generatedDir, DELEGATION_MARKER_DIRNAME, childSessionId);
}

/**
 * sha256 hex of a filesystem path, canonicalized through `realpathSync`
 * when the path exists and through `path.resolve` when it does not.
 *
 * The canonicalization is the point, not an optimization: the parent
 * writing the delegation and the child reporting its cwd routinely spell
 * the same directory differently (on macOS `os.tmpdir()` hands out
 * `/var/folders/...` while the process reports `/private/var/folders/...`,
 * because `/var` is a symlink), and an uncanonicalized comparison would
 * refuse a perfectly legitimate delegation. Falling back to `resolve` for
 * a non-existent path keeps the function total: a path that cannot be
 * canonicalized still hashes deterministically, and a delegation bound to
 * it simply will not match a cwd that resolves elsewhere.
 *
 * Named for its primary use; the fallback shape hashes the launcher-
 * supplied report file's PATH with the same function, so that WHERE the
 * parent put the report is part of what was signed.
 */
export function hashDelegationCwd(targetPath: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(targetPath);
  } catch {
    canonical = path.resolve(targetPath);
  }
  return sha256Hex(canonical);
}

/** The bindings packed into a delegation's `approvedBy` string. */
export interface DelegationApprovedByFields {
  parentSessionId: string;
  /** sha256 of the child's expected cwd, or `null` for a task-only delegation. */
  cwdHash: string | null;
  /** The task id the child is delegated for, or `null` for a cwd-only delegation. */
  taskId: string | null;
  /** ISO-8601 instant at which the delegation stops being valid. */
  expiresAt: string;
  /** sha256 of the launcher-supplied report file's PATH; present only in the fallback shape. */
  reportPathHash?: string;
}

function rejectUnsafeSegmentValue(field: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${field} is empty`);
  }
  if (value.includes(";") || value.includes("=")) {
    throw new Error(
      `${field} contains a delegation-segment delimiter (";" or "="): ${JSON.stringify(value)}`,
    );
  }
}

function rejectNonSha256(field: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`${field} is not a sha256 hex digest: ${JSON.stringify(value)}`);
  }
}

function rejectNonIsoInstant(field: string, value: string): void {
  if (!ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} is not an ISO-8601 instant: ${JSON.stringify(value)}`);
  }
}

/**
 * Build the `approvedBy` string a delegation signs:
 * `delegated:<parent>;cwd=<sha256|->;task=<id|->;expires=<iso>` plus
 * `;report=<sha256>` in the fallback shape.
 *
 * Throws on any input that would corrupt the encoding (an empty value, a
 * value carrying a `;` or `=` delimiter or a control character, a
 * malformed parent session id (`rejectMalformedSessionId`), a cwd/report
 * hash that is not a sha256 digest, a non-ISO expiry, or the literal `-`
 * as a task id, which would round-trip as "no task bound"). A silently
 * mis-encoded delegation would be signed and then read back with
 * different bindings than the caller intended, so this fails loudly at
 * the only place that can still tell the difference.
 */
export function buildDelegationApprovedBy(fields: DelegationApprovedByFields): string {
  const { parentSessionId, cwdHash, taskId, expiresAt, reportPathHash } = fields;
  // Same shape check the CHILD session id already gets in
  // `delegationMarkerPathFor`: the parent id never reaches a `path.join`
  // here, but it is still a session id, and a value carrying `/`, `\`, or
  // `..` has no business inside a signed audit field either.
  rejectMalformedSessionId(parentSessionId);
  rejectUnsafeSegmentValue("parentSessionId", parentSessionId);
  if (CONTROL_CHARS.test(parentSessionId)) {
    throw new Error(
      `parentSessionId contains a control character: ${JSON.stringify(parentSessionId)}`,
    );
  }
  if (cwdHash !== null) rejectNonSha256("cwdHash", cwdHash);
  if (taskId !== null) {
    rejectUnsafeSegmentValue("taskId", taskId);
    if (taskId === UNBOUND) {
      throw new Error(`taskId is the reserved unbound literal ${JSON.stringify(UNBOUND)}`);
    }
  }
  rejectNonIsoInstant("expiresAt", expiresAt);
  if (reportPathHash !== undefined) rejectNonSha256("reportPathHash", reportPathHash);

  const segments = [
    `${DELEGATED_SEGMENT_PREFIX}${parentSessionId}`,
    `cwd=${cwdHash ?? UNBOUND}`,
    `task=${taskId ?? UNBOUND}`,
    `expires=${expiresAt}`,
  ];
  if (reportPathHash !== undefined) {
    segments.push(`report=${reportPathHash}`);
  }
  return segments.join(";");
}

/** Bindings read back out of a delegation's `approvedBy` string. */
export interface ParsedDelegationApprovedBy {
  parentSessionId: string;
  /** `null` when the delegation binds no cwd (`cwd=-`). */
  cwdHash: string | null;
  /** `null` when the delegation binds no task (`task=-`). */
  taskId: string | null;
  expiresAt: string;
  /** Present only in the fallback shape. */
  reportPathHash?: string;
}

export type DelegationApprovedByParse =
  | { ok: true; value: ParsedDelegationApprovedBy }
  | { ok: false; reason: string };

/**
 * Strict inverse of {@link buildDelegationApprovedBy}. All four of
 * `delegated`, `cwd`, `task` and `expires` are required and `report` is
 * optional; a missing, duplicated, unknown, empty or malformed segment is
 * an error RESULT, never a default. Segment order is not enforced (the
 * signature already pins the exact bytes), but every other deviation is
 * refused: this string is the only place a delegation's bindings live, so
 * "read it partially and assume the rest" is the one failure mode that
 * would quietly widen a delegation past what the parent signed.
 */
export function parseDelegationApprovedBy(approvedBy: unknown): DelegationApprovedByParse {
  if (typeof approvedBy !== "string" || approvedBy.length === 0) {
    return {
      ok: false,
      reason: `approvedBy is not a non-empty string (got ${typeof approvedBy})`,
    };
  }

  let parentSessionId: string | undefined;
  let cwdRaw: string | undefined;
  let taskRaw: string | undefined;
  let expiresRaw: string | undefined;
  let reportRaw: string | undefined;

  for (const segment of approvedBy.split(";")) {
    if (segment.startsWith(DELEGATED_SEGMENT_PREFIX)) {
      if (parentSessionId !== undefined) {
        return { ok: false, reason: `duplicate "delegated" segment` };
      }
      const value = segment.slice(DELEGATED_SEGMENT_PREFIX.length);
      if (value.length === 0) {
        return { ok: false, reason: `empty value for segment "delegated"` };
      }
      // Mirror of the writer's checks (`buildDelegationApprovedBy`): the
      // reader must never accept a parent linkage the writer could not
      // have produced. `;` cannot survive the `split(";")` above without
      // becoming a second, unrecognized segment, but `=` and control
      // characters can, so they are checked explicitly here.
      if (value.includes("=") || CONTROL_CHARS.test(value)) {
        return {
          ok: false,
          reason: `"delegated" value contains "=" or a control character: ${JSON.stringify(value)}`,
        };
      }
      try {
        rejectMalformedSessionId(value);
      } catch (err) {
        return {
          ok: false,
          reason: `"delegated" value is not a well-formed session id: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      parentSessionId = value;
      continue;
    }
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      return { ok: false, reason: `unrecognized delegation segment ${JSON.stringify(segment)}` };
    }
    const key = segment.slice(0, eq);
    const value = segment.slice(eq + 1);
    if (value.length === 0) {
      return { ok: false, reason: `empty value for segment ${JSON.stringify(key)}` };
    }
    switch (key) {
      case "cwd":
        if (cwdRaw !== undefined) return { ok: false, reason: `duplicate "cwd" segment` };
        cwdRaw = value;
        break;
      case "task":
        if (taskRaw !== undefined) return { ok: false, reason: `duplicate "task" segment` };
        taskRaw = value;
        break;
      case "expires":
        if (expiresRaw !== undefined) return { ok: false, reason: `duplicate "expires" segment` };
        expiresRaw = value;
        break;
      case "report":
        if (reportRaw !== undefined) return { ok: false, reason: `duplicate "report" segment` };
        reportRaw = value;
        break;
      default:
        return { ok: false, reason: `unknown delegation segment key ${JSON.stringify(key)}` };
    }
  }

  if (parentSessionId === undefined) return { ok: false, reason: `missing "delegated" segment` };
  if (cwdRaw === undefined) return { ok: false, reason: `missing "cwd" segment` };
  if (taskRaw === undefined) return { ok: false, reason: `missing "task" segment` };
  if (expiresRaw === undefined) return { ok: false, reason: `missing "expires" segment` };

  let cwdHash: string | null = null;
  if (cwdRaw !== UNBOUND) {
    if (!SHA256_HEX.test(cwdRaw)) {
      return { ok: false, reason: `"cwd" is not a sha256 hex digest: ${JSON.stringify(cwdRaw)}` };
    }
    cwdHash = cwdRaw;
  }

  let taskId: string | null = null;
  if (taskRaw !== UNBOUND) {
    if (taskRaw.includes("=")) {
      return { ok: false, reason: `"task" contains a segment delimiter: ${JSON.stringify(taskRaw)}` };
    }
    taskId = taskRaw;
  }

  if (!ISO_INSTANT.test(expiresRaw) || !Number.isFinite(Date.parse(expiresRaw))) {
    return {
      ok: false,
      reason: `"expires" is not an ISO-8601 instant: ${JSON.stringify(expiresRaw)}`,
    };
  }

  if (reportRaw !== undefined && !SHA256_HEX.test(reportRaw)) {
    return { ok: false, reason: `"report" is not a sha256 hex digest: ${JSON.stringify(reportRaw)}` };
  }

  const value: ParsedDelegationApprovedBy = {
    parentSessionId,
    cwdHash,
    taskId,
    expiresAt: expiresRaw,
    ...(reportRaw !== undefined ? { reportPathHash: reportRaw } : {}),
  };
  return { ok: true, value };
}

export interface WriteDelegationMarkerOptions {
  generatedDir: string;
  /** Session id of the `claude -p` child this delegation authorizes. Becomes the file name. */
  childSessionId: string;
  /** Session id of the already-approved parent issuing the delegation. */
  parentSessionId: string;
  /** {@link hashDelegationCwd} of the child's expected cwd, or `null` for a task-only delegation. */
  cwdHash: string | null;
  /** Task id the child is delegated for, or `null` for a cwd-only delegation. */
  taskId: string | null;
  /** ISO-8601 instant the delegation expires at. */
  expiresAt: string;
  /** Fallback shape: {@link hashDelegationCwd} of the launcher-supplied report file's path. */
  reportPathHash?: string;
  /** Fallback shape: sha256 of that file's CONTENT. Omitted (written as `null`) in the base shape. */
  reportContentHash?: string;
  /** Override the issue timestamp for deterministic tests. */
  now?: Date;
}

export type WriteDelegationMarkerResult =
  | { ok: true; filePath: string; markerId: string; approvedAt: string; approvedBy: string }
  | {
      ok: false;
      reason: "signing-key-absent" | "invalid-input" | "write-failed";
      detail: string;
    };

/**
 * Write a signed delegation marker through the shared `signMarker` path,
 * under markerId `delegation-<child-sid>`, at
 * `<generatedDir>/.delegations/<child-sid>`. Atomic and mode 0600, like
 * every other marker write.
 *
 * NEVER CREATES THE SIGNING KEY. `signMarker` -> `getOrCreateSigningKey`
 * treats a missing key as a case to REPAIR, generating one and signing
 * with it; key creation is an operator-side act (`harness init`,
 * `harness approve`), and a delegation minted on a machine that never had
 * a key would be a marker signed by whoever asked for it. So this
 * prechecks `signingKeyExists` and returns `signing-key-absent` without
 * reaching the write path at all (ADR threat model (b) item 5, the same
 * rule slice 1's auto path follows).
 *
 * Returns a result rather than throwing, for every failure mode: the
 * callers are a CLI verb and, later, a hook, and both must fail closed
 * with a diagnostic instead of unwinding.
 *
 * Deliberately does NOT refuse a delegation that binds neither cwd nor
 * task. That refusal belongs to the issuing verb (ADR slice 3 acceptance
 * criterion 1) and to `verifyDelegation`, which reports `no_binding`;
 * keeping the writer able to produce one is what lets the test suite
 * exercise that verifier branch against a genuinely signed artifact
 * rather than a hand-rolled fake.
 */
export function writeDelegationMarker(opts: WriteDelegationMarkerOptions): WriteDelegationMarkerResult {
  const reportPathHash = opts.reportPathHash;
  const reportContentHash = opts.reportContentHash ?? null;
  if ((reportPathHash === undefined) !== (reportContentHash === null)) {
    // The fallback shape binds the launcher-supplied report by BOTH its
    // path and its content. Half a binding is worse than none: a `report=`
    // segment with no content hash, or a content hash with no `report=`
    // segment, reads as "bound" to a human and enforces only one half.
    return {
      ok: false,
      reason: "invalid-input",
      detail:
        "the fallback shape requires reportPathHash AND reportContentHash together (one without the other would leave half the report binding unenforced)",
    };
  }
  if (reportContentHash !== null) {
    try {
      rejectNonSha256("reportContentHash", reportContentHash);
    } catch (err) {
      return {
        ok: false,
        reason: "invalid-input",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let filePath: string;
  let approvedBy: string;
  try {
    filePath = delegationMarkerPathFor(opts.generatedDir, opts.childSessionId);
    approvedBy = buildDelegationApprovedBy({
      parentSessionId: opts.parentSessionId,
      cwdHash: opts.cwdHash,
      taskId: opts.taskId,
      expiresAt: opts.expiresAt,
      reportPathHash,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-input",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!signingKeyExists(opts.generatedDir)) {
    return {
      ok: false,
      reason: "signing-key-absent",
      detail: `no operator signing key at ${signingKeyPathFor(
        opts.generatedDir,
      )}; refusing to mint a delegation (key creation is an operator-side act, never a side effect of delegating)`,
    };
  }

  const approvedAt = (opts.now ?? new Date()).toISOString();
  const markerId = delegationMarkerIdFor(opts.childSessionId);
  const signed = signMarker(opts.generatedDir, markerId, {
    approvedAt,
    approvedBy,
    reportContentHash,
  });
  try {
    atomicWriteFile(filePath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      reason: "write-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, filePath, markerId, approvedAt, approvedBy };
}

/**
 * Why a delegation was refused. Every value is reachable and distinct;
 * there is no "unknown" bucket and no branch that falls through to
 * allow.
 */
export type DelegationRefusalReason =
  /** No delegation file for this child session (also: a child session id that cannot name a file). */
  | "missing"
  /** The file exists but its integrity cannot be established right now: symlink, non-regular, I/O error, or an unavailable signing key. Not a claim of tampering. */
  | "unreadable"
  /** A file was there and its signature does not verify against `delegation-<child-sid>`: unsigned, wrong alg, tampered, or copied from another child's delegation. */
  | "forged"
  /** Validly signed, but its `approvedBy` bindings cannot be read in full. */
  | "unparseable"
  | "expired"
  | "cwd_mismatch"
  | "task_mismatch"
  /** Binds neither a cwd nor a task, so it would authorize the child anywhere, for anything. */
  | "no_binding"
  /** Fallback shape: the launcher report is not at the path the parent signed. */
  | "report_path_mismatch"
  /** Fallback shape: the launcher report's content is not what the parent signed (including a report that cannot be read). */
  | "report_content_mismatch";

export type DelegationVerification =
  | {
      ok: true;
      parentSessionId: string;
      expiresAt: string;
      boundCwdHash: string | null;
      boundTaskId: string | null;
      reportPathHash?: string;
    }
  | { ok: false; reason: DelegationRefusalReason; detail: string };

export interface VerifyDelegationOptions {
  generatedDir: string;
  /** The child session whose delegation is being checked. */
  childSessionId: string;
  /** The child's actual cwd, or `null` when the caller has none to offer. */
  cwd: string | null;
  /** The child's actual task id, or `null` when the caller has none to offer. */
  taskId: string | null;
  /** Fallback shape: the launcher-supplied report file the parent bound. */
  launcherReportPath?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/**
 * Gate-side: is there a valid, unexpired, matching delegation for this
 * child session? Checks, in order (ADR slice 3 acceptance criterion 2):
 *
 *   1. the file is present and JSON-readable,
 *   2. its signature verifies against markerId `delegation-<child-sid>`,
 *   3. its `approvedBy` segments parse in full,
 *   4. it binds at least one of cwd / task,
 *   5. it has not expired,
 *   6. the bound cwd hash-matches the caller's cwd,
 *   7. the bound task equals the caller's task,
 *   8. in the fallback shape, the launcher report sits at the bound path
 *      AND hashes to the bound content.
 *
 * Reads only `.delegations/`; an artifact in `.approvals/` is `missing`
 * here, whatever it contains.
 *
 * NEVER CREATES THE SIGNING KEY, on the READ path either.
 * `verifyMarkerSignature` obtains the key through
 * `getOrCreateSigningKey`, which treats a missing key as a case to
 * REPAIR and generates one; on a machine the operator never initialized
 * that would make a mere gate-time read perform the operator-side act of
 * minting the key. It cannot make a foreign-signed delegation verify, but
 * it does leave a key behind that every LATER write path would then
 * happily sign with, so the never-create rule applies here exactly as it
 * does to `writeDelegationMarker` and to slice 1's auto path. An absent
 * key is reported as `unreadable` (we could not check, not "we checked
 * and it is a forgery"), the same class `verifyMarkerSignature`'s own
 * `key-unavailable` lands in below.
 */
export function verifyDelegation(opts: VerifyDelegationOptions): DelegationVerification {
  const { generatedDir, childSessionId } = opts;

  let filePath: string;
  try {
    filePath = delegationMarkerPathFor(generatedDir, childSessionId);
  } catch (err) {
    // A session id that cannot name a file has no delegation, by
    // construction. Fail closed here rather than throwing out of a hook.
    return {
      ok: false,
      reason: "missing",
      detail: `invalid childSessionId for delegation marker: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const read = readRegularFileRejectingSymlink(filePath);
  if (read.kind === "missing") {
    return { ok: false, reason: "missing", detail: `no delegation marker at ${filePath}` };
  }
  if (read.kind === "symlink") {
    return {
      ok: false,
      reason: "unreadable",
      detail: `delegation marker is a symlink, refusing for safety: ${filePath}`,
    };
  }
  if (read.kind === "not-regular") {
    return {
      ok: false,
      reason: "unreadable",
      detail: `delegation marker path is not a regular file: ${filePath}`,
    };
  }
  if (read.kind === "unreadable") {
    return {
      ok: false,
      reason: "unreadable",
      detail: `delegation marker at ${filePath} exists but could not be read (I/O error); treating as no delegation since its signature cannot be verified`,
    };
  }

  const parsed = safeJsonParse(read.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "forged",
      detail: `forged/unsigned delegation rejected: body at ${filePath} is not a JSON object`,
    };
  }
  const body = parsed as Record<string, unknown>;

  // Key precheck BEFORE `verifyMarkerSignature`, which would otherwise
  // mint the key it is supposed to require (see the doc comment above).
  // Placed after the file read so a session with no delegation at all
  // still reports `missing` rather than this stronger, misleading reason.
  if (!signingKeyExists(generatedDir)) {
    return {
      ok: false,
      reason: "unreadable",
      detail: `signing key absent at ${signingKeyPathFor(
        generatedDir,
      )}; the delegation at ${filePath} cannot be verified and no key is created to verify it (key creation is an operator-side act)`,
    };
  }

  const markerId = delegationMarkerIdFor(childSessionId);
  const verification = verifyMarkerSignature(generatedDir, markerId, body);
  if (!verification.ok) {
    if (verification.kind === "key-unavailable") {
      // Fail-closed I/O problem, not evidence of tampering (the same
      // distinction `checkApprovalMarker` draws).
      return {
        ok: false,
        reason: "unreadable",
        detail: `delegation at ${filePath} could not be verified: ${verification.reason}`,
      };
    }
    return {
      ok: false,
      reason: "forged",
      detail: `forged/unsigned delegation rejected: ${verification.reason} (${filePath})`,
    };
  }

  const segments = parseDelegationApprovedBy(body["approvedBy"]);
  if (!segments.ok) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `delegation at ${filePath} has an unparseable approvedBy: ${segments.reason}`,
    };
  }
  const { parentSessionId, cwdHash, taskId, expiresAt, reportPathHash } = segments.value;

  if (cwdHash === null && taskId === null) {
    return {
      ok: false,
      reason: "no_binding",
      detail: `delegation at ${filePath} binds neither a cwd nor a task; refusing an unbound pre-authorization`,
    };
  }

  const nowMs = (opts.now ?? new Date()).getTime();
  const expiresMs = Date.parse(expiresAt);
  // `nowMs` is caller-supplied (`opts.now`, a test-only override); an
  // invalid Date's `.getTime()` is NaN, and NaN fails every `<=`
  // comparison, which would otherwise fail this check OPEN (a clock that
  // cannot report the time would silently pass every delegation as
  // unexpired). Fail closed instead: an unusable clock is treated the same
  // as an already-expired one.
  if (!Number.isFinite(nowMs) || expiresMs <= nowMs) {
    return {
      ok: false,
      reason: "expired",
      detail: Number.isFinite(nowMs)
        ? `delegation at ${filePath} expired at ${expiresAt} (now ${new Date(nowMs).toISOString()})`
        : `delegation at ${filePath} cannot be checked for expiry: the supplied clock is unusable (now getTime() => ${nowMs})`,
    };
  }

  if (cwdHash !== null) {
    if (opts.cwd === null) {
      return {
        ok: false,
        reason: "cwd_mismatch",
        detail: `delegation at ${filePath} is bound to a cwd but the caller supplied none`,
      };
    }
    const actual = hashDelegationCwd(opts.cwd);
    if (actual !== cwdHash) {
      return {
        ok: false,
        reason: "cwd_mismatch",
        detail: `delegation at ${filePath} is bound to a different cwd (bound ${cwdHash}, got ${actual} for ${opts.cwd})`,
      };
    }
  }

  if (taskId !== null) {
    if (opts.taskId === null) {
      return {
        ok: false,
        reason: "task_mismatch",
        detail: `delegation at ${filePath} is bound to task ${taskId} but the caller supplied none`,
      };
    }
    if (opts.taskId !== taskId) {
      return {
        ok: false,
        reason: "task_mismatch",
        detail: `delegation at ${filePath} is bound to task ${taskId}, not ${opts.taskId}`,
      };
    }
  }

  if (reportPathHash !== undefined) {
    if (opts.launcherReportPath === undefined) {
      return {
        ok: false,
        reason: "report_path_mismatch",
        detail: `delegation at ${filePath} binds a launcher-supplied report but no report path was offered`,
      };
    }
    const actualPathHash = hashDelegationCwd(opts.launcherReportPath);
    if (actualPathHash !== reportPathHash) {
      return {
        ok: false,
        reason: "report_path_mismatch",
        detail: `delegation at ${filePath} binds a report at a different path (bound ${reportPathHash}, got ${actualPathHash} for ${opts.launcherReportPath})`,
      };
    }
    const boundContentHash =
      typeof body["reportContentHash"] === "string" ? (body["reportContentHash"] as string) : null;
    if (boundContentHash === null) {
      return {
        ok: false,
        reason: "report_content_mismatch",
        detail: `delegation at ${filePath} carries a report path binding but no reportContentHash to check the file against`,
      };
    }
    const reportRead = readRegularFileRejectingSymlink(opts.launcherReportPath);
    if (reportRead.kind !== "ok") {
      return {
        ok: false,
        reason: "report_content_mismatch",
        detail: `launcher-supplied report at ${opts.launcherReportPath} could not be read (${reportRead.kind}); its content cannot be checked against the bound hash`,
      };
    }
    const actualContentHash = sha256Hex(reportRead.content);
    if (actualContentHash !== boundContentHash) {
      return {
        ok: false,
        reason: "report_content_mismatch",
        detail: `launcher-supplied report at ${opts.launcherReportPath} does not match the bound content hash (bound ${boundContentHash}, got ${actualContentHash})`,
      };
    }
  }

  return {
    ok: true,
    parentSessionId,
    expiresAt,
    boundCwdHash: cwdHash,
    boundTaskId: taskId,
    ...(reportPathHash !== undefined ? { reportPathHash } : {}),
  };
}
