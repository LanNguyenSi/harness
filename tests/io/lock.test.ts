import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../../src/io/lock.js";

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

describe("withFileLock — concurrency via fork", () => {
  it("serialises two concurrent invocations from separate processes", async () => {
    const workerPath = path.resolve(__dirname, "fixtures/lock-worker.cjs");
    // A holds the lock for 300ms so the [A,B] order is stable even if B's fork() resolves
    // before A finishes acquiring; A's hold is much longer than typical fork latency on
    // CI runners. The 50ms lead-time is just a tiebreaker for the first-acquire race.
    const a = forkWorker(workerPath, { lockPath, dataPath, label: "A", holdMs: 300 });
    await new Promise((r) => setTimeout(r, 50));
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
