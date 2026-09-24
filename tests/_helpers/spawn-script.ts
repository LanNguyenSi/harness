import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

/** The shape execFileSync throws when the spawned process exits nonzero. */
export interface FailedSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `execFileSync(execPath, args, opts)` and, instead of letting a
 * nonzero exit throw, returns its status/stdout/stderr: the
 * try/catch-and-unwrap shape the `tests/scripts/*.test.ts` spawn-smoke
 * suites share. Rethrows anything that isn't the expected
 * "process exited nonzero" shape (e.g. ENOENT from a bad execPath),
 * since that is a real test-setup bug, not the case this helper exists
 * to unwrap.
 */
export function spawnExpectingFailure(
  execPath: string,
  args: readonly string[],
  opts: ExecFileSyncOptionsWithStringEncoding,
): FailedSpawnResult {
  try {
    execFileSync(execPath, args, opts);
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    if (typeof e?.stdout === "string" && typeof e?.stderr === "string") {
      return { status: e.status ?? null, stdout: e.stdout, stderr: e.stderr };
    }
    throw err;
  }
  throw new Error(`spawnExpectingFailure: ${execPath} ${args.join(" ")} exited 0, expected a failure.`);
}
