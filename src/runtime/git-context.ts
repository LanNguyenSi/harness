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
import { isValidProjectName } from "../io/project-name.js";
import { readRegularFileBounded } from "../io/read-regular-file.js";

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
  /**
   * Present (non-empty) only when a git file the lookup needed was NOT
   * simply absent but refused: a FIFO, a device, a directory, an oversized
   * or unreadable file stood where a regular file belongs (`HEAD`,
   * `refs/heads/<branch>`, `packed-refs`, `commondir`, named relative to the
   * git directory), or a node that is neither a directory nor a regular file
   * stood at `.git` itself (the lookup then stops there instead of walking
   * up to an enclosing repository, so it never resolves THAT repository's
   * branch for this checkout). The affected fields stay `""` exactly as they do for a
   * missing file, so a caller that only treats `""` as "unknown" is
   * unchanged; a deny-capable caller that must not read "unknown" as "safe"
   * (branch-protection) checks this field instead, because in a healthy
   * repository none of these paths is ever anything but a regular file or
   * absent. Never populated for a path that is merely missing.
   */
  refused?: readonly string[];
}

const EMPTY: GitRepoContext = { repo: "", branch: "", sha: "" };

/**
 * A short ` [git file refused ...]` suffix for a diagnostic when
 * {@link GitRepoContext.refused} is set, `""` otherwise, so a hook that
 * resolves an unknown from a refused git file says so instead of reading
 * like an ordinary detached HEAD.
 */
export function describeRefusedGitFiles(ctx: Pick<GitRepoContext, "refused">): string {
  if (ctx.refused === undefined || ctx.refused.length === 0) return "";
  return ` [git file refused, present but not a regular file or over the read cap: ${ctx.refused.join(", ")}]`;
}

/**
 * The most bytes a git ref file may have. A loose ref, `HEAD`, a `.git`
 * pointer file and `commondir` hold one line (a sha, a ref name or a path),
 * so the shared 1 MiB cap is generous for them. Only `packed-refs` can
 * legitimately be large (one line per ref: a repository with hundreds of
 * thousands of tags and branches reaches tens of MiB), see
 * {@link MAX_PACKED_REFS_BYTES}.
 */
// `packed-refs` carries ~100 bytes per ref (a 40-char sha, the ref name, a
// peeled line for an annotated tag), so 32 MiB covers on the order of
// 300,000 refs, well past any repository whose hook budget a lookup would
// be asked to fit, and is still a bound a sparse planted file cannot run
// the hook past.
const MAX_PACKED_REFS_BYTES = 32 * 1024 * 1024;

/**
 * Read one git file by path through the shared bounded, non-blocking
 * descriptor read (the path is opened once with `O_NONBLOCK`, the type and
 * size come from `fstat` on that descriptor). A path that is simply absent
 * is `null`, like the old `readFileSync` throwing `ENOENT`; a path that is
 * there but cannot be read as a regular file (a FIFO with no writer used to
 * block the hook here until the runtime's budget ran out, which the runtime
 * treats as an allow) is also `null` but recorded in `refused` so a caller
 * can tell the two apart. Symlinks are followed, as before (git itself
 * does): the descriptor's own type is what decides.
 */
function readGitFile(
  filePath: string,
  label: string,
  refused: string[] | undefined,
  maxBytes?: number,
): string | null {
  const read = readRegularFileBounded(filePath, {
    followSymlinks: true,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  if (read.kind === "ok") return read.content;
  if (read.kind !== "missing") refused?.push(label);
  return null;
}

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
  /**
   * `".git"` when the `.git` entry is present but refused: a node that is
   * neither a directory nor a regular file (a FIFO, a device, a socket, a
   * symlink to one, a dangling or looping symlink), or a file that cannot be
   * read (a FIFO swapped in after the stat, an oversized or unreadable
   * file), as opposed to a readable file without a `gitdir:` line; `"HEAD"` when the
   * `.git` directory's `HEAD` is present but not a regular file. Absent
   * otherwise. `gitDir` is `""` in both cases, exactly as for any other
   * unreadable `.git` file.
   */
  refused?: ".git" | "HEAD";
}

/** Whether `lstat` finds anything at the path (a dangling symlink counts). */
function lstatPresent(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
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
    // A `.git` that is PRESENT but is neither a directory nor a regular file
    // (a FIFO, a device, a socket, a symlink to one, a dangling or looping
    // symlink) is not "no `.git` here, keep walking": walking up would
    // resolve whatever repository ENCLOSES this one (a linked worktree
    // checked out inside an outer repository would read as the outer
    // repository's branch). It is reported as refused with `gitDir` left
    // empty, like a present-but-unreadable `HEAD`. Only a `.git` that is
    // absent (`lstat` finds nothing) is skipped.
    const refusedNode =
      stat === undefined ? lstatPresent(dotGit) : !stat.isDirectory() && !stat.isFile();
    if (refusedNode) {
      return { worktreeRoot: dir, gitDir: "", refused: ".git" };
    }
    if (stat?.isDirectory()) {
      let headStat: fs.Stats;
      try {
        headStat = fs.statSync(path.join(dotGit, "HEAD"));
      } catch {
        return null;
      }
      // A `HEAD` that is PRESENT but not a regular file (a FIFO planted
      // over it, a directory, a device) is not "no repository here": this
      // is a git directory whose `HEAD` cannot be read, reported as
      // refused with `gitDir` left empty (so nothing reads through it),
      // never as "outside a work tree" (which a deny-capable caller would
      // read as safe to allow).
      if (!headStat.isFile()) return { worktreeRoot: dir, gitDir: "", refused: "HEAD" };
      return { worktreeRoot: dir, gitDir: dotGit };
    }
    if (stat?.isFile()) {
      let gitDir = "";
      const refused: string[] = [];
      // An unreadable `.git` file leaves gitDir empty, the repo still resolves.
      const text = readGitFile(dotGit, ".git", refused);
      if (text !== null) {
        const match = GITDIR_RE.exec(text.trim());
        if (match) gitDir = path.resolve(dir, match[1]!.trim());
      }
      return { worktreeRoot: dir, gitDir, ...(refused.length > 0 ? { refused: ".git" as const } : {}) };
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
 *
 * A loose ref that is MISSING falls through to `packed-refs` (the normal
 * shape of a packed branch). A loose ref that is present but REFUSED (a
 * FIFO, a device, a directory, an oversized or unreadable file) does not:
 * `packed-refs` holds an OLDER tip of the same branch, so falling back to
 * it would hand a caller a stale sha it would trust (a head-pinned verdict
 * for the old tip would match), where the unknown `""` it gets instead
 * fails closed. The same goes for a refused `packed-refs`.
 */
function resolveBranchSha(gitDir: string, branch: string, refused: string[]): string {
  const looseLabel = `refs/heads/${branch}`;
  const refusedBefore = refused.length;
  const looseRaw = readGitFile(path.join(gitDir, "refs", "heads", branch), looseLabel, refused);
  if (looseRaw !== null) {
    const loose = looseRaw.trim();
    if (SHA_RE.test(loose)) return loose;
  } else if (refused.length > refusedBefore) {
    return "";
  }
  const packed = readGitFile(
    path.join(gitDir, "packed-refs"),
    "packed-refs",
    refused,
    MAX_PACKED_REFS_BYTES,
  );
  if (packed === null) return "";
  const target = `refs/heads/${branch}`;
  for (const raw of packed.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, ref] = line.split(/\s+/, 2);
    if (ref === target && sha && SHA_RE.test(sha)) return sha;
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
  const refused: string[] = entry.refused !== undefined ? [entry.refused] : [];
  if (entry.gitDir) {
    try {
      // A missing or refused HEAD leaves branch + sha "" (a refused one is
      // also recorded in `refused`, see GitRepoContext.refused).
      const headRaw = readGitFile(path.join(entry.gitDir, "HEAD"), "HEAD", refused);
      if (headRaw === null) throw new Error("no readable HEAD");
      const head = headRaw.trim();
      const match = HEAD_REF_RE.exec(head);
      if (match) {
        branch = match[1]!.trim();
        // `refs/heads/<branch>` and `packed-refs` are not duplicated in
        // a linked worktree's private gitdir; they live in the shared
        // common dir (see `resolveCommonDir`'s doc comment). Routing
        // through it here is a no-op for the main checkout (no
        // `commondir` file, `resolveCommonDir` returns `gitDir`
        // unchanged).
        sha = resolveBranchSha(resolveCommonDir(entry.gitDir, refused), branch, refused);
      } else if (SHA_RE.test(head)) {
        // Detached HEAD: the file contains the raw sha directly.
        sha = head;
      }
    } catch {
      /* unreadable HEAD — branch + sha stay "" */
    }
  }
  return { repo, branch, sha, ...(refused.length > 0 ? { refused } : {}) };
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
  // Both reads go through the bounded, non-blocking git-file read. A loose
  // symref that is present but refused (a FIFO, a device, an oversized file)
  // resolves to `null` and does NOT fall back to `packed-refs`, which may
  // name a stale default branch; a missing one falls back as before.
  const refused: string[] = [];
  const looseRaw = readGitFile(
    path.join(gitDir, "refs", "remotes", "origin", "HEAD"),
    ORIGIN_HEAD_REF_PATH,
    refused,
  );
  if (looseRaw !== null) {
    const match = ORIGIN_HEAD_REF_RE.exec(looseRaw.trim());
    if (match) return match[1]!.trim();
  } else if (refused.length > 0) {
    return null;
  }
  // A missing or refused `packed-refs` leaves the caller's "unresolvable".
  const packed = readGitFile(
    path.join(gitDir, "packed-refs"),
    "packed-refs",
    refused,
    MAX_PACKED_REFS_BYTES,
  );
  if (packed === null) return null;
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
export function resolveCommonDir(gitDir: string, refused?: string[]): string {
  // A `commondir` that is present but refused (a FIFO, a device, an
  // oversized file) is reported through `refused` when the caller passes
  // one; the answer stays `gitDir`, as for a missing file.
  const text = readGitFile(path.join(gitDir, "commondir"), "commondir", refused);
  const raw = (text ?? "").trim();
  if (raw.length > 0) {
    // `path.normalize` on the absolute branch: the relative branch already
    // normalizes via `path.resolve`, but an absolute `commondir`
    // value was once returned verbatim, `..` segments and all. A crafted
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
 * `resolvePaths`/`src/cli/loader.ts`; task `e904f25a` extended the same
 * exit to a name containing a control character, which no consumer could
 * render safely). A rejection here is silent by design: no project
 * override layer resolves for that repository and the base/machine value
 * applies, exactly as for a repository that simply has no layer on disk.
 * Never throws.
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
 * used by two of the three producers of a per-repo-scoped
 * `session_start_preflight` project name: `harness doctor`'s second,
 * project-scoped load and the `session_start_preflight` producer. Both
 * surfaces agree on the first two terms (an explicit `--project`, then
 * the cwd-derived name); only the fallback differs by call site, and
 * this helper takes it as an explicit argument so that difference is
 * named rather than duplicated inline. The third producer,
 * `harness explain-policy` (`src/cli/explain-policy.ts`), keeps its own
 * copy of the same expression with a third fallback (`undefined`);
 * folding it into this helper is deliberately out of scope of task
 * `f1eb1c5c`. No observable behaviour change versus either surface's
 * own prior inline expression, other than doctor's `cwd` expression
 * now being evaluated eagerly (see the call site): this only extracts
 * the shared shape.
 */
export function resolveScopedProjectName<T>(opts: ResolveScopedProjectNameOptions<T>): string | T {
  return opts.project ?? deriveProjectName(opts.cwd) ?? opts.fallback;
}

/**
 * `{project}` value validation and safe display now live in
 * `src/io/project-name.ts` (task `b5e6ccb0`): `buildLockEntries`
 * (`src/io/harness-lock.ts`) is itself a `{project}` sink, and `io/` may
 * not import from `runtime/` (`io-no-upward-imports`,
 * `.dependency-cruiser.cjs`), so the shared logic moved down rather than
 * `harness-lock.ts` re-implementing it. Re-exported here so every
 * existing consumer that imports `isValidProjectName` /
 * `sanitizeProjectForDisplay` from `../runtime/git-context.js` keeps
 * working unchanged; see `src/io/project-name.ts` for the doc comments
 * (the sink inventory, the two-screen rationale, the display-stripping
 * invariant).
 */
export { isValidProjectName, sanitizeProjectForDisplay } from "../io/project-name.js";
