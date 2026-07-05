// Integration tests for `runSmoke`. Each test injects a fake `claude`
// binary (a tiny Node script) and a stubbed `applyImpl`, so the only
// production code under test is the orchestration: argv-building, env
// passing, stream capture, parser hand-off, assertion evaluation,
// forensic-file invariants.

import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSmoke } from "../../../src/cli/smoke/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Poll (real time, no wall-clock budget) until `filePath` exists. Used to
 * synchronize with a child process's own readiness signal instead of
 * assuming it starts up within some fixed window, which is what made the
 * SIGKILL-escalation test flaky under CPU contention (see the comment at
 * its call site).
 */
async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Fake claude binary. The runner spawns it the same way it spawns the
 * real claude. The fake reads its instructions from env vars rather
 * than from argv, since the real claude accepts a different argv shape
 * and we want the runner's argv-building to flow unmodified into the
 * spawn().
 */
function makeFakeClaude(opts: {
  /** JSONL emitted on stdout. */
  stdout?: string;
  /** Free-form stderr text. */
  stderr?: string;
  /** Exit code. */
  exit?: number;
  /** Sleep N ms before emitting anything (to test timeouts). */
  sleepMs?: number;
}): string {
  const dir = makeTmpDir("harness-fake-claude-");
  const bin = path.join(dir, "claude");
  const stdoutJson = JSON.stringify(opts.stdout ?? "");
  const stderrJson = JSON.stringify(opts.stderr ?? "");
  const exit = typeof opts.exit === "number" ? opts.exit : 0;
  const sleep = typeof opts.sleepMs === "number" ? opts.sleepMs : 0;
  const script = `#!/usr/bin/env node
const STDOUT = ${stdoutJson};
const STDERR = ${stderrJson};
const SLEEP_MS = ${sleep};
const EXIT_CODE = ${exit};
setTimeout(() => {
  if (STDOUT) process.stdout.write(STDOUT);
  if (STDERR) process.stderr.write(STDERR);
  // Give Node a tick to flush the stdio buffers before exit so the
  // parent always observes the full payload.
  setImmediate(() => process.exit(EXIT_CODE));
}, SLEEP_MS);
`;
  fs.writeFileSync(bin, script, "utf8");
  fs.chmodSync(bin, 0o755);
  return bin;
}

/**
 * No-op apply stub so the integration tests don't need to write a
 * schema-valid manifest. Touches `target` so `runSmoke` finds the file.
 */
function stubApply(): NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]> {
  return (async (opts: { target?: string }) => {
    if (opts.target) {
      fs.mkdirSync(path.dirname(opts.target), { recursive: true });
      fs.writeFileSync(opts.target, '{"hooks":{}}', "utf8");
    }
    // The real ApplyResult shape is unused by runSmoke, but the
    // declared return type forces an object.
    return {
      manifestPath: "",
      generatedDir: "",
      files: [],
      warnings: [],
      restartHints: [],
      lockDrift: [],
      outcome: "no-changes" as const,
      written: false,
      dryRun: false,
      lockPath: "",
    } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]>>>;
  }) as NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]>;
}

const RESULT_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 5,
});
const RESULT_ERR = JSON.stringify({
  type: "result",
  subtype: "error",
  is_error: true,
  duration_ms: 5,
});
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-x",
  cwd: "/tmp",
});
const HOOK_STARTED = (id: string): string =>
  JSON.stringify({
    type: "system",
    subtype: "hook_started",
    hook_id: id,
    hook_name: "PreToolUse",
    hook_event: "PreToolUse",
  });
const HOOK_RESP = (id: string, stdout = ""): string =>
  JSON.stringify({
    type: "system",
    subtype: "hook_response",
    hook_id: id,
    hook_name: "PreToolUse",
    hook_event: "PreToolUse",
    output: "",
    stdout,
    stderr: "",
    exit_code: 0,
    outcome: "success",
  });

describe("runSmoke: happy path", () => {
  it("writes stream.jsonl + stderr.log + settings.json under output-dir on PASS", async () => {
    const outputDir = makeTmpDir("smoke-out-");
    const claude = makeFakeClaude({
      stdout: [INIT, HOOK_STARTED("h1"), HOOK_RESP("h1"), RESULT_OK].join("\n") + "\n",
      stderr: "fake claude noise\n",
    });

    const result = await runSmoke({
      prompt: "say hi",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      expectations: { expectHooks: ["PreToolUse"], expectExit: 0 },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
    expect(fs.existsSync(result.settingsPath)).toBe(true);
    expect(fs.existsSync(result.streamPath)).toBe(true);
    expect(fs.existsSync(result.stderrPath)).toBe(true);
    const onDiskStream = fs.readFileSync(result.streamPath, "utf8");
    expect(onDiskStream).toContain('"is_error":false');
    const onDiskStderr = fs.readFileSync(result.stderrPath, "utf8");
    expect(onDiskStderr).toContain("fake claude noise");
    expect(result.summary.hooks).toHaveLength(1);
    expect(result.claudeArgv).toContain("--include-hook-events");
    expect(result.claudeArgv).toContain("--permission-mode");
    expect(result.claudeArgv).toContain("bypassPermissions");
  });

  it("propagates --session-id into the spawned argv", async () => {
    const outputDir = makeTmpDir("smoke-sid-");
    const claude = makeFakeClaude({ stdout: `${RESULT_OK}\n` });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    const sidIdx = result.claudeArgv.indexOf("--session-id");
    expect(sidIdx).toBeGreaterThan(-1);
    expect(result.claudeArgv[sidIdx + 1]).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("runSmoke: expectation failures", () => {
  it("returns EX_FAIL with a per-assertion failure entry when expect-hook is unmet", async () => {
    const outputDir = makeTmpDir("smoke-fail-hook-");
    const claude = makeFakeClaude({ stdout: `${INIT}\n${RESULT_OK}\n` });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      expectations: { expectHooks: ["PreToolUse"] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe("expect-hook");
    expect(fs.existsSync(result.streamPath)).toBe(true);
  });

  it("returns EX_FAIL when expect-exit diverges from the captured is_error", async () => {
    const outputDir = makeTmpDir("smoke-fail-exit-");
    const claude = makeFakeClaude({ stdout: `${INIT}\n${RESULT_ERR}\n` });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      expectations: { expectExit: 0 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.failures[0]?.kind).toBe("expect-exit");
  });

  it("returns EX_FAIL for an unmet --expect-decision deny", async () => {
    const outputDir = makeTmpDir("smoke-fail-dec-");
    const stream = [INIT, HOOK_STARTED("h1"), HOOK_RESP("h1"), RESULT_OK].join("\n") + "\n";
    const claude = makeFakeClaude({ stdout: stream });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      expectations: { expectDecision: "deny" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.failures[0]?.kind).toBe("expect-decision");
  });

  it("PASSes --expect-decision deny when a hook stdout carries the PR #81 envelope", async () => {
    const outputDir = makeTmpDir("smoke-pass-deny-");
    const denyStdout = '{"decision":"block","hookSpecificOutput":{"permissionDecision":"deny"}}';
    const stream = [INIT, HOOK_STARTED("h1"), HOOK_RESP("h1", denyStdout), RESULT_OK].join("\n") + "\n";
    const claude = makeFakeClaude({ stdout: stream });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      expectations: { expectDecision: "deny" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
  });
});

describe("runSmoke: input validation", () => {
  it("EX_USAGE when --prompt is empty", async () => {
    await expect(
      runSmoke({
        prompt: "",
        outputDir: makeTmpDir("smoke-usage-"),
        applyImpl: stubApply(),
      }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });

  it("EX_UNAVAILABLE when claude binary is missing on PATH", async () => {
    const outputDir = makeTmpDir("smoke-no-claude-");
    await expect(
      runSmoke({
        prompt: "x",
        outputDir,
        applyImpl: stubApply(),
        claudeBin: "/no/such/path/definitely-not-claude",
      }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });

  it("EX_USAGE when --expect-decision is not allow|deny|warn", async () => {
    await expect(
      runSmoke({
        prompt: "x",
        outputDir: makeTmpDir("smoke-bad-dec-"),
        applyImpl: stubApply(),
        // Bypass the typed enum to simulate a bad CLI value.
        expectations: { expectDecision: "maybe" as unknown as "allow" },
      }),
    ).rejects.toBeInstanceOf(HarnessExitError);
  });
});

describe("runSmoke: timeout", () => {
  it("kills claude and reports timed-out failure when the budget is exceeded", async () => {
    const outputDir = makeTmpDir("smoke-timeout-");
    const claude = makeFakeClaude({
      stdout: `${RESULT_OK}\n`,
      sleepMs: 2000,
    });
    const start = Date.now();
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(result.claudeTimedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.failures[0]?.kind).toBe("expect-exit");
    // Should kill well before the fake's 2s sleep; allow generous slack for CI.
    expect(elapsed).toBeLessThan(1500);
  });

  it("escalates to SIGKILL when the child traps SIGTERM", async () => {
    const outputDir = makeTmpDir("smoke-sigkill-");
    // Fake claude that explicitly ignores SIGTERM and sleeps long enough
    // that the runner's 2s grace before SIGKILL is exercised end-to-end.
    const dir = makeTmpDir("fake-trap-claude-");
    const claudePath = path.join(dir, "claude");
    const readyPath = path.join(dir, "ready");
    fs.writeFileSync(
      claudePath,
      `#!/usr/bin/env node
process.on("SIGTERM", () => { /* swallow on purpose */ });
// Signal that the trap is installed (see the readiness handshake below)
// before doing anything else.
require("fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");
// Stay alive long past timeoutMs + SIGKILL grace so a missing SIGKILL
// would hang the run far past the wall-clock budget we assert on.
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    fs.chmodSync(claudePath, 0o755);

    // Root cause of the flake (agent-tasks/8bd005cd): the runner arms its
    // SIGTERM timer as soon as it spawns the child, but under CPU
    // contention Node's own startup (module load + event-loop spin-up)
    // can take longer than the runner's timeoutMs. When that happens the
    // SIGTERM lands before `process.on("SIGTERM", ...)` above has run, so
    // the untrapped default SIGTERM kills the child immediately and the
    // observed wall-clock collapses well under the 2s grace window
    // (observed: "expected 835 to be >= 2000"). That's a race between the
    // runner's timer and the child's own startup, not a real bug in the
    // escalation path.
    //
    // Close the race with an explicit handshake instead of hoping the
    // child starts up in time: spawn it ourselves with no deadline
    // pressure, wait (real time, no wall-clock budget) for it to confirm
    // the trap is installed, then hand the already-armed child to
    // runSmoke via the spawn-injection test seam. The runner's timeout
    // window only starts once SIGTERM is guaranteed to be swallowed, so
    // the only way the child can die is via the runner's own SIGKILL
    // escalation.
    const child = spawnChildProcess(claudePath, []) as ChildProcessWithoutNullStreams;
    cleanups.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });
    await waitForFile(readyPath, 10_000);

    const start = Date.now();
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claudePath,
      applyImpl: stubApply(),
      timeoutMs: 200,
      spawn: () => child,
    });
    const elapsed = Date.now() - start;
    expect(result.claudeTimedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    // 200ms budget + 2000ms grace + epsilon. With the trap-installation
    // race above closed, SIGTERM is deterministically swallowed, so this
    // bound can only be met via the runner's SIGKILL escalation: Node's
    // setTimeout never fires earlier than its delay, so 2000ms is a hard
    // floor once SIGTERM is a no-op. Upper bound at 7000ms (was 4500ms):
    // under CI load the wall-clock SIGKILL escalation was observed at
    // ~4756ms (agent-tasks/595ba01e, PR #208); 7000 keeps the
    // regression-detection floor (a real 6s+ cleanup bug still trips)
    // while leaving headroom for scheduler jitter.
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(7000);
    // Integration-style confirmation that the child is actually gone:
    // since SIGTERM is swallowed by design, the only way the OS process
    // can be dead here is that SIGKILL (which cannot be trapped) fired.
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});

describe("runSmoke: implicit failure on claude crash without terminal result", () => {
  it("returns EX_FAIL when claude exits non-zero with no result event, even without --expect-* flags", async () => {
    const outputDir = makeTmpDir("smoke-crash-");
    // Stream carries an init event but no terminal result; exit code !=0.
    const claude = makeFakeClaude({
      stdout: `${INIT}\n`,
      exit: 7,
    });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe("expect-exit");
    expect(result.failures[0]?.actual).toContain("exited 7");
  });

  it("stays green when claude exits non-zero BUT a terminal result event is present", async () => {
    // Some claude builds may exit non-zero after emitting a result event
    // (e.g. on a non-fatal post-result error). If the operator did not
    // pass --expect-exit, we honour the stream's verdict, not the OS
    // exit code, so we don't double-flag.
    const outputDir = makeTmpDir("smoke-nonzero-ok-");
    const claude = makeFakeClaude({
      stdout: `${INIT}\n${RESULT_OK}\n`,
      exit: 3,
    });
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
  });
});

describe("runSmoke: apply refusal", () => {
  it("returns EX_FAIL when apply reports a drift-refuse outcome", async () => {
    const outputDir = makeTmpDir("smoke-drift-");
    const claude = makeFakeClaude({ stdout: `${RESULT_OK}\n` });

    const refusingApply: NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]> = (async (
      opts: { target?: string },
    ) => {
      if (opts.target) {
        fs.mkdirSync(path.dirname(opts.target), { recursive: true });
        fs.writeFileSync(opts.target, '{"hooks":{}}', "utf8");
      }
      return {
        manifestPath: "",
        generatedDir: "",
        files: [],
        warnings: [],
        restartHints: [],
        lockDrift: [],
        outcome: "drift-refuse" as const,
        written: false,
        dryRun: false,
        lockPath: "",
      } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]>>>;
    }) as NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]>;

    await expect(
      runSmoke({
        prompt: "x",
        outputDir,
        claudeBin: claude,
        applyImpl: refusingApply,
      }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      message: expect.stringContaining("drift-refuse"),
    });
  });
});

describe("runSmoke: HARNESS_POLICY_VERBOSE injection", () => {
  it("sets HARNESS_POLICY_VERBOSE=1 in the spawned env so the warn diagnostic is observable", async () => {
    const outputDir = makeTmpDir("smoke-env-");
    // Fake that echoes its env to stderr so we can verify.
    const dir = makeTmpDir("fake-env-claude-");
    const claudePath = path.join(dir, "claude");
    fs.writeFileSync(
      claudePath,
      `#!/usr/bin/env node
process.stderr.write("HPV=" + (process.env.HARNESS_POLICY_VERBOSE || "(unset)") + "\\n");
process.stdout.write(${JSON.stringify(RESULT_OK)} + "\\n");
process.exit(0);
`,
      "utf8",
    );
    fs.chmodSync(claudePath, 0o755);
    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claudePath,
      applyImpl: stubApply(),
    });
    const stderr = fs.readFileSync(result.stderrPath, "utf8");
    expect(stderr).toContain("HPV=1");
  });
});
