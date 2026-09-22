import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFileLock, withFileLock } from "../../src/io/lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let lockPath: string;
let dataPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lock-"));
  lockPath = path.join(tmpDir, ".harness.lock");
  dataPath = path.join(tmpDir, "data.txt");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("withFileLock — basic", () => {
  it("creates the lock file if missing and runs the callback", async () => {
    let ran = false;
    const result = await withFileLock(lockPath, async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("releases the lock so a second call succeeds sequentially", async () => {
    await withFileLock(lockPath, async () => {});
    const r = await withFileLock(lockPath, async () => "second");
    expect(r).toBe("second");
  });

  it("propagates errors from the callback after releasing the lock", async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const r = await withFileLock(lockPath, async () => "after");
    expect(r).toBe("after");
  });
});

// Three-valued read-only check (harness/799de976): `checkFileLock` is the
// designated read-only wrapper `hook-solution-acceptance.ts`'s attempt-lock
// liveness check is routed through, so it must never collapse "the
// underlying check threw" into "not live": a caller reading that as
// confirmed-absent would assert an attempt is gone when liveness simply
// could not be determined.
describe("checkFileLock", () => {
  it('reads "not-live" when no lock directory exists', () => {
    expect(checkFileLock(lockPath)).toBe("not-live");
  });

  it('reads "live" while a lock is held, "not-live" once released', async () => {
    let seenDuringHold: string | undefined;
    await withFileLock(lockPath, async () => {
      seenDuringHold = checkFileLock(lockPath);
    });
    expect(seenDuringHold).toBe("live");
    expect(checkFileLock(lockPath)).toBe("not-live");
  });

  it('reads "not-live" for a lock directory past the given staleMs (left by a dead process)', () => {
    const lockDir = `${lockPath}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);
    expect(checkFileLock(lockPath, { staleMs: 10_000 })).toBe("not-live");
  });

  it('reads "unknown" (not "not-live") when the underlying check throws something other than ENOENT', () => {
    // A self-referential symlink at the `.lock` path: `fs.statSync` throws
    // ELOOP resolving it, not ENOENT, so this must read "unknown", never
    // collapse to "not-live".
    const lockDir = `${lockPath}.lock`;
    fs.symlinkSync(lockDir, lockDir);
    expect(checkFileLock(lockPath)).toBe("unknown");
  });
});

describe("withFileLock — concurrency via fork", () => {
  it("serialises two concurrent invocations from separate processes", async () => {
    const workerPath = path.resolve(__dirname, "fixtures/lock-worker.cjs");
    // Deterministic first-acquire ordering via a readiness handshake, not a fixed
    // lead-time: worker A appends "A:lock-acquired" the instant lockfile.lock()
    // resolves, so we fork B only once A is provably holding the lock. B then
    // blocks on acquire until A releases, so the [A,B] order no longer depends on
    // process-startup latency winning a 50ms window under CPU load (the same
    // fixed-window flake class fixed in the smoke SIGKILL test, #330).
    const a = forkWorker(workerPath, { lockPath, dataPath, label: "A", holdMs: 300 });
    await waitForAcquired(dataPath, "A", 10_000);
    const b = forkWorker(workerPath, { lockPath, dataPath, label: "B", holdMs: 100 });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.label).toBe("A");
    expect(rb.label).toBe("B");

    const log = fs.readFileSync(dataPath, "utf8").trim().split("\n");
    expect(log).toEqual([
      "A:lock-acquired",
      "A:lock-released",
      "B:lock-acquired",
      "B:lock-released",
    ]);
  }, 15_000);
});

/**
 * Poll (real time, no wall-clock budget) until `dataPath` shows that `label`
 * has acquired the lock — the worker appends "<label>:lock-acquired" the moment
 * lockfile.lock() resolves. Synchronizing on the child's own readiness signal
 * instead of assuming it acquires within a fixed startup window is what makes
 * the [A,B] ordering deterministic under CPU contention. The 10ms interval is a
 * poll cadence, not an ordering tiebreaker. Mirrors the #330 smoke handshake.
 */
async function waitForAcquired(dataPath: string, label: string, timeoutMs: number): Promise<void> {
  const marker = `${label}:lock-acquired`;
  const start = Date.now();
  while (!(fs.existsSync(dataPath) && fs.readFileSync(dataPath, "utf8").includes(marker))) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for "${marker}" in ${dataPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface WorkerArgs {
  lockPath: string;
  dataPath: string;
  label: string;
  holdMs: number;
}

interface WorkerResult {
  label: string;
  exitCode: number | null;
  stderr: string;
}

function forkWorker(workerPath: string, args: WorkerArgs): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [JSON.stringify(args)], { silent: true });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ label: args.label, exitCode: code, stderr });
      else reject(new Error(`worker ${args.label} exited ${code}: ${stderr}`));
    });
    child.on("error", reject);
  });
}
