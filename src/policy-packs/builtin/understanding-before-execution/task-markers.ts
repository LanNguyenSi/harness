// Task-scoped approval markers (harness/1ee26e77), split out of the
// former monolithic understanding-before-execution-runtime.ts (structural
// concentration slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { signMarker } from "../../../runtime/approval-signing.js";
import { readActiveClaim } from "./active-claim.js";
import { parseApprovalLifecycle } from "./lifecycle.js";
import {
  APPROVAL_MARKER_DIRNAME,
  type ApprovalMarker,
  checkApprovalMarker,
  type CheckApprovalMarkerOptions,
  type MarkerCheck,
} from "./markers.js";

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
// deletes the session marker on a listed completion boundary (a
// `task_finish` to done, `task_abandon`, `task_merge`, ...), but if
// delivery is unreliable (e.g. PostToolUse skipped for an MCP tool) or
// the task completes outside the session (a merge in the UI), the file
// persists. A task-keyed marker side-steps that delivery concern because
// the next task's id is different even if the previous marker file
// outlives its scope; the session marker gets the same property from its
// signed task binding (`checkSessionApprovalMarker`, task 5018c0c4).

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
 *
 * Signed the same way as `writeApprovalMarker` (harness/f9485cc7), using
 * `task-<id>` (the exact string `checkActiveClaimApprovalMarker` looks
 * up) as the signed markerId — so a validly-signed task marker cannot be
 * copied onto a different task id (or the session marker's id) and still
 * verify.
 */
export function writeTaskApprovalMarker(
  generatedDir: string,
  taskId: string,
  marker: ApprovalMarker,
): string {
  const filePath = taskApprovalMarkerPathFor(generatedDir, taskId);
  const markerId = `${APPROVAL_MARKER_TASK_PREFIX}${taskId}`;
  const signed = signMarker(generatedDir, markerId, marker);
  atomicWriteFile(filePath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
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
 * Same safety filters as `checkApprovalMarker` (signature verification,
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
      forged: false,
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
      forged: false,
    };
  }
  return {
    matched: false,
    detail: `active-claim ${claim} has no fresh task marker (${check.detail})`,
    marker: null,
    expired: check.expired,
    forged: check.forged,
  };
}

export interface SessionMarkerCheck extends MarkerCheck {
  /**
   * True when a validly signed session marker existed but was refused
   * because of its task binding (task 5018c0c4): it was granted for a
   * different active claim than the current one, or it carries no
   * binding at all (written by a release before the binding existed).
   * `matched`, `expired` and `forged` are all false in that case: the
   * gate treats it exactly like a missing marker.
   */
  bindingRefused: boolean;
}

function describeClaim(taskId: string | null): string {
  return taskId === null ? "no claimed task" : `task ${taskId}`;
}

/**
 * Gate-side: the session-keyed marker, accepted only while it belongs to
 * the current task (task 5018c0c4, operator decision: bind the session
 * marker to the task). `writeApprovalMarker` records the active-claim
 * task id at approval time (`null` when none was held); this reader
 * compares it with the active claim NOW and refuses the marker when the
 * two differ, so an approval never carries over to another task, even
 * when the previous task completed outside the session where no
 * PostToolUse hook could expire it (a merge in the UI, a webhook moving
 * the task to done). A marker without the binding field (older release)
 * is refused too: one fresh approve re-binds it.
 *
 * The binding is checked BEFORE the `maxAgeMs` verdict is passed on, so a
 * marker that belongs to another task never reads as `expired` (that
 * signal means "this task's own approval aged out" and opens the
 * recovery-git-commit exemption, see src/runtime/recovery-git-commit.ts).
 */
export function checkSessionApprovalMarker(
  generatedDir: string,
  sessionId: string,
  opts: CheckApprovalMarkerOptions = {},
): SessionMarkerCheck {
  const check = checkApprovalMarker(generatedDir, sessionId, opts);
  if (check.marker === null) {
    // Absent, unreadable, forged, or a malformed session id: nothing to
    // bind, the plain verdict stands.
    return { ...check, bindingRefused: false };
  }
  const refused = (detail: string): SessionMarkerCheck => ({
    matched: false,
    detail,
    marker: null,
    expired: false,
    forged: false,
    bindingRefused: true,
  });
  if (!Object.prototype.hasOwnProperty.call(check.marker, "claimTaskId")) {
    return refused(
      `session approval marker for ${sessionId} carries no task binding (written by a harness release before approvals were bound to the claimed task); approve once more to bind it to ${describeClaim(readActiveClaim(generatedDir))}`,
    );
  }
  const boundTo = check.marker.claimTaskId ?? null;
  const current = readActiveClaim(generatedDir);
  if (boundTo !== current) {
    return refused(
      `session approval for ${sessionId} belongs to another task: it was granted for ${describeClaim(boundTo)}, the active claim is now ${describeClaim(current)}; approve the Understanding Report for this task`,
    );
  }
  return { ...check, bindingRefused: false };
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
  /**
   * True when EITHER the task-scoped or the session-scoped marker
   * existed but FAILED signature verification (harness/f9485cc7) —
   * missing/invalid signature, wrong `alg`, or tampered payload. Distinct
   * from a marker simply being absent, so a caller can log a forgery
   * attempt distinctly from the routine "not approved yet" case.
   */
  forged: boolean;
  /**
   * True when the session marker was refused only because of its task
   * binding (`SessionMarkerCheck.bindingRefused`, task 5018c0c4): it
   * belongs to another task, or predates the binding. Always false when
   * `matched` is true. Lets the PreToolUse hooks say "the approval
   * belongs to another task" instead of "no approval marker".
   */
  sessionBindingRefused: boolean;
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
      forged: false,
      sessionBindingRefused: false,
    };
  }
  const sessionMarker = checkSessionApprovalMarker(generatedDir, sessionId, ageOpts);
  if (sessionMarker.matched) {
    return {
      matched: true,
      source: "session",
      detail: sessionMarker.detail,
      taskCheckDetail: taskMarker.detail,
      expired: false,
      forged: false,
      sessionBindingRefused: false,
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
    // Surfaced so a forgery attempt against EITHER marker is visible to
    // the caller even though the overall result is (correctly) unmatched
    // — mirrors the `expired` OR-merge above.
    forged: taskMarker.forged || sessionMarker.forged,
    sessionBindingRefused: sessionMarker.bindingRefused,
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
