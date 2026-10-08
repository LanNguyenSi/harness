// Pair-test: `harness pause` writes a sentinel, the PreToolUse hook
// reads it on its next fire and allows without evaluating, `harness
// resume` deletes it, and the next hook fire evaluates normally.
//
// This is the acceptance test the task description calls out: "Integration
// test pairs pause + bash-event-through-hook + resume + bash-event-through-
// hook for at least one of the standard PreToolUse hooks."

import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pause, resume } from "../../src/cli/pause/index.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import { sentinelPath } from "../../src/runtime/pause-sentinel.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";
import { makeManifest, makePolicy } from "../_helpers/manifest.js";

let tmp: string;
let generatedDir: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedCodex: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pause-hook-int-"));
  generatedDir = path.join(tmp, "harness.generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  // Mirror tests/cli/pause.test.ts: clear all three agent-session env
  // vars so the dev host's $CLAUDE_CODE_SESSION_ID doesn't make pause
  // refuse to run when only claudeSessionIdEnv is overridden.
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
});

function manifestWithPack(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
  });
}

function manifestWithBranchProtection(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      { name: "branch-protection", enabled: true, config: { branches: ["master"] } },
    ],
  });
}

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

const editEvent = JSON.stringify({
  session_id: "sess-int",
  tool_name: "Edit",
  tool_input: { file_path: "/tmp/x" },
});

describe("pause → hook fire → resume → hook fire (understanding-before-execution)", () => {
  it("hook allows + emits notice while paused; evaluates normally after resume", async () => {
    // Step 1: pause. Use real time (no `now` injection) so the sentinel
    // is genuinely in-window when the hook fires below — hooks read their
    // own clock and would otherwise see a stale pause.
    await pause({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "10m",
      reason: "integration test",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(true);

    // Step 2: hook fires while paused. Should allow + emit a notice
    // without consulting the ledger (we'd see calls if it did).
    const stdoutA = bufferStream();
    const stderrA = bufferStream();
    let ledgerWasQueriedA = false;
    const resA = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(editEvent),
      stdout: stdoutA.stream,
      stderr: stderrA.stream,
      generatedDir,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => {
        ledgerWasQueriedA = true;
        return [];
      },
    });
    expect(resA.exitCode).toBe(0);
    expect(resA.blocked).toBe(false);
    expect(ledgerWasQueriedA).toBe(false);
    expect(stderrA.read()).toContain("PAUSED");
    expect(stderrA.read()).toContain("integration test");

    // Step 3: resume.
    await resume({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(false);

    // Step 4: hook fires after resume. Should now evaluate normally and
    // block on a missing approval (no marker, no report, no ledger entry).
    const stdoutB = bufferStream();
    const stderrB = bufferStream();
    let ledgerWasQueriedB = false;
    const resB = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(editEvent),
      stdout: stdoutB.stream,
      stderr: stderrB.stream,
      generatedDir,
      reportsDir: path.join(tmp, "no-reports"),
      ledgerQuery: async (): Promise<LedgerEntry[]> => {
        ledgerWasQueriedB = true;
        return [];
      },
    });
    // Post-resume the hook went through its normal evaluation path: it
    // consulted the ledger (audit probe) and emitted a block envelope on
    // stdout because no approval source was satisfied.
    expect(ledgerWasQueriedB).toBe(true);
    expect(resB.exitCode).toBe(0);
    expect(resB.blocked).toBe(true);
    expect(stdoutB.read()).toContain('"decision":"block"');
  });

  it("auto-expires past the --for window: hook on next fire blocks normally", async () => {
    // Deterministic clock. The previous version paused with a 1s `--for`
    // window and bridged it to the hook fire with a real `setTimeout`
    // (~1100ms) before asserting expiry. `pause()` writes `expiresAt` off
    // the wall clock and the hook checks expiry against the wall clock,
    // but `setTimeout` counts monotonic time — on a host whose wall clock
    // drifts relative to the monotonic timer (WSL2, a loaded CI runner),
    // the ~100ms margin could read the sentinel as still active and the
    // hook would short-circuit to allow, flaking `res.blocked`. Injecting
    // `now` into both `pause()` and the hook removes the wall-clock
    // dependency entirely: no real sleep, no race.
    const pausedAt = new Date("2026-05-20T12:00:00.000Z");
    await pause({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "1s",
      now: pausedAt,
      ledgerAdd: async () => ({ ok: true }),
    });

    // Fire the hook 5s past the 1s window — unambiguously expired.
    const afterExpiry = new Date(pausedAt.getTime() + 5000);
    const stdout = bufferStream();
    const stderr = bufferStream();
    const res = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(editEvent),
      stdout: stdout.stream,
      stderr: stderr.stream,
      generatedDir,
      reportsDir: path.join(tmp, "no-reports"),
      now: afterExpiry,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });

    expect(res.blocked).toBe(true);
    // The expired sentinel got auto-deleted on the hook fire.
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(false);
  });
});

describe("pause → policy intercept hook → resume", () => {
  // A policy that blocks an agent-tasks PR merge unless a matching
  // `review:${PR_NUMBER}` ledger entry exists. With an empty ledger it
  // always blocks, so it is a clean probe for "did the gate evaluate?".
  const blockingPolicy = makePolicy({
    name: "review-before-merge",
    description: "block merges without review evidence",
    trigger: {
      event: "PreToolUse",
      match: "mcp__agent-tasks__pull_requests_merge",
      extract: { PR_NUMBER: "toolArgs.prNumber" },
    },
    requires: { ledger_tag: "review:${PR_NUMBER}" },
    hook: "h",
    enforcement: "block",
  });

  const mergeEvent = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__agent-tasks__pull_requests_merge",
    tool_input: { prNumber: 42 },
    session_id: "sess-int",
  });

  it("policy intercept yields while paused, re-engages after resume", async () => {
    await pause({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "10m",
      reason: "wedged preflight gate",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(true);

    // While paused: the gate must short-circuit BEFORE evaluating, so the
    // injected ledger is never consulted and nothing is written to stdout.
    let ledgerQueriedWhilePaused = false;
    const pausedLedger: LedgerClient = {
      async query() {
        ledgerQueriedWhilePaused = true;
        return { kind: "ok", entries: [] };
      },
      async record() {
        /* no-op */
      },
    };
    const stdoutA = bufferStream();
    const stderrA = bufferStream();
    const resA = await runInterceptCli({
      stdin: readableFromString(mergeEvent),
      stdout: stdoutA.stream,
      stderr: stderrA.stream,
      manifest: makeManifest({ policies: [blockingPolicy] }),
      ledger: pausedLedger,
      generatedDir,
    });
    expect(resA.blocked).toBe(false);
    expect(resA.exitCode).toBe(0);
    expect(ledgerQueriedWhilePaused).toBe(false);
    expect(stdoutA.read()).toBe("");
    // The notice carries the policy-intercept hook label, the one value
    // that diverges from the reference pack hook.
    expect(stderrA.read()).toContain("policy intercept: PAUSED");
    expect(stderrA.read()).toContain("wedged preflight gate");

    // Resume.
    await resume({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(false);

    // After resume: the gate evaluates normally, consults the ledger, and
    // blocks the merge because no review evidence exists.
    let ledgerQueriedAfterResume = false;
    const liveLedger: LedgerClient = {
      async query() {
        ledgerQueriedAfterResume = true;
        return { kind: "ok", entries: [] };
      },
      async record() {
        /* no-op */
      },
    };
    const stdoutB = bufferStream();
    const stderrB = bufferStream();
    const resB = await runInterceptCli({
      stdin: readableFromString(mergeEvent),
      stdout: stdoutB.stream,
      stderr: stderrB.stream,
      manifest: makeManifest({ policies: [blockingPolicy] }),
      ledger: liveLedger,
      generatedDir,
    });
    expect(ledgerQueriedAfterResume).toBe(true);
    expect(resB.blocked).toBe(true);
    expect(resB.exitCode).toBe(0);
    expect(stdoutB.read()).toContain('"decision":"block"');
  });

  it("honours an injected pause time even when the real clock sees an expired sentinel", async () => {
    const realNow = Date.now();
    const pausedAt = new Date(realNow - 24 * 60 * 60 * 1000);
    const duringPause = new Date(pausedAt.getTime() + 5 * 60 * 1000);
    await pause({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "10m",
      now: pausedAt,
      reason: "injected clock pause",
      ledgerAdd: async () => ({ ok: true }),
    });
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath(generatedDir), "utf8"));
    expect(Date.parse(sentinel.expiresAt)).toBeGreaterThan(duringPause.getTime());
    expect(Date.parse(sentinel.expiresAt)).toBeLessThan(realNow);

    let ledgerQueried = false;
    const stdout = bufferStream();
    const stderr = bufferStream();
    const res = await runInterceptCli({
      stdin: readableFromString(mergeEvent),
      stdout: stdout.stream,
      stderr: stderr.stream,
      manifest: makeManifest({ policies: [blockingPolicy] }),
      ledger: {
        async query() {
          ledgerQueried = true;
          return { kind: "ok", entries: [] };
        },
        async record() {
          /* no-op */
        },
      },
      generatedDir,
      now: duringPause,
    });

    expect(res.exitCode).toBe(0);
    expect(res.blocked).toBe(false);
    expect(res.decisions).toEqual([]);
    expect(ledgerQueried).toBe(false);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("policy intercept: PAUSED");
    expect(stderr.read()).toContain("injected clock pause");
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(true);
  });

  it("auto-expires past the --for window: policy intercept evaluates normally", async () => {
    const pausedAt = new Date("2026-05-20T12:00:00.000Z");
    await pause({
      manifest: manifestWithPack(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "1s",
      now: pausedAt,
      ledgerAdd: async () => ({ ok: true }),
    });

    // Fire 5s past the 1s window — unambiguously expired.
    const afterExpiry = new Date(pausedAt.getTime() + 5000);
    const stdout = bufferStream();
    const stderr = bufferStream();
    const res = await runInterceptCli({
      stdin: readableFromString(mergeEvent),
      stdout: stdout.stream,
      stderr: stderr.stream,
      manifest: makeManifest({ policies: [blockingPolicy] }),
      ledger: {
        async query() {
          return { kind: "ok", entries: [] };
        },
        async record() {
          /* no-op */
        },
      },
      generatedDir,
      now: afterExpiry,
    });

    expect(res.blocked).toBe(true);
    expect(stdout.read()).toContain('"decision":"block"');
    // The expired sentinel got auto-deleted on the hook fire.
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(false);
  });
});

describe("pause → branch-protection hook", () => {
  // branch-protection no longer yields to the operator pause (task
  // a4d8adc5): the kept gate is switched off from an operator shell with
  // `harness gate disable`, never by a sentinel the hook reads.
  it("does not yield to an active pause: a Write on a protected branch is still refused", async () => {
    await pause({
      manifest: manifestWithBranchProtection(),
      generatedDir,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "10m",
      reason: "incident hotfix",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(generatedDir))).toBe(true);

    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    const gitEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(gitEnv)) if (k.startsWith("GIT_")) delete gitEnv[k];
    Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    execFileSync("git", ["-c", "init.defaultBranch=master", "init", "-q"], { cwd: repo, env: gitEnv, stdio: "ignore" });

    const stdoutA = bufferStream();
    const stderrA = bufferStream();
    const writeEvent = JSON.stringify({
      session_id: "sess-int",
      tool_name: "Write",
      tool_input: { file_path: path.join(repo, "writeme.txt") },
      cwd: repo,
    });
    const resA = await runPackHookBranchProtectionCli({
      manifest: manifestWithBranchProtection(),
      stdin: readableFromString(writeEvent),
      stdout: stdoutA.stream,
      stderr: stderrA.stream,
      configPath: path.join(tmp, "harness.yaml"),
    });
    expect(resA.exitCode).toBe(0);
    expect(resA.blocked).toBe(true);
    expect(stdoutA.read()).toContain('"decision":"block"');
    expect(stderrA.read()).not.toContain("PAUSED");
  });
});
