// Tests for the slice-3 pre-spawn delegation the smoke runner now
// issues (ADR docs/decisions/2026-08-27-ug-auto-mode-approval.md, "TTL,
// cwd, and subagents": "The harness smoke runner ... is the natural
// first consumer", agent-tasks 37ad0b05 T-004, AC 1). A sibling of
// smoke.test.ts rather than an addition to it: this file owns the
// generatedDir/signing-key/parent-marker fixture plumbing the
// delegation needs, which the rest of smoke.test.ts's fixtures have no
// use for.

import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueDelegation } from "../../../src/cli/delegate/index.js";
import { runSmoke } from "../../../src/cli/smoke/index.js";
import {
  delegationMarkerPathFor,
  writeApprovalMarker,
} from "../../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { getOrCreateSigningKey } from "../../../src/runtime/approval-signing.js";

const CHILD = "22222222-2222-4222-8222-222222222222";
const PARENT = "parent-session-0001";

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

/** Minimal fake `claude` binary: emits a terminal result event and exits 0. */
function makeFakeClaude(): string {
  const dir = makeTmpDir("harness-fake-claude-delegate-");
  const bin = path.join(dir, "claude");
  const script = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1 })}\n`,
  )});
process.exit(0);
`;
  fs.writeFileSync(bin, script, "utf8");
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** No-op apply stub, same shape as smoke.test.ts's `stubApply`. */
function stubApply(): NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]> {
  return (async (opts: { target?: string }) => {
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
      outcome: "no-changes" as const,
      written: false,
      dryRun: false,
      lockPath: "",
    } as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]>>>;
  }) as NonNullable<Parameters<typeof runSmoke>[0]["applyImpl"]>;
}

// Env hygiene: a real $CLAUDE_CODE_SESSION_ID exported into the test
// runner's own shell would supply a parent session id that the
// injected `issueDelegationImpl` below deliberately overrides anyway,
// but clearing it keeps these fixtures from depending on that override
// working (same top-level pattern as tests/cli/delegate.test.ts).
let savedClaudeCode: string | undefined;
let savedClaude: string | undefined;
let savedCodex: string | undefined;
beforeEach(() => {
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});
afterEach(() => {
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
});

describe("runSmoke: slice-3 pre-spawn delegation", () => {
  it("the delegation file exists for the chosen session id before the spawn is invoked", async () => {
    const tmp = makeTmpDir("smoke-delegate-happy-");
    const generatedDir = path.join(tmp, "harness.generated");
    const childCwd = path.join(tmp, "child-cwd");
    fs.mkdirSync(childCwd, { recursive: true });
    getOrCreateSigningKey(generatedDir);
    writeApprovalMarker(generatedDir, PARENT, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
      reportContentHash: null,
    });

    const outputDir = makeTmpDir("smoke-delegate-happy-out-");
    const claude = makeFakeClaude();
    const lines: string[] = [];
    let delegationFilePresentAtSpawnTime: boolean | undefined;

    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      sessionId: CHILD,
      spawnCwd: childCwd,
      stdout: (s) => lines.push(s),
      issueDelegationImpl: ((opts: Parameters<typeof issueDelegation>[0]) =>
        issueDelegation({ ...opts, generatedDir, parentSessionId: PARENT })) as typeof issueDelegation,
      spawn: (command, args, options) => {
        // Captured synchronously, before the real spawn below hands
        // control back to the event loop: this is the "before the
        // spawn is invoked" instant the acceptance criterion asks for.
        delegationFilePresentAtSpawnTime = fs.existsSync(
          delegationMarkerPathFor(generatedDir, CHILD),
        );
        return spawnChildProcess(command, args, options) as ChildProcessWithoutNullStreams;
      },
    });

    expect(delegationFilePresentAtSpawnTime).toBe(true);
    expect(result.claudeExitCode).toBe(0);
    expect(lines.join("")).toMatch(
      new RegExp(`delegation: ✓ .*\\(child ${CHILD}, parent ${PARENT}, expires `),
    );
  });

  it("a refusal path still spawns and prints the skipped line", async () => {
    const tmp = makeTmpDir("smoke-delegate-refuse-");
    const generatedDir = path.join(tmp, "harness.generated");
    const childCwd = path.join(tmp, "child-cwd");
    fs.mkdirSync(childCwd, { recursive: true });
    getOrCreateSigningKey(generatedDir);
    // Deliberately no parent marker written: the delegation must refuse
    // with "parent-marker-missing".

    const outputDir = makeTmpDir("smoke-delegate-refuse-out-");
    const claude = makeFakeClaude();
    const lines: string[] = [];

    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      sessionId: CHILD,
      spawnCwd: childCwd,
      stdout: (s) => lines.push(s),
      issueDelegationImpl: ((opts: Parameters<typeof issueDelegation>[0]) =>
        issueDelegation({ ...opts, generatedDir, parentSessionId: PARENT })) as typeof issueDelegation,
    });

    // The spawn still happened and the run completed exactly as it
    // would have before slice 3: a claude process ran and the stream
    // was captured, refusal or not.
    expect(result.claudeExitCode).toBe(0);
    expect(fs.existsSync(result.streamPath)).toBe(true);
    expect(lines.join("")).toContain("delegation: skipped (parent-marker-missing:");
  });

  it("--no-delegate issues nothing", async () => {
    const outputDir = makeTmpDir("smoke-delegate-optout-out-");
    const claude = makeFakeClaude();
    const lines: string[] = [];
    const issueDelegationImpl = vi.fn(() => {
      throw new Error("issueDelegation must not be called when --no-delegate is set");
    }) as unknown as typeof issueDelegation;

    const result = await runSmoke({
      prompt: "x",
      outputDir,
      claudeBin: claude,
      applyImpl: stubApply(),
      sessionId: CHILD,
      noDelegate: true,
      stdout: (s) => lines.push(s),
      issueDelegationImpl,
    });

    expect(issueDelegationImpl).not.toHaveBeenCalled();
    expect(result.claudeExitCode).toBe(0);
    expect(lines.join("")).not.toContain("delegation:");
  });
});
