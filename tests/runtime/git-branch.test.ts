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
  PathBoundError,
  classifyGitHeadAnswer,
  firstLine,
  gitReaderEnv,
  hasGitEntryAbove,
  nearestExistingDirectory,
  nearestExistingDirectoryAsWritten,
  readBranch,
  readBranchAt,
  readGitHead,
  writeTargetDirectories,
  type GitHeadAnswer,
  type PathResolution,
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

  it.each([
    ["a tool error line", "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)\n"],
    ["a warning line", "warning: something\n"],
    ["a lone line feed", "\n"],
  ])("exit 1 with nothing on stdout but %s on stderr is an error, not a detached HEAD", (_name, stderr) => {
    const read = classifyGitHeadAnswer({ kind: "exited", code: 1, stdout: "", stderr });
    expect(read.kind).toBe("error");
    if (read.kind === "error") expect(read.detail).toBe(stderr.trim() === "" ? "git exited 1" : `git exited 1: ${stderr.trim()}`);
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

  // An lstat that fails for another reason than a missing path cannot tell
  // whether a `.git` is there, so it counts as present and git decides.
  it.skipIf(!POSIX)("an lstat of .git failing with ELOOP counts as present", (ctx) => {
    const root = tmpDir("harness-gb-eloop-");
    if (hasGitEntryAbove(root)) ctx.skip("the host keeps a repository above the temp directory");
    fs.symlinkSync("loop", path.join(root, "loop"));
    const dir = path.join(root, "loop", "sub");
    expect(() => fs.lstatSync(path.join(dir, ".git"))).toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect(hasGitEntryAbove(dir)).toBe(true);
  });

  it.skipIf(!POSIX || process.getuid?.() === 0)("an lstat of .git failing with EACCES counts as present", (ctx) => {
    const root = tmpDir("harness-gb-eacces-");
    if (hasGitEntryAbove(root)) ctx.skip("the host keeps a repository above the temp directory");
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o600);
    cleanups.push(() => fs.chmodSync(locked, 0o755));
    expect(() => fs.lstatSync(path.join(locked, ".git"))).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(hasGitEntryAbove(locked)).toBe(true);
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

  // The directory is resolved the way the operating system resolves it:
  // through symlinks, with `..` taken from the directory reached so far.
  it.skipIf(!POSIX)("returns the physical directory behind a symlink, and `..` steps up from it", () => {
    const root = tmpDir("harness-gb-nearest-");
    const target = path.join(root, "repo", "src");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(target, path.join(root, "outside", "link"));
    expect(nearestExistingDirectory(path.join(root, "outside", "link"))).toBe(target);
    expect(nearestExistingDirectory(path.join(root, "outside", "link", "new", "deeper"))).toBe(target);
    expect(nearestExistingDirectory(`${root}/outside/link/..`)).toBe(path.join(root, "repo"));
    expect(nearestExistingDirectory(`${root}/outside/link/../new`)).toBe(path.join(root, "repo"));
  });
});

describe.skipIf(!POSIX)("writeTargetDirectories", () => {
  const layout = (): { root: string; out: string; src: string } => {
    const root = tmpDir("harness-gb-targets-");
    const src = path.join(root, "repo", "src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "real.ts"), "x\n");
    const out = path.join(root, "outside");
    fs.mkdirSync(out);
    return { root, out, src };
  };

  it("a plain file, existing or new, lands in its own directory; a missing directory chain in the nearest existing one", () => {
    const { src } = layout();
    expect(writeTargetDirectories(path.join(src, "real.ts"), "/")).toEqual([src]);
    expect(writeTargetDirectories(path.join(src, "new.ts"), "/")).toEqual([src]);
    expect(writeTargetDirectories(path.join(src, "a", "b", "new.ts"), "/")).toEqual([src]);
    expect(writeTargetDirectories("new.ts", src)).toEqual([src]);
  });

  it("a path through a directory symlink lands in the directory the symlink leads to", () => {
    const { out, src } = layout();
    fs.symlinkSync(src, path.join(out, "link"));
    expect(writeTargetDirectories(path.join(out, "link", "new.ts"), "/")).toEqual([src]);
    expect(writeTargetDirectories("new.ts", path.join(out, "link"))).toEqual([src]);
    expect(writeTargetDirectories("link/new.ts", out)).toEqual([src]);
  });

  it("`..` steps up from the directory a symlink leads to, and back over directories that do not exist yet", () => {
    const { root, out, src } = layout();
    fs.symlinkSync(src, path.join(out, "link"));
    expect(writeTargetDirectories(`${out}/link/../b.ts`, "/")).toEqual([path.join(root, "repo")]);
    expect(writeTargetDirectories("../b.ts", path.join(out, "link"))).toEqual([path.join(root, "repo")]);
    expect(writeTargetDirectories(`${out}/missing/../link/b.ts`, "/")).toEqual([src]);
  });

  it("a file symlink lands in its own directory and in the directory of the file it names", () => {
    const { out, src } = layout();
    fs.symlinkSync(path.join(src, "real.ts"), path.join(out, "file-link.ts"));
    expect(writeTargetDirectories(path.join(out, "file-link.ts"), "/")).toEqual([out, src]);
  });

  it("a dangling symlink, or a chain of them, is followed by its text to where the file would be created", () => {
    const { root, out, src } = layout();
    fs.symlinkSync(path.join(src, "new.ts"), path.join(out, "dangling.ts"));
    expect(writeTargetDirectories(path.join(out, "dangling.ts"), "/")).toEqual([out, src]);
    fs.mkdirSync(path.join(root, "middle"));
    fs.symlinkSync("../repo/src/other.ts", path.join(root, "middle", "hop.ts"));
    fs.symlinkSync(path.join(root, "middle", "hop.ts"), path.join(out, "chain.ts"));
    expect(writeTargetDirectories(path.join(out, "chain.ts"), "/")).toEqual([out, path.join(root, "middle"), src]);
  });

  it("a symlink loop ends after a bounded number of hops", () => {
    const { out } = layout();
    fs.symlinkSync(path.join(out, "b"), path.join(out, "a"));
    fs.symlinkSync(path.join(out, "a"), path.join(out, "b"));
    expect(writeTargetDirectories(path.join(out, "a"), "/")).toEqual([out]);
  });
});

// The as-written reading: `.` and `..` resolved on the text, symlinks left
// in the path.
describe("nearestExistingDirectoryAsWritten", () => {
  it("returns an existing directory itself, else the nearest existing ancestor of the text", () => {
    const root = tmpDir("harness-gb-written-");
    fs.writeFileSync(path.join(root, "file"), "x");
    expect(nearestExistingDirectoryAsWritten(root)).toBe(root);
    expect(nearestExistingDirectoryAsWritten(path.join(root, "no", "such", "dir"))).toBe(root);
    expect(nearestExistingDirectoryAsWritten(path.join(root, "file", "below"))).toBe(root);
  });

  it.skipIf(!POSIX)("keeps a symlink in the path, and `..` after it steps up on the text", () => {
    const root = tmpDir("harness-gb-written-");
    const target = path.join(root, "elsewhere", "sub");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(root, "repo"));
    fs.symlinkSync(target, path.join(root, "repo", "lnk"));
    expect(nearestExistingDirectoryAsWritten(path.join(root, "repo", "lnk"))).toBe(path.join(root, "repo", "lnk"));
    expect(nearestExistingDirectoryAsWritten(`${root}/repo/lnk/..`)).toBe(path.join(root, "repo"));
    expect(nearestExistingDirectoryAsWritten(`${root}/repo/lnk/../new/deeper`)).toBe(path.join(root, "repo"));
    // The physical reading of the same text lands where the symlink leads.
    expect(nearestExistingDirectory(`${root}/repo/lnk/..`)).toBe(path.join(root, "elsewhere"));
  });
});

describe("readBranchAt", () => {
  it.skipIf(!POSIX)("walks and asks git about the directory as given, not where a symlink in it leads", async (ctx) => {
    const root = tmpDir("harness-gb-at-");
    if (hasGitEntryAbove(root)) ctx.skip("the host keeps a repository above the temp directory");
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(repo, "to-outside"));
    const dirs: string[] = [];
    const reader = async (dir: string): Promise<GitHeadAnswer> => {
      dirs.push(dir);
      return { kind: "exited", code: 128, stdout: "", stderr: "fatal: not a git repository\n" };
    };
    const asGiven = path.join(repo, "to-outside");
    expect(await readBranchAt(asGiven, { reader })).toEqual({ kind: "error", detail: "git exited 128: fatal: not a git repository" });
    expect(dirs).toEqual([asGiven]);
    // The physical reading of the same directory finds no .git above it.
    expect(await readBranch(asGiven, { reader })).toEqual({ kind: "outside" });
    expect(dirs).toEqual([asGiven]);
  });
});

describe("resolving the paths of one event is bounded and shares a cache", () => {
  const deepTree = (): { root: string; deep: string } => {
    const root = tmpDir("harness-gb-bound-");
    let deep = root;
    for (let i = 0; i < 8; i += 1) deep = path.join(deep, `d${i}`);
    fs.mkdirSync(deep, { recursive: true });
    return { root, deep };
  };

  it.each<[string, (p: string, res: PathResolution) => unknown]>([
    ["nearestExistingDirectory", (p, res) => nearestExistingDirectory(p, res)],
    ["nearestExistingDirectoryAsWritten", (p, res) => nearestExistingDirectoryAsWritten(p, res)],
    ["writeTargetDirectories", (p, res) => writeTargetDirectories(p, "/", res)],
  ])("%s stops with a PathBoundError once the bound has passed, and asks before every step", (_name, resolve) => {
    const { deep } = deepTree();
    const target = path.join(deep, "missing", "x.ts");
    expect(() => resolve(target, { overBound: () => true })).toThrow(PathBoundError);
    let asked = 0;
    expect(resolve(target, { overBound: () => (asked += 1) < 0 })).toBeDefined();
    const steps = asked;
    expect(steps).toBeGreaterThan(1);
    asked = 0;
    expect(() => resolve(target, { overBound: () => (asked += 1) >= steps })).toThrow(PathBoundError);
  });

  it("a shared cache gives the same directories and holds every prefix once", () => {
    const { root, deep } = deepTree();
    const memo = new Map<string, string | null>();
    const fresh = Array.from({ length: 50 }, (_, i) => writeTargetDirectories(path.join(deep, `f${i}.ts`), "/"));
    const cached = Array.from({ length: 50 }, (_, i) => writeTargetDirectories(path.join(deep, `f${i}.ts`), "/", { memo }));
    expect(cached).toEqual(fresh);
    expect(memo.get(deep)).toBe(deep);
    expect(memo.get(path.join(root, "d0"))).toBe(path.join(root, "d0"));
    expect(memo.size).toBeLessThan(50);
  });
});

describe("readBranch", () => {
  it("a directory that cannot be resolved is an error, and git is not asked", async () => {
    let called = false;
    const r = await readBranch(path.join(tmpDir("harness-gb-gone-"), "missing"), {
      reader: async () => {
        called = true;
        return { kind: "exited", code: 0, stdout: "refs/heads/feat/x\n", stderr: "" };
      },
    });
    expect(r).toEqual({ kind: "error", detail: "the directory could not be resolved (ENOENT)" });
    expect(called).toBe(false);
  });

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

  it.skipIf(!POSIX)("a directory reached through a symlink is read where the symlink leads: the walk and git see the physical directory", async (ctx) => {
    const root = tmpDir("harness-gb-physical-");
    if (hasGitEntryAbove(root)) ctx.skip("the host keeps a repository above the temp directory");
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(repo, "src"), path.join(root, "outside", "link"));
    const dirs: string[] = [];
    const r = await readBranch(path.join(root, "outside", "link"), {
      reader: async (dir) => {
        dirs.push(dir);
        return { kind: "exited", code: 0, stdout: "refs/heads/master\n", stderr: "" };
      },
    });
    expect(r).toEqual({ kind: "branch", name: "master" });
    expect(dirs).toEqual([path.join(repo, "src")]);
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

  it("a git that exits 1 with text on stderr and nothing on stdout reads as an error naming that line", async () => {
    fakeGitFirstOnPath('echo "xcrun: error: invalid active developer path" >&2\nexit 1');
    const dir = tmpDir("harness-gb-x-");
    fs.mkdirSync(path.join(dir, ".git"));
    expect(await readGitHead(dir, 2000)).toEqual({
      kind: "exited",
      code: 1,
      stdout: "",
      stderr: "xcrun: error: invalid active developer path\n",
    });
    expect(await readBranch(dir)).toEqual({ kind: "error", detail: "git exited 1: xcrun: error: invalid active developer path" });
  });
});
