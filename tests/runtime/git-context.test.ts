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

/** Create `<root>/<name>/.git/` as a directory with the given HEAD. */
function makeRepo(root: string, name: string, head: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `${head}\n`);
  return repo;
}

describe("resolveGitContext", () => {
  it("resolves repo (work-tree basename) and branch from .git/HEAD", () => {
    const repo = makeRepo(tmpDir(), "my-project", "ref: refs/heads/main");
    expect(resolveGitContext(repo)).toEqual({ repo: "my-project", branch: "main" });
  });

  it("keeps a slashed branch name intact", () => {
    const repo = makeRepo(tmpDir(), "harness", "ref: refs/heads/fix/some-bug");
    expect(resolveGitContext(repo)).toEqual({ repo: "harness", branch: "fix/some-bug" });
  });

  it("walks up from a nested cwd to find the work-tree root", () => {
    const repo = makeRepo(tmpDir(), "deep-repo", "ref: refs/heads/dev");
    const nested = path.join(repo, "src", "cli", "policy");
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveGitContext(nested)).toEqual({ repo: "deep-repo", branch: "dev" });
  });

  it("returns an empty branch for a detached HEAD (raw SHA)", () => {
    const repo = makeRepo(
      tmpDir(),
      "detached",
      "9fceb02d0ae598e95dc970b74767f19372d61af8",
    );
    expect(resolveGitContext(repo)).toEqual({ repo: "detached", branch: "" });
  });

  it("resolves repo but empty branch when HEAD is missing", () => {
    const root = tmpDir();
    const repo = path.join(root, "no-head");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(resolveGitContext(repo)).toEqual({ repo: "no-head", branch: "" });
  });

  it("follows a `.git` file (linked worktree) to its gitdir for HEAD", () => {
    const root = tmpDir();
    // The real git dir lives elsewhere; the worktree's `.git` is a file.
    const realGitDir = path.join(root, "main-repo", ".git", "worktrees", "wt");
    fs.mkdirSync(realGitDir, { recursive: true });
    fs.writeFileSync(path.join(realGitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
    const worktree = path.join(root, "linked-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${realGitDir}\n`);
    expect(resolveGitContext(worktree)).toEqual({
      repo: "linked-worktree",
      branch: "wt-branch",
    });
  });

  it("resolves repo but empty branch when a `.git` file is unparseable", () => {
    const root = tmpDir();
    const worktree = path.join(root, "broken-worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), "not a gitdir pointer\n");
    expect(resolveGitContext(worktree)).toEqual({ repo: "broken-worktree", branch: "" });
  });

  it("returns empty strings when cwd is not inside a git work tree", () => {
    const root = tmpDir();
    const plain = path.join(root, "just", "some", "dirs");
    fs.mkdirSync(plain, { recursive: true });
    expect(resolveGitContext(plain)).toEqual({ repo: "", branch: "" });
  });

  it("returns empty strings for an empty cwd", () => {
    expect(resolveGitContext("")).toEqual({ repo: "", branch: "" });
  });
});
