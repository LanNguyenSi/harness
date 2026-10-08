// Unit rows for the branch reader of the branch-protection gate (task
// a4d8adc5): the environment git runs in, the classification of git's
// answer, the presence walk, the nearest existing directory, and the real
// runner against real git and against stand-in `git` scripts (a timeout, a
// signal, output past the cap) placed first on PATH.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_OUTPUT_CAP_BYTES,
  classifyGitHeadAnswer,
  firstLine,
  gitReaderEnv,
  hasGitEntryAbove,
  nearestExistingDirectory,
  readBranch,
  readGitHead,
} from "../../src/runtime/git-branch.js";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const POSIX = process.platform !== "win32";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setPath(value: string): void {
  const saved = process.env["PATH"];
  process.env["PATH"] = value;
  cleanups.push(() => {
    process.env["PATH"] = saved;
  });
}

/** A directory holding an executable `git` script with `body`, first on PATH. */
function fakeGitFirstOnPath(body: string): void {
  const bin = tmpDir("harness-fake-git-");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  setPath(`${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
}

const fixtureEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(fixtureEnv)) if (key.startsWith("GIT_")) delete fixtureEnv[key];
Object.assign(fixtureEnv, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });

describe("gitReaderEnv", () => {
  it("drops every GIT_* variable, in any case, and sets the three fixed values", () => {
    const env = gitReaderEnv({
      HOME: "/home/x",
      PATH: "/bin",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
      git_dir: "/lower",
      GIT_TERMINAL_PROMPT: "1",
      LC_ALL: "de_DE.UTF-8",
    });
    expect(env).toEqual({
      HOME: "/home/x",
      PATH: "/bin",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("does not modify the environment it is given", () => {
    const base = { GIT_DIR: "/x", HOME: "/h" };
    gitReaderEnv(base);
    expect(base).toEqual({ GIT_DIR: "/x", HOME: "/h" });
  });
});

describe("classifyGitHeadAnswer", () => {
  it("reads refs/heads/<name> on exit 0 as the branch, with or without the final line feed", () => {
    expect(classifyGitHeadAnswer({ kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" })).toEqual({
      kind: "branch",
      name: "feat/x",
    });
    expect(classifyGitHeadAnswer({ kind: "exited", code: 0, stdout: "refs/heads/main", stderr: "" })).toEqual({
      kind: "branch",
      name: "main",
    });
  });

  it.each([
    ["a tag", "refs/tags/v1\n"],
    ["refs/heads/ with no name", "refs/heads/\n"],
    ["two lines", "refs/heads/a\nrefs/heads/b\n"],
    ["a carriage return", "refs/heads/main\r\n"],
    ["two line feeds", "refs/heads/main\n\n"],
    ["leading whitespace", " refs/heads/main\n"],
    ["nothing", ""],
  ])("an exit-0 answer with %s is an error", (_name, stdout) => {
    expect(classifyGitHeadAnswer({ kind: "exited", code: 0, stdout, stderr: "" }).kind).toBe("error");
  });

  it("exit 1 with no stdout is a detached HEAD; exit 1 with stdout is an error", () => {
    expect(classifyGitHeadAnswer({ kind: "exited", code: 1, stdout: "", stderr: "" })).toEqual({ kind: "detached" });
    expect(classifyGitHeadAnswer({ kind: "exited", code: 1, stdout: "x\n", stderr: "" }).kind).toBe("error");
  });

  it.each([2, 128, 129, 255])("exit %i is an error carrying git's first stderr line", (code) => {
    expect(classifyGitHeadAnswer({ kind: "exited", code, stdout: "", stderr: "fatal: nope\nmore\n" })).toEqual({
      kind: "error",
      detail: `git exited ${code}: fatal: nope`,
    });
  });

  it("a signal, a timeout, output past the cap and a failed start are errors", () => {
    expect(classifyGitHeadAnswer({ kind: "signaled", signal: "SIGKILL", stderr: "" })).toEqual({
      kind: "error",
      detail: "git was killed by SIGKILL",
    });
    expect(classifyGitHeadAnswer({ kind: "timed-out", timeoutMs: 50, stderr: "warning: slow\n" })).toEqual({
      kind: "error",
      detail: "git did not answer within 50 ms: warning: slow",
    });
    expect(classifyGitHeadAnswer({ kind: "oversized", stderr: "" })).toEqual({
      kind: "error",
      detail: `git's output passed ${GIT_OUTPUT_CAP_BYTES} bytes`,
    });
    expect(classifyGitHeadAnswer({ kind: "spawn-failed", code: "EACCES" })).toEqual({
      kind: "error",
      detail: "git could not be started (EACCES)",
    });
  });
});

describe("firstLine", () => {
  it("takes the first non-empty line, trims it, replaces control characters and caps it", () => {
    expect(firstLine("\n\n  fatal: x  \nsecond")).toBe("fatal: x");
    expect(firstLine("a\u0007b\u009bc")).toBe("a?b?c");
    expect(firstLine("z".repeat(250))).toBe(`${"z".repeat(200)}...`);
    expect(firstLine("")).toBe("");
  });
});

describe("hasGitEntryAbove", () => {
  it("finds a .git directory, file or symlink in the directory or above it", (ctx) => {
    const root = tmpDir("harness-gb-presence-");
    const deep = path.join(root, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    if (hasGitEntryAbove(root)) ctx.skip("the host keeps a repository above the temp directory");
    expect(hasGitEntryAbove(deep)).toBe(false);
    fs.writeFileSync(path.join(root, "a", ".git"), "gitdir: nowhere\n");
    expect(hasGitEntryAbove(deep)).toBe(true);
    fs.rmSync(path.join(root, "a", ".git"));
    fs.mkdirSync(path.join(deep, ".git"));
    expect(hasGitEntryAbove(deep)).toBe(true);
    fs.rmSync(path.join(deep, ".git"), { recursive: true });
    if (POSIX) {
      fs.symlinkSync(path.join(root, "missing"), path.join(deep, ".git"));
      expect(hasGitEntryAbove(deep)).toBe(true);
    }
  });
});

describe("nearestExistingDirectory", () => {
  it("returns an existing directory itself, else the nearest existing ancestor", () => {
    const root = tmpDir("harness-gb-nearest-");
    expect(nearestExistingDirectory(root)).toBe(root);
    expect(nearestExistingDirectory(path.join(root, "no", "such", "dir"))).toBe(root);
  });

  it("steps over a regular file in the path", () => {
    const root = tmpDir("harness-gb-nearest-");
    fs.writeFileSync(path.join(root, "file"), "x");
    expect(nearestExistingDirectory(path.join(root, "file"))).toBe(root);
    expect(nearestExistingDirectory(path.join(root, "file", "below"))).toBe(root);
  });
});

describe("readBranch", () => {
  it("does not call the reader outside every repository", async (ctx) => {
    const dir = tmpDir("harness-gb-outside-");
    if (hasGitEntryAbove(dir)) ctx.skip("the host keeps a repository above the temp directory");
    let called = false;
    const r = await readBranch(dir, {
      reader: async () => {
        called = true;
        return { kind: "exited", code: 0, stdout: "refs/heads/master\n", stderr: "" };
      },
    });
    expect(r).toEqual({ kind: "outside" });
    expect(called).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)("readGitHead against real git", () => {
  it("reports the branch, then the detached HEAD", async () => {
    const repo = tmpDir("harness-gb-real-");
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        env: fixtureEnv,
        stdio: "ignore",
      });
    };
    git("-c", "init.defaultBranch=feat/real", "init", "-q");
    expect(await readGitHead(repo, 2000)).toMatchObject({ kind: "exited", code: 0, stdout: "refs/heads/feat/real\n" });
    git("commit", "-q", "--allow-empty", "-m", "c");
    git("checkout", "-q", "--detach");
    expect(await readGitHead(repo, 2000)).toMatchObject({ kind: "exited", code: 1, stdout: "" });
  });

  it.skipIf(!POSIX)("a HEAD that never answers (a FIFO) ends in a timeout, not a hang", async () => {
    const repo = tmpDir("harness-gb-fifo-");
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repo, env: fixtureEnv, stdio: "ignore" });
    fs.rmSync(path.join(repo, ".git", "HEAD"));
    execFileSync("mkfifo", [path.join(repo, ".git", "HEAD")]);
    const started = Date.now();
    const answer = await readGitHead(repo, 300);
    expect(answer).toMatchObject({ kind: "timed-out", timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe.skipIf(!POSIX)("readGitHead against a stand-in git", () => {
  it("a git that sleeps is killed at the bound", async () => {
    fakeGitFirstOnPath("sleep 5");
    const answer = await readGitHead(tmpDir("harness-gb-x-"), 200);
    expect(answer).toMatchObject({ kind: "timed-out", timeoutMs: 200 });
  });

  it("a git that kills itself reports the signal", async () => {
    fakeGitFirstOnPath("kill -TERM $$");
    const answer = await readGitHead(tmpDir("harness-gb-x-"), 2000);
    expect(answer).toMatchObject({ kind: "signaled", signal: "SIGTERM" });
  });

  it("output past the cap is reported as oversized", async () => {
    fakeGitFirstOnPath(`head -c ${GIT_OUTPUT_CAP_BYTES * 2} /dev/zero | tr '\\0' 'a'`);
    const answer = await readGitHead(tmpDir("harness-gb-x-"), 2000);
    expect(answer.kind).toBe("oversized");
  });

  it("git sees the stripped environment, and the directory after -C", async () => {
    fakeGitFirstOnPath('printf "%s|%s|%s|%s|%s\\n" "$1" "$2" "${GIT_DIR-unset}" "$LC_ALL" "$GIT_OPTIONAL_LOCKS"');
    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = "/elsewhere/.git";
    cleanups.push(() => {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    });
    const dir = tmpDir("harness-gb-x-");
    const answer = await readGitHead(dir, 2000);
    expect(answer).toEqual({ kind: "exited", code: 0, stdout: `-C|${dir}|unset|C|0\n`, stderr: "" });
  });

  it("no git on PATH is a failed start (ENOENT)", async () => {
    setPath(tmpDir("harness-gb-empty-"));
    expect(await readGitHead(tmpDir("harness-gb-x-"), 2000)).toEqual({ kind: "spawn-failed", code: "ENOENT" });
  });
});
