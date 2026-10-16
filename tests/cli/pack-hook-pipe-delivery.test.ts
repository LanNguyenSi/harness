// A hook's refusal must reach the host through a real pipe whose reader is
// slow. Two things used to cut it: a manifest load error of any size was
// embedded whole in the deny envelope (so the output outgrew the 64 KiB pipe
// buffer), and the entry point called process.exit while the rest was still
// queued, which on macOS cut stdout at the buffer size. A cut envelope is not
// JSON, so Claude Code saw no refusal.
//
// A reader that is gone is a third case: the host closed its end of a pipe, a
// write gets EPIPE, and the hook must still end with the exit code it would
// have had without the wait for the pipe to drain (0 for a Claude Code block,
// 2 for a Codex block). A crash there exits 1, which both hosts read as allow.
//
// These tests run dist/cli/main.js with piped stdio and a reader that starts
// late or never. Build first (`npm run build`).

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BLOCK_TEXT_MAX_BYTES } from "../../src/runtime/bounded-text.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");
const QUEUED_STDOUT_PRELOAD = path.join(REPO_ROOT, "tests", "_helpers", "queued-stdout-preload.cjs");

// The reader starts this long after the child; well inside the drain bound,
// well past the time the child needs to write and want to exit.
const READER_DELAY_MS = 250;
// Failure-path deadline for a child that never exits.
const KILL_AFTER_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
// A pipe buffer holds 64 KiB on macOS and Linux; the queued payload is well over it.
const PIPE_BUFFER_BYTES = 64 * 1024;
const QUEUED_BYTES = 8 * PIPE_BUFFER_BYTES;
// A load error far over the pipe buffer: every entry is one schema issue.
const INVALID_HOOK_ENTRIES = 100_000;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface PipeRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  hung: boolean;
}

/** Run the CLI with piped stdio; stdout and stderr are read only after `readerDelayMs`. */
async function runWithSlowReader(opts: {
  args: string[];
  stdin?: string;
  preloadQueuedBytes?: number;
  preloadQueuedStderrBytes?: number;
  readerDelayMs?: number;
  /** Close the parent's read end of the child's stdout before the child writes. */
  closeStdout?: boolean;
  /** Close the parent's read end of the child's stderr before the child writes. */
  closeStderr?: boolean;
  extraEnv?: Record<string, string>;
  cwd: string;
  home: string;
}): Promise<PipeRun> {
  expect(fs.existsSync(MAIN_JS), "run `npm run build` first").toBe(true);
  const env = { ...process.env };
  delete env["CLAUDE_CODE_SESSION_ID"];
  delete env["CLAUDE_SESSION_ID"];
  delete env["CODEX_SESSION_ID"];
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env["HARNESS_HOME"] = opts.home;
  env["HOME"] = opts.home;
  Object.assign(env, opts.extraEnv);
  const nodeArgs: string[] = [];
  if (opts.preloadQueuedBytes !== undefined || opts.preloadQueuedStderrBytes !== undefined) {
    nodeArgs.push("--require", QUEUED_STDOUT_PRELOAD);
    if (opts.preloadQueuedBytes !== undefined) {
      env["HARNESS_TEST_QUEUED_STDOUT_BYTES"] = String(opts.preloadQueuedBytes);
    }
    if (opts.preloadQueuedStderrBytes !== undefined) {
      env["HARNESS_TEST_QUEUED_STDERR_BYTES"] = String(opts.preloadQueuedStderrBytes);
    }
  }
  const child = spawn(process.execPath, [...nodeArgs, MAIN_JS, ...opts.args], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const pid = child.pid as number;
  cleanups.push(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(opts.stdin ?? "");
  // Paused: nothing is read, so the pipes back up, until the reader starts.
  child.stdout.pause();
  child.stderr.pause();
  // The child needs far longer than this to start and write, so its first
  // write lands on a pipe nobody reads any more.
  if (opts.closeStdout === true) child.stdout.destroy();
  if (opts.closeStderr === true) child.stderr.destroy();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => out.push(c));
  child.stderr.on("data", (c: Buffer) => err.push(c));
  const ended = Promise.all(
    [child.stdout, child.stderr].map((s) => new Promise<void>((resolve) => s.once("close", () => resolve()))),
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  setTimeout(() => {
    child.stdout.resume();
    child.stderr.resume();
  }, opts.readerDelayMs ?? READER_DELAY_MS);
  let hung = false;
  const killer = setTimeout(() => {
    hung = true;
    child.kill("SIGKILL");
  }, KILL_AFTER_MS);
  const { code, signal } = await exited;
  await ended;
  clearTimeout(killer);
  return { code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), hung };
}

function oversizedManifest(dir: string): string {
  const configPath = path.join(dir, "harness.yaml");
  fs.writeFileSync(
    configPath,
    `version: 1\npolicy_packs:\n  - name: branch-protection\n    enabled: true\nhooks:\n${"  - 1\n".repeat(INVALID_HOOK_ENTRIES)}`,
  );
  return configPath;
}

/**
 * A real repository with `branch` checked out (unborn). The default `master`
 * is protected, so a write inside it is refused.
 */
function protectedRepo(branch = "master"): string {
  const repo = path.join(tmpDir("harness-pipe-repo-"), "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-c", `init.defaultBranch=${branch}`, "init", "-q"], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "ignore",
  });
  return repo;
}

/** A valid manifest that enables the pack, so a write on `master` is refused for the branch. */
function packManifest(): string {
  const dir = tmpDir("harness-pipe-cfg-");
  const configPath = path.join(dir, "harness.yaml");
  fs.writeFileSync(configPath, "version: 1\npolicy_packs:\n  - name: branch-protection\n    enabled: true\n");
  return configPath;
}

/**
 * Like packManifest, plus a `config.ux` block the schema rejects, so the hook
 * writes its `config.ux ignored` warning to stderr before it asks git for the
 * branch (an await), i.e. while run() is still pending.
 */
function packManifestWithBadUx(): string {
  const dir = tmpDir("harness-pipe-cfg-ux-");
  const configPath = path.join(dir, "harness.yaml");
  fs.writeFileSync(
    configPath,
    [
      "version: 1",
      "policy_packs:",
      "  - name: branch-protection",
      "    enabled: true",
      "    config:",
      "      ux:",
      "        cannot: x",
      "        required: []",
      "        run: [y]",
      "",
    ].join("\n"),
  );
  return configPath;
}

function writeEventIn(repo: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    cwd: repo,
    tool_input: { file_path: path.join(repo, "x.txt"), content: "x" },
  });
}

const EVENT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  cwd: os.tmpdir(),
  tool_input: { file_path: path.join(os.tmpdir(), "harness-pipe-delivery", "x.txt"), content: "x" },
});

describe("branch-protection: an oversized manifest load error through a slow pipe reader", () => {
  it(
    "claude-code: a complete, parseable deny envelope, exit 0",
    async () => {
      const dir = tmpDir("harness-pipe-claude-");
      const configPath = oversizedManifest(dir);
      expect(fs.statSync(configPath).size).toBeGreaterThan(PIPE_BUFFER_BYTES);
      const run = await runWithSlowReader({
        args: ["pack", "hook", "branch-protection", "--config", configPath],
        stdin: EVENT,
        cwd: dir,
        home: dir,
      });
      expect(run.hung).toBe(false);
      expect(run.code).toBe(0);
      const text = run.stdout.toString("utf8");
      expect(text.endsWith("\n")).toBe(true);
      const env = JSON.parse(text) as {
        decision: string;
        reason: string;
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string; hookEventName: string };
      };
      expect(env.decision).toBe("block");
      expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(env.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(env.reason).toContain("the harness manifest could not be loaded");
      expect(env.reason).toMatch(/\n\[truncated \d+ bytes\]$/);
      expect(env.hookSpecificOutput.permissionDecisionReason).toBe(env.reason);
      expect(Buffer.byteLength(env.reason)).toBeLessThanOrEqual(BLOCK_TEXT_MAX_BYTES + 64);
      // The note on stderr is bounded the same way and arrives whole.
      const note = run.stderr.toString("utf8");
      expect(note).toMatch(/\[truncated \d+ bytes\]\n$/);
      expect(run.stderr.length).toBeLessThan(PIPE_BUFFER_BYTES);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "codex: exit 2 with the bounded reason complete on stderr",
    async () => {
      const dir = tmpDir("harness-pipe-codex-");
      const configPath = oversizedManifest(dir);
      const run = await runWithSlowReader({
        args: ["pack", "hook", "branch-protection", "--config", configPath, "--runtime", "codex"],
        stdin: EVENT,
        cwd: dir,
        home: dir,
      });
      expect(run.hung).toBe(false);
      expect(run.code).toBe(2);
      expect(run.stdout.length).toBe(0);
      const text = run.stderr.toString("utf8");
      // The diagnostic line, then the reason: each cut with its own marker.
      expect(text).toContain("harness pack hook branch-protection: BLOCK: the harness manifest could not be loaded");
      expect(text).toContain("branch-protection: refusing Write: the harness manifest could not be loaded");
      expect(text.match(/\[truncated \d+ bytes\]/g)).toHaveLength(2);
      expect(text.endsWith("]\n")).toBe(true);
      expect(run.stderr.length).toBeLessThan(2 * (BLOCK_TEXT_MAX_BYTES + 128) + 512);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the entry point drains stdout before it exits", () => {
  it(
    "output queued past the pipe buffer reaches a slow reader whole (any verb that exits through main.ts)",
    async () => {
      const dir = tmpDir("harness-pipe-drain-");
      const run = await runWithSlowReader({
        args: ["--version"],
        preloadQueuedBytes: QUEUED_BYTES,
        cwd: dir,
        home: dir,
      });
      expect(run.hung).toBe(false);
      expect(run.code).toBe(0);
      const text = run.stdout.toString("utf8");
      expect(text.startsWith("Q".repeat(QUEUED_BYTES))).toBe(true);
      expect(text.slice(QUEUED_BYTES)).toMatch(/^\d+\.\d+\.\d+\S*\n$/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a reader that never reads does not hold the exit past the bound",
    async () => {
      const dir = tmpDir("harness-pipe-never-");
      const started = Date.now();
      const run = await runWithSlowReader({
        args: ["--version"],
        preloadQueuedBytes: QUEUED_BYTES,
        // Starts after the drain bound has long passed.
        readerDelayMs: 4000,
        cwd: dir,
        home: dir,
      });
      expect(run.hung).toBe(false);
      expect(run.code).toBe(0);
      // The child exited without waiting for the reader: the reader got a cut stream.
      expect(run.stdout.length).toBeLessThan(QUEUED_BYTES);
      expect(Date.now() - started).toBeLessThan(KILL_AFTER_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "output queued on stderr past the pipe buffer reaches a slow reader whole",
    async () => {
      const dir = tmpDir("harness-pipe-drain-err-");
      const run = await runWithSlowReader({
        args: ["--version"],
        preloadQueuedStderrBytes: QUEUED_BYTES,
        cwd: dir,
        home: dir,
      });
      expect(run.hung).toBe(false);
      expect(run.code).toBe(0);
      expect(run.stderr.toString("utf8")).toBe("E".repeat(QUEUED_BYTES));
      expect(run.stdout.toString("utf8")).toMatch(/^\d+\.\d+\.\d+\S*\n$/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a rejection that escapes run() drains stdout before it exits 70",
    async () => {
      const dir = tmpDir("harness-pipe-reject-");
      // One enabled MCP server makes `doctor` reach a real spawn; under the
      // test runner's VITEST variable the spawn guard throws a
      // HermeticSpawnViolationError, which run() rethrows to the entry point.
      const configPath = path.join(dir, "harness.yaml");
      fs.writeFileSync(
        configPath,
        "version: 1\ntools:\n  mcp:\n    - name: x\n      command: [/usr/bin/true]\n",
      );
      const run = await runWithSlowReader({
        args: ["doctor", "--config", configPath],
        preloadQueuedBytes: QUEUED_BYTES,
        extraEnv: { VITEST: "true" },
        cwd: dir,
        home: dir,
      });
      expect(run.hung).toBe(false);
      expect(run.code).toBe(70);
      expect(run.stderr.toString("utf8")).toContain("Refusing to spawn a REAL");
      expect(run.stdout.toString("utf8")).toBe("Q".repeat(QUEUED_BYTES));
    },
    TEST_TIMEOUT_MS,
  );
});

// The host may close a read end before the hook has written: the write gets
// EPIPE, which a stream with no 'error' listener turns into an uncaught
// exception (exit 1, read as allow by both hosts). Each row asserts the exit
// code the hook has with no wait for a drain: 0 for Claude Code, 2 for Codex.
describe("a closed reader does not change the exit code", () => {
  const CLOSED: ReadonlyArray<{ name: string; closeStdout: boolean; closeStderr: boolean }> = [
    { name: "stdout", closeStdout: true, closeStderr: false },
    { name: "stderr", closeStdout: false, closeStderr: true },
    { name: "stdout and stderr", closeStdout: true, closeStderr: true },
  ];

  for (const closed of CLOSED) {
    it(
      `claude-code: a protected-branch block with the ${closed.name} reader closed exits 0 and delivers what is still open`,
      async () => {
        const repo = protectedRepo();
        const run = await runWithSlowReader({
          args: ["pack", "hook", "branch-protection", "--config", packManifest()],
          stdin: writeEventIn(repo),
          closeStdout: closed.closeStdout,
          closeStderr: closed.closeStderr,
          cwd: repo,
          home: repo,
        });
        expect(run.hung).toBe(false);
        expect(run.signal).toBeNull();
        expect(run.code).toBe(0);
        if (!closed.closeStdout) {
          const env = JSON.parse(run.stdout.toString("utf8")) as {
            decision: string;
            reason: string;
            hookSpecificOutput: { permissionDecision: string };
          };
          expect(env.decision).toBe("block");
          expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
          expect(env.reason).toContain('protected branch "master"');
        }
        if (!closed.closeStderr) {
          expect(run.stderr.toString("utf8")).not.toMatch(/EPIPE|Unhandled|node:events/);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      `codex: a protected-branch block with the ${closed.name} reader closed exits 2 and delivers what is still open`,
      async () => {
        const repo = protectedRepo();
        const run = await runWithSlowReader({
          args: ["pack", "hook", "branch-protection", "--config", packManifest(), "--runtime", "codex"],
          stdin: writeEventIn(repo),
          closeStdout: closed.closeStdout,
          closeStderr: closed.closeStderr,
          cwd: repo,
          home: repo,
        });
        expect(run.hung).toBe(false);
        expect(run.signal).toBeNull();
        expect(run.code).toBe(2);
        if (!closed.closeStderr) {
          const text = run.stderr.toString("utf8");
          expect(text).toContain("refusing Write on protected branch");
          expect(text).not.toMatch(/EPIPE|Unhandled|node:events/);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      `a plain verb (--version) with the ${closed.name} reader closed exits 0`,
      async () => {
        const dir = tmpDir("harness-pipe-verb-");
        const run = await runWithSlowReader({
          args: ["--version"],
          closeStdout: closed.closeStdout,
          closeStderr: closed.closeStderr,
          cwd: dir,
          home: dir,
        });
        expect(run.hung).toBe(false);
        expect(run.signal).toBeNull();
        expect(run.code).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

// The warning for a bad `config.ux` is written while run() is still awaiting
// git. A closed reader's EPIPE is emitted then, before the exit path attaches
// its listener, so without an earlier listener it is an uncaught exception
// (exit 1, read as allow by both hosts).
describe("a closed reader at the early config.ux warning does not change the exit code", () => {
  it(
    "claude-code: stderr reader closed, a protected-branch block still exits 0 with the deny envelope",
    async () => {
      const repo = protectedRepo();
      const run = await runWithSlowReader({
        args: ["pack", "hook", "branch-protection", "--config", packManifestWithBadUx()],
        stdin: writeEventIn(repo),
        closeStderr: true,
        cwd: repo,
        home: repo,
      });
      expect(run.hung).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      const env = JSON.parse(run.stdout.toString("utf8")) as {
        decision: string;
        reason: string;
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(env.decision).toBe("block");
      expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(env.reason).toContain('protected branch "master"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "claude-code: both readers closed, a protected-branch block still exits 0",
    async () => {
      const repo = protectedRepo();
      const run = await runWithSlowReader({
        args: ["pack", "hook", "branch-protection", "--config", packManifestWithBadUx()],
        stdin: writeEventIn(repo),
        closeStdout: true,
        closeStderr: true,
        cwd: repo,
        home: repo,
      });
      expect(run.hung).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "codex: stderr reader closed, a protected-branch block still exits 2",
    async () => {
      const repo = protectedRepo();
      const run = await runWithSlowReader({
        args: ["pack", "hook", "branch-protection", "--config", packManifestWithBadUx(), "--runtime", "codex"],
        stdin: writeEventIn(repo),
        closeStderr: true,
        cwd: repo,
        home: repo,
      });
      expect(run.hung).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.code).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an allow keeps exit 0 (claude-code and codex) with the stderr reader closed",
    async () => {
      for (const runtimeArgs of [[], ["--runtime", "codex"]]) {
        // A repository on an unprotected branch: git is asked the same way as for a block.
        const dir = protectedRepo("feature");
        const run = await runWithSlowReader({
          args: ["pack", "hook", "branch-protection", "--config", packManifestWithBadUx(), ...runtimeArgs],
          stdin: writeEventIn(dir),
          closeStderr: true,
          cwd: dir,
          home: dir,
        });
        expect(run.hung).toBe(false);
        expect(run.signal).toBeNull();
        expect(run.code).toBe(0);
        expect(run.stdout.length).toBe(0);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
