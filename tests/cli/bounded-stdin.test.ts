// The shared idle-bounded stdin reader (task c8cfc110). Every hook-style CLI
// entry that parses an event JSON from stdin used to await `end` with no
// bound, so an open, never-closed stdin hung the process. Each entry is pinned
// here with a real child process whose stdin is never closed, plus the
// closed-stdin and slow-payload paths in-process.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readStdinBounded, STDIN_IDLE_TIMEOUT_MS } from "../../src/cli/bounded-stdin.js";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import { runSessionStartBranchCheck } from "../../src/cli/session-start/branch-check.js";
import { runSessionStartStaleBaseCheck } from "../../src/cli/session-start/stale-base-check.js";
import { runSessionStartToolchainParity } from "../../src/cli/session-start/toolchain-parity.js";
import { parseManifest } from "../../src/schema/index.js";

// A bare manifest: the opt-in producers are disabled, so each run ends right
// after the stdin step and only the stdin handling is under test.
const bareManifest = (): ReturnType<typeof parseManifest> => parseManifest({ version: 1 });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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

const KILL_AFTER_MS = 12_000;

/**
 * Spawn the built CLI with an open, never-written, never-ended stdin and wait
 * for it to exit by itself. The child is killed by pid when it outlives the
 * bound (the failure case) and again on cleanup, so no test leaves a process.
 */
async function runWithNeverClosedStdin(
  args: string[],
): Promise<{ code: number | null; hung: boolean; stderr: string; pid: number }> {
  expect(fs.existsSync(MAIN_JS), "run `npm run build` first").toBe(true);
  const cwd = tmpDir("harness-bstdin-cwd-");
  const home = tmpDir("harness-bstdin-home-");
  const child = spawn(process.execPath, [MAIN_JS, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HARNESS_HOME: home, HOME: home },
  });
  const pid = child.pid as number;
  cleanups.push(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });
  const outcome = await new Promise<{ code: number | null; hung: boolean }>((resolve) => {
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, hung: true });
    }, KILL_AFTER_MS);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, hung: false });
    });
  });
  return { ...outcome, stderr, pid };
}

describe("bounded stdin: real child process with a never-closed stdin", () => {
  const cases: Array<{ name: string; args: string[]; label: string }> = [
    {
      name: "session-start branch-check",
      args: ["session-start", "branch-check"],
      label: "harness session-start branch-check:",
    },
    {
      name: "session-start stale-base-check",
      args: ["session-start", "stale-base-check"],
      label: "harness session-start stale-base-check:",
    },
    {
      name: "session-start toolchain-parity",
      args: ["session-start", "toolchain-parity"],
      label: "harness session-start toolchain-parity:",
    },
    {
      name: "policy intercept",
      args: ["policy", "intercept", "--config", "/nonexistent/harness.yaml"],
      label: "harness policy intercept:",
    },
  ];
  for (const c of cases) {
    it(`${c.name} exits 0 within a bound with a stderr note naming the timeout (not a hang)`, async () => {
      const r = await runWithNeverClosedStdin(c.args);
      expect(r.hung, `pid ${r.pid} still running after ${KILL_AFTER_MS} ms; stderr: ${r.stderr}`).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(c.label);
      expect(r.stderr).toContain("stdin never closed");
    }, 20_000);
  }
});

describe("bounded stdin: reader behaviour", () => {
  it("a slow but live pipe is not cut off: each chunk restarts the idle bound", async () => {
    const stream = new PassThrough();
    const read = readStdinBounded(stream, 400);
    stream.write("ab");
    await new Promise((r) => setTimeout(r, 250));
    stream.write("cd");
    await new Promise((r) => setTimeout(r, 250));
    stream.end("ef");
    expect(await read).toEqual({ text: "abcdef", timedOut: false });
  });

  it("an idle stream resolves with what was read and timedOut set", async () => {
    const stream = new PassThrough();
    stream.write("partial");
    expect(await readStdinBounded(stream, 100)).toEqual({ text: "partial", timedOut: true });
    expect(stream.isPaused()).toBe(true);
    expect(() => stream.emit("error", new Error("late"))).not.toThrow();
  });

  it("the default bound is the one the preflight path has always used", () => {
    expect(STDIN_IDLE_TIMEOUT_MS).toBe(3000);
  });
});

function hermeticProducerOpts(): { stderr: NodeJS.WritableStream; err: () => string } {
  const { stream, output } = captureStream();
  return { stderr: stream, err: output };
}

describe("bounded stdin: each producer keeps parsing a closed stdin and a slow payload", () => {
  const producers: Array<{
    name: string;
    run: (stdin: NodeJS.ReadableStream, stderr: NodeJS.WritableStream, idle?: number) => Promise<{ sessionId: string }>;
  }> = [
    {
      name: "branch-check",
      run: (stdin, stderr, idle) =>
        runSessionStartBranchCheck({
          stdin,
          stderr,
          writeLedger: async () => ({ ok: true }),
          manifest: bareManifest(),
          ...(idle !== undefined && { stdinIdleTimeoutMs: idle }),
        }),
    },
    {
      name: "stale-base-check",
      run: (stdin, stderr, idle) =>
        runSessionStartStaleBaseCheck({
          stdin,
          stderr,
          writeLedger: async () => ({ ok: true }),
          manifest: bareManifest(),
          ...(idle !== undefined && { stdinIdleTimeoutMs: idle }),
        }),
    },
    {
      name: "toolchain-parity",
      run: (stdin, stderr, idle) =>
        runSessionStartToolchainParity({
          stdin,
          stderr,
          writeLedger: async () => ({ ok: true }),
          manifest: bareManifest(),
          ...(idle !== undefined && { stdinIdleTimeoutMs: idle }),
        }),
    },
  ];
  for (const p of producers) {
    it(`${p.name}: event JSON on a closed stdin is parsed with no timeout note`, async () => {
      const dir = tmpDir("harness-bstdin-closed-");
      const { stderr, err } = hermeticProducerOpts();
      const result = await p.run(
        Readable.from([JSON.stringify({ session_id: "closed-sess", cwd: dir })]),
        stderr,
      );
      expect(result.sessionId).toBe("closed-sess");
      expect(err()).not.toContain("stdin");
    });

    it(`${p.name}: a payload whose chunks arrive inside the idle bound still parses`, async () => {
      const dir = tmpDir("harness-bstdin-slow-");
      const { stderr, err } = hermeticProducerOpts();
      const json = JSON.stringify({ session_id: "slow-sess", cwd: dir });
      const half = Math.floor(json.length / 2);
      const stream = new PassThrough();
      const run = p.run(stream, stderr, 400);
      stream.write(json.slice(0, half));
      await new Promise((r) => setTimeout(r, 250));
      stream.write(json.slice(half, half + 2));
      await new Promise((r) => setTimeout(r, 250));
      stream.end(json.slice(half + 2));
      expect((await run).sessionId).toBe("slow-sess");
      expect(err()).not.toContain("stdin");
    });

    it(`${p.name}: an idle stdin times out with a note and does not throw`, async () => {
      const { stderr, err } = hermeticProducerOpts();
      const prior = process.cwd();
      process.chdir(tmpDir("harness-bstdin-idle-"));
      try {
        const result = await p.run(new PassThrough(), stderr, 100);
        expect(result.sessionId).toBeDefined();
      } finally {
        process.chdir(prior);
      }
      expect(err()).toContain("stdin never closed");
    });
  }
});

describe("bounded stdin: policy intercept fail posture", () => {
  async function intercept(stdin: NodeJS.ReadableStream, idle?: number) {
    const { stream: out, output: stdout } = captureStream();
    const { stream: err, output: stderr } = captureStream();
    const result = await runInterceptCli({
      stdin,
      stdout: out,
      stderr: err,
      manifest: bareManifest(),
      ...(idle !== undefined && { stdinIdleTimeoutMs: idle }),
    });
    return { result, stdout: stdout(), stderr: stderr() };
  }

  it("malformed event JSON on a closed stdin fails open: exit 0, no decisions, stderr note", async () => {
    const r = await intercept(Readable.from(["{not json"]));
    expect(r.result).toEqual({ exitCode: 0, decisions: [], blocked: false });
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("harness policy intercept: malformed event JSON:");
  });

  it("an absent event (empty stdin) is an empty event, not an error", async () => {
    const r = await intercept(Readable.from([""]));
    expect(r.result.exitCode).toBe(0);
    expect(r.result.blocked).toBe(false);
    expect(r.stderr).not.toContain("malformed event JSON");
  });

  it("an idle stdin with partial malformed text fails open with both notes", async () => {
    const stream = new PassThrough();
    stream.write("{\"tool_name\":");
    const r = await intercept(stream, 100);
    expect(r.result).toEqual({ exitCode: 0, decisions: [], blocked: false });
    expect(r.stderr).toContain("stdin did not close within 100 ms of the last data");
    expect(r.stderr).toContain("malformed event JSON:");
  });

  it("an idle empty stdin continues as an empty event and notes the timeout", async () => {
    const r = await intercept(new PassThrough(), 100);
    expect(r.result.exitCode).toBe(0);
    expect(r.result.blocked).toBe(false);
    expect(r.stderr).toContain("no complete event JSON on stdin within 100 ms (stdin never closed)");
    expect(r.stderr).not.toContain("malformed event JSON");
  });

  it("a slow payload with chunks inside the idle bound is parsed, not dropped", async () => {
    const stream = new PassThrough();
    const json = JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    const run = intercept(stream, 400);
    stream.write(json.slice(0, 20));
    await new Promise((r) => setTimeout(r, 250));
    stream.write(json.slice(20, 40));
    await new Promise((r) => setTimeout(r, 250));
    stream.end(json.slice(40));
    const r = await run;
    expect(r.stderr).not.toContain("stdin did not close");
    expect(r.stderr).not.toContain("malformed event JSON");
  });
});
