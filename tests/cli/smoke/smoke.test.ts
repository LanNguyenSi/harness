// Integration tests for `runSmoke`. Each test injects a fake `claude`
// binary (a tiny Node script) and a stubbed `applyImpl`, so the only
// production code under test is the orchestration: argv-building, env
// passing, stream capture, parser hand-off, assertion evaluation,
// forensic-file invariants.

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
