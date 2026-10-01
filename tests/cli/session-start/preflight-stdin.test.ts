// stdin handling of `harness session-start preflight` / `harness preflight`
// (task dda77b46). The producer used to await stdin's `end` event
// unconditionally, so a backgrounded compound command whose stdin is an open,
// never-closed pipe left the process idle forever. The SessionStart hook pipes
// the event JSON and closes stdin, which must keep working.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runSessionStartPreflight } from "../../../src/cli/session-start/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

/** A stdin that never produces data and never ends, and counts read attempts. */
function neverEndingStdin(): { stream: PassThrough; reads: () => number } {
  const stream = new PassThrough();
  let reads = 0;
  const onNewListener = (event: string | symbol): void => {
    if (event === "data" || event === "readable") reads += 1;
  };
  stream.on("newListener", onNewListener);
  return { stream, reads: () => reads };
}

// Hermetic runner options: nothing may touch the operator's home.
function hermeticOpts(cwd: string): {
  logDir: string;
  writeLedger: () => Promise<{ ok: true }>;
  runPreflight: () => Promise<{ ok: true; json: { ready: boolean; confidence: number; checks: [] } }>;
  resolveSession: (explicit?: string) => string;
} {
  void cwd;
  return {
    logDir: tmpDir("harness-stdin-logs-"),
    writeLedger: async () => ({ ok: true }),
    runPreflight: async () => ({ ok: true, json: { ready: true, confidence: 0.9, checks: [] } }),
    resolveSession: (explicit) => explicit ?? "default",
  };
}

describe("session-start preflight stdin: real child process with a never-closed stdin", () => {
  it("exits 0 within a bound with a stderr note naming the timeout (not a hang)", async () => {
    expect(fs.existsSync(MAIN_JS), "run `npm run build` first").toBe(true);
    // A non-git cwd makes the run end right after the stdin step, so only the
    // stdin handling decides whether the child exits.
    const cwd = tmpDir("harness-stdin-cwd-");
    const home = tmpDir("harness-stdin-home-");
    const child = spawn(process.execPath, [MAIN_JS, "preflight"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HARNESS_HOME: home, HOME: home },
    });
    // stdin stays open: nothing is written and end() is never called.
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, timedOut: true });
      }, 12_000);
      child.on("exit", (code) => {
        clearTimeout(killer);
        resolve({ code, timedOut: false });
      });
    });
    expect(outcome.timedOut, `child still running after 12 s; stderr: ${stderr}`).toBe(false);
    expect(outcome.code).toBe(0);
    expect(stderr).toContain("stdin never closed");
  }, 20_000);
});

describe("session-start preflight stdin: bounded read", () => {
  it("with --session, never reads stdin (a never-ending stream is left untouched)", async () => {
    const { stream, reads } = neverEndingStdin();
    const { stream: err } = captureStream();
    const cwd = tmpDir("harness-stdin-nogit-");
    const prior = process.cwd();
    process.chdir(cwd);
    try {
      const result = await Promise.race([
        runSessionStartPreflight({
          ...hermeticOpts(cwd),
          stdin: stream,
          stderr: err,
          session: "explicit-sess",
          // A long bound: the run must not depend on the timeout to finish.
          stdinIdleTimeoutMs: 60_000,
        }),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 5_000)),
      ]);
      expect(result).not.toBe("hung");
      expect(reads()).toBe(0);
    } finally {
      process.chdir(prior);
    }
  }, 15_000);

  it("without --session, an idle stdin times out, notes it on stderr and falls back to the default resolution", async () => {
    const { stream } = neverEndingStdin();
    const { stream: err, output } = captureStream();
    const cwd = tmpDir("harness-stdin-nogit2-");
    const prior = process.cwd();
    process.chdir(cwd);
    try {
      const started = Date.now();
      const result = await runSessionStartPreflight({
        ...hermeticOpts(cwd),
        stdin: stream,
        stderr: err,
        stdinIdleTimeoutMs: 150,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.exitCode).toBe(0);
      expect(output()).toContain("no complete event JSON on stdin within 150 ms");
      expect(output()).toContain("falling back to the default session resolution");
      // Not a malformed-JSON outcome: the empty read parses as an empty event.
      expect(output()).not.toContain("malformed event JSON");
    } finally {
      process.chdir(prior);
    }
  }, 15_000);

  it("a slow but live pipe is not cut off: each chunk restarts the idle bound", async () => {
    const stream = new PassThrough();
    const { stream: err, output } = captureStream();
    const repo = tmpDir("harness-stdin-slow-");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const json = JSON.stringify({ session_id: "slow-sess", cwd: repo });
    const third = Math.floor(json.length / 3);
    const run = runSessionStartPreflight({
      ...hermeticOpts(repo),
      stdin: stream,
      stderr: err,
      stdinIdleTimeoutMs: 400,
    });
    // Each gap (250 ms) is under the bound (400 ms) but the whole write
    // (500 ms) is over it: only a per-chunk restart lets this finish.
    stream.write(json.slice(0, third));
    await new Promise((r) => setTimeout(r, 250));
    stream.write(json.slice(third, 2 * third));
    await new Promise((r) => setTimeout(r, 250));
    stream.end(json.slice(2 * third));
    const result = await run;
    expect(result.sessionId).toBe("slow-sess");
    expect(result.sessionSource).toBe("stdin");
    expect(output()).not.toContain("stdin never closed");
    expect(output()).not.toContain("within 400 ms");
  });

  it("normal path: event JSON with cwd and session_id on a closed stdin is still parsed, with no timeout note", async () => {
    const repo = tmpDir("harness-stdin-normal-");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const { stream: err, output } = captureStream();
    const result = await runSessionStartPreflight({
      ...hermeticOpts(repo),
      stdin: Readable.from([JSON.stringify({ session_id: "hook-sess", cwd: repo })]),
      stderr: err,
    });
    expect(result.sessionId).toBe("hook-sess");
    expect(result.sessionSource).toBe("stdin");
    expect(result.wrote).toBe(true);
    expect(output()).not.toContain("within");
  });
});
