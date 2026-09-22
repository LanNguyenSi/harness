import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";

export interface LockOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  staleMs?: number;
}

export interface CheckLockOptions {
  staleMs?: number;
}

/**
 * Three-valued read of a lock's liveness, never a boolean: `"live"` (the
 * `proper-lockfile` `.lock` directory exists and is not yet stale under
 * the given `staleMs`), `"not-live"` (no lock directory at all:
 * `checkSync` throws `ENOENT`), or `"unknown"` (`checkSync` threw
 * anything else: an unreadable parent directory, a symlink loop, ...). A
 * caller must not collapse `"unknown"` into `"not-live"`: that would
 * assert the lock is free when the check simply could not tell.
 */
export type LockCheckResult = "live" | "not-live" | "unknown";

export const DEFAULT_LOCK_RETRIES = 50;
export const DEFAULT_LOCK_MIN_TIMEOUT_MS = 50;
export const DEFAULT_LOCK_MAX_TIMEOUT_MS = 500;
export const DEFAULT_LOCK_STALE_MS = 10_000;

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  ensureLockTarget(lockPath);
  const release = await lockfile.lock(lockPath, {
    retries: {
      retries: options.retries ?? DEFAULT_LOCK_RETRIES,
      minTimeout: options.minTimeoutMs ?? DEFAULT_LOCK_MIN_TIMEOUT_MS,
      maxTimeout: options.maxTimeoutMs ?? DEFAULT_LOCK_MAX_TIMEOUT_MS,
    },
    stale: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
    realpath: false,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Read-only liveness check for a lock at `lockPath`, the designated
 * wrapper around `proper-lockfile`'s own read-only `checkSync` (the SAME
 * library `withFileLock` above acquires locks with), so the live/stale
 * split is decided by the producer's own mtime arithmetic, not a
 * reimplementation of it. `realpath: false` mirrors `withFileLock`'s own
 * acquisition options above: `lockPath` is checked at its own literal
 * path, not its resolved target, so a symlinked lock path is checked at
 * itself. Never acquires or mutates the lock; a check-only read has
 * nothing to release.
 */
export function checkFileLock(lockPath: string, options: CheckLockOptions = {}): LockCheckResult {
  try {
    const live = lockfile.checkSync(lockPath, {
      stale: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
      realpath: false,
    });
    return live ? "live" : "not-live";
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "not-live" : "unknown";
  }
}

function ensureLockTarget(lockPath: string): void {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, "");
  }
}
