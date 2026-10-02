// The pack hook stdin readers are idle-bounded (task 7dfdcaaf). Claude Code
// pipes the event and closes stdin, so these tests only exercise the case the
// bound exists for: a real child process whose stdin is open and never closed.
// Each PreToolUse gate also pins what a timeout means for it: the same thing an
// empty or truncated event means on a closed stdin, so no gate turns a timeout
// into a weaker decision than its own unparseable-input posture, and a complete
// event that merely never closes is still decided on its content.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

const KILL_AFTER_MS = 15_000;
const TIMEOUT_NOTE = "stdin never closed";

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

interface ChildResult {
  code: number | null;
  hung: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  ms: number;
}

/**
 * Spawn the built CLI with an open stdin that is never ended. When `payload` is
 * given it is written once and stdin then stays open. The child is killed by pid
 * when it outlives the bound (the failure case) and again on cleanup, so no test
 * leaves a process behind.
 */
async function runHookWithOpenStdin(opts: {
  verb: string;
  payload?: string;
  manifest?: string;
  cwd?: string;
}): Promise<ChildResult> {
  expect(fs.existsSync(MAIN_JS), "run `npm run build` first").toBe(true);
  const home = tmpDir("harness-hook-stdin-home-");
  const cwd = opts.cwd ?? tmpDir("harness-hook-stdin-cwd-");
  const args = [MAIN_JS, "pack", "hook", opts.verb];
  if (opts.manifest !== undefined) {
    const configPath = path.join(home, "harness.yaml");
    fs.writeFileSync(configPath, opts.manifest, "utf8");
    args.push("--config", configPath);
  }
  // The host's own session ids must not steer the decision under test.
  const env = { ...process.env };
  delete env["CLAUDE_CODE_SESSION_ID"];
  delete env["CLAUDE_SESSION_ID"];
  delete env["CODEX_SESSION_ID"];
  env["HARNESS_HOME"] = home;
  env["HOME"] = home;
  env["UNDERSTANDING_GATE_REPORT_DIR"] = path.join(home, "reports");

  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
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
  if (opts.payload !== undefined) child.stdin.write(opts.payload);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString("utf8");
  });
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
  return { ...outcome, stdout, stderr, pid, ms: Date.now() - started };
}

function expectBoundedExit(r: ChildResult): void {
  expect(r.hung, `pid ${r.pid} still running after ${KILL_AFTER_MS} ms; stderr: ${r.stderr}`).toBe(
    false,
  );
  expect(r.code).toBe(0);
}

function makeProtectedRepo(): string {
  const repo = tmpDir("harness-hook-stdin-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  return repo;
}

const EDIT_EVENT = JSON.stringify({
  session_id: "stdin-bound-sess",
  tool_name: "Edit",
  tool_input: { file_path: "/some/file.ts", old_string: "a", new_string: "b" },
});

describe("pack hook stdin bound: PreToolUse gates with a never-closed stdin", () => {
  it.concurrent(
    "pre-tool-use (understanding gate): an empty timeout is the same ALLOW as unparseable input, with the timeout note",
    async () => {
      const r = await runHookWithOpenStdin({
        verb: "pre-tool-use",
        manifest: manifestWithPack("understanding-before-execution"),
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expect(r.stderr).toContain("no session_id resolvable");
      expect(r.stderr).toContain("allowing");
      expect(r.stdout).toBe("");
    },
    25_000,
  );

  it.concurrent(
    "pre-tool-use: a complete event on a stdin that never closes is still gated on its content (no approval marker, so BLOCK)",
    async () => {
      const r = await runHookWithOpenStdin({
        verb: "pre-tool-use",
        manifest: manifestWithPack("understanding-before-execution"),
        payload: EDIT_EVENT,
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain("using the");
      expect(r.stderr).toContain("bytes read");
      expect(r.stdout).toContain('"decision":"block"');
    },
    25_000,
  );

  it.concurrent(
    "codex-pre-tool-use: an empty timeout is the same ALLOW as unparseable input, with the timeout note",
    async () => {
      const r = await runHookWithOpenStdin({
        verb: "codex-pre-tool-use",
        manifest: manifestWithPack("understanding-before-execution"),
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expect(r.stderr).toContain("no session_id resolvable");
      expect(r.stdout).toBe("");
    },
    25_000,
  );

  it.concurrent(
    "branch-protection: an empty timeout on a protected branch stays BLOCK (fail closed)",
    async () => {
      const r = await runHookWithOpenStdin({
        verb: "branch-protection",
        manifest: manifestWithPack("branch-protection"),
        cwd: makeProtectedRepo(),
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expect(r.stderr).toContain("BLOCK");
      expect(r.stdout).toContain('"decision":"block"');
    },
    25_000,
  );

  it.concurrent(
    "branch-protection: a complete Write event on a stdin that never closes is decided on its content (BLOCK on the protected branch)",
    async () => {
      const repo = makeProtectedRepo();
      const r = await runHookWithOpenStdin({
        verb: "branch-protection",
        manifest: manifestWithPack("branch-protection"),
        cwd: repo,
        payload: JSON.stringify({
          session_id: "stdin-bound-sess",
          tool_name: "Write",
          tool_input: { file_path: path.join(repo, "a.txt"), content: "x" },
        }),
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain("bytes read");
      expect(r.stdout).toContain('"decision":"block"');
      // The session id from the partial read reached the decision, not the
      // "no session_id resolvable" path of an empty event.
      expect(r.stderr).not.toContain("no session_id resolvable");
    },
    25_000,
  );

  it.concurrent(
    "solution-acceptance: an empty timeout is the same ALLOW as unparseable input (not a completion action)",
    async () => {
      const r = await runHookWithOpenStdin({
        verb: "solution-acceptance",
        manifest: manifestWithPack("solution-acceptance"),
        cwd: makeProtectedRepo(),
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expect(r.stderr).toContain("is not a gated completion action");
      expect(r.stdout).toBe("");
    },
    25_000,
  );

  it.concurrent(
    "solution-acceptance: a complete completion-action event on a stdin that never closes is still refused",
    async () => {
      const r = await runHookWithOpenStdin({
        verb: "solution-acceptance",
        manifest: manifestWithPack("solution-acceptance"),
        cwd: makeProtectedRepo(),
        payload: JSON.stringify({
          session_id: "stdin-bound-sess",
          tool_name: "mcp__agent-tasks__task_finish",
          tool_input: { taskId: "t1" },
        }),
      });
      expectBoundedExit(r);
      expect(r.stderr).toContain("bytes read");
      expect(r.stdout).toContain('"decision":"block"');
    },
    25_000,
  );

  it.concurrent(
    "solution-acceptance-writeguard: an empty timeout is the same ALLOW as unparseable input (not a guarded surface)",
    async () => {
      const r = await runHookWithOpenStdin({ verb: "solution-acceptance-writeguard" });
      expectBoundedExit(r);
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expect(r.stderr).toContain("is not a guarded write surface");
      expect(r.stdout).toBe("");
    },
    25_000,
  );

  it.concurrent(
    "runtime-reality (fail open by design): an empty timeout is an ALLOW with no output and the timeout note",
    async () => {
      const r = await runHookWithOpenStdin({ verb: "runtime-reality" });
      expectBoundedExit(r);
      expect(r.stderr).toContain("harness pack hook runtime-reality:");
      expect(r.stderr).toContain(TIMEOUT_NOTE);
      expect(r.stdout).toBe("");
    },
    25_000,
  );
});

describe("pack hook stdin bound: every other bootstrap-reader hook exits instead of hanging", () => {
  const verbs = [
    "post-tool-use",
    "post-merge-gate",
    "post-merge-gate-record",
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
      `${verb} exits 0 within a bound with the timeout note`,
      async () => {
        const r = await runHookWithOpenStdin({ verb });
        expectBoundedExit(r);
        expect(r.stderr).toContain(TIMEOUT_NOTE);
      },
      25_000,
    );
  }
});
