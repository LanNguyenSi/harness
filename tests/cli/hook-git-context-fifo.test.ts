// A FIFO planted at a git file the hooks resolve the repository context from
// (`.git/refs/heads/<branch>`, `.git/HEAD`) used to block `resolveGitContext`
// until the runtime's hook budget ran out, which the runtime treats as an
// allow (task 323bd5b9). These tests drive the BUILT CLI, one child process
// per case under a SIGKILL timeout, through every hook that reads the
// branch: the two pack hooks that still resolve the git context and `harness
// policy intercept`, the PreToolUse entrypoint both the Claude and the Codex
// adapters install, plus branch-protection, which asks git itself (task
// a4d8adc5) and so meets the FIFO through git.
//
// Needs dist/ (`npm run build` before `vitest`).

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addGitDirSkeleton } from "../_helpers/git-dir-fixture.js";

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
  addGitDirSkeleton(gitDir);
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

// branch-protection asks git for the branch (task a4d8adc5). A git file that
// never answers (a FIFO at HEAD) holds git, not the hook: the hook's own
// bound kills git and refuses, well inside the pack's 5000 ms hook budget,
// instead of hanging until the runtime gives up and reads that as an allow.
const BP_BUDGET_MS = 5000;

function plainGitHead(cwd: string): { status: number | null; stdout: string } {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const r = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd, env, encoding: "utf8", timeout: BOUND_MS });
  return { status: r.status, stdout: r.stdout ?? "" };
}

describe.skipIf(process.platform === "win32")("pack hook branch-protection: a git file that never answers ends in a refusal within the bound", { timeout: 30_000 }, () => {
  const writeEvent = (repo: string): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "Write",
    cwd: repo,
    tool_input: { file_path: path.join(repo, "src.txt"), content: "x" },
  });
  const run = (cfg: string, repo: string): HookRun =>
    runCli(["pack", "hook", "branch-protection", "--config", cfg], writeEvent(repo));
  const expectWithinBudget = (out: HookRun): void => {
    expectBounded(out);
    expect(out.ms).toBeLessThan(BP_BUDGET_MS);
  };

  it("control: a regular repository on a non-protected branch allows", () => {
    const repo = makeRepo("feat/x");
    const out = run(manifestWithPack("branch-protection"), repo);
    expectWithinBudget(out);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/branch "feat\/x" is not in the protected list .*; allowing/);
  });

  it("a FIFO at HEAD refuses within the bound, naming the timeout (not read as an allow)", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "HEAD"));
    const out = run(manifestWithPack("branch-protection"), repo);
    expectWithinBudget(out);
    expect(out.status).toBe(0);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    // The hook names the directory as the operating system resolves it (the
    // temp directory may sit behind a symlink, /var on macOS).
    expect(envelope.reason).toBe(
      `branch-protection: refusing Write: git could not report the branch of ${fs.realpathSync.native(repo)} (git did not answer within 2000 ms).`,
    );
  });

  it("a FIFO at HEAD of a non-protected checkout still refuses (the branch cannot be known)", () => {
    const repo = makeRepo("feat/x");
    fifoOver(path.join(repo, ".git", "HEAD"));
    const out = run(manifestWithPack("branch-protection"), repo);
    expectWithinBudget(out);
    expect((JSON.parse(out.stdout) as { decision: string }).decision).toBe("block");
    expect(out.stderr).toMatch(/git did not answer within 2000 ms/);
  });

  // git opens the branch's loose ref too (measured), so a FIFO there also
  // holds git until the hook's bound; the branch is then unknown and refused.
  it.each(["feat/x", "main"])("a FIFO at the loose ref of %s refuses within the bound, naming the timeout", (branch) => {
    const repo = makeRepo(branch);
    fifoOver(path.join(repo, ".git", "refs", "heads", ...branch.split("/")));
    const out = run(manifestWithPack("branch-protection"), repo);
    expectWithinBudget(out);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/\(git did not answer within 2000 ms\)\.$/);
  });

  it("a FIFO at `.git` itself refuses within the bound with git's own message", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git"), { directory: true });
    const out = run(manifestWithPack("branch-protection"), repo);
    expectWithinBudget(out);
    const envelope = JSON.parse(out.stdout) as { decision: string; reason: string };
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/git could not report the branch of .*\(git exited 128: fatal: /);
  });

  it("a FIFO at the `.git` of a directory nested in a feature checkout refuses, it does not resolve the outer branch", () => {
    const outer = makeRepo("feat/outer");
    const nested = path.join(outer, "nested-worktree");
    fs.mkdirSync(nested, { recursive: true });
    execFileSync("mkfifo", [path.join(nested, ".git")]);
    const out = run(manifestWithPack("branch-protection"), nested);
    expectWithinBudget(out);
    expect((JSON.parse(out.stdout) as { decision: string }).decision).toBe("block");
    expect(out.stderr).not.toMatch(/feat\/outer/);
  });

  it.each([
    ["a dangling symlink at `.git`", (nested: string) => fs.symlinkSync(path.join(nested, "no-such-gitdir"), path.join(nested, ".git"))],
    ["a looping symlink at `.git`", (nested: string) => fs.symlinkSync(path.join(nested, ".git"), path.join(nested, ".git"))],
    ["a `.git` directory without HEAD", (nested: string) => fs.mkdirSync(path.join(nested, ".git"))],
    ["a `.git` file with a missing gitdir target", (nested: string) => fs.writeFileSync(path.join(nested, ".git"), `gitdir: ${path.join(nested, "no-such-gitdir")}\n`)],
    ["a `.git` file without a gitdir line", (nested: string) => fs.writeFileSync(path.join(nested, ".git"), "not a gitdir pointer\n")],
  ] as const)("%s nested in a checkout on master: the hook refuses wherever git errors or resolves master", (_name, plant) => {
    const outer = makeRepo("master");
    const nested = path.join(outer, "nested-worktree");
    fs.mkdirSync(nested, { recursive: true });
    plant(nested);
    const git = plainGitHead(nested);
    const out = run(manifestWithPack("branch-protection"), nested);
    expectWithinBudget(out);
    // git either stops with an error or resolves the outer checkout on master;
    // the hook refuses in both cases.
    expect(git.status === 0 ? git.stdout : `exit ${git.status}`).toMatch(/^(refs\/heads\/master\n|exit 128)$/);
    expect((JSON.parse(out.stdout) as { decision: string }).decision).toBe("block");
  });

  it.each([
    ["a `.git` directory without HEAD", (nested: string) => fs.mkdirSync(path.join(nested, ".git"))],
    ["a `.git` directory with a garbage HEAD", (nested: string) => {
      fs.mkdirSync(path.join(nested, ".git"));
      fs.writeFileSync(path.join(nested, ".git", "HEAD"), "garbage\n");
      addGitDirSkeleton(path.join(nested, ".git"));
    }],
    ["a `.git` file without a gitdir line", (nested: string) => fs.writeFileSync(path.join(nested, ".git"), "not a gitdir pointer\n")],
  ] as const)("%s nested in a feature checkout: the hook does what git does", (_name, plant) => {
    const outer = makeRepo("feat/outer");
    const nested = path.join(outer, "nested-worktree");
    fs.mkdirSync(nested, { recursive: true });
    plant(nested);
    const git = plainGitHead(nested);
    const out = run(manifestWithPack("branch-protection"), nested);
    expectWithinBudget(out);
    if (git.status === 0 && git.stdout === "refs/heads/feat/outer\n") {
      expect(out.stdout).toBe("");
      expect(out.stderr).toMatch(/branch "feat\/outer" is not in the protected list/);
    } else {
      expect((JSON.parse(out.stdout) as { decision: string }).decision).toBe("block");
    }
  });
});

describe.skipIf(process.platform === "win32")("pack hook branch-protection --runtime codex: a git file that never answers", { timeout: 30_000 }, () => {
  // The Codex adapter feeds the same blocker an `apply_patch` event whose
  // target path sits in the patch text, not in a `file_path` field, and reads
  // a block as exit 2 with the reason on stderr.
  const patchEvent = (repo: string, files: string[]): unknown => ({
    hook_event_name: "PreToolUse",
    session_id: "sess-fifo",
    tool_name: "apply_patch",
    cwd: repo,
    tool_input: {
      input: `*** Begin Patch\n${files.map((f) => `*** Add File: ${f}\n+x\n`).join("")}*** End Patch\n`,
    },
  });
  const run = (repo: string, files: string[]): HookRun =>
    runCli(
      ["pack", "hook", "branch-protection", "--config", manifestWithPack("branch-protection"), "--runtime", "codex"],
      patchEvent(repo, files),
    );

  it("apply_patch with a FIFO at HEAD exits 2 within the bound, naming the timeout on stderr", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "HEAD"));
    const out = run(repo, [path.join(repo, "src.txt")]);
    expectBounded(out);
    expect(out.ms).toBeLessThan(BP_BUDGET_MS);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/branch-protection: refusing apply_patch: git could not report the branch of .*\(git did not answer within 2000 ms\)\./);
  });

  it("apply_patch with a FIFO at the loose ref of a protected branch exits 2 within the bound", () => {
    const repo = makeRepo("main");
    fifoOver(path.join(repo, ".git", "refs", "heads", "main"));
    const out = run(repo, [path.join(repo, "src.txt")]);
    expectBounded(out);
    expect(out.ms).toBeLessThan(BP_BUDGET_MS);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/refusing apply_patch: git could not report the branch of .*\(git did not answer within 2000 ms\)\./);
  });

  it("apply_patch on a protected branch exits 2 naming the branch", () => {
    const repo = makeRepo("main");
    const out = run(repo, [path.join(repo, "src.txt")]);
    expectBounded(out);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/refusing apply_patch on protected branch "main"/);
  });

  it("apply_patch on a non-protected branch exits 0 with nothing on stdout", () => {
    const repo = makeRepo("feat/x");
    const out = run(repo, [path.join(repo, "src.txt")]);
    expectBounded(out);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
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
