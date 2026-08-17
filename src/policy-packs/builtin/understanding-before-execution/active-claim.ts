// Active-claim tracking (harness/494fd1e5), split out of the former
// monolithic understanding-before-execution-runtime.ts (structural
// concentration slice 2, agent-tasks 348a4d42). Pure move: see
// src/policy-packs/builtin/understanding-before-execution/index.ts for
// the re-exported public surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../io/atomic-write.js";

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
