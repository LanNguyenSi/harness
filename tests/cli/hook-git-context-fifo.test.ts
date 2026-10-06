// A FIFO planted at a git file the hooks resolve the repository context from
// (`.git/refs/heads/<branch>`, `.git/HEAD`) used to block `resolveGitContext`
// until the runtime's hook budget ran out, which the runtime treats as an
// allow (task 323bd5b9). These tests drive the BUILT CLI, one child process
// per case under a SIGKILL timeout, through every hook that resolves the
// git context: the three pack hooks that gate on it and `harness policy
// intercept`, the PreToolUse entrypoint both the Claude and the Codex
// adapters install.
//
// Needs dist/ (`npm run build` before `vitest`).

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");
const BOUND_MS = 15_000;
const SHA = "a".repeat(40);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-git-fifo-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(branch: string): string {
  const repo = path.join(tmp, "repo");
  const gitDir = path.join(repo, ".git");
  fs.mkdirSync(path.join(gitDir, "refs", "heads", path.dirname(branch)), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(gitDir, "refs", "heads", branch), `${SHA}\n`);
  return repo;
}

function fifoOver(file: string, opts: { directory?: boolean } = {}): void {
  fs.rmSync(file, { recursive: opts.directory === true });
  execFileSync("mkfifo", [file]);
}

function manifestWithPack(pack: string): string {
  const cfg = path.join(tmp, "harness.yaml");
  fs.writeFileSync(
    cfg,
    `version: 1
policy_packs:
  - name: ${pack}
    enabled: true
hooks: []
policies: []
tools:
  builtin:
    known: [Bash, Edit, Write]
`,
    "utf8",
  );
  return cfg;
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

function runCli(args: string[], payload: unknown, env: Record<string, string> = {}): HookRun {
  const childEnv = { ...process.env };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID", "SOLUTION_VERDICT_ID"]) {
    delete childEnv[k];
  }
  childEnv["HARNESS_HOME"] = path.join(tmp, "home");
  Object.assign(childEnv, env);
  const started = Date.now();
  const result = spawnSync("node", [MAIN_JS, ...args], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: BOUND_MS,
    killSignal: "SIGKILL",
    env: childEnv,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    ms: Date.now() - started,
  };
}

function expectBounded(run: HookRun): void {
  expect(run.timedOut).toBe(false);
  expect(run.ms).toBeLessThan(BOUND_MS);
}

describe.skipIf(process.platform === "win32")("pack hook branch-protection: a planted FIFO cannot switch the gate off", () => {
  const writeEvent = (repo: string): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "Write",
    cwd: repo,
    tool_input: { file_path: path.join(repo, "src.txt"), content: "x" },
  });
  const run = (cfg: string, repo: string): HookRun =>
    runCli(["pack", "hook", "branch-protection", "--config", cfg], writeEvent(repo));

  it("control: a regular repository on a non-protected branch allows", () => {
    const repo = makeRepo("feat/x");
    const out = run(manifestWithPack("branch-protection"), repo);
    expectBounded(out);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/is not in the protected list .*; allowing/);
  });

  it("a FIFO at HEAD BLOCKS within the bound (not read as 'outside a work tree, allow')", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "HEAD"));
    const out = run(manifestWithPack("branch-protection"), repo);
    expectBounded(out);
    expect(out.status).toBe(0);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/could not read the git metadata/);
    expect(envelope.reason).toMatch(/HEAD is present but not a regular file/);
  });

  it("a FIFO at the loose ref of a non-protected branch still allows, within the bound (the branch is known)", () => {
    const repo = makeRepo("feat/x");
    fifoOver(path.join(repo, ".git", "refs", "heads", "feat", "x"));
    const out = run(manifestWithPack("branch-protection"), repo);
    expectBounded(out);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/is not in the protected list .*; allowing/);
  });

  it("a FIFO at the loose ref of a protected branch is gated as that branch (blocked by the gate, not hung)", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const out = run(manifestWithPack("branch-protection"), repo);
    expectBounded(out);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/protected branch "main"/);
  });
});

describe.skipIf(process.platform === "win32")("pack hook branch-protection: a node planted at `.git` itself", () => {
  const writeEvent = (cwd: string, file: string): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "Write",
    cwd,
    tool_input: { file_path: file, content: "x" },
  });
  const run = (cfg: string, cwd: string, file: string): HookRun =>
    runCli(["pack", "hook", "branch-protection", "--config", cfg], writeEvent(cwd, file));

  it("a FIFO at `.git` BLOCKS within the bound, naming `.git` (not 'outside a work tree, allow')", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git"), { directory: true });
    const out = run(manifestWithPack("branch-protection"), repo, path.join(repo, "src.txt"));
    expectBounded(out);
    expect(out.status).toBe(0);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/could not read the git metadata/);
    expect(envelope.reason).toMatch(/\.git is present but not a regular file/);
  });

  it("a FIFO at the `.git` pointer file of a linked worktree nested in an outer checkout BLOCKS, it does not resolve the OUTER repository's branch", () => {
    // The outer checkout is on a non-protected branch, so reading the
    // enclosing repository would have allowed the write; the nested linked
    // worktree's `.git` FIFO must stop the lookup at the nested root.
    const outer = makeRepo("feat/outer");
    const nested = path.join(outer, "nested-worktree");
    fs.mkdirSync(nested, { recursive: true });
    execFileSync("mkfifo", [path.join(nested, ".git")]);
    const out = run(manifestWithPack("branch-protection"), nested, path.join(nested, "src.txt"));
    expectBounded(out);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/\.git is present but not a regular file/);
    expect(out.stderr).not.toMatch(/feat\/outer/);
  });

  it("control: the same nested directory with a MISSING `.git` still resolves the outer repository (allowed on its non-protected branch)", () => {
    const outer = makeRepo("feat/outer");
    const nested = path.join(outer, "nested-worktree");
    fs.mkdirSync(nested, { recursive: true });
    const out = run(manifestWithPack("branch-protection"), nested, path.join(nested, "src.txt"));
    expectBounded(out);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/"feat\/outer" is not in the protected list .*; allowing/);
  });
});

describe.skipIf(process.platform === "win32")("pack hook branch-protection: Codex-shaped events with a planted FIFO", () => {
  // The Codex adapter feeds the same blocker an `apply_patch` event whose
  // target path sits in the patch text, not in a `file_path` field.
  const patchEvent = (repo: string): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "apply_patch",
    cwd: repo,
    tool_input: {
      input: `*** Begin Patch\n*** Add File: ${path.join(repo, "src.txt")}\n+x\n*** End Patch\n`,
    },
  });
  const run = (cfg: string, repo: string): HookRun =>
    runCli(["pack", "hook", "branch-protection", "--config", cfg], patchEvent(repo));
  const manifest = (): string => {
    const cfg = manifestWithPack("branch-protection");
    fs.writeFileSync(
      cfg,
      fs.readFileSync(cfg, "utf8").replace("known: [Bash, Edit, Write]", "known: [Bash, Edit, Write, apply_patch]"),
      "utf8",
    );
    return cfg;
  };

  it("apply_patch with a FIFO at HEAD BLOCKS within the bound, naming HEAD", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "HEAD"));
    const out = run(manifest(), repo);
    expectBounded(out);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/HEAD is present but not a regular file/);
  });

  it("apply_patch with a FIFO at the loose ref of a protected branch is gated as that branch within the bound", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const out = run(manifest(), repo);
    expectBounded(out);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/protected branch "main"/);
  });
});

describe.skipIf(process.platform === "win32")("pack hook post-merge-gate: a planted FIFO is bounded and named in the diagnostic", () => {
  const commitEvent = (repo: string): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "Bash",
    cwd: repo,
    tool_input: { command: "git commit -m x" },
  });

  it("a FIFO at the loose ref returns within the bound, allows (this gate fails open by design) and names the refused file", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const out = runCli(["pack", "hook", "post-merge-gate", "--config", manifestWithPack("post-merge-gate")], commitEvent(repo));
    expectBounded(out);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/cannot resolve git context .*\[git file refused[^\]]*refs\/heads\/main\]; allowing/);
  });
});

describe.skipIf(process.platform === "win32")("pack hook solution-acceptance: a planted FIFO at the loose ref still denies, within the bound", () => {
  it("returns a deny envelope instead of hanging", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const out = runCli(
      ["pack", "hook", "solution-acceptance", "--config", manifestWithPack("solution-acceptance")],
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-fifo",
        tool_name: "Bash",
        cwd: repo,
        tool_input: { command: "git push origin main" },
      },
      { SOLUTION_VERDICT_ID: "task-fifo", SOLUTION_VERDICT_DIR: path.join(tmp, "verdicts") },
    );
    expectBounded(out);
    const envelope = JSON.parse(out.stdout) as { decision: string };
    expect(envelope.decision).toBe("block");
  });
});

describe.skipIf(process.platform === "win32")("policy intercept (the Claude and Codex PreToolUse entrypoint): a planted FIFO is bounded", () => {
  const MANIFEST = `version: 1
tools:
  builtin:
    known: [Read, Edit, Write, Bash]
hooks: []
policies: []
`;
  it("a FIFO at the loose ref does not hold the hook past the bound", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const cfg = path.join(tmp, "harness.yaml");
    fs.writeFileSync(cfg, MANIFEST, "utf8");
    const out = runCli(["policy", "intercept", "--config", cfg], {
      hook_event_name: "PreToolUse",
      session_id: "sess-fifo",
      tool_name: "Read",
      cwd: repo,
      tool_input: { file_path: path.join(repo, "x") },
    });
    expectBounded(out);
    expect(out.status).toBe(0);
  });

  // Codex's shell tool is an alias of Bash for the policy matcher; its event
  // carries the command in `raw_input`.
  const codexShellEvent = (repo: string): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "shell",
    cwd: repo,
    raw_input: { command: "git status" },
  });
  const runCodexShell = (repo: string): HookRun => {
    const cfg = path.join(tmp, "harness.yaml");
    fs.writeFileSync(cfg, MANIFEST, "utf8");
    return runCli(["policy", "intercept", "--config", cfg], codexShellEvent(repo));
  };

  it("a Codex shell event with a FIFO at the loose ref does not hold the hook past the bound", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const out = runCodexShell(repo);
    expectBounded(out);
    expect(out.status).toBe(0);
  });

  // No-regression control: this passes on the pre-change code too, because a
  // non-regular HEAD was rejected on stat before any read. It pins that the
  // intercept path never opens a non-regular HEAD; the loose-ref case above is
  // the discriminating one.
  it("a Codex shell event with a FIFO at HEAD does not hold the hook past the bound", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "HEAD"));
    const out = runCodexShell(repo);
    expectBounded(out);
    expect(out.status).toBe(0);
  });
});
