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

import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { readJsonDirEntriesRejectingSymlinks } from "../../../io/read-json-dir-entries.js";

export const PERMISSION_MODE_OBSERVATION_DIRNAME = ".permission-mode-observations";

export interface PermissionModeObservation {
  sessionId: string;
  permissionMode: string;
  observedAt: string;
}

export function permissionModeObservationPathFor(
  generatedDir: string,
  sessionId: string,
): string {
  return path.join(generatedDir, PERMISSION_MODE_OBSERVATION_DIRNAME, sessionId);
}

/**
 * Best-effort write/update of the per-session observation.
 *
 * `permissionMode` must be a non-empty string; any other shape (absent,
 * non-string, empty) is a silent no-op: there is nothing to observe.
 * `sessionId` is trusted as already-validated by the caller
 * (`hook-pre-tool-use.ts` rejects an unresolvable session id earlier in
 * its own decision order); this function only uses it as a filename and
 * does not re-validate it. Never throws: a write failure (unwritable
 * dir, disk full, ...) is reported to `stderr` and swallowed.
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

/**
 * Read-side: the newest `windowSize` per-session observations, newest
 * first by `observedAt`. Mirrors `ug-auto-approvals.ts`'s own
 * read-and-window convention (missing dir / empty dir / all-unreadable
 * all resolve to an empty-ish result, never throw: this is a doctor
 * read, not a gate decision).
 */
export function listPermissionModeObservations(
  generatedDir: string,
  opts: { windowSize: number },
): PermissionModeObservationsResult {
  const dir = path.join(generatedDir, PERMISSION_MODE_OBSERVATION_DIRNAME);

  const { dirPresent, entries: readable, unreadableCount } =
    readJsonDirEntriesRejectingSymlinks<PermissionModeObservation>(dir, {
      parse: (raw) => (isValidObservation(raw) ? raw : null),
    });

  readable.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

  return {
    dirPresent,
    entries: readable.slice(0, opts.windowSize),
    unreadableCount,
  };
}
