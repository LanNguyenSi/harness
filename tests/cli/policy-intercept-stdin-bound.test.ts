// `harness policy intercept` is the PreToolUse gate entrypoint, and its stdin
// read is idle-bounded (3000 ms). A timed-out read must not turn into an allow:
// a host that stalls past the bound and then writes a complete gated event used
// to get an allow here, because the hook had already continued as an empty event
// when the late data arrived (task aca3de04). These tests drive the built CLI
// with a block-tier policy that would deny the gated event on a closed stdin, in
// the shapes the bound exists for: a stdin that is open and never closed, and a
// writer that is merely late. A closed stdin keeps its pre-existing decision.
//
// The late-writer clock starts from the readiness preload's fd 3 signal (the
// CLI attached its stdin data listener, which arms the idle timer), never from
// the spawn, so a slow runner cannot let the late write beat the timer.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GENERATED_DIRNAME } from "../../src/io/generated-dir.js";
import { writeSentinel } from "../../src/runtime/pause-sentinel.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");
const READY_PRELOAD = path.join(REPO_ROOT, "tests", "_helpers", "stdin-reader-ready-preload.cjs");

// Failure-path deadline for a child that never exits; a loaded runner can spend
// seconds booting node.
const KILL_AFTER_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const BOUND_MS = 3000;
// Measured from the moment the hook started reading, wide enough that a late
// write can only land after the hook's timer fired.
const LATE_MS = BOUND_MS + 5000;
const BLOCK_REASON_HEAD = "stdin timeout:";
const BOUND_TEXT = `within ${BOUND_MS} ms`;
const MAX_CONCURRENT_CHILDREN = 8;

const GATED_MCP_TOOL = "mcp__agent-tasks__pull_requests_merge";

// A block-tier policy and no grounding-mcp server: the evidence cannot be read,
// so the gated tool is denied (fail closed) on a closed stdin. Any other tool
// matches no policy and is allowed.
const MANIFEST = `version: 1
tools:
  builtin:
    known: [Read, Edit, Write, Bash]
hooks:
  - name: gate-pretooluse
    event: PreToolUse
    match: "${GATED_MCP_TOOL}"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review exists.
    trigger:
      event: PreToolUse
      match: "${GATED_MCP_TOOL}"
    requires:
      ledger_tag: "review:1"
    hook: gate-pretooluse
    enforcement: block
`;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let running = 0;
const waiting: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_CHILDREN) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

interface Ctx {
  home: string;
  cwd: string;
  configPath: string;
}

function makeCtx(): Ctx {
  const home = tmpDir("harness-intercept-stdin-home-");
  const cwd = tmpDir("harness-intercept-stdin-repo-");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  const configPath = path.join(home, "harness.yaml");
  fs.writeFileSync(configPath, MANIFEST, "utf8");
  return { home, cwd, configPath };
}

function event(ctx: Ctx, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "intercept-stdin-sess",
    hook_event_name: "PreToolUse",
    cwd: ctx.cwd,
    tool_name: GATED_MCP_TOOL,
    tool_input: { prNumber: 1 },
    ...over,
  });
}

interface WriteStep {
  afterMs: number;
  data: string;
}

interface ChildResult {
  code: number | null;
  hung: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  ms: number;
  readSignalled: boolean;
  writesBeforeExit: number;
}

/**
 * Spawn the built CLI behind the readiness preload and drive its stdin from a
 * script. With no `closeAfter` stdin stays open forever (never closed); with it
 * stdin is ended after the last step (a late writer). The first step's clock
 * starts when the child reports it began reading stdin.
 */
async function runIntercept(opts: {
  ctx: Ctx;
  steps?: WriteStep[];
  closeAfter?: boolean;
}): Promise<ChildResult> {
  expect(fs.existsSync(MAIN_JS), "run `npm run build` first").toBe(true);
  const { home, cwd, configPath } = opts.ctx;
  const env = { ...process.env };
  delete env["CLAUDE_CODE_SESSION_ID"];
  delete env["CLAUDE_SESSION_ID"];
  delete env["HARNESS_POLICY_VERBOSE"];
  delete env["HARNESS_REPO"];
  delete env["HARNESS_BRANCH"];
  env["HARNESS_HOME"] = home;
  env["HOME"] = home;

  await acquireSlot();
  try {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ["--require", READY_PRELOAD, MAIN_JS, "policy", "intercept", "--config", configPath],
      { cwd, stdio: ["pipe", "pipe", "pipe", "pipe"], env },
    );
    const pid = child.pid as number;
    cleanups.push(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
    });
    child.stdin.on("error", () => undefined);
    let exited = false;
    let readSignalled = false;
    let written = 0;
    let writesBeforeExit = 0;
    let stdout = "";
    let stderr = "";
    let wake: () => void = () => undefined;
    const readyOrExit = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const readyPipe = child.stdio[3];
    if (readyPipe !== null && readyPipe !== undefined) {
      readyPipe.on("error", () => undefined);
      readyPipe.once("data", () => {
        readSignalled = true;
        wake();
      });
    }
    let cancelWait: () => void = () => undefined;
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    void (async () => {
      await readyOrExit;
      for (const step of opts.steps ?? []) {
        if (step.afterMs > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, step.afterMs);
            cancelWait = () => {
              clearTimeout(t);
              resolve();
            };
          });
        }
        if (exited) return;
        child.stdin.write(step.data);
        written += 1;
      }
      if (opts.closeAfter === true && !exited) child.stdin.end();
    })();
    const outcome = await new Promise<{ code: number | null; hung: boolean }>((resolve) => {
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, hung: true });
      }, KILL_AFTER_MS);
      child.on("exit", (code) => {
        exited = true;
        writesBeforeExit = written;
        clearTimeout(killer);
        wake();
        cancelWait();
        resolve({ code, hung: false });
      });
    });
    return {
      ...outcome,
      stdout,
      stderr,
      pid,
      ms: Date.now() - started,
      readSignalled,
      writesBeforeExit,
    };
  } finally {
    releaseSlot();
  }
}

function expectBoundedExit(r: ChildResult): void {
  expect(r.hung, `pid ${r.pid} still running after ${KILL_AFTER_MS} ms; stderr: ${r.stderr}`).toBe(
    false,
  );
}

/** The hook started reading, timed out, and exited before the late write was sent. */
function expectExitedBeforeLateWrite(r: ChildResult, sent: number): void {
  expect(r.readSignalled, "the child never reported that it started reading stdin").toBe(true);
  expect(
    r.writesBeforeExit,
    `the child exited after ${r.writesBeforeExit} writes, expected ${sent} (the late write must not have been sent before the timer fired)`,
  ).toBe(sent);
}

/** The intercept refused the tool call because of the timed-out read: PreToolUse deny envelope, exit 0. */
function expectTimeoutBlock(r: ChildResult): void {
  expectBoundedExit(r);
  expect(r.code, `stdout: ${r.stdout}; stderr: ${r.stderr}`).toBe(0);
  expect(r.stdout, `the intercept allowed the call; stderr: ${r.stderr}`).not.toBe("");
  const out = JSON.parse(r.stdout.trim()) as {
    decision: string;
    reason: string;
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(out.decision).toBe("block");
  expect(out.reason.startsWith(BLOCK_REASON_HEAD)).toBe(true);
  expect(out.reason).toContain(BOUND_TEXT);
  expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(out.hookSpecificOutput.permissionDecisionReason).toBe(out.reason);
  expect(r.stderr).toContain("harness policy intercept: BLOCK: stdin timeout:");
  // The bound is the 3000 ms default: the child waited about that long before refusing.
  expect(r.ms).toBeGreaterThanOrEqual(BOUND_MS - 500);
}

describe("policy intercept stdin bound: a timed-out read blocks a PreToolUse intercept", () => {
  it.concurrent(
    "control: the gated event on a closed stdin is denied by the policy, with no stdin timeout involved",
    async () => {
      const ctx = makeCtx();
      const r = await runIntercept({ ctx, steps: [{ afterMs: 0, data: event(ctx) }], closeAfter: true });
      expectBoundedExit(r);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout.trim()) as { decision: string; reason: string };
      expect(out.decision).toBe("block");
      expect(out.reason).toContain("review-before-merge");
      expect(r.stdout).not.toContain(BLOCK_REASON_HEAD);
      expect(r.stderr).not.toContain("stdin timeout");
      expect(r.stderr).not.toContain("did not close");
    },
    TEST_TIMEOUT_MS,
  );

  it.concurrent(
    "a never-closed empty stdin blocks with a reason naming the stdin timeout and the bound",
    async () => {
      expectTimeoutBlock(await runIntercept({ ctx: makeCtx() }));
    },
    TEST_TIMEOUT_MS,
  );

  it.concurrent(
    "a complete gated event on a stdin that never closes blocks (a timeout is not an allow)",
    async () => {
      const ctx = makeCtx();
      expectTimeoutBlock(await runIntercept({ ctx, steps: [{ afterMs: 0, data: event(ctx) }] }));
    },
    TEST_TIMEOUT_MS,
  );

  it.concurrent(
    "a writer that waits past the bound, then writes the full gated event and closes, blocks",
    async () => {
      const ctx = makeCtx();
      const r = await runIntercept({
        ctx,
        steps: [{ afterMs: LATE_MS, data: event(ctx) }],
        closeAfter: true,
      });
      expectTimeoutBlock(r);
      expectExitedBeforeLateWrite(r, 0);
    },
    TEST_TIMEOUT_MS,
  );

  it.concurrent(
    "a writer that stalls past the bound mid-event, then finishes the event and closes, blocks",
    async () => {
      const ctx = makeCtx();
      const full = event(ctx);
      const cut = Math.floor(full.length / 2);
      const r = await runIntercept({
        ctx,
        steps: [
          { afterMs: 0, data: full.slice(0, cut) },
          { afterMs: LATE_MS, data: full.slice(cut) },
        ],
        closeAfter: true,
      });
      expectTimeoutBlock(r);
      expectExitedBeforeLateWrite(r, 1);
    },
    TEST_TIMEOUT_MS,
  );

  it.concurrent(
    "the operator pause wins over a timed-out read: exit 0, no block, the pause notice",
    async () => {
      const ctx = makeCtx();
      const generated = path.join(ctx.home, GENERATED_DIRNAME);
      fs.mkdirSync(generated, { recursive: true });
      writeSentinel(generated, {
        pausedAt: new Date().toISOString(),
        expiresAt: null,
        reason: "stdin bound test",
        pausedBy: "test",
      });
      const r = await runIntercept({ ctx, steps: [{ afterMs: 0, data: event(ctx) }] });
      expectBoundedExit(r);
      expect(r.code, `stdout: ${r.stdout}; stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain(BLOCK_REASON_HEAD);
      expect(r.stderr.toLowerCase()).toContain("paused");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("policy intercept stdin bound: events that are not PreToolUse keep the continue behaviour", () => {
  it.concurrent(
    "a complete PostToolUse event on a stdin that never closes is not blocked: timeout note, no stdout, exit 0",
    async () => {
      const ctx = makeCtx();
      const r = await runIntercept({
        ctx,
        steps: [{ afterMs: 0, data: event(ctx, { hook_event_name: "PostToolUse" }) }],
      });
      expectBoundedExit(r);
      expect(r.code, `stdout: ${r.stdout}; stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("stdin did not close within 3000 ms of the last data");
      expect(r.stderr).not.toContain(BLOCK_REASON_HEAD);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("policy intercept stdin bound: a closed stdin decides exactly as before", () => {
  it.concurrent(
    "an event no policy matches on a closed stdin allows: exit 0, empty stdout, no stdin note",
    async () => {
      const ctx = makeCtx();
      const r = await runIntercept({
        ctx,
        steps: [{ afterMs: 0, data: event(ctx, { tool_name: "Read", tool_input: { file_path: "/x" } }) }],
        closeAfter: true,
      });
      expectBoundedExit(r);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain("stdin never closed");
      expect(r.stderr).not.toContain("did not close");
      expect(r.stderr).not.toContain("stdin timeout");
      expect(r.stderr).not.toContain("BLOCK");
    },
    TEST_TIMEOUT_MS,
  );

  it.concurrent(
    "an empty closed stdin is an empty event, allowed with no stdin note",
    async () => {
      const r = await runIntercept({ ctx: makeCtx(), steps: [], closeAfter: true });
      expectBoundedExit(r);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain("stdin never closed");
      expect(r.stderr).not.toContain("did not close");
      expect(r.stderr).not.toContain("stdin timeout");
      expect(r.stderr).not.toContain("BLOCK");
    },
    TEST_TIMEOUT_MS,
  );
});
