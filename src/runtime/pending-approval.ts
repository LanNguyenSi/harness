// Task 33abc147 — `.pending-approval` session-id staging file.
//
// The gate hook knows the running session's exact `session_id` (it arrives
// on the hook event's stdin). An approval run from the operator's `!`-shell does NOT: $CLAUDE_SESSION_ID
// is unset in that shell, and guessing the id from the newest project
// transcript is a heuristic that breaks on subagent / parallel-session
// transcripts.
//
// So the producer hands the id off instead of making the consumer guess:
// on every block / ask the gate hook writes the `session_id` to
// `<generatedDir>/.pending-approval`, and an approval verb reads it when
// no `--session` flag and no `$CLAUDE_SESSION_ID` are given. Deterministic,
// not a guess.
//
// `harness apply` only writes its own known files into harness.generated/
// (it never wipes the directory), so the staging file survives applies.

import * as path from "node:path";
import { atomicWriteFile } from "../io/atomic-write.js";
import { GENERATED_DIRNAME, resolveGeneratedDir } from "../io/generated-dir.js";
import { readTextFileBoundedOrThrow } from "../io/read-regular-file.js";

export { GENERATED_DIRNAME, resolveGeneratedDir };

export const PENDING_APPROVAL_BASENAME = ".pending-approval";

export function pendingApprovalPath(generatedDir: string): string {
  return path.join(generatedDir, PENDING_APPROVAL_BASENAME);
}

/**
 * Producer: stage `sessionId` for a later `harness approve`. `atomicWriteFile`
 * creates `generatedDir` if missing, so a hand-wired hook with no prior
 * apply still benefits. Callers treat this as best-effort — a write
 * failure must never escalate a gate block into a thrown hook error.
 */
export function writePendingApproval(generatedDir: string, sessionId: string): void {
  atomicWriteFile(pendingApprovalPath(generatedDir), `${sessionId}\n`);
}

/**
 * Consumer: read the staged session id, or null when the file is absent,
 * empty, whitespace-only, or unreadable. Trims the trailing newline the
 * producer writes plus any surrounding whitespace.
 */
export function readPendingApproval(generatedDir: string): string | null {
  let raw: string;
  try {
    // Bounded and non-blocking (a FIFO or oversized file at the staging path
    // reads as "no staged session id", the same as an absent one).
    raw = readTextFileBoundedOrThrow(pendingApprovalPath(generatedDir), { followSymlinks: true });
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
