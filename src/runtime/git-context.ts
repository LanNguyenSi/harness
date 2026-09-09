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
      // `path.normalize` on the absolute branch (review round 3,
      // decision D-028's security finding): the relative branch already
      // normalizes via `path.resolve`, but an absolute `commondir`
      // value was returned verbatim, `..` segments and all. A crafted
      // `.git` FILE pointing at a private gitdir whose `commondir` file
      // holds an absolute path ending in unresolved `..` segments (e.g.
      // `<gitDir>/../..`) then reached `deriveProjectName` below with
      // those segments still literally present, `path.basename` textually
      // returning `..` instead of the intended ancestor directory's real
      // name. Normalizing here closes that off at the source, before
      // either caller (`resolveOriginHeadBase`, `deriveProjectName`)
      // ever sees the raw value.
      return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(gitDir, raw);
    }
  } catch {
    /* no commondir file — gitDir already IS the common dir */
  }
  return gitDir;
}

// ---------------------------------------------------------------------------
// Repository-identity derivation for per-repo config scoping (task
// c88461c1, review round 2, decision D-021a).
//
// Round 1 fed `resolveGitContext(cwd).repo` (the WORK-TREE basename)
// into the `session_start_preflight.setup` project-layer lookup. That
// is wrong for a linked worktree: `git worktree add ../foo` gives the
// linked checkout its OWN directory name, so two worktrees of the SAME
// repository resolved two DIFFERENT project layers, and neither one
// matched the name an operator would naturally pick for the shared
// project override file. `repo` stays exactly as-is for its existing
// consumer (the `preflight:${REPO}` ledger tag, `src/cli/session-start/
// index.ts`), a ledger tag namespaced per CHECKOUT is a defensible,
// unrelated design choice, and changing it is out of this task's scope.
// This is a SEPARATE derivation for a SEPARATE purpose: naming the
// `<home>/projects/<name>/harness.overrides.yaml` layer that should
// apply to every linked worktree of one repository alike.
// ---------------------------------------------------------------------------

/**
 * Derive the project-layer name for `cwd`: the basename of the
 * directory that CONTAINS the repository's shared git common dir (the
 * main checkout), so every linked worktree of one repository resolves
 * the same name, unlike `resolveGitContext(cwd).repo`, which names the
 * checkout directory itself and therefore differs per worktree. Feeds
 * `LoaderOptions.project` (the same seam every command's own
 * `--project <name>` flag already uses) for `harness session-start
 * preflight`, `harness explain-policy`, and `harness doctor` alike (one
 * helper, three consumers, so the three cannot silently disagree on
 * what "this repository's project name" means).
 *
 * Resolution:
 *  - `findGitEntry(cwd)` walks up to the `.git` entry, exactly like
 *    `resolveGitContext`.
 *  - `resolveCommonDir(entry.gitDir)` follows a linked worktree's
 *    `commondir` file to the shared common dir (a no-op for the main
 *    checkout, which has none).
 *  - The COMMON DIR's basename is normally literally `.git` (a
 *    directory or, in a linked worktree's private gitdir, the resolved
 *    target of a `.git` FILE): in that shape the project name is one
 *    level further up, the basename of the directory THAT CONTAINS the
 *    common dir, i.e. the main checkout's own directory name.
 *  - For a BARE repository (`git init --bare`, or a linked worktree
 *    created FROM one), there is no `.git` wrapper at all, the common
 *    dir IS the bare directory itself (its basename is not `.git`), so
 *    that basename is the project name directly, with no extra `..`
 *    step. This is the one shape where going up an extra level would
 *    be wrong (it would name the bare directory's PARENT instead), and
 *    the `.git` SUFFIX in a conventionally-named bare directory (e.g.
 *    `myrepo.git`) is kept, not stripped.
 *  - A SUBMODULE checkout (`git submodule add`) derives the submodule's
 *    OWN name, not its superproject's: a submodule's `.git` FILE points
 *    at a private gitdir under the superproject's `.git/modules/<name>/`
 *    tree, which has no `commondir` file of its own (that mechanism is
 *    for linked worktrees, not submodules), so `resolveCommonDir` is a
 *    no-op and the submodule's own checkout directory basename applies
 *    directly, same as a normal (non-worktree) repo.
 *  - A `git init --separate-git-dir=<dir>` checkout derives the GIT
 *    DIR's own basename, NOT the work tree's: the `.git` file at the
 *    work tree root points at `<dir>` with no `commondir` file either
 *    (again a linked-worktree-only mechanism), so `resolveCommonDir` is
 *    a no-op and `<dir>`'s own basename (e.g. `sepgit.git`) is the
 *    derived name, exactly like the bare-repository shape above; the
 *    work tree's own directory name never enters into it.
 *
 * Returns `null` when `cwd` is not inside a git work tree (mirrors
 * `resolveGitContext`'s "" for the same case), when `entry.gitDir`
 * could not be resolved at all (an unreadable `.git` FILE, see
 * `findGitEntry`'s doc comment; in that case this falls back to the
 * checkout directory's own basename, the same value `repo` would
 * carry, rather than guessing at a common dir it has no path to), or
 * when the resolved name fails {@link isValidProjectName} (review
 * round 3, decision D-028's security finding: an untrusted on-disk
 * `commondir`/`.git` FILE value must never hand a caller a name like
 * `""`, `"."`, `".."`, or one containing a path separator, since every
 * consumer joins it straight into a filesystem path,
 * `resolvePaths`/`src/cli/loader.ts`). Never throws.
 *
 * REALPATH (task c88461c1, review round 3 residual; task `1c4eb3ea`
 * of the batch-44 follow-up run): the common dir is resolved through
 * `fs.realpathSync` BEFORE taking its basename, so a checkout reached
 * through a symlink (an operator's own convenience symlink, or a
 * second clone path) derives the SAME project name as the real
 * directory it points at, matching D-021a's "repository identity is
 * the common dir" rule: two paths to one repository must resolve one
 * project layer, not two. Best-effort: `realpathSync` failing (a
 * dangling symlink, a permissions error) falls back to the
 * un-resolved common dir rather than throwing, so a repository that
 * was reachable before this change stays reachable.
 */
export function deriveProjectName(cwd: string): string | null {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const entry = findGitEntry(cwd);
  if (!entry) return null;
  if (!entry.gitDir) {
    const fallback = path.basename(entry.worktreeRoot);
    return isValidProjectName(fallback) ? fallback : null;
  }
  let commonDir = resolveCommonDir(entry.gitDir);
  try {
    commonDir = fs.realpathSync(commonDir);
  } catch {
    /* dangling symlink or unreadable target, keep the un-resolved commonDir */
  }
  const commonDirBase = path.basename(commonDir);
  const projectDir = commonDirBase === ".git" ? path.dirname(commonDir) : commonDir;
  const name = path.basename(projectDir);
  return isValidProjectName(name) ? name : null;
}

export interface ResolveScopedProjectNameOptions<T> {
  /** An explicit `--project <name>` value, when the caller has one. Wins outright. */
  project?: string;
  /** The cwd to derive a project name from via {@link deriveProjectName}. */
  cwd: string;
  /**
   * What to return when neither `project` nor `deriveProjectName(cwd)`
   * produced a name. Callers disagreed on this value before this helper
   * existed: `harness doctor` used `null`, the `session_start_preflight`
   * producer used its own already-resolved `repo` basename. Naming it
   * here makes that difference a visible, per-call-site argument instead
   * of an accident of two copies of the same expression drifting apart
   * (task `f1eb1c5c`; see docs/CLI.md's PER-REPO SCOPING section).
   */
  fallback: T;
}

/**
 * Shared `opts.project ?? deriveProjectName(cwd) ?? fallback` resolution,
 * used by every producer of a per-repo-scoped `session_start_preflight`
 * project name (`harness doctor`'s second, project-scoped load and the
 * `session_start_preflight` producer). Both surfaces agree on the first
 * two terms (an explicit `--project`, then the cwd-derived name); only
 * the fallback differs by call site, and this helper takes it as an
 * explicit argument so that difference is named rather than duplicated
 * inline. No behavior change versus either surface's own prior inline
 * expression: this only extracts the shared shape.
 */
export function resolveScopedProjectName<T>(opts: ResolveScopedProjectNameOptions<T>): string | T {
  return opts.project ?? deriveProjectName(opts.cwd) ?? opts.fallback;
}

/**
 * Is `name` safe to join into `<home>/projects/<name>/harness.overrides.yaml`
 * (`resolvePaths`, `src/cli/loader.ts`) as an on-disk directory
 * component? Rejects the empty string, `"."`, and `".."` (the two
 * `path.join` special-cases that either no-op or climb a level, `".."`
 * being exactly the shape a crafted, un-normalized `commondir` used to
 * produce before the fix above), plus any name containing a forward
 * slash, a backslash (Windows separator; POSIX permits a literal
 * backslash IN a directory name, so this is not redundant with the
 * platform's own path parsing), or a NUL byte. A name that passes this
 * check may still not exist on disk (`resolvePaths` already handles
 * that with `fs.existsSync`); this only guards against the value
 * escaping the single path segment it is meant to occupy.
 *
 * Exported (task c88461c1, review round 3 residual; task `1c4eb3ea`
 * of the batch-44 follow-up run) so `resolvePaths` (`src/cli/loader.ts`)
 * can apply the SAME guard at its own `path.join` sink, defense in
 * depth: this function already rejects an unsafe name at every
 * `deriveProjectName` exit, but an `opts.project` reaching
 * `resolvePaths`' OWN sink from anywhere else (a caller building
 * `LoaderOptions` by hand, a future producer) had no equivalent check
 * of its own until now. Scoped to that ONE sink (task `1c4eb3ea`,
 * round 2, D-027 item 8): this guard covers neither `substituteProject`
 * (`src/probes/memory.ts`) nor `generate-memory-index.ts`'s own
 * `{project}` substitution, both of which still interpolate an
 * operator-supplied `--project` value into a path unvalidated (reached
 * only via the explicit CLI flag, not this module's derivation); a
 * caller reading this comment should not assume this function guards
 * every `{project}`-shaped sink in the codebase.
 */
export function isValidProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === "." || name === "..") return false;
  return !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}
