// Hook-side observation of PreToolUse `permission_mode` (task 8f637efd,
// docs/decisions/2026-08-27-ug-auto-mode-approval.md's "Amendment:
// install default"). One small per-session record under
// `<generatedDir>/.permission-mode-observations/<sessionId>`.
//
// WHY A NEW ARTEFACT, NOT THE LEDGER OR THE PERSISTED REPORT. `harness
// doctor`'s missing-`auto_approve` finding needs to know whether a
// session actually ran under `bypassPermissions`, and the evidence-ledger
// trust boundary this pack already enforces for approval
// (docs/okf/evidence-ledger-trust-boundary.md) applies here too: a fact
// the AGENT can write (a ledger row, a report field) proves nothing about
// what the harness process observed. `permission_mode` on the PreToolUse
// payload is a T1 signal (composed by Claude Code itself, not by the
// model: same trust class the auto-approval path already relies on,
// see the ADR's "Signal sources per harness" table), so the write side
// here is the SAME hook, at the SAME point in its decision order, using
// the SAME field. The record carries no payload content beyond the
// mode itself: (sessionId, permissionMode, observedAt), nothing else.
//
// WHERE IT IS WRITTEN. `hook-pre-tool-use.ts` calls
// `recordPermissionModeObservation` once per PreToolUse invocation that
// reaches the same point `attemptAutoApproval` already runs at
// (auto-approve-path.ts's module header explains why that point matters:
// every call that reaches it has already been declined by the signed
// marker check, the read-only Bash exemption, the recovery-commit
// exemption, and the escape `ask`: so it is exactly the call that would
// otherwise need approval). A session whose first tool call already
// matches a still-valid marker never reaches this point and is therefore
// never observed for that session; this is an accepted coverage gap
// (documented at the call site), not a silent failure: the finding this
// feeds targets the ADR's Mac-mini incident shape (a marker EXPIRED or
// never existed, the call fell through to the block/auto-approve
// attempt, and `permission_mode` WAS on the payload at that instant),
// not perfect per-session coverage.
//
// FAIL-OPEN ON WRITE ERRORS. A failed write is one stderr warning line,
// never escalated into a block: this is telemetry for `harness doctor`,
// never a gate input, and the write happens on the same fail-open
// posture every other best-effort write in this pack already uses
// (`writePendingApproval`, the marker writers).
//
// UNSIGNED: ADVISORY ONLY, NOT PROOF (review round 3, F2). Unlike the
// approval marker (`markers.ts`), this record is NOT HMAC-signed. It is
// written by the hook PROCESS from whatever `session_id`/`permission_mode`
// appear on the invocation's PreToolUse payload; that only proves the
// hook was invoked with that payload, not that any particular session
// actually ran under that mode: an already-approved session (or anything
// else able to invoke `harness pack hook pre-tool-use` with crafted
// stdin) can write, or forge, an observation. That is why
// `checkBypassWithoutAutoApprove` (bypass-without-auto-approve.ts) is
// wired as an advisory `harness doctor` finding ONLY: it can never gate a
// tool call or mint an approval, and the operator who reads the finding
// is the one who decides what to do about it. A possible future
// hardening, not done here, is signing the observation the same way
// approval markers are signed.

import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { readJsonDirEntriesRejectingSymlinks } from "../../../io/read-json-dir-entries.js";
import { rejectMalformedSessionId } from "../../../runtime/reject-malformed-session-id.js";

export const PERMISSION_MODE_OBSERVATION_DIRNAME = ".permission-mode-observations";

export interface PermissionModeObservation {
  sessionId: string;
  permissionMode: string;
  observedAt: string;
}

/**
 * `sessionId` is validated with the SAME `rejectMalformedSessionId` used
 * for the approval marker path (`markers.ts`'s `approvalMarkerPathFor`):
 * a value carrying `/`, `\`, `..`, or that is empty/blank throws rather
 * than being joined into the path (review round 3, F1: the earlier
 * version of this function trusted the caller's own empty-string check
 * and joined `sessionId` verbatim, letting a crafted `session_id` on the
 * hook's stdin write outside `<generatedDir>/.permission-mode-observations/`).
 */
export function permissionModeObservationPathFor(
  generatedDir: string,
  sessionId: string,
): string {
  rejectMalformedSessionId(sessionId);
  return path.join(generatedDir, PERMISSION_MODE_OBSERVATION_DIRNAME, sessionId);
}

/**
 * Best-effort write/update of the per-session observation.
 *
 * `permissionMode` must be a non-empty string; any other shape (absent,
 * non-string, empty) is a silent no-op: there is nothing to observe.
 * `sessionId` is NOT trusted as pre-validated (review round 3, F1): the
 * caller (`hook-pre-tool-use.ts`) only rejects an EMPTY session id
 * before this is reached, and `session_id` on the hook's stdin payload
 * is otherwise attacker-controllable input to a CLI invocation, not a
 * value this function may assume is already path-safe. A malformed id
 * (path separators, `..`, blank) makes `permissionModeObservationPathFor`
 * throw; that throw is treated exactly like any other write failure
 * below: one `stderr` warning, never escalated into a block, never
 * thrown out of this function.
 */
export function recordPermissionModeObservation(
  generatedDir: string,
  sessionId: string,
  permissionMode: unknown,
  stderr: { write(s: string): unknown },
  now: () => Date = () => new Date(),
): void {
  if (typeof permissionMode !== "string" || permissionMode.length === 0) return;
  if (sessionId.length === 0) return;
  const record: PermissionModeObservation = {
    sessionId,
    permissionMode,
    observedAt: now().toISOString(),
  };
  try {
    atomicWriteFile(
      permissionModeObservationPathFor(generatedDir, sessionId),
      `${JSON.stringify(record)}\n`,
    );
  } catch (err) {
    stderr.write(
      `harness pack hook: failed to write permission-mode observation for session ${sessionId} (${
        (err as Error).message
      }), continuing.\n`,
    );
  }
}

export interface PermissionModeObservationsResult {
  /** Whether `<generatedDir>/.permission-mode-observations/` exists at all. */
  dirPresent: boolean;
  /** Newest `windowSize` readable observations, newest `observedAt` first. */
  entries: PermissionModeObservation[];
  /** Files present but unparseable / missing a required field. */
  unreadableCount: number;
}

function isValidObservation(value: unknown): value is PermissionModeObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["sessionId"] === "string" &&
    typeof obj["permissionMode"] === "string" &&
    typeof obj["observedAt"] === "string" &&
    !Number.isNaN(Date.parse(obj["observedAt"] as string))
  );
}

/** Cap applied to a sanitized `sessionId` before it reaches doctor output. */
const DISPLAY_VALUE_MAX_LENGTH = 200;

/**
 * Strip C0/DEL control characters (including ESC, which could otherwise
 * smuggle an ANSI escape sequence into a terminal) and cap the length,
 * mirroring `persisted-reports.ts`'s `sanitizeDetailValue` for the same
 * reason: `bypass-without-auto-approve.ts` embeds an observation's
 * `sessionId` directly into a doctor finding's `message`, the surface an
 * operator reads (review round 3, F1). This is independent of
 * `permissionModeObservationPathFor`'s write-time
 * `rejectMalformedSessionId` guard: that guard rejects path-traversal
 * shapes, not control characters, and a directory entry's on-disk
 * filename (or the `sessionId` field inside it) is never itself
 * constrained to be display-safe: POSIX filenames may contain any byte
 * but `/` and NUL, and the JSON body's `sessionId` field is a plain
 * string with no such constraint either.
 */
function sanitizeForDisplay(value: string): string {
  const flattened = value.replace(/[\x00-\x1f\x7f]/g, " ");
  return flattened.length > DISPLAY_VALUE_MAX_LENGTH
    ? `${flattened.slice(0, DISPLAY_VALUE_MAX_LENGTH)}...`
    : flattened;
}

/**
 * Read-side: the newest `windowSize` per-session observations, newest
 * first by `observedAt`. Mirrors `ug-auto-approvals.ts`'s own
 * read-and-window convention (missing dir / empty dir / all-unreadable
 * all resolve to an empty-ish result, never throw: this is a doctor
 * read, not a gate decision). Every returned `sessionId` has already
 * been through {@link sanitizeForDisplay}, so every consumer (today,
 * `bypass-without-auto-approve.ts`'s finding `message`) gets a
 * doctor-output-safe value without having to sanitize it itself.
 */
export function listPermissionModeObservations(
  generatedDir: string,
  opts: { windowSize: number },
): PermissionModeObservationsResult {
  const dir = path.join(generatedDir, PERMISSION_MODE_OBSERVATION_DIRNAME);

  const { dirPresent, entries: readable, unreadableCount } =
    readJsonDirEntriesRejectingSymlinks<PermissionModeObservation>(dir, {
      parse: (raw) =>
        isValidObservation(raw) ? { ...raw, sessionId: sanitizeForDisplay(raw.sessionId) } : null,
    });

  readable.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

  return {
    dirPresent,
    entries: readable.slice(0, opts.windowSize),
    unreadableCount,
  };
}
