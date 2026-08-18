// Shared plumbing for doctor's per-`--target` adapter check modules
// (codex.ts, opencode.ts, and any future adapter). Moved out of
// codex.ts (LOW-F5, batch18 fix-round, task f34eb233 review): both
// `CodexCheckStatus` and `countStatusDiagnostics` were already
// target-agnostic in everything but name -- opencode.ts's
// `countOpencodeDiagnostics` reused the same function via `./codex.js`,
// which made codex.ts (a Codex-specific adapter module) the load-bearing
// home for logic every `--target` adapter depends on. codex.ts re-
// exports both names for import-path compatibility with existing
// callers instead of requiring every consumer to move at once.

/** Tri-state status shared by every per-target doctor check entry. */
export type DoctorCheckStatus = "ok" | "warn" | "error";

/**
 * Tally `error`/`warn` entries across any target's check list.
 */
export function countStatusDiagnostics(
  checks: readonly { status: DoctorCheckStatus }[],
): { errorCount: number; warningCount: number } {
  let errorCount = 0;
  let warningCount = 0;
  for (const c of checks) {
    if (c.status === "error") errorCount += 1;
    else if (c.status === "warn") warningCount += 1;
  }
  return { errorCount, warningCount };
}
