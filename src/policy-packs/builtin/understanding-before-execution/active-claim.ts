// Active-claim tracking (harness/494fd1e5), split out of the former
// monolithic understanding-before-execution-runtime.ts (structural
// concentration slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";
import { readRegularFileBounded } from "../../../io/read-regular-file.js";

// Active-claim tracking (harness/494fd1e5). When the agent calls
// `mcp__agent-tasks__task_start`, a PostToolUse hook writes the claimed
// task id to a stable file. `harness approve understanding` reads it
// when --task is absent and auto-supplies it as the task-scoped marker
// target. This closes the v1 ergonomics gap from PR #184 where the
// operator had to type the taskId by hand.
//
// File contract: a single line containing just the taskId. No JSON,
// no metadata. Operators can `cat` it to debug. The track-active-claim
// PostToolUse hook removes the file when `claimEffectForAgentTasksTool`
// says the claim is released (a task_finish to done, task_abandon,
// task_merge, a tasks_transition to done); a task_finish that lands in
// review keeps it. The session approval marker records this id when it
// is written and, outside `approval_lifecycle: { mode: session }`,
// counts only while it is unchanged (task 5018c0c4).

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
 * What the active-claim path holds, three ways (task b56d95d3). Collapsing
 * the last two into one `null` was a fail-open: a node at the path that
 * could not be read as a claim (a FIFO, a directory, a device, a file over
 * the cap, an unreadable file, a link that does not resolve, or content
 * that is not a task id) read as "no claim", so the solution-acceptance
 * gate fell back to the `SOLUTION_VERDICT_ID` knob and a session approval
 * bound to "no claim" matched. The kinds:
 *
 * - `claim`: a well-formed task id.
 * - `absent`: nothing is claimed: no file, or an empty one.
 * - `refused`: something is at the path that is NOT a usable claim. `reason`
 *   is a short agent-safe text naming why. A caller that decides a gate
 *   from the claim fails closed on this kind; one that only clears or
 *   replaces a claim may treat it like `absent`.
 */
export type ActiveClaimRead =
  | { kind: "claim"; taskId: string }
  | { kind: "absent" }
  | { kind: "refused"; reason: string };

const REFUSED_DESCRIPTION: Record<"symlink" | "not-regular" | "unreadable", string> = {
  symlink: "is a symbolic link (refused)",
  "not-regular": "is not a regular file",
  unreadable: "is unreadable or larger than the read cap",
};

/**
 * Operator-side and gate-side: read the active claim file as a tri-state
 * ({@link ActiveClaimRead}). `harness approve understanding` calls this
 * when --task is absent and passes a `claim` id to writeTaskApprovalMarker.
 *
 * One bounded, non-blocking descriptor read: a FIFO or an oversized file
 * at the claim path is `refused` instead of holding the hook past its
 * budget. A path that does not exist is `absent`; so is one whose parent
 * does not exist (`ENOTDIR`). A path that DOES exist but does not resolve
 * (a dangling or looping symlink) is `refused`: the entry is there, the
 * claim just cannot be read from it.
 *
 * Defense-in-depth: if the on-disk content fails the same
 * path-traversal / newline check that gates writes, the read is `refused`
 * instead of surfacing a poisoned id. The write side guards against a
 * malformed taskId reaching the file in the first place, but a stale file
 * authored before this guard (or hand-edited) shouldn't escalate into a
 * forged task-marker write downstream.
 */
export function readActiveClaim(generatedDir: string): ActiveClaimRead {
  const filePath = activeClaimPathFor(generatedDir);
  const read = readRegularFileBounded(filePath, { followSymlinks: true });
  if (read.kind === "missing") {
    // `missing` also covers a link that dangles: lstat tells an entry that
    // is there apart from a path that is not.
    try {
      fs.lstatSync(filePath);
      return { kind: "refused", reason: `${ACTIVE_CLAIM_FILENAME} exists but does not resolve to a file` };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { kind: "absent" }
        : { kind: "refused", reason: `${ACTIVE_CLAIM_FILENAME} could not be inspected (${code ?? "unknown error"})` };
    }
  }
  if (read.kind !== "ok") {
    return { kind: "refused", reason: `${ACTIVE_CLAIM_FILENAME} ${REFUSED_DESCRIPTION[read.kind]}` };
  }
  const trimmed = read.content.trim();
  if (trimmed.length === 0) return { kind: "absent" };
  try {
    rejectMalformedClaimId(trimmed);
  } catch {
    return { kind: "refused", reason: `${ACTIVE_CLAIM_FILENAME} does not hold a well-formed task id` };
  }
  return { kind: "claim", taskId: trimmed };
}

/**
 * The task binding a session marker records when it is written while the
 * active-claim path is `refused`. It is not a well-formed task id (it holds
 * a path separator and `..`, which `rejectMalformedClaimId` refuses), so no
 * readable claim, and no absent one, can ever equal it: the marker never
 * satisfies a binding check, and the operator approves again once the claim
 * path is repaired.
 */
export const REFUSED_CLAIM_BINDING = "../refused-active-claim";

/** The claimed task id, or `null` for `absent` and `refused` alike. For callers that only clear or replace a claim, never for a gate decision. */
export function claimTaskIdOrNull(read: ActiveClaimRead): string | null {
  return read.kind === "claim" ? read.taskId : null;
}

/** Hook-side: remove the active claim file. Idempotent. */
export function clearActiveClaim(generatedDir: string): void {
  try {
    fs.rmSync(activeClaimPathFor(generatedDir));
  } catch {
    /* already gone */
  }
}
