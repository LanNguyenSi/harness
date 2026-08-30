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
   * (a raw SHA, there is no branch to name).
   */
  branch: string;
  /**
   * Current HEAD commit sha (40 lowercase hex chars), or "" when not in
   * a repo or the sha could not be resolved. On a detached HEAD this is
   * the raw sha from `.git/HEAD`; on a branch it is the sha pointed at
   * by `.git/refs/heads/<branch>` (or the matching entry in
   * `.git/packed-refs` when the loose ref is absent). Used by the
   * `at_head:true` requires-flag so a preflight whose recorded HEAD
   * equals the current HEAD satisfies the gate regardless of age.
   */
  sha: string;
}

const EMPTY: GitRepoContext = { repo: "", branch: "", sha: "" };

// A `.git` *file* (linked worktree / submodule) points at the real git
// dir: `gitdir: <path>`.
const GITDIR_RE = /^gitdir:\s*(.+)$/;
// `.git/HEAD` on a branch: `ref: refs/heads/<branch>`. A detached HEAD
// holds a raw SHA instead and matches nothing here.
const HEAD_REF_RE = /^ref:\s*refs\/heads\/(.+)$/;
// A loose ref or detached-HEAD sha is exactly 40 lowercase hex chars.
const SHA_RE = /^[0-9a-f]{40}$/;

export interface GitEntry {
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
 *
 * Exported (task T-001, record-verbs) so `cli/record/index.ts` can
 * locate the same `.git` directory this module resolves `repo`/
 * `branch`/`sha` from, without re-walking the tree with duplicate
 * logic — its base-branch resolution needs the raw git directory (to
 * read `refs/remotes/origin/HEAD` / `packed-refs`), which
 * `resolveGitContext`'s return shape does not expose. Behavior is
 * unchanged; this is a visibility-only change.
 */
export function findGitEntry(startDir: string): GitEntry | null {
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
      try {
        if (!fs.statSync(path.join(dotGit, "HEAD")).isFile()) return null;
      } catch {
        return null;
      }
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
 * Look up a branch's sha by reading the loose ref file first, then
 * falling back to `packed-refs`. Both sources are plain text; the
 * lookup stays cheap (no `git` subprocess).
 */
function resolveBranchSha(gitDir: string, branch: string): string {
  try {
    const loose = fs
      .readFileSync(path.join(gitDir, "refs", "heads", branch), "utf8")
      .trim();
    if (SHA_RE.test(loose)) return loose;
  } catch {
    /* loose ref missing, try packed-refs */
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    const target = `refs/heads/${branch}`;
    for (const raw of packed.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, ref] = line.split(/\s+/, 2);
      if (ref === target && sha && SHA_RE.test(sha)) return sha;
    }
  } catch {
    /* packed-refs missing too — caller treats "" as "unknown" */
  }
  return "";
}

/**
 * Resolve `{ repo, branch, sha }` for a working directory. Returns empty
 * strings (never throws) when `cwd` is not inside a git work tree, or
 * when any individual lookup fails: callers treat "" as "unknown" and
 * fall through to their own behaviour.
 */
export function resolveGitContext(cwd: string): GitRepoContext {
  if (typeof cwd !== "string" || cwd.length === 0) return EMPTY;
  const entry = findGitEntry(cwd);
  if (!entry) return EMPTY;
  const repo = path.basename(entry.worktreeRoot);
  let branch = "";
  let sha = "";
  if (entry.gitDir) {
    try {
      const head = fs.readFileSync(path.join(entry.gitDir, "HEAD"), "utf8").trim();
      const match = HEAD_REF_RE.exec(head);
      if (match) {
        branch = match[1]!.trim();
        // `refs/heads/<branch>` and `packed-refs` are not duplicated in
        // a linked worktree's private gitdir; they live in the shared
        // common dir (see `resolveCommonDir`'s doc comment). Routing
        // through it here is a no-op for the main checkout (no
        // `commondir` file, `resolveCommonDir` returns `gitDir`
        // unchanged).
        sha = resolveBranchSha(resolveCommonDir(entry.gitDir), branch);
      } else if (SHA_RE.test(head)) {
        // Detached HEAD: the file contains the raw sha directly.
        sha = head;
      }
    } catch {
      /* unreadable HEAD — branch + sha stay "" */
    }
  }
  return { repo, branch, sha };
}

// ---------------------------------------------------------------------------
// Default-branch resolution (offline, no `gh`/`git` subprocess).
//
// Originally written for `harness record review`'s `--base` fallback
// (task T-001, record-verbs) and lived only in `cli/record/index.ts`.
// Exported here (task post-merge-gate, T-001) so
// `policy-packs/builtin/post-merge-gate-runtime.ts` can resolve the same
// "what's the default branch to switch back to" answer for its deny
// message without a policy-pack module reaching into `cli/`. Behavior is
// unchanged; this is a visibility/location move, not a rewrite — see
// `findGitEntry`'s doc comment above for the identical precedent
// (record/index.ts reusing this module's git-dir walk instead of
// duplicating it).
// ---------------------------------------------------------------------------

// `.git/refs/remotes/origin/HEAD` on a normal clone: a symbolic ref
// pointing at the remote's default branch.
const ORIGIN_HEAD_REF_RE = /^ref:\s*refs\/remotes\/origin\/(.+)$/;
const ORIGIN_HEAD_REF_PATH = "refs/remotes/origin/HEAD";
const ORIGIN_REMOTE_PREFIX = "refs/remotes/origin/";

/**
 * Resolve the remote's default branch name from `<gitDir>/refs/remotes/
 * origin/HEAD`. Loose symbolic ref first (the normal shape: `ref: refs/
 * remotes/origin/<name>`, written by `git clone` / `git remote set-head
 * origin -a`). When that loose file is absent, falls back to
 * `packed-refs`: some git versions / tooling pack `refs/remotes/origin/
 * HEAD` as a plain `<sha> <ref>` entry instead of a symref, which loses
 * the branch NAME directly — recovered here by matching that sha
 * against another packed `refs/remotes/origin/<name>` entry that shares
 * it (mirrors the loose-then-packed shape `resolveBranchSha` uses
 * above, adapted since packed-refs has no symref concept). Returns null
 * when neither source resolves a name.
 */
export function resolveOriginHeadBase(gitDir: string): string | null {
  try {
    const raw = fs
      .readFileSync(path.join(gitDir, "refs", "remotes", "origin", "HEAD"), "utf8")
      .trim();
    const match = ORIGIN_HEAD_REF_RE.exec(raw);
    if (match) return match[1]!.trim();
  } catch {
    /* loose symref missing — try packed-refs */
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    let headSha: string | null = null;
    const entries: Array<{ sha: string; ref: string }> = [];
    for (const rawLine of packed.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
      const parts = line.split(/\s+/);
      const sha = parts[0];
      const ref = parts[1];
      if (!sha || !ref || !SHA_RE.test(sha)) continue;
      if (ref === ORIGIN_HEAD_REF_PATH) headSha = sha;
      else entries.push({ sha, ref });
    }
    if (headSha) {
      const match = entries.find(
        (e) => e.sha === headSha && e.ref.startsWith(ORIGIN_REMOTE_PREFIX),
      );
      if (match) return match.ref.slice(ORIGIN_REMOTE_PREFIX.length);
    }
  } catch {
    /* packed-refs missing too — caller treats null as "unresolvable" */
  }
  return null;
}

/**
 * Resolve the actual shared git directory for `gitDir`, following the
 * `commondir` file linked worktrees write. `git worktree add` gives each
 * worktree its own private `.git` FILE pointing at `<main>/.git/
 * worktrees/<name>/` (what `findGitEntry` returns as `gitDir`), but
 * `refs/remotes/origin/HEAD` and `packed-refs` are NOT duplicated there
 * — they live only in the shared common dir, reachable via that
 * per-worktree directory's own `commondir` file (a path, normally
 * `../..`, relative to the per-worktree directory itself; see
 * `git-worktree(1)`). Without this indirection, `resolveOriginHeadBase`
 * would look for those refs in the empty per-worktree directory and
 * always miss. Returns `gitDir` unchanged when no `commondir` file
 * exists (the normal, non-worktree case).
 */
export function resolveCommonDir(gitDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (raw.length > 0) {
      return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
    }
  } catch {
    /* no commondir file — gitDir already IS the common dir */
  }
  return gitDir;
}
