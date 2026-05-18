import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitContext } from "../../src/runtime/git-context.js";

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

  it("resolves repo but empty branch + sha when HEAD is missing", () => {
    const root = tmpDir();
    const repo = path.join(root, "no-head");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(resolveGitContext(repo)).toEqual({ repo: "no-head", branch: "", sha: "" });
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
    const realGitDir = path.join(root, "main-repo", ".git", "worktrees", "wt");
    fs.mkdirSync(realGitDir, { recursive: true });
    fs.writeFileSync(path.join(realGitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
    const refPath = path.join(realGitDir, "refs", "heads", "wt-branch");
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, `${FAKE_SHA}\n`);
    const worktree = path.join(root, "linked-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${realGitDir}\n`);
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
});
