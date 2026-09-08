import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveProjectName,
  resolveCommonDir,
  resolveGitContext,
  resolveOriginHeadBase,
} from "../../src/runtime/git-context.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gitctx-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_SHA = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const ALT_SHA = "1111111111111111111111111111111111111111";

/**
 * Create `<root>/<name>/.git/` as a directory with the given HEAD and,
 * when `headSha` is provided AND HEAD is a `ref:` pointer, a loose ref
 * file at the resolved path so resolveGitContext can pick up the sha.
 */
function makeRepo(
  root: string,
  name: string,
  head: string,
  headSha?: string,
): string {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `${head}\n`);
  if (headSha !== undefined) {
    const branchMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (branchMatch) {
      const refPath = path.join(repo, ".git", "refs", "heads", branchMatch[1]!);
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.writeFileSync(refPath, `${headSha}\n`);
    }
  }
  return repo;
}

/**
 * Create a linked-worktree layout: `<root>/main-repo/.git/worktrees/wt/`
 * (the per-worktree gitdir) plus `<root>/linked-worktree/.git` (the
 * gitlink file pointing at it), matching what `git worktree add`
 * actually produces. `opts.head`, when given, is written to the
 * per-worktree gitdir's `HEAD` file (with a trailing newline). `opts.commondir`,
 * when given, is written to the per-worktree gitdir's `commondir` file
 * (with a trailing newline); omit it to leave no `commondir` file at all.
 * Returns both gitdirs and the worktree path so callers can write refs
 * or `packed-refs` into either one.
 */
function makeLinkedWorktree(
  root: string,
  opts: { head?: string; commondir?: string } = {},
): { worktree: string; wtGitDir: string; mainGitDir: string } {
  const mainGitDir = path.join(root, "main-repo", ".git");
  const wtGitDir = path.join(mainGitDir, "worktrees", "wt");
  fs.mkdirSync(wtGitDir, { recursive: true });
  if (opts.head !== undefined) {
    fs.writeFileSync(path.join(wtGitDir, "HEAD"), `${opts.head}\n`);
  }
  if (opts.commondir !== undefined) {
    fs.writeFileSync(path.join(wtGitDir, "commondir"), `${opts.commondir}\n`);
  }
  const worktree = path.join(root, "linked-worktree");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
  return { worktree, wtGitDir, mainGitDir };
}

describe("resolveGitContext", () => {
  it("resolves repo + branch + sha from a loose ref file", () => {
    const repo = makeRepo(tmpDir(), "my-project", "ref: refs/heads/main", FAKE_SHA);
    expect(resolveGitContext(repo)).toEqual({
      repo: "my-project",
      branch: "main",
      sha: FAKE_SHA,
    });
  });

  it("keeps a slashed branch name intact and resolves its sha", () => {
    const repo = makeRepo(tmpDir(), "harness", "ref: refs/heads/fix/some-bug", FAKE_SHA);
    expect(resolveGitContext(repo)).toEqual({
      repo: "harness",
      branch: "fix/some-bug",
      sha: FAKE_SHA,
    });
  });

  it("walks up from a nested cwd to find the work-tree root", () => {
    const repo = makeRepo(tmpDir(), "deep-repo", "ref: refs/heads/dev", FAKE_SHA);
    const nested = path.join(repo, "src", "cli", "policy");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveGitContext(nested)).toEqual({
      repo: "deep-repo",
      branch: "dev",
      sha: FAKE_SHA,
    });
  });

  it("falls back to packed-refs when the loose ref is absent", () => {
    const repo = makeRepo(tmpDir(), "packed", "ref: refs/heads/main");
    fs.writeFileSync(
      path.join(repo, ".git", "packed-refs"),
      [
        "# pack-refs with: peeled fully-peeled sorted",
        `${FAKE_SHA} refs/heads/main`,
        `${ALT_SHA} refs/tags/v1.0.0`,
        `^${FAKE_SHA}`, // peeled annotation, must be skipped
        "",
      ].join("\n"),
    );
    expect(resolveGitContext(repo)).toEqual({
      repo: "packed",
      branch: "main",
      sha: FAKE_SHA,
    });
  });

  it("returns the raw sha for a detached HEAD (no branch)", () => {
    const repo = makeRepo(tmpDir(), "detached", FAKE_SHA);
    expect(resolveGitContext(repo)).toEqual({
      repo: "detached",
      branch: "",
      sha: FAKE_SHA,
    });
  });

  it("returns empty strings when a directory-form .git has no HEAD", () => {
    const root = tmpDir();
    const repo = path.join(root, "no-head");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(resolveGitContext(repo)).toEqual({ repo: "", branch: "", sha: "" });
  });

  it("resolves branch but empty sha when neither loose ref nor packed-refs has it", () => {
    const repo = makeRepo(tmpDir(), "no-ref-file", "ref: refs/heads/main");
    expect(resolveGitContext(repo)).toEqual({
      repo: "no-ref-file",
      branch: "main",
      sha: "",
    });
  });

  it("follows a `.git` file (linked worktree) to its gitdir for HEAD + sha", () => {
    const root = tmpDir();
    const { worktree, wtGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
    });
    const refPath = path.join(wtGitDir, "refs", "heads", "wt-branch");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${FAKE_SHA}\n`);
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: FAKE_SHA,
    });
  });

  it("resolves repo but empty branch + sha when a `.git` file is unparseable", () => {
    const root = tmpDir();
    const worktree = path.join(root, "broken-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), "not a gitdir pointer\n");
    expect(resolveGitContext(worktree)).toEqual({
      repo: "broken-worktree",
      branch: "",
      sha: "",
    });
  });

  it("returns empty strings when cwd is not inside a git work tree", () => {
    const root = tmpDir();
    const plain = path.join(root, "just", "some", "dirs");
    fs.mkdirSync(plain, { recursive: true });
    expect(resolveGitContext(plain)).toEqual({ repo: "", branch: "", sha: "" });
  });

  it("returns empty strings for an empty cwd", () => {
    expect(resolveGitContext("")).toEqual({ repo: "", branch: "", sha: "" });
  });

  it("rejects a HEAD file whose sha is non-hex (treats as unresolved)", () => {
    const repo = makeRepo(tmpDir(), "bad-sha", "not-a-sha-at-all");
    expect(resolveGitContext(repo)).toEqual({ repo: "bad-sha", branch: "", sha: "" });
  });

  it("resolves an attached branch in a linked worktree via commondir (refs only in the common dir)", () => {
    const root = tmpDir();
    // `commondir` is a path relative to the per-worktree gitdir, per
    // `git-worktree(1)` (normally `../..`).
    const { worktree, mainGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
      commondir: "../..",
    });
    // The branch ref lives only in the common dir, never in wtGitDir.
    const refPath = path.join(mainGitDir, "refs", "heads", "wt-branch");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${FAKE_SHA}\n`);
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: FAKE_SHA,
    });
  });

  it("resolves an attached branch in a linked worktree via an ABSOLUTE commondir path", () => {
    // `commondir` may also be an absolute path (git writes a relative
    // one, but nothing in the format forbids absolute); pin the
    // `path.isAbsolute(raw) ? raw : ...` branch in `resolveCommonDir`
    // separately from the relative-path case above.
    //
    // A trailing slash on the raw absolute path is deliberate: for a
    // "clean" absolute path, `path.resolve(gitDir, raw)` (the mutant
    // that always resolves, dropping the `isAbsolute` branch) produces
    // the identical normalized string as `raw` itself, so no test could
    // ever distinguish the two branches that way: Node's `path.resolve`
    // discards `gitDir` entirely once it hits an absolute argument and
    // just normalizes `raw`. The trailing slash survives untouched on
    // the `raw` branch but gets stripped by `path.resolve`'s
    // normalization, which is what actually makes the two branches
    // observably different.
    const root = tmpDir();
    const mainGitDir = path.join(root, "main-repo", ".git");
    const rawCommondir = `${mainGitDir}${path.sep}`;
    const { worktree, wtGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
      commondir: rawCommondir,
    });
    const refPath = path.join(mainGitDir, "refs", "heads", "wt-branch");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${FAKE_SHA}\n`);
    expect(resolveCommonDir(wtGitDir)).toBe(rawCommondir);
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: FAKE_SHA,
    });
  });

  it("resolves an attached branch in a linked worktree via commondir, falling back to packed-refs", () => {
    const root = tmpDir();
    const { worktree, mainGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
      commondir: "../..",
    });
    fs.writeFileSync(
      path.join(mainGitDir, "packed-refs"),
      ["# pack-refs with: peeled fully-peeled sorted", `${FAKE_SHA} refs/heads/wt-branch`, ""].join(
        "\n",
      ),
    );
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: FAKE_SHA,
    });
  });

  it("resolves a detached HEAD in a linked worktree regardless of commondir", () => {
    const root = tmpDir();
    const { worktree } = makeLinkedWorktree(root, {
      head: FAKE_SHA,
      commondir: "../..",
    });
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "",
      sha: FAKE_SHA,
    });
  });

  it("falls back to today's behaviour (reads refs from gitDir) when no commondir file exists", () => {
    // Same shape as the "follows a `.git` file" test above: no
    // `commondir` written, so `resolveCommonDir` returns `wtGitDir`
    // unchanged and the ref is read directly from it.
    const root = tmpDir();
    const { worktree, wtGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
    });
    const refPath = path.join(wtGitDir, "refs", "heads", "wt-branch");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${FAKE_SHA}\n`);
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: FAKE_SHA,
    });
  });

  it("resolves as if no commondir file exists when it is present but empty/whitespace-only", () => {
    // An empty (or whitespace-only) `commondir` file falls through the
    // `raw.length > 0` guard in `resolveCommonDir`, which returns
    // `gitDir` unchanged; refs are read from the per-worktree gitdir,
    // same as the "no commondir file at all" case above.
    const root = tmpDir();
    const { worktree, wtGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
      commondir: "",
    });
    const refPath = path.join(wtGitDir, "refs", "heads", "wt-branch");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${FAKE_SHA}\n`);
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: FAKE_SHA,
    });
  });

  it("resolves empty branch + sha (never throws) when commondir points at a non-existent path", () => {
    const root = tmpDir();
    const { worktree } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
      commondir: "../../does-not-exist",
    });
    expect(() => resolveGitContext(worktree)).not.toThrow();
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: "",
    });
  });

  it("resolves empty branch + sha (never throws) when reading commondir itself throws", () => {
    // The non-existent-path case above never actually exercises
    // resolveCommonDir's try/catch: readFileSync throws ENOENT on the
    // MISSING `commondir` file itself, which is exactly the "no
    // commondir file" case resolveCommonDir already handles by
    // returning gitDir unchanged (that gitDir just happens not to have
    // the branch ref either, so the assertions above pass for the wrong
    // reason). Make `commondir` EXIST but be unreadable as a file: write
    // it as a directory, so `readFileSync` throws EISDIR and the
    // try/catch in `resolveCommonDir` is what's actually pinned.
    const root = tmpDir();
    const { worktree, wtGitDir } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
    });
    fs.mkdirSync(path.join(wtGitDir, "commondir"));
    expect(() => resolveGitContext(worktree)).not.toThrow();
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
      sha: "",
    });
  });
});

describe("resolveOriginHeadBase in a linked worktree", () => {
  it("resolves the default branch from a linked worktree's common dir, not its private gitdir (already routed through resolveCommonDir by its callers)", () => {
    const root = tmpDir();
    const { wtGitDir, mainGitDir } = makeLinkedWorktree(root, { commondir: "../.." });
    // origin/HEAD lives only in the common dir, never in wtGitDir.
    const originHeadPath = path.join(mainGitDir, "refs", "remotes", "origin", "HEAD");
    fs.mkdirSync(path.dirname(originHeadPath), { recursive: true });
    fs.writeFileSync(originHeadPath, "ref: refs/remotes/origin/main\n");
    expect(resolveOriginHeadBase(resolveCommonDir(wtGitDir))).toBe("main");
    // Without the commondir indirection the lookup misses entirely.
    expect(resolveOriginHeadBase(wtGitDir)).toBeNull();
  });
});

/**
 * Create a linked-worktree layout of a BARE repository: `<root>/<bareDirName>`
 * IS the git dir itself (no `.git` wrapper, a bare repo's top-level
 * directory holds `HEAD`/`objects`/`refs`/`worktrees` directly), with a
 * private per-worktree gitdir under `<bareDirName>/worktrees/<name>`
 * whose `commondir` file (`../..`) resolves straight back to
 * `<bareDirName>`, there is no further `.git` to go up from, unlike a
 * non-bare main checkout's `<main>/.git`.
 */
function makeLinkedWorktreeOfBareRepo(
  root: string,
  bareDirName: string,
  opts: { head?: string } = {},
): { worktree: string; bareDir: string } {
  const bareDir = path.join(root, bareDirName);
  const perWorktreeDir = path.join(bareDir, "worktrees", "wt");
  fs.mkdirSync(perWorktreeDir, { recursive: true });
  if (opts.head !== undefined) {
    fs.writeFileSync(path.join(perWorktreeDir, "HEAD"), `${opts.head}\n`);
  }
  fs.writeFileSync(path.join(perWorktreeDir, "commondir"), "../..\n");
  const worktree = path.join(root, "bare-linked-worktree");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${perWorktreeDir}\n`);
  return { worktree, bareDir };
}

describe("deriveProjectName (task c88461c1, review round 2, decision D-021a)", () => {
  it("derives the main checkout's own basename for a normal (non-worktree) repo", () => {
    const repo = makeRepo(tmpDir(), "solo-project", "ref: refs/heads/main");
    expect(deriveProjectName(repo)).toBe("solo-project");
  });

  it("walks up from a nested cwd to the main checkout's basename", () => {
    const repo = makeRepo(tmpDir(), "deep-project", "ref: refs/heads/main");
    const nested = path.join(repo, "src", "cli");
    fs.mkdirSync(nested, { recursive: true });
    expect(deriveProjectName(nested)).toBe("deep-project");
  });

  it("resolves a linked worktree to the MAIN checkout's basename, not its own directory name", () => {
    const root = tmpDir();
    const { worktree } = makeLinkedWorktree(root, {
      head: "ref: refs/heads/wt-branch",
      commondir: "../..",
    });
    // makeLinkedWorktree names the main checkout "main-repo" and the
    // linked worktree itself "linked-worktree" (see its doc comment
    // above); the derived name must be the FORMER, matching every
    // other worktree of the same repository, never the latter.
    expect(deriveProjectName(worktree)).toBe("main-repo");
    expect(deriveProjectName(worktree)).not.toBe(path.basename(worktree));
  });

  it("resolves the identical project name from the main checkout and a linked worktree of it", () => {
    // Build a MAIN checkout via makeRepo (a real `.git/HEAD`, unlike
    // makeLinkedWorktree's own hardcoded "main-repo", which only ever
    // populates the PER-WORKTREE side and leaves the main checkout's own
    // `.git/HEAD` absent), then hand-add a linked worktree pointing at
    // its gitdir, mirroring `git worktree add`'s real layout.
    const root = tmpDir();
    const mainCheckout = makeRepo(root, "main-repo", "ref: refs/heads/main");
    const mainGitDir = path.join(mainCheckout, ".git");
    const perWorktreeDir = path.join(mainGitDir, "worktrees", "wt1");
    fs.mkdirSync(perWorktreeDir, { recursive: true });
    fs.writeFileSync(path.join(perWorktreeDir, "HEAD"), "ref: refs/heads/wt-branch\n");
    fs.writeFileSync(path.join(perWorktreeDir, "commondir"), "../..\n");
    const worktree = path.join(root, "linked-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${perWorktreeDir}\n`);

    expect(deriveProjectName(mainCheckout)).toBe("main-repo");
    expect(deriveProjectName(worktree)).toBe("main-repo");
  });

  it("applies the bare directory's own basename directly for a linked worktree of a bare repository", () => {
    // A bare repo has no `.git` wrapper: `resolveCommonDir` resolves
    // straight to the bare directory itself, whose basename is NOT
    // literally ".git", so there is no extra `..` step to take (taking
    // one would wrongly name the bare directory's PARENT instead).
    const root = tmpDir();
    const { worktree } = makeLinkedWorktreeOfBareRepo(root, "myrepo.git", {
      head: "ref: refs/heads/wt-branch",
    });
    expect(deriveProjectName(worktree)).toBe("myrepo.git");
    expect(deriveProjectName(worktree)).not.toBe(path.basename(worktree));
  });

  it("falls back to the checkout's own basename when a `.git` file is unparseable (gitDir unresolved)", () => {
    const root = tmpDir();
    const worktree = path.join(root, "broken-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), "not a gitdir pointer\n");
    expect(deriveProjectName(worktree)).toBe("broken-worktree");
  });

  it("returns null when cwd is not inside a git work tree", () => {
    const root = tmpDir();
    const plain = path.join(root, "just", "some", "dirs");
    fs.mkdirSync(plain, { recursive: true });
    expect(deriveProjectName(plain)).toBeNull();
  });

  it("returns null for an empty cwd", () => {
    expect(deriveProjectName("")).toBeNull();
  });
});

// Review round 3, decision D-028's security finding: `deriveProjectName`
// feeds an untrusted, on-disk-controlled string straight into
// `resolvePaths` (`src/cli/loader.ts`), which joins it into
// `<home>/projects/<name>/harness.overrides.yaml`. A crafted `.git`
// FILE plus gitdir whose `commondir` file holds an absolute path with
// unresolved `..` segments could hand that path.join a `".."`
// component (a directory-traversal shape), before `resolveCommonDir`
// normalized its absolute branch and `deriveProjectName` validated the
// resolved name.
describe("deriveProjectName: hardening against a crafted commondir / gitdir (task c88461c1, review round 3, decision D-028)", () => {
  it("normalizes an absolute commondir with unresolved `..` segments to the real ancestor directory, not a literal `..`", () => {
    const root = tmpDir();
    // The MAIN checkout's real per-worktree gitdir, laid out exactly
    // like a genuine `git worktree add` (`.git/worktrees/<name>/`).
    const mainCheckout = path.join(root, "real-project");
    const mainWorktreeDir = path.join(mainCheckout, ".git", "worktrees", "wt1");
    fs.mkdirSync(mainWorktreeDir, { recursive: true });
    fs.writeFileSync(path.join(mainWorktreeDir, "HEAD"), "ref: refs/heads/main\n");
    // A crafted `commondir`: an ABSOLUTE path built with string
    // concatenation (not `path.join`, which would normalize it away)
    // so the `..` segments reach `resolveCommonDir` unresolved, exactly
    // the shape a hostile `.git` FILE target could produce.
    const linkedGitDir = path.join(root, "linked-private-gitdir");
    fs.mkdirSync(linkedGitDir, { recursive: true });
    fs.writeFileSync(path.join(linkedGitDir, "commondir"), `${mainWorktreeDir}/../..\n`);
    const linkedCheckout = path.join(root, "linked-checkout");
    fs.mkdirSync(linkedCheckout, { recursive: true });
    fs.writeFileSync(path.join(linkedCheckout, ".git"), `gitdir: ${linkedGitDir}\n`);

    // Pre-fix, `resolveCommonDir` returned the raw, un-normalized
    // string, whose textual basename is `".."`, and `deriveProjectName`
    // returned that literal `".."` unvalidated. Post-fix, normalizing
    // collapses the crafted `..` segments back to the real common dir
    // (`<mainCheckout>/.git`), and `deriveProjectName` derives the
    // MAIN checkout's real name from it, exactly as an unmangled
    // `commondir` value would.
    expect(resolveCommonDir(linkedGitDir)).toBe(path.join(mainCheckout, ".git"));
    expect(deriveProjectName(linkedCheckout)).toBe("real-project");
    expect(deriveProjectName(linkedCheckout)).not.toBe("..");
  });

  it("returns null for a resolved name containing a path separator, rather than handing an unvalidated string to resolvePaths", () => {
    const root = tmpDir();
    // POSIX permits a literal backslash IN a directory name (only `/`
    // and NUL are forbidden by the filesystem); `path.basename` never
    // strips it, so this main-checkout directory name reaches
    // `deriveProjectName`'s final `path.basename` call carrying a
    // character `resolvePaths`' `path.join` would otherwise treat as a
    // Windows path separator.
    const evilName = "evil\\name";
    const mainCheckout = path.join(root, evilName);
    fs.mkdirSync(path.join(mainCheckout, ".git"), { recursive: true });
    fs.writeFileSync(path.join(mainCheckout, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(deriveProjectName(mainCheckout)).toBeNull();
  });
});

// Review round 3, decision D-028's docs finding: two more real-git
// shapes `deriveProjectName` was never pinned against. Both use actual
// `git` subprocesses (unlike the hand-built `.git` FILE fixtures
// above) so the derivation is checked against genuine on-disk layouts,
// not this file's own model of them.
describe("deriveProjectName: submodule and --separate-git-dir shapes (task c88461c1, review round 3, decision D-028)", () => {
  function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  }

  it("derives the SUBMODULE's own name, not its superproject's", () => {
    const root = tmpDir();
    const subSource = path.join(root, "sub-source");
    initRepo(subSource);
    fs.writeFileSync(path.join(subSource, "file.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: subSource });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: subSource });

    const superRoot = path.join(root, "super-project");
    initRepo(superRoot);
    // `-c protocol.file.allow=always`: newer git refuses a bare `file://`
    // submodule source by default (CVE-2022-39253); this fixture's
    // source is local and trusted, so the allowance is scoped to this
    // one command only.
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subSource, "sub"],
      { cwd: superRoot },
    );

    expect(deriveProjectName(path.join(superRoot, "sub"))).toBe("sub");
    expect(deriveProjectName(path.join(superRoot, "sub"))).not.toBe("super-project");
  });

  it("derives the GIT DIR's own basename for a `git init --separate-git-dir` checkout, not the work tree's", () => {
    const root = tmpDir();
    const workTree = path.join(root, "sepgit-worktree");
    const gitDir = path.join(root, "sepgit.git");
    fs.mkdirSync(workTree, { recursive: true });
    execFileSync("git", [
      "init",
      "-q",
      "-b",
      "main",
      `--separate-git-dir=${gitDir}`,
      workTree,
    ]);

    expect(deriveProjectName(workTree)).toBe("sepgit.git");
    expect(deriveProjectName(workTree)).not.toBe(path.basename(workTree));
  });
});

// Residual of task c88461c1's review round 3 (T-004 of the follow-up
// batch, decision D-006): before the `fs.realpathSync` step added to
// `deriveProjectName` above, a checkout reached through a symlink
// derived the SYMLINK's own basename, not the real directory's, so two
// paths to the SAME repository (the real checkout, and a symlink
// pointing at it) resolved two DIFFERENT project layers, contradicting
// D-021a's "repository identity is the common dir" rule.
describe("deriveProjectName: symlinked checkout resolves the real directory's name (task c88461c1, review round 3 residual, decision D-006)", () => {
  it("derives the real directory's basename through a symlinked checkout, matching the real path directly", () => {
    const root = tmpDir();
    const realRepo = makeRepo(root, "real-project", "ref: refs/heads/main");
    const symlinkPath = path.join(root, "symlinked-project");
    fs.symlinkSync(realRepo, symlinkPath, "dir");

    expect(deriveProjectName(realRepo)).toBe("real-project");
    expect(deriveProjectName(symlinkPath)).toBe("real-project");
    expect(deriveProjectName(symlinkPath)).not.toBe("symlinked-project");
  });

  it("falls back to the un-resolved common dir when realpath fails, rather than throwing", () => {
    // `findGitEntry` never verifies a `.git` FILE's `gitdir:` target
    // exists (see its doc comment): it just resolves the pointer path
    // textually. A `gitdir:` line pointing at a nonexistent absolute
    // path reaches `deriveProjectName`'s `fs.realpathSync` call with a
    // path that genuinely does not exist on disk, exercising the
    // catch branch directly (unlike the symlink case above, where
    // `findGitEntry`'s own `fs.statSync` calls already require the
    // target to exist).
    const root = tmpDir();
    const worktree = path.join(root, "broken-gitdir-project");
    fs.mkdirSync(worktree, { recursive: true });
    const missingGitDir = path.join(root, "does-not-exist", "gitdir");
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${missingGitDir}\n`);

    expect(() => deriveProjectName(worktree)).not.toThrow();
    // `resolveCommonDir` finds no `commondir` file under the missing
    // path (its own read throws and is caught), so it returns
    // `missingGitDir` unchanged; `realpathSync` on that then also
    // throws and is caught, falling back to the SAME un-resolved
    // value used before this task's realpath step existed.
    expect(deriveProjectName(worktree)).toBe(path.basename(missingGitDir));
  });
});
