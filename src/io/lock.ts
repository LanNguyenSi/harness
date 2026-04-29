import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";

export interface LockOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  staleMs?: number;
}

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

function ensureLockTarget(lockPath: string): void {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, "");
  }
}
