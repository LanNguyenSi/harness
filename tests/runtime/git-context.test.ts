import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    // ever distinguish the two branches that way — Node's `path.resolve`
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
