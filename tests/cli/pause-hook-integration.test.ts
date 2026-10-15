// Integration test: `harness pause` writes a sentinel and the kept
// branch-protection PreToolUse hook does not read it.

import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pause } from "../../src/cli/pause/index.js";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import { sentinelPath } from "../../src/runtime/pause-sentinel.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

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
    policy_packs: [{ name: "branch-protection", enabled: true }],
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
