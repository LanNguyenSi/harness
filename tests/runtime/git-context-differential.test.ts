// Differential test of repository detection against real git (task
// 51bfba5a). Every row builds an inner directory inside an outer repository
// (on `master`) and asks two questions of it: which work tree does git find
// from there (`git rev-parse --show-toplevel`, run from the inner directory),
// and what does `findGitEntry` / `resolveGitContext` make of it.
//
// The rule is one-sided. The lookup must NEVER resolve a repository git does
// not resolve from that directory (it would read a branch git does not
// commit to: a planted `.git` whose branch is not protected switches
// branch-protection off for the enclosing checkout). The other direction,
// refusing a directory git does take for a repository, is allowed only for
// the rows listed with a reason (`conservative`), and a listed row that stops
// diverging fails too, so the list cannot rot. Layouts git writes itself
// (`legit`) must resolve, with git's own branch.
//
// git itself is the oracle, so a git release that changes its rules shows up
// here as a failing row rather than as a silent gap. Rows that need a
// repository format or a worktree option the installed git lacks are skipped
// visibly; the whole file is skipped only when there is no git at all. Set
// HARNESS_GIT_DIFFERENTIAL_TRANSCRIPT=1 to print what both sides said for
// every row.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findGitEntry, resolveGitContext } from "../../src/runtime/git-context.js";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const POSIX = process.platform !== "win32";
const ROOT_USER = process.getuid?.() === 0;

type Need = "sha256" | "reftable" | "relative-worktree" | "posix" | "non-root";

interface Built {
  /** Where both sides look from. */
  cwd: string;
  /** The work tree the row is about (`cwd` unless the row starts below it). */
  repoRoot?: string;
}

interface Row {
  /** A generic description of the shape (no concrete bypass text). */
  name: string;
  build: (id: string) => string | Built;
  needs?: Need[];
  /** A layout git writes itself: must resolve, never be refused. */
  legit?: boolean;
  /** Allowlisted conservative divergence: the lookup refuses, git accepts. */
  conservative?: string;
  /** Why the branch is not compared for this row (repository identity still is). */
  skipBranchCompare?: string;
}

// The hermetic git environment of tests/runtime/git-context.test.ts: no
// global or system config, a fixed identity, and none of the variables that
// point git somewhere other than the directory it runs in.
const gitEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) if (key.startsWith("GIT_")) delete gitEnv[key];
Object.assign(gitEnv, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "init.defaultBranch=master", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** `git rev-parse --show-toplevel` from `cwd`, `null` when git finds no work tree (or stops with an error). */
function gitToplevel(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env: gitEnv, encoding: "utf8" });
  return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

/** The branch git's HEAD names (`""` when detached or naming a ref outside refs/heads/). */
function gitBranch(cwd: string): string {
  const r = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0) return "";
  const ref = r.stdout.replace(/\n$/, "");
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
}

function probe(...args: string[]): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gitdiff-probe-"));
  try {
    return spawnSync("git", [...args, path.join(dir, "repo")], { env: gitEnv, stdio: "ignore" }).status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let ROOT = "";
let OUTER = "";
let TEMPLATE = "";
let SHA = "";
const supported: Record<Need, boolean> = {
  sha256: false,
  reftable: false,
  "relative-worktree": false,
  posix: POSIX,
  "non-root": !ROOT_USER,
};
const transcript: string[] = [];

/** The inner directory of row `id`, inside the outer work tree. */
function inner(id: string): string {
  return path.join(OUTER, "rows", id);
}

/** A real repository (one commit, on `feat/x`, tag `v1`) copied to `dir`. */
function copyRepo(dir: string): string {
  fs.cpSync(TEMPLATE, dir, { recursive: true });
  return dir;
}

/** A copy of the template's git directory outside the outer work tree. */
function copyGitDir(id: string): string {
  const target = path.join(ROOT, "targets", `${id}.git`);
  fs.cpSync(path.join(TEMPLATE, ".git"), target, { recursive: true });
  return target;
}

/** A real repository at the row's inner directory whose `HEAD` is replaced by `head`. */
function dotGitWithHead(id: string, head: string | Buffer): string {
  const dir = copyRepo(inner(id));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), head);
  return dir;
}

/**
 * A linked worktree at the row's inner directory, of a main repository of its
 * own (a row that damages its private git directory must not break the next
 * `git worktree add`).
 */
function linkedWorktree(id: string, ...extra: string[]): { dir: string; main: string; privateGitDir: string } {
  const main = copyRepo(path.join(ROOT, "mains", id));
  const dir = inner(id);
  git(main, "worktree", "add", "-q", ...extra, ...(extra.includes("--detach") ? [] : ["-b", `wt/${id}`]), dir);
  return { dir, main, privateGitDir: path.join(main, ".git", "worktrees", id) };
}

/** A linked worktree whose private `HEAD` is replaced by `head`. */
function linkedWorktreeWithHead(id: string, head: string | Buffer): string {
  const { dir, privateGitDir } = linkedWorktree(id);
  fs.writeFileSync(path.join(privateGitDir, "HEAD"), head);
  return dir;
}

/** The row's inner directory holding only a `.git` file with `content`. */
function dotGitFile(id: string, content: string | Buffer): string {
  const dir = inner(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), content);
  return dir;
}

/** The row's inner directory holding a `.git` directory with the given entries. */
function bareDotGit(id: string, head: string, entries: { objects?: boolean; refs?: boolean }): string {
  const dir = inner(id);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), head);
  if (entries.objects === true) fs.mkdirSync(path.join(dir, ".git", "objects"));
  if (entries.refs === true) fs.mkdirSync(path.join(dir, ".git", "refs"));
  return dir;
}

const REF = "ref: refs/heads/feat/x\n";
const sha = (): string => SHA;

// HEAD content git does not accept: the lookup must refuse it in a `.git`
// directory and in a linked worktree's private git directory alike.
const REJECTED_HEADS: Array<[string, () => string]> = [
  ["whitespace before the ref prefix", () => `  ${REF}`],
  ["a line feed before the ref prefix", () => `\n${REF}`],
  ["a tab before the ref prefix", () => `\t${REF}`],
  ["a byte-order mark before the ref prefix", () => `﻿${REF}`],
  ["a no-break space before the ref prefix", () => ` ${REF}`],
  ["a vertical tab after the ref prefix", () => "ref:\u000brefs/heads/feat/x\n"],
  ["a form feed after the ref prefix", () => "ref:\u000crefs/heads/feat/x\n"],
  ["a no-break space after the ref prefix", () => "ref: refs/heads/feat/x\n"],
  ["a line separator after the ref prefix", () => "ref: refs/heads/feat/x\n"],
  ["whitespace before an object id", () => ` ${sha()}\n`],
  ["a byte-order mark before an object id", () => `﻿${sha()}\n`],
  ["a vertical tab before an object id", () => `\u000b${sha()}\n`],
  ["an upper-case ref prefix", () => REF.replace("ref:", "REF:")],
  ["refs/ starting past git's check window", () => `ref:${" ".repeat(247)}refs/heads/feat/x\n`],
  ["a NUL between the ref prefix and refs/", () => "ref: \u0000refs/heads/feat/x\n"],
  ["a 39-hex object id", () => `${sha().slice(1)}\n`],
  ["no content at all", () => ""],
];

const ROWS: Row[] = [
  // Layouts git writes itself.
  { name: "a repository on a branch", legit: true, build: (id) => copyRepo(inner(id)) },
  {
    name: "a repository, from a subdirectory",
    legit: true,
    build: (id) => {
      const repoRoot = copyRepo(inner(id));
      const cwd = path.join(repoRoot, "src", "deep");
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd, repoRoot };
    },
  },
  {
    name: "a repository on a detached HEAD",
    legit: true,
    build: (id) => {
      const dir = copyRepo(inner(id));
      git(dir, "checkout", "-q", "--detach");
      return dir;
    },
  },
  {
    name: "a repository on an unborn branch",
    legit: true,
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "feat/unborn");
      return dir;
    },
  },
  {
    name: "a repository whose branch ref is packed",
    legit: true,
    build: (id) => {
      const dir = copyRepo(inner(id));
      git(dir, "pack-refs", "--all");
      return dir;
    },
  },
  { name: "a linked worktree", legit: true, build: (id) => linkedWorktree(id).dir },
  { name: "a linked worktree on a detached HEAD", legit: true, build: (id) => linkedWorktree(id, "--detach").dir },
  {
    name: "a linked worktree added from inside another linked worktree",
    legit: true,
    build: (id) => {
      const first = linkedWorktree(`${id}-first`).dir;
      const dir = inner(id);
      git(first, "worktree", "add", "-q", "-b", `wt/${id}`, dir);
      return dir;
    },
  },
  {
    name: "a linked worktree of a bare repository",
    legit: true,
    build: (id) => {
      const bare = path.join(ROOT, "bare", `${id}.git`);
      git(ROOT, "clone", "-q", "--bare", TEMPLATE, bare);
      const dir = inner(id);
      git(bare, "worktree", "add", "-q", "-b", `wt/${id}`, dir);
      return dir;
    },
  },
  {
    name: "a linked worktree with relative paths",
    legit: true,
    needs: ["relative-worktree"],
    build: (id) => linkedWorktree(id, "--relative-paths").dir,
  },
  {
    name: "a submodule checkout",
    legit: true,
    build: (id) => {
      const superproject = copyRepo(inner(id));
      git(superproject, "submodule", "add", "-q", TEMPLATE, "mod");
      return path.join(superproject, "mod");
    },
  },
  {
    name: "a superproject holding a submodule",
    legit: true,
    build: (id) => {
      const superproject = copyRepo(inner(id));
      git(superproject, "submodule", "add", "-q", TEMPLATE, "mod");
      return superproject;
    },
  },
  {
    name: "a checkout with a separate git directory",
    legit: true,
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(ROOT, "separate"), { recursive: true });
      git(dir, "init", "-q", `--separate-git-dir=${path.join(ROOT, "separate", `${id}.git`)}`);
      fs.writeFileSync(path.join(dir, "f"), "x\n");
      git(dir, "add", "f");
      git(dir, "commit", "-qm", "c");
      git(dir, "switch", "-qc", "feat/sep");
      return dir;
    },
  },
  {
    name: "a .git symlink to a git directory elsewhere",
    legit: true,
    needs: ["posix"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      const real = path.join(ROOT, "moved", `${id}.git`);
      fs.mkdirSync(path.dirname(real), { recursive: true });
      fs.renameSync(path.join(dir, ".git"), real);
      fs.symlinkSync(real, path.join(dir, ".git"));
      return dir;
    },
  },
  {
    name: "a HEAD written as a symlink (core.preferSymlinkRefs)",
    legit: true,
    needs: ["posix"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      git(dir, "-c", "core.preferSymlinkRefs=true", "symbolic-ref", "HEAD", "refs/heads/feat/x");
      return dir;
    },
  },
  {
    name: "a SHA-256 repository",
    legit: true,
    needs: ["sha256"],
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "--object-format=sha256");
      fs.writeFileSync(path.join(dir, "f"), "x\n");
      git(dir, "add", "f");
      git(dir, "commit", "-qm", "c");
      git(dir, "switch", "-qc", "feat/s256");
      return dir;
    },
  },
  {
    name: "a SHA-256 repository on a detached HEAD",
    legit: true,
    needs: ["sha256"],
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "--object-format=sha256");
      fs.writeFileSync(path.join(dir, "f"), "x\n");
      git(dir, "add", "f");
      git(dir, "commit", "-qm", "c");
      git(dir, "checkout", "-q", "--detach");
      return dir;
    },
  },
  {
    name: "a reftable repository",
    legit: true,
    needs: ["reftable"],
    skipBranchCompare: "a reftable repository keeps no branch name in HEAD; branch naming there is not this check's scope",
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "--ref-format=reftable");
      fs.writeFileSync(path.join(dir, "f"), "x\n");
      git(dir, "add", "f");
      git(dir, "commit", "-qm", "c");
      git(dir, "switch", "-qc", "feat/rt");
      return dir;
    },
  },

  // HEAD content git accepts.
  { name: "HEAD with no space after the ref prefix", build: (id) => dotGitWithHead(id, "ref:refs/heads/feat/x\n") },
  { name: "HEAD with a tab after the ref prefix", build: (id) => dotGitWithHead(id, "ref:\trefs/heads/feat/x\n") },
  {
    name: "HEAD with a carriage return and a line feed after the ref prefix",
    build: (id) => dotGitWithHead(id, "ref:\r\n refs/heads/feat/x\n"),
  },
  {
    name: "HEAD whose refs/ ends inside git's check window",
    build: (id) => dotGitWithHead(id, `ref:${" ".repeat(246)}refs/heads/feat/x\n`),
  },
  { name: "HEAD holding an upper-case object id", build: (id) => dotGitWithHead(id, `${SHA.toUpperCase()}\n`) },
  { name: "HEAD naming a ref outside refs/heads/", build: (id) => dotGitWithHead(id, "ref: refs/tags/v1\n") },
  {
    name: "HEAD with an object id followed by other text",
    conservative: "git accepts any 40-hex prefix; no object id can be read from the rest, refused since task b56d95d3",
    build: (id) => dotGitWithHead(id, `${SHA}xyz\n`),
  },
  {
    name: "HEAD naming refs/heads/ with no branch",
    conservative: "git takes it for a repository whose HEAD cannot be resolved; refused since task b56d95d3",
    build: (id) => dotGitWithHead(id, "ref: refs/heads/\n"),
  },
  {
    name: "HEAD naming refs/ with no ref",
    conservative: "git takes it for a repository whose HEAD cannot be resolved; refused since task b56d95d3",
    build: (id) => dotGitWithHead(id, "ref: refs/\n"),
  },

  // HEAD content git rejects, in a `.git` directory and in a linked worktree.
  ...REJECTED_HEADS.map(
    ([shape, head]): Row => ({ name: `HEAD with ${shape}`, build: (id) => dotGitWithHead(id, head()) }),
  ),
  ...REJECTED_HEADS.map(
    ([shape, head]): Row => ({
      name: `a linked worktree whose HEAD has ${shape}`,
      build: (id) => linkedWorktreeWithHead(id, head()),
    }),
  ),
  {
    name: "a HEAD that is a directory",
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.rmSync(path.join(dir, ".git", "HEAD"));
      fs.mkdirSync(path.join(dir, ".git", "HEAD"));
      return dir;
    },
  },
  {
    name: "a .git directory without HEAD",
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.rmSync(path.join(dir, ".git", "HEAD"));
      return dir;
    },
  },

  // HEAD symlinks.
  {
    name: "a HEAD symlink naming a ref outside refs/heads/",
    needs: ["posix"],
    conservative: "git accepts any link text under refs/; only refs/heads/<name> names a branch here, since task b56d95d3",
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.rmSync(path.join(dir, ".git", "HEAD"));
      fs.symlinkSync("refs/tags/v1", path.join(dir, ".git", "HEAD"));
      return dir;
    },
  },
  {
    name: "a HEAD symlink to an absolute path",
    needs: ["posix"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.rmSync(path.join(dir, ".git", "HEAD"));
      fs.symlinkSync(path.join(dir, ".git", "refs", "heads", "feat", "x"), path.join(dir, ".git", "HEAD"));
      return dir;
    },
  },

  // The directories git requires next to HEAD.
  { name: "a .git directory holding only HEAD", build: (id) => bareDotGit(id, REF, {}) },
  { name: "a .git directory without objects/", build: (id) => bareDotGit(id, REF, { refs: true }) },
  { name: "a .git directory without refs/", build: (id) => bareDotGit(id, REF, { objects: true }) },
  { name: "a .git directory with objects/ and refs/", build: (id) => bareDotGit(id, REF, { objects: true, refs: true }) },
  {
    name: "objects/ that cannot be searched",
    needs: ["posix", "non-root"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.chmodSync(path.join(dir, ".git", "objects"), 0o600);
      return dir;
    },
  },
  {
    name: "refs/ that cannot be searched",
    needs: ["posix", "non-root"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.chmodSync(path.join(dir, ".git", "refs"), 0o600);
      return dir;
    },
  },
  {
    name: "objects/ that is a regular file",
    build: (id) => {
      const dir = bareDotGit(id, REF, { refs: true });
      fs.writeFileSync(path.join(dir, ".git", "objects"), "x\n");
      return dir;
    },
  },
  {
    name: "objects/ that is an executable regular file",
    needs: ["posix"],
    conservative: "git probes only the execute permission of objects/ and refs/; a non-directory there is refused (task 51bfba5a)",
    build: (id) => {
      const dir = bareDotGit(id, REF, { refs: true });
      fs.writeFileSync(path.join(dir, ".git", "objects"), "x\n", { mode: 0o755 });
      return dir;
    },
  },
  {
    name: "refs/ that is a regular file",
    build: (id) => {
      const dir = bareDotGit(id, REF, { objects: true });
      fs.writeFileSync(path.join(dir, ".git", "refs"), "x\n");
      return dir;
    },
  },
  {
    name: "objects/ that is a symlink to a directory",
    needs: ["posix"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      const moved = path.join(ROOT, "moved-objects", id);
      fs.mkdirSync(path.dirname(moved), { recursive: true });
      fs.renameSync(path.join(dir, ".git", "objects"), moved);
      fs.symlinkSync(moved, path.join(dir, ".git", "objects"));
      return dir;
    },
  },
  {
    name: "objects/ that is a dangling symlink",
    needs: ["posix"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.rmSync(path.join(dir, ".git", "objects"), { recursive: true });
      fs.symlinkSync(path.join(ROOT, "nowhere"), path.join(dir, ".git", "objects"));
      return dir;
    },
  },

  // `commondir`.
  {
    name: "a commondir naming a directory without objects/ and refs/",
    build: (id) => {
      const dir = copyRepo(inner(id));
      const empty = path.join(ROOT, "empty-common", id);
      fs.mkdirSync(empty, { recursive: true });
      fs.writeFileSync(path.join(dir, ".git", "commondir"), `${empty}\n`);
      return dir;
    },
  },
  {
    name: "an empty commondir file",
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.writeFileSync(path.join(dir, ".git", "commondir"), "");
      return dir;
    },
  },
  {
    name: "a commondir holding only a line feed",
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.writeFileSync(path.join(dir, ".git", "commondir"), "\n");
      return dir;
    },
  },
  {
    name: "a commondir that is a dangling symlink",
    needs: ["posix"],
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.symlinkSync(path.join(ROOT, "nowhere"), path.join(dir, ".git", "commondir"));
      return dir;
    },
  },
  {
    name: "a commondir that is a directory",
    build: (id) => {
      const dir = copyRepo(inner(id));
      fs.mkdirSync(path.join(dir, ".git", "commondir"));
      return dir;
    },
  },
  {
    name: "a linked worktree whose commondir has leading whitespace",
    build: (id) => {
      const { dir, privateGitDir } = linkedWorktree(id);
      fs.writeFileSync(path.join(privateGitDir, "commondir"), " ../..\n");
      return dir;
    },
  },
  {
    name: "a linked worktree whose private git directory has no commondir",
    build: (id) => {
      const { dir, privateGitDir } = linkedWorktree(id);
      fs.rmSync(path.join(privateGitDir, "commondir"));
      return dir;
    },
  },
  {
    name: "a linked worktree whose commondir goes up from a symlink's target",
    needs: ["posix"],
    build: (id) => {
      // Read as text, the path cancels out to the real common directory;
      // resolved by the filesystem, as git resolves it, it leads elsewhere.
      const { dir, main, privateGitDir } = linkedWorktree(id);
      const elsewhere = path.join(ROOT, "elsewhere", id, "deep");
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.symlinkSync(elsewhere, path.join(main, ".git", `link-${id}`));
      fs.writeFileSync(path.join(privateGitDir, "commondir"), `../../link-${id}/..\n`);
      return dir;
    },
  },

  // `.git` files.
  { name: "a .git file pointing at a git directory", build: (id) => dotGitFile(id, `gitdir: ${copyGitDir(id)}\n`) },
  {
    name: "a .git file with a relative pointer",
    build: (id) => {
      const target = copyGitDir(id);
      return dotGitFile(id, `gitdir: ${path.relative(inner(id), target)}\n`);
    },
  },
  {
    name: "a .git file pointer ending in a carriage return and a line feed",
    build: (id) => dotGitFile(id, `gitdir: ${copyGitDir(id)}\r\n`),
  },
  { name: "a .git file pointer without a final line feed", build: (id) => dotGitFile(id, `gitdir: ${copyGitDir(id)}`) },
  { name: "a .git file pointer without a space after the prefix", build: (id) => dotGitFile(id, `gitdir:${copyGitDir(id)}\n`) },
  { name: "a .git file pointer with a tab after the prefix", build: (id) => dotGitFile(id, `gitdir:\t${copyGitDir(id)}\n`) },
  { name: "a .git file pointer with two spaces after the prefix", build: (id) => dotGitFile(id, `gitdir:  ${copyGitDir(id)}\n`) },
  { name: "a .git file pointer with whitespace before the prefix", build: (id) => dotGitFile(id, ` gitdir: ${copyGitDir(id)}\n`) },
  { name: "a .git file pointer with an upper-case prefix", build: (id) => dotGitFile(id, `GITDIR: ${copyGitDir(id)}\n`) },
  { name: "a .git file pointer with trailing whitespace", build: (id) => dotGitFile(id, `gitdir: ${copyGitDir(id)} \n`) },
  { name: "a .git file pointer followed by a second line", build: (id) => dotGitFile(id, `gitdir: ${copyGitDir(id)}\nx\n`) },
  { name: "a .git file pointer to a missing directory", build: (id) => dotGitFile(id, `gitdir: ${path.join(ROOT, "missing", id)}\n`) },
  {
    name: "a .git file pointer with a NUL after the path",
    conservative: "git reads the path only up to the NUL; a pointer holding one is refused rather than cut short",
    build: (id) => dotGitFile(id, `gitdir: ${copyGitDir(id)}\u0000x\n`),
  },
  {
    name: "a .git file pointer to a git directory holding only HEAD",
    build: (id) => {
      const target = path.join(ROOT, "targets", `${id}.git`);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "HEAD"), REF);
      return dotGitFile(id, `gitdir: ${target}\n`);
    },
  },
  {
    name: "a .git file pointer to a git directory whose HEAD git rejects",
    build: (id) => {
      const target = copyGitDir(id);
      fs.writeFileSync(path.join(target, "HEAD"), `﻿${REF}`);
      return dotGitFile(id, `gitdir: ${target}\n`);
    },
  },
  {
    name: "a .git file pointer that goes up from a symlink's target",
    needs: ["posix"],
    build: (id) => {
      // Read as text, the pointer names a git directory planted next to the
      // `.git` file; resolved by the filesystem, as git resolves it, it
      // names a directory that does not exist.
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(path.join(TEMPLATE, ".git"), path.join(dir, "planted"), { recursive: true });
      const elsewhere = path.join(ROOT, "elsewhere", id, "deep");
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.symlinkSync(elsewhere, path.join(dir, "link"));
      fs.writeFileSync(path.join(dir, ".git"), "gitdir: link/../planted\n");
      return dir;
    },
  },
];

describe.skipIf(!GIT_AVAILABLE)("repository detection agrees with real git (differential, task 51bfba5a)", () => {
  beforeAll(() => {
    ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-gitdiff-")));
    OUTER = path.join(ROOT, "outer");
    fs.mkdirSync(OUTER);
    git(OUTER, "init", "-q");
    fs.writeFileSync(path.join(OUTER, "f"), "o\n");
    git(OUTER, "add", "f");
    git(OUTER, "commit", "-qm", "outer");
    TEMPLATE = path.join(ROOT, "template");
    fs.mkdirSync(TEMPLATE);
    git(TEMPLATE, "init", "-q");
    fs.writeFileSync(path.join(TEMPLATE, "g"), "i\n");
    git(TEMPLATE, "add", "g");
    git(TEMPLATE, "commit", "-qm", "inner");
    git(TEMPLATE, "tag", "v1");
    git(TEMPLATE, "switch", "-qc", "feat/x");
    SHA = git(TEMPLATE, "rev-parse", "HEAD");
    supported.sha256 = probe("init", "-q", "--object-format=sha256");
    supported.reftable = probe("init", "-q", "--ref-format=reftable");
    const probeMain = copyRepo(path.join(ROOT, "probe-main"));
    supported["relative-worktree"] =
      spawnSync("git", ["worktree", "add", "-q", "--relative-paths", "--detach", path.join(ROOT, "probe-wt")], {
        cwd: probeMain,
        env: gitEnv,
        stdio: "ignore",
      }).status === 0;
  });

  afterAll(() => {
    if (process.env.HARNESS_GIT_DIFFERENTIAL_TRANSCRIPT === "1") {
      console.log(`git differential transcript (${ROWS.length} rows)\n${transcript.join("\n")}`);
    }
    if (ROOT === "") return;
    // Restore the search permission a row removed, so the tree can be deleted.
    const rows = path.join(OUTER, "rows");
    for (const id of fs.existsSync(rows) ? fs.readdirSync(rows) : []) {
      for (const name of ["objects", "refs"]) {
        const p = path.join(rows, id, ".git", name);
        try {
          if (fs.lstatSync(p).isDirectory()) fs.chmodSync(p, 0o755);
        } catch {
          /* not there */
        }
      }
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("has at least 30 rows and lists every allowlisted divergence with a reason", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
    for (const row of ROWS) {
      if (row.conservative !== undefined) expect(row.conservative.trim(), row.name).not.toBe("");
      expect(row.legit === true && row.conservative !== undefined, row.name).toBe(false);
    }
  });

  ROWS.forEach((row, index) => {
    it(`row ${index + 1}: ${row.name}`, (ctx) => {
      const missing = (row.needs ?? []).filter((need) => !supported[need]);
      if (missing.length > 0) {
        transcript.push(`row ${index + 1} SKIPPED (${missing.join(", ")} unavailable): ${row.name}`);
        ctx.skip(`needs ${missing.join(", ")}, which this git or platform does not provide`);
        return;
      }
      const id = `r${index + 1}`;
      const built = row.build(id);
      const cwd = typeof built === "string" ? built : built.cwd;
      const repoRoot = typeof built === "string" ? built : (built.repoRoot ?? built.cwd);
      const gitTop = gitToplevel(cwd);
      const entry = findGitEntry(cwd);
      const ctxResolved = resolveGitContext(cwd);
      const rel = (p: string | null): string => (p === null ? "(none)" : path.relative(ROOT, p) || ".");
      const harness =
        entry === null ? "(none)" : entry.refused !== undefined ? `refused ${entry.refused}` : `resolved ${rel(entry.worktreeRoot)}`;
      transcript.push(
        `row ${index + 1}: ${row.name}\n  git: ${rel(gitTop)}${gitTop === repoRoot ? " (accepts it)" : ""}\n  harness: ${harness}` +
          ` branch=${JSON.stringify(ctxResolved.branch)}${row.conservative !== undefined ? "\n  allowlisted: " + row.conservative : ""}`,
      );

      if (entry === null) {
        expect(gitTop, "the lookup finds no repository where git finds one").toBeNull();
        return;
      }
      if (entry.refused === undefined) {
        // Never a repository git does not resolve from here.
        expect(entry.worktreeRoot, `the lookup resolves ${rel(entry.worktreeRoot)}, git ${rel(gitTop)}`).toBe(gitTop);
        expect(ctxResolved.refused).toBeUndefined();
        expect(ctxResolved.repo).toBe(path.basename(entry.worktreeRoot));
        expect(row.conservative, "an allowlisted row that no longer diverges must leave the allowlist").toBeUndefined();
        if (row.skipBranchCompare === undefined) expect(ctxResolved.branch).toBe(gitBranch(cwd));
        return;
      }
      // Refused: no branch, and the refusal is visible to a deny-capable caller.
      expect(ctxResolved.branch).toBe("");
      expect(ctxResolved.refused ?? []).toContain(entry.refused);
      expect(row.legit, "a layout git writes itself must not be refused").not.toBe(true);
      if (gitTop === repoRoot) {
        expect(row.conservative, "refused where git accepts the repository: allowlist it with a reason, or fix it").toBeDefined();
      } else {
        expect(row.conservative, "an allowlisted row that no longer diverges must leave the allowlist").toBeUndefined();
      }
    });
  });
});
