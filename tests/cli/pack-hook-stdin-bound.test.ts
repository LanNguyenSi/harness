// The pack hook stdin readers are idle-bounded (task 7dfdcaaf). Claude Code
// pipes the event and closes stdin, so these tests exercise the cases the bound
// exists for with real child processes: a stdin that is open and never closed,
// and a writer that is merely late (it waits past the bound, then writes the
// full event and closes).
//
// A PreToolUse gate must not turn a timed-out read into an allow, so every gate
// verb is pinned to BLOCK in all of those shapes, with a reason that names the
// stdin timeout and the 3000 ms bound. Every other hook verb is not a gate and
// treats a timeout as the bytes it read (one stderr note, exit 0).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GENERATED_DIRNAME } from "../../src/io/generated-dir.js";
import { writeSentinel } from "../../src/runtime/pause-sentinel.js";
import { addGitDirSkeleton } from "../_helpers/git-dir-fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");
// Loaded ahead of the CLI; it reports on fd 3 when the CLI starts reading stdin.
const READY_PRELOAD = path.join(REPO_ROOT, "tests", "_helpers", "stdin-reader-ready-preload.cjs");

// Generous on purpose: it is only the failure-path deadline for a child that
// never exits, and a loaded runner can spend seconds booting node.
const KILL_AFTER_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
// The default idle bound the readers must apply, and the wait that outlasts it.
// The wait is measured from the moment the hook started reading (not from the
// spawn), and carries a wide margin over the bound so a late write can only
// land after the hook's timer fired, whatever the runner's speed.
const BOUND_MS = 3000;
const LATE_MS = BOUND_MS + 5000;
const TIMEOUT_NOTE = "stdin never closed";
const BLOCK_REASON_HEAD = "stdin timeout:";
const BOUND_TEXT = `within ${BOUND_MS} ms`;
const MAX_CONCURRENT_CHILDREN = 8;

function manifestWithPack(pack: string): string {
  return `version: 1
policy_packs:
  - name: ${pack}
    enabled: true
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`;
}

// The cases below run concurrently, so cleanup happens once after all of them
// (a per-test hook would kill a sibling's still-running child).
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A small gate keeps the concurrent children from starving each other of CPU
// (each one spends its first second booting node), which would eat into the
// kill deadline.
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

interface ChildResult {
  code: number | null;
  hung: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  ms: number;
  /** True when the child reported (fd 3) that it started reading stdin before it exited. */
  readSignalled: boolean;
  /** How many scripted writes had been sent to the child when it exited. */
  writesBeforeExit: number;
}

/**
 * One scripted write: `data` goes to the child's stdin `afterMs` after the
 * previous step. The first step's clock starts when the child reports that it
 * began reading stdin, so a slow node start-up cannot eat into the delay.
 */
interface WriteStep {
  afterMs: number;
  data: string;
}

interface Ctx {
  home: string;
  cwd: string;
  configPath: string | undefined;
}

/**
 * Spawn the built CLI and drive its stdin from a script. With no `closeAfter`
 * the stdin stays open forever (the never-closed case); with `closeAfter` it is
 * ended after the last step (the late-writer case). The child is killed by pid
 * when it outlives the deadline (the failure case) and again on cleanup, so no
 * test leaves a process behind.
 */
async function runHook(opts: {
  verb: string;
  extraArgs?: string[];
  steps?: WriteStep[];
  closeAfter?: boolean;
  manifest?: string;
  ctx: Ctx;
}): Promise<ChildResult> {
  expect(fs.existsSync(MAIN_JS), "run `npm run build` first").toBe(true);
  const { home, cwd, configPath } = opts.ctx;
  const args = [MAIN_JS, "pack", "hook", opts.verb, ...(opts.extraArgs ?? [])];
  if (opts.manifest !== undefined && configPath !== undefined) {
    fs.writeFileSync(configPath, opts.manifest, "utf8");
    args.push("--config", configPath);
  }
  // The host's own session ids and runtime-reality knobs must not steer the
  // decision under test.
  const env = { ...process.env };
  delete env["CLAUDE_CODE_SESSION_ID"];
  delete env["CLAUDE_SESSION_ID"];
  delete env["CODEX_SESSION_ID"];
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUNTIME_REALITY_")) delete env[key];
  }
  env["HARNESS_HOME"] = home;
  env["HOME"] = home;
  env["UNDERSTANDING_GATE_REPORT_DIR"] = path.join(home, "reports");
  env["SOLUTION_VERDICT_DIR"] = path.join(home, "verdicts");

  await acquireSlot();
  try {
    const started = Date.now();
    const child = spawn(process.execPath, ["--require", READY_PRELOAD, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
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
    // A child that exits before reading stdin makes the write fail with EPIPE.
    child.stdin.on("error", () => undefined);
    let exited = false;
    let readSignalled = false;
    let written = 0;
    let writesBeforeExit = 0;
    let stdout = "";
    let stderr = "";
    // Resolves when the child starts reading stdin, or when it exits first
    // (a verb that never reads), and wakes a writer that is mid-wait.
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

function makeCtx(): Ctx {
  const home = tmpDir("harness-hook-stdin-home-");
  const cwd = tmpDir("harness-hook-stdin-repo-");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  addGitDirSkeleton(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(home, "verdicts"), { recursive: true });
  return { home, cwd, configPath: path.join(home, "harness.yaml") };
}

function expectBoundedExit(r: ChildResult): void {
  expect(r.hung, `pid ${r.pid} still running after ${KILL_AFTER_MS} ms; stderr: ${r.stderr}`).toBe(
    false,
  );
}

/** One PreToolUse gate verb: the pack its manifest enables and a gated event it would act on. */
interface Gate {
  verb: string;
  /** Test label when one verb runs in several forms (defaults to `verb`). */
  name?: string;
  /** Arguments after the verb (e.g. a runtime selector). */
  extraArgs?: string[];
  /** Pack enabled in the manifest handed to the child; null for a verb that takes no config. */
  pack: string | null;
  /** The block exit code: 0 with a stdout envelope, or 2 (codex stderr / runtime-reality deny). */
  blockExit: 0 | 2;
  /** Where the block reason is written. */
  reasonOn: "stdout" | "stderr";
  event: (ctx: Ctx) => string;
}

const GATES: Gate[] = [
  {
    verb: "pre-tool-use",
    pack: "understanding-before-execution",
    blockExit: 0,
    reasonOn: "stdout",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "Edit",
        tool_input: { file_path: path.join(ctx.cwd, "a.ts"), old_string: "a", new_string: "b" },
      }),
  },
  {
    verb: "codex-pre-tool-use",
    pack: "understanding-before-execution",
    blockExit: 2,
    reasonOn: "stderr",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      }),
  },
  {
    verb: "branch-protection",
    pack: "branch-protection",
    blockExit: 0,
    reasonOn: "stdout",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "Write",
        tool_input: { file_path: path.join(ctx.cwd, "a.txt"), content: "x" },
      }),
  },
  {
    // The Codex form of the same gate (task a4d8adc5): exit 2, reason on stderr.
    verb: "branch-protection",
    name: "branch-protection --runtime codex",
    extraArgs: ["--runtime", "codex"],
    pack: "branch-protection",
    blockExit: 2,
    reasonOn: "stderr",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "apply_patch",
        tool_input: { input: `*** Begin Patch\n*** Add File: ${path.join(ctx.cwd, "a.txt")}\n+x\n*** End Patch\n` },
      }),
  },
  {
    verb: "solution-acceptance",
    pack: "solution-acceptance",
    blockExit: 0,
    reasonOn: "stdout",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "mcp__agent-tasks__task_finish",
        tool_input: { taskId: "t1" },
      }),
  },
  {
    verb: "solution-acceptance-writeguard",
    pack: null,
    blockExit: 0,
    reasonOn: "stdout",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "Write",
        tool_input: { file_path: path.join(ctx.home, "verdicts", "t1.json"), content: "{}" },
      }),
  },
  {
    verb: "runtime-reality",
    pack: null,
    blockExit: 2,
    reasonOn: "stdout",
    event: (ctx) =>
      JSON.stringify({
        session_id: "stdin-bound-sess",
        cwd: ctx.cwd,
        tool_name: "Bash",
        tool_input: { command: "docker compose up -d" },
      }),
  },
];

function runGate(
  gate: Gate,
  steps: WriteStep[] | undefined,
  closeAfter: boolean,
  ctx: Ctx = makeCtx(),
): Promise<ChildResult> {
  return runHook({
    verb: gate.verb,
    ...(gate.extraArgs !== undefined ? { extraArgs: gate.extraArgs } : {}),
    ...(steps !== undefined ? { steps } : {}),
    closeAfter,
    ...(gate.pack !== null ? { manifest: manifestWithPack(gate.pack) } : {}),
    ctx,
  });
}

/**
 * The hook started reading, its timer fired, and it exited before the late
 * write was attempted: `sent` is how many scripted writes had been sent by then
 * (0 for a writer that stays silent past the bound, 1 for one that stalls
 * after the first half of the event).
 */
function expectExitedBeforeLateWrite(r: ChildResult, sent: number): void {
  expect(r.readSignalled, "the child never reported that it started reading stdin").toBe(true);
  expect(
    r.writesBeforeExit,
    `the child exited after ${r.writesBeforeExit} writes, expected ${sent} (the late write must not have been sent before the timer fired)`,
  ).toBe(sent);
}

/** The gate refused the tool call because of the timed-out read, in the gate's own block form. */
function expectTimeoutBlock(gate: Gate, r: ChildResult): void {
  expectBoundedExit(r);
  expect(r.code, `stdout: ${r.stdout}; stderr: ${r.stderr}`).toBe(gate.blockExit);
  const reasonText = gate.reasonOn === "stdout" ? r.stdout : r.stderr;
  expect(reasonText).toContain(BLOCK_REASON_HEAD);
  expect(reasonText).toContain(BOUND_TEXT);
  if (gate.reasonOn === "stdout") {
    expect(r.stdout).toContain('"permissionDecision":"deny"');
    if (gate.verb !== "runtime-reality") expect(r.stdout).toContain('"decision":"block"');
  } else {
    expect(r.stdout).toBe("");
  }
  // The bound is the 3000 ms default: the child waited about that long before refusing.
  expect(r.ms).toBeGreaterThanOrEqual(BOUND_MS - 500);
}

describe("pack hook stdin bound: every PreToolUse gate blocks on a timed-out read", () => {
  for (const gate of GATES) {
    it.concurrent(
      `${gate.name ?? gate.verb}: a never-closed empty stdin BLOCKS with a reason naming the stdin timeout and the bound`,
      async () => {
        expectTimeoutBlock(gate, await runGate(gate, undefined, false));
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${gate.name ?? gate.verb}: a complete gated event on a stdin that never closes BLOCKS (a timeout is not an allow)`,
      async () => {
        const ctx = makeCtx();
        const r = await runGate(gate, [{ afterMs: 0, data: gate.event(ctx) }], false, ctx);
        expectTimeoutBlock(gate, r);
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${gate.name ?? gate.verb}: a writer that waits past the bound, then writes the full gated event and closes, BLOCKS`,
      async () => {
        const ctx = makeCtx();
        const r = await runGate(gate, [{ afterMs: LATE_MS, data: gate.event(ctx) }], true, ctx);
        expectTimeoutBlock(gate, r);
        expectExitedBeforeLateWrite(r, 0);
      },
      TEST_TIMEOUT_MS,
    );

    it.concurrent(
      `${gate.name ?? gate.verb}: a writer that stalls past the bound mid-event, then finishes the event and closes, BLOCKS`,
      async () => {
        const ctx = makeCtx();
        const event = gate.event(ctx);
        const cut = Math.floor(event.length / 2);
        const r = await runGate(
          gate,
          [
            { afterMs: 0, data: event.slice(0, cut) },
            { afterMs: LATE_MS, data: event.slice(cut) },
          ],
          true,
          ctx,
        );
        expectTimeoutBlock(gate, r);
        expectExitedBeforeLateWrite(r, 1);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it("covers every PreToolUse gate verb the pack hook bootstrap reader serves, plus runtime-reality", () => {
    expect([...new Set(GATES.map((g) => g.verb))].sort()).toEqual(
      [
        "branch-protection",
        "codex-pre-tool-use",
        "pre-tool-use",
        "runtime-reality",
        "solution-acceptance",
        "solution-acceptance-writeguard",
      ].sort(),
    );
  });
});

describe("pack hook stdin bound: the operator pause still wins over the timeout block", () => {
  // branch-protection is not among them: it no longer yields to a pause
  // (task a4d8adc5), pinned in the describe block below.
  for (const gate of GATES.filter((g) => g.pack !== null && g.pack !== "branch-protection")) {
    it.concurrent(
      `${gate.verb}: with an active pause a never-closed empty stdin exits 0 without a block`,
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
        const r = await runGate(gate, undefined, false, ctx);
        expectBoundedExit(r);
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain("block");
        expect(r.stdout).not.toContain("deny");
        expect(r.stderr).not.toContain(BLOCK_REASON_HEAD);
        expect(r.stderr.toLowerCase()).toContain("paused");
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe("pack hook stdin bound: branch-protection does not yield to a pause", () => {
  for (const gate of GATES.filter((g) => g.pack === "branch-protection")) {
    it.concurrent(
      `${gate.name ?? gate.verb}: with an active pause a never-closed empty stdin still BLOCKS on the timeout`,
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
        const r = await runGate(gate, undefined, false, ctx);
        expectTimeoutBlock(gate, r);
        expect(r.stderr.toLowerCase()).not.toContain("paused");
        // The refusal names no operator override (the pause is not one here).
        expect(gate.reasonOn === "stdout" ? r.stdout : r.stderr).not.toMatch(/harness pause/);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

// The two gates that take no --config resolve the pause sentinel from the
// default generated dir, so the sentinel is written under both layouts the
// default home can resolve to.
describe("pack hook stdin bound: the pause wins over a timed-out read for the config-less gates", () => {
  for (const gate of GATES.filter((g) => g.pack === null)) {
    it.concurrent(
      `${gate.verb}: a complete event on a stdin that never closes is allowed while paused, and blocked once unpaused`,
      async () => {
        // Control: no pause, the same timed-out read is refused.
        const control = makeCtx();
        expectTimeoutBlock(
          gate,
          await runGate(gate, [{ afterMs: 0, data: gate.event(control) }], false, control),
        );

        const ctx = makeCtx();
        for (const generated of [
          path.join(ctx.home, GENERATED_DIRNAME),
          path.join(ctx.home, ".harness", GENERATED_DIRNAME),
        ]) {
          fs.mkdirSync(generated, { recursive: true });
          writeSentinel(generated, {
            pausedAt: new Date().toISOString(),
            expiresAt: null,
            reason: "stdin bound test",
            pausedBy: "test",
          });
        }
        const r = await runGate(gate, [{ afterMs: 0, data: gate.event(ctx) }], false, ctx);
        expectBoundedExit(r);
        expect(r.code, `stdout: ${r.stdout}; stderr: ${r.stderr}`).toBe(0);
        expect(r.stdout).not.toContain("block");
        expect(r.stdout).not.toContain("deny");
        expect(r.stderr).not.toContain(BLOCK_REASON_HEAD);
        expect(r.stderr.toLowerCase()).toContain("paused");
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe("pack hook stdin bound: every other hook verb treats a timeout as the bytes it read", () => {
  const verbs = [
    "post-tool-use",
    "track-active-claim",
    "stay-in-scope",
    "subagent-start",
    "subagent-stop",
    "codex-post-tool-use",
    "codex-stop",
    "codex-user-prompt-submit",
  ];
  for (const verb of verbs) {
    it.concurrent(
      `${verb} (not a PreToolUse gate) exits 0 within a bound, with the timeout note and no block`,
      async () => {
        const r = await runHook({ verb, ctx: makeCtx() });
        expectBoundedExit(r);
        expect(r.code).toBe(0);
        expect(r.stderr).toContain(TIMEOUT_NOTE);
        expect(r.stderr).toContain(BOUND_TEXT);
        expect(r.stderr).not.toContain(BLOCK_REASON_HEAD);
        expect(r.stdout).not.toContain("block");
      },
      TEST_TIMEOUT_MS,
    );
  }

  it.concurrent(
    "a non-gate hook decides a late writer's full event like the same bytes on a closed stdin (the timeout note, then exit 0)",
    async () => {
      const ctx = makeCtx();
      const r = await runHook({
        verb: "post-tool-use",
        steps: [
          {
            afterMs: LATE_MS,
            data: JSON.stringify({ session_id: "stdin-bound-sess", tool_name: "Bash" }),
          },
        ],
        closeAfter: true,
        manifest: manifestWithPack("understanding-before-execution"),
        ctx,
      });
      expectBoundedExit(r);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expectExitedBeforeLateWrite(r, 0);
    },
    TEST_TIMEOUT_MS,
  );
});
