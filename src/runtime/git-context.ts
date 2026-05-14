// Resolves the `REPO` and `BRANCH` policy builtins from a working
// directory.
//
// The intercept engine exposes `${REPO}` / `${BRANCH}` as `ledger_tag`
// template builtins, but they were only ever populated from the
// `HARNESS_REPO` / `HARNESS_BRANCH` env vars — which nothing sets — so
// every `preflight:${REPO}` tag collapsed to the literal `preflight:`.
// That silently degraded the founding-incident policies to one global
// tag: a preflight done in repo A satisfied the gate in repo B.
//
// This module derives both values from the filesystem, not a `git`
// subprocess: the intercept hook runs on every Bash / Edit / Write
// tool call, so the resolution must stay cheap. A bounded walk up the
// directory tree to find `.git`, plus one small `HEAD` read, is
// microseconds and spawns no process.
//
// It is a deliberate approximation of `git rev-parse`: it reads the
// work tree's basename and `.git/HEAD` directly and does NOT consult
// `GIT_DIR` / `GIT_WORK_TREE` / `core.worktree`. For namespacing a
// ledger tag, the on-disk layout is the right (and more stable)
// signal; those exotic overrides are out of scope.

import * as fs from "node:fs";
import * as path from "node:path";

export interface GitRepoContext {
  /** Basename of the work-tree root, or "" when `cwd` is not in a repo. */
  repo: string;
  /**
   * Current branch name, or "" when not in a repo or HEAD is detached
   * (a raw SHA — there is no branch to name).
   */
  branch: string;
}

const EMPTY: GitRepoContext = { repo: "", branch: "" };

// A `.git` *file* (linked worktree / submodule) points at the real git
// dir: `gitdir: <path>`.
const GITDIR_RE = /^gitdir:\s*(.+)$/;
// `.git/HEAD` on a branch: `ref: refs/heads/<branch>`. A detached HEAD
// holds a raw SHA instead and matches nothing here.
const HEAD_REF_RE = /^ref:\s*refs\/heads\/(.+)$/;

interface GitEntry {
  /** Directory that contains the `.git` entry (the work-tree root). */
  worktreeRoot: string;
  /** Resolved git directory — for a `.git` file, its `gitdir:` target. */
  gitDir: string;
}

/**
 * Walk up from `startDir` looking for a `.git` entry. Handles both the
 * common `.git` directory and the `.git` *file* form used by linked
 * worktrees and submodules. The walk is bounded so a pathologically
 * deep cwd cannot spin.
 */
function findGitEntry(startDir: string): GitEntry | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 128; depth++) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) {
      return { worktreeRoot: dir, gitDir: dotGit };
    }
    if (stat?.isFile()) {
      let gitDir = "";
      try {
        const match = GITDIR_RE.exec(fs.readFileSync(dotGit, "utf8").trim());
        if (match) gitDir = path.resolve(dir, match[1]!.trim());
      } catch {
        /* unreadable `.git` file — leave gitDir empty, repo still resolves */
      }
      return { worktreeRoot: dir, gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve `{ repo, branch }` for a working directory. Returns empty
 * strings (never throws) when `cwd` is not inside a git work tree, or
 * when any individual lookup fails — callers treat "" as "unknown" and
 * fall through to their own behaviour.
 */
export function resolveGitContext(cwd: string): GitRepoContext {
  if (typeof cwd !== "string" || cwd.length === 0) return EMPTY;
  const entry = findGitEntry(cwd);
  if (!entry) return EMPTY;
  const repo = path.basename(entry.worktreeRoot);
  let branch = "";
  if (entry.gitDir) {
    try {
      const head = fs.readFileSync(path.join(entry.gitDir, "HEAD"), "utf8").trim();
      const match = HEAD_REF_RE.exec(head);
      if (match) branch = match[1]!.trim();
    } catch {
      /* unreadable HEAD — branch stays "" */
    }
  }
  return { repo, branch };
}
