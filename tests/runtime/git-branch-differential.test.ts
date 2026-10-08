// Differential test of the branch-protection gate against real git (task
// a4d8adc5), adapted from the repository-detection differential in
// tests/runtime/git-context-differential.test.ts: the same layouts, built the
// same way, inside an outer repository on `master`. Every row asks two sides
// about the row's directory: git, run plainly there (`git symbolic-ref -q
// HEAD`), and the gate (the presence walk plus the git reader of
// src/runtime/git-branch.ts, and the hook itself on a Write into that
// directory).
//
// The rule is one-sided: the hook never allows where git, run plainly in
// that directory, names a protected branch. A planted layout git rejects
// either stops git with an error (the hook refuses) or makes git resolve the
// enclosing repository, whose branch is protected (the hook refuses too).
// Layouts git writes itself (`legit`: linked worktrees, submodules, a
// separate git directory, SHA-256, reftable, packed refs, a symlinked HEAD)
// must resolve git's own branch. The reader must also report what git
// reports, and the hook must decide from the reader's answers alone.
//
// "That directory" is every directory the hook judges a write in. As the
// operating system resolves the path: the directory holding the written path
// (git runs there and the operating system follows symlinks and `..` on the
// way), and, when the written path is itself a symlink, the directory it
// leads to. As written: the path made absolute with `.` and `..` resolved on
// the text, shortened to its nearest existing directory, symlinks left in
// place. The hook refuses when either judgment refuses or cannot answer. Most
// symlink rows are built outside the outer repository, so the presence walk
// meets no `.git` on the text of the path.
//
// Rows that need a repository format or a worktree option the installed git
// lacks are skipped visibly; the whole file is skipped only when there is no
// git at all. Set HARNESS_GIT_DIFFERENTIAL_TRANSCRIPT=1 to print what both
// sides said for every row, how long the hook took, and the row counts.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import {
  GIT_BRANCH_TIMEOUT_MS,
  classifyGitHeadAnswer,
  hasGitEntryAbove,
  readBranch,
  readGitHead,
  type BranchRead,
} from "../../src/runtime/git-branch.js";
import { parseManifest } from "../../src/schema/index.js";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const POSIX = process.platform !== "win32";
const ROOT_USER = process.getuid?.() === 0;

type Need = "sha256" | "reftable" | "relative-worktree" | "posix" | "non-root" | "no-repository-above-tmp";

interface Built {
  /** Where both sides look from. */
  cwd: string;
  /** The work tree the row is about (`cwd` unless the row starts below it). */
  repoRoot?: string;
  /** The path the hook's Write targets, as written (default `<cwd>/new-file.txt`). */
  target?: string;
}

interface Row {
  /** A generic description of the shape (no concrete bypass text). */
  name: string;
  build: (id: string) => string | Built;
  needs?: Need[];
  /** A layout git writes itself: must resolve git's own branch (or detached HEAD). */
  legit?: boolean;
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

/** What git, run plainly in `cwd`, says about HEAD. */
interface PlainGit {
  status: number | null;
  /** The branch for `refs/heads/<name>` on exit 0, else null. */
  branch: string | null;
  stdout: string;
  stderr: string;
}

function gitPlain(cwd: string): PlainGit {
  const r = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd, env: gitEnv, encoding: "utf8", timeout: 10_000 });
  const stdout = r.stdout ?? "";
  const m = r.status === 0 ? /^refs\/heads\/(.+)\n$/.exec(stdout) : null;
  return { status: r.status, branch: m ? m[1]! : null, stdout, stderr: r.stderr ?? "" };
}

const PROTECTED = ["master", "main", "develop"];
/** The test's own oracle for "a protected name": the default list, case folded. */
const namesProtected = (branch: string): boolean => PROTECTED.includes(branch.toLowerCase());
const MANIFEST = parseManifest({ version: 1, policy_packs: [{ name: "branch-protection" }] });

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString("utf8"));
        cb();
      },
    }),
    text: () => chunks.join(""),
  };
}

/** The hook's decision on a Write of `target` from the event cwd `cwd`, and how long it took. */
async function hookOnWrite(cwd: string, target: string): Promise<{ blocked: boolean; diagnostic: string; ms: number }> {
  const out = sink();
  const err = sink();
  const event = { tool_name: "Write", cwd, tool_input: { file_path: target, content: "x" } };
  const started = performance.now();
  const r = await runPackHookBranchProtectionCli({
    stdin: Readable.from([JSON.stringify(event)]),
    stdout: out.stream,
    stderr: err.stream,
    manifest: MANIFEST,
  });
  return { blocked: r.blocked, diagnostic: r.diagnostic, ms: performance.now() - started };
}

/**
 * The directory a Write of `target` names as written: the path made absolute
 * against `cwd` with `.` and `..` resolved on the text, its parent, shortened
 * until it names an existing directory. Symlinks stay in the result.
 */
function writtenDirectory(cwd: string, target: string): string {
  let current = path.dirname(path.resolve(cwd, target));
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      /* not there: one level up */
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** The gate's reading of a directory taken as written: the presence walk on its text, then git there. */
async function readAsWritten(dir: string): Promise<BranchRead> {
  if (!hasGitEntryAbove(dir)) return { kind: "outside" };
  return classifyGitHeadAnswer(await readGitHead(dir, GIT_BRANCH_TIMEOUT_MS));
}

/**
 * Where a Write of `target` lands, left to the operating system to resolve:
 * the directory holding it, written as text (git is run there, and the
 * operating system follows symlinks and `..` when it changes into it), and,
 * when `target` is a symlink, the directory it leads to.
 */
function landingDirectories(cwd: string, target: string): string[] {
  const abs = path.isAbsolute(target) ? target : `${cwd}${path.sep}${target}`;
  const out = [path.dirname(abs)];
  let isLink = false;
  try {
    isLink = fs.lstatSync(abs).isSymbolicLink();
  } catch {
    /* not there yet */
  }
  if (isLink) {
    try {
      out.push(path.dirname(fs.realpathSync.native(abs)));
    } catch {
      const text = fs.readlinkSync(abs);
      out.push(path.dirname(path.isAbsolute(text) ? text : `${path.dirname(abs)}${path.sep}${text}`));
    }
  }
  return out;
}

function describeRead(r: BranchRead): string {
  return r.kind === "branch" ? `branch ${JSON.stringify(r.name)}` : r.kind === "error" ? `error (${r.detail})` : r.kind;
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
  "no-repository-above-tmp": false,
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

/** A checkout on `master` outside the outer work tree, with `src/real.ts`. */
function protectedCheckout(id: string): { repo: string; src: string } {
  const repo = copyRepo(path.join(ROOT, "protected", id));
  git(repo, "checkout", "-q", "master");
  const src = path.join(repo, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "real.ts"), "x\n");
  return { repo, src };
}

/** A directory outside the outer work tree (and outside every repository when the temp directory is). */
function outsideDir(id: string): string {
  const dir = path.join(ROOT, "outside", id);
  fs.mkdirSync(dir, { recursive: true });
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
  ["a byte-order mark before the ref prefix", () => `\ufeff${REF}`],
  ["a no-break space before the ref prefix", () => `\u00a0${REF}`],
  ["a vertical tab after the ref prefix", () => "ref:\u000brefs/heads/feat/x\n"],
  ["a form feed after the ref prefix", () => "ref:\u000crefs/heads/feat/x\n"],
  ["a no-break space after the ref prefix", () => "ref:\u00a0refs/heads/feat/x\n"],
  ["a line separator after the ref prefix", () => "ref:\u2028refs/heads/feat/x\n"],
  ["whitespace before an object id", () => ` ${sha()}\n`],
  ["a byte-order mark before an object id", () => `\ufeff${sha()}\n`],
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
    build: (id) => dotGitWithHead(id, `${SHA}xyz\n`),
  },
  {
    name: "HEAD naming refs/heads/ with no branch",
    build: (id) => dotGitWithHead(id, "ref: refs/heads/\n"),
  },
  {
    name: "HEAD naming refs/ with no ref",
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
      fs.writeFileSync(path.join(target, "HEAD"), `\ufeff${REF}`);
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

  // Shapes the presence walk meets before git does.
  {
    name: "a directory outside every repository",
    needs: ["no-repository-above-tmp"],
    build: (id) => {
      const dir = path.join(ROOT, "outside", id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  },
  {
    name: "a .git that is a FIFO",
    needs: ["posix"],
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("mkfifo", [path.join(dir, ".git")]);
      return dir;
    },
  },
  {
    name: "a .git that is a dangling symlink",
    needs: ["posix"],
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(ROOT, "nowhere"), path.join(dir, ".git"));
      return dir;
    },
  },
  {
    name: "an empty .git directory",
    build: (id) => {
      const dir = inner(id);
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      return dir;
    },
  },
  {
    name: "a repository on a protected branch nested in the outer one",
    legit: true,
    build: (id) => {
      const dir = copyRepo(inner(id));
      git(dir, "switch", "-qc", "main");
      return dir;
    },
  },
  {
    name: "a repository on a case variant of a protected branch",
    legit: true,
    build: (id) => {
      const dir = copyRepo(inner(id));
      git(dir, "switch", "-qc", "Develop");
      return dir;
    },
  },

  // Symlinks: the write lands where the operating system resolves the path.
  {
    name: "a directory symlink outside every repository into a checkout on a protected branch",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { src } = protectedCheckout(id);
      const link = path.join(outsideDir(id), "link");
      fs.symlinkSync(src, link);
      return link;
    },
  },
  {
    name: "a file symlink outside every repository to a file in a checkout on a protected branch",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { src } = protectedCheckout(id);
      const out = outsideDir(id);
      fs.symlinkSync(path.join(src, "real.ts"), path.join(out, "file-link.ts"));
      return { cwd: out, target: path.join(out, "file-link.ts") };
    },
  },
  {
    name: "a dangling file symlink outside every repository into a checkout on a protected branch",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { src } = protectedCheckout(id);
      const out = outsideDir(id);
      fs.symlinkSync(path.join(src, "new.ts"), path.join(out, "dangling.ts"));
      return { cwd: out, target: path.join(out, "dangling.ts") };
    },
  },
  {
    name: "a symlink outside every repository to the root of a checkout on a protected branch",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { repo } = protectedCheckout(id);
      const link = path.join(outsideDir(id), "repo-link");
      fs.symlinkSync(repo, link);
      return link;
    },
  },
  {
    name: "a target path that goes up from a symlink's target, outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { src } = protectedCheckout(id);
      const out = outsideDir(id);
      fs.symlinkSync(src, path.join(out, "link"));
      return { cwd: out, target: `${out}/link/../new-file.txt` };
    },
  },
  {
    name: "an event cwd that goes up from a symlink's target, outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { src } = protectedCheckout(id);
      const out = outsideDir(id);
      fs.symlinkSync(src, path.join(out, "link"));
      return { cwd: `${out}/link/..`, target: "new-file.txt" };
    },
  },
  {
    name: "a directory symlink in a checkout on a protected branch into a checkout on a feature branch",
    needs: ["posix"],
    build: (id) => {
      const { repo } = protectedCheckout(id);
      const feat = copyRepo(path.join(ROOT, "feature", id));
      fs.symlinkSync(feat, path.join(repo, "to-feat"));
      return path.join(repo, "to-feat");
    },
  },
  {
    name: "a directory symlink in a checkout on a protected branch to a directory outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { repo } = protectedCheckout(id);
      fs.symlinkSync(outsideDir(id), path.join(repo, "to-outside"));
      return path.join(repo, "to-outside");
    },
  },

  // As written: `..` after a symlink is resolved on the text as well.
  {
    name: "a target path that goes up from a symlink in a checkout on a protected branch whose target is outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { repo } = protectedCheckout(id);
      const sub = path.join(outsideDir(id), "sub");
      fs.mkdirSync(sub);
      fs.symlinkSync(sub, path.join(repo, "lnk"));
      return { cwd: repo, target: `${repo}/lnk/../new-file.txt` };
    },
  },
  {
    name: "a relative target path that goes up from a symlink in a checkout on a protected branch whose target is outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { repo } = protectedCheckout(id);
      const sub = path.join(outsideDir(id), "sub");
      fs.mkdirSync(sub);
      fs.symlinkSync(sub, path.join(repo, "lnk"));
      return { cwd: repo, target: "lnk/../new-file.txt" };
    },
  },
  {
    name: "an event cwd that goes up from a symlink in a checkout on a protected branch whose target is outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const { repo } = protectedCheckout(id);
      const sub = path.join(outsideDir(id), "sub");
      fs.mkdirSync(sub);
      fs.symlinkSync(sub, path.join(repo, "lnk"));
      return { cwd: `${repo}/lnk/..`, target: "new-file.txt" };
    },
  },
  {
    name: "a target path that goes up from a symlink in a checkout on a feature branch whose target is outside every repository",
    needs: ["posix", "no-repository-above-tmp"],
    build: (id) => {
      const repo = copyRepo(path.join(ROOT, "feature", id));
      const sub = path.join(outsideDir(id), "sub");
      fs.mkdirSync(sub);
      fs.symlinkSync(sub, path.join(repo, "lnk"));
      return { cwd: repo, target: `${repo}/lnk/../new-file.txt` };
    },
  },
];

const tally = {
  rows: 0,
  skipped: 0,
  legit: 0,
  refusedProtected: 0,
  refusedError: 0,
  allowed: 0,
  plainNamesProtected: 0,
  writtenNamesProtected: 0,
};
/** How long the hook took per row, for the transcript's slowest rows. */
const timings: Array<{ row: number; name: string; ms: number }> = [];

describe.skipIf(!GIT_AVAILABLE)("the branch-protection gate agrees with real git (differential, task a4d8adc5)", () => {
  beforeAll(() => {
    ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-gitbranchdiff-")));
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
    supported["no-repository-above-tmp"] = !hasGitEntryAbove(ROOT);
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
      const slowest = [...timings]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5)
        .map((t) => `  row ${t.row} (${t.ms.toFixed(1)} ms): ${t.name}`);
      console.log(
        `git branch differential transcript (${ROWS.length} rows; tally ${JSON.stringify(tally)})\n${transcript.join("\n")}\n` +
          `slowest hook calls:\n${slowest.join("\n")}`,
      );
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

  it("has at least 60 rows with unique names", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
  });

  ROWS.forEach((row, index) => {
    it(`row ${index + 1}: ${row.name}`, async (ctx) => {
      tally.rows += 1;
      const missing = (row.needs ?? []).filter((need) => !supported[need]);
      if (missing.length > 0) {
        tally.skipped += 1;
        transcript.push(`row ${index + 1} SKIPPED (${missing.join(", ")} unavailable): ${row.name}`);
        ctx.skip(`needs ${missing.join(", ")}, which this git or platform does not provide`);
        return;
      }
      const id = `r${index + 1}`;
      const built = row.build(id);
      const cwd = typeof built === "string" ? built : built.cwd;
      const target = (typeof built === "string" ? undefined : built.target) ?? `${cwd}${path.sep}new-file.txt`;
      const landings = landingDirectories(cwd, target);
      const plains = landings.map((dir) => gitPlain(dir));
      const reads: BranchRead[] = [];
      for (const dir of landings) reads.push(await readBranch(dir));
      const written = writtenDirectory(cwd, target);
      const plainWritten = gitPlain(written);
      const readWritten = await readAsWritten(written);
      const hook = await hookOnWrite(cwd, target);
      timings.push({ row: index + 1, name: row.name, ms: hook.ms });
      transcript.push(
        `row ${index + 1}: ${row.name}` +
          landings
            .map(
              (dir, i) =>
                `${landings.length > 1 ? `\n  lands in ${dir}` : ""}` +
                `\n  git: exit ${plains[i]!.status} ${JSON.stringify(plains[i]!.stdout.trim())}` +
                `\n  reader: ${describeRead(reads[i]!)}`,
            )
            .join("") +
          `\n  as written ${written}: git: exit ${plainWritten.status} ${JSON.stringify(plainWritten.stdout.trim())}; reader: ${describeRead(readWritten)}` +
          `\n  hook: ${hook.blocked ? "refuses" : "allows"} in ${hook.ms.toFixed(1)} ms (${hook.diagnostic})`,
      );

      // The rule, as written: never allow where git, run plainly in the directory the path names as written, names a protected branch.
      if (plainWritten.branch !== null && namesProtected(plainWritten.branch)) {
        tally.writtenNamesProtected += 1;
        expect(hook.blocked, `git names "${plainWritten.branch}" in ${written} (as written)`).toBe(true);
      }
      // Where the presence walk on the text finds a .git, the as-written reading is git's own answer there.
      if (readWritten.kind !== "outside") {
        if (plainWritten.branch !== null) expect(readWritten).toEqual({ kind: "branch", name: plainWritten.branch });
        else if (plainWritten.status === 1 && plainWritten.stdout === "" && plainWritten.stderr === "") expect(readWritten).toEqual({ kind: "detached" });
        else expect(readWritten.kind, `git as written: exit ${plainWritten.status} ${JSON.stringify(plainWritten.stderr)}`).toBe("error");
      }

      landings.forEach((dir, i) => {
        const plain = plains[i]!;
        const read = reads[i]!;

        // The rule: never allow where git, run plainly where the write lands, names a protected branch.
        if (plain.branch !== null && namesProtected(plain.branch)) {
          tally.plainNamesProtected += 1;
          expect(hook.blocked, `git names "${plain.branch}" in ${dir}`).toBe(true);
        }

        // The reader reports what git reports.
        if (read.kind === "outside") {
          expect(plain.status, "the presence walk found no .git, so git must not find a repository").not.toBe(0);
          expect(plain.status, "the presence walk found no .git, so git must not find a repository").not.toBe(1);
        } else if (plain.branch !== null) {
          expect(read).toEqual({ kind: "branch", name: plain.branch });
        } else if (plain.status === 1 && plain.stdout === "" && plain.stderr === "") {
          expect(read).toEqual({ kind: "detached" });
        } else {
          expect(read.kind, `git: exit ${plain.status} ${JSON.stringify(plain.stdout)} ${JSON.stringify(plain.stderr)}`).toBe("error");
        }

        // Layouts git writes itself resolve git's own branch (or its detached HEAD).
        if (row.legit === true) {
          expect(["branch", "detached"], "a layout git writes itself must not be an error").toContain(read.kind);
        }
      });
      if (row.legit === true) {
        expect(["branch", "detached"], "a layout git writes itself must not be an error as written either").toContain(readWritten.kind);
        tally.legit += 1;
      }

      // The hook decides from the readers' answers alone, both judgments together.
      const allReads = [readWritten, ...reads];
      const anyError = allReads.some((r) => r.kind === "error");
      const shouldRefuse = anyError || allReads.some((r) => r.kind === "branch" && namesProtected(r.name));
      expect(hook.blocked, hook.diagnostic).toBe(shouldRefuse);
      if (anyError) tally.refusedError += 1;
      else if (shouldRefuse) tally.refusedProtected += 1;
      else tally.allowed += 1;
    });
  });
});
