// Filesystem side of the quote-aware shell command model (task 7d4abf84).
//
// `shell-command-model.ts` stays pure: its path possibilities are steps as
// written, each with a mode. This module resolves them against the real
// directory tree for the gate (`resolveAttributedContexts` in
// `intercept.ts`, and `harness dry-run` through it), and answers the
// model's `DirectoryOracle` question (does a `cd` certainly land in an
// existing directory), for one event at a time.
//
// RESOLUTION. A path starts at the working directory as the event names it
// (the shell's logical `$PWD`). A logical step (a plain `cd` or `pushd`) is
// joined lexically onto the directory before it, like the shell's own
// `$PWD`. A physical step (`cd -P`, `git -C`, `env -C`, `--git-dir`) is a
// `chdir(2)`: it starts from the real directory before it and is resolved
// one component at a time through the real directories it passes, so a
// `..` after a symlink leaves the symlink's target, not the directory
// holding the link. A component that names no existing directory is joined
// lexically onto the real directory before it. A `..` that leaves a
// directory `chdir(2)` cannot pass through (missing, a file, not
// searchable) marks the path as one the shell cannot reach, so the oracle
// never confirms it (`cd -P missing/../x` and `cd -P README.md/../x` fail in
// bash and zsh, though `x` exists). The final directory is realpath'd (a
// symlink names its target's repository).
//
// COST. The model can name the same directory for thousands of commands (a
// long chain of `cd` followed by many `git log`), and the gate attributes
// once per matched per-repo policy, so one resolver serves one event: every
// possibility is resolved once (memoised by its key, for every command and
// every policy of the event), a `cd` the model asks about is resolved from
// the directory it starts in (already resolved), and every unit of
// filesystem work is counted. Past `MAX_MODEL_PATH_WORK` units the resolver
// refuses further work: `resolve` returns `null`, which the gate reads as
// an opaque target (the policy fails closed), and `certainDirectory`
// answers `false` (the model keeps the failure branch). One unit is one
// step (a lexical join, or one component of a physical step: one
// `realpath`, plus a directory check of the directory a `..` leaves), one
// final `realpath`, one directory check, or one level of the repository
// walk the gate runs for a newly resolved directory
// (`chargeRepositoryLookup`).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  dirPossibilityKey,
  stepMayBeConfirmed,
  type DirectoryOracle,
  type PathPossibility,
  type PathStep,
} from "./shell-command-model.js";

/**
 * Units of filesystem work one event may spend resolving the shell model's
 * paths (see the module comment). Well above any realistic command (the
 * measured corpora spend at most a few dozen units per event) and small
 * enough that the worst case stays far below the hook budget.
 */
export const MAX_MODEL_PATH_WORK = 4096;

/** The repository walk of `resolveGitContext` stops after this many levels. */
const REPOSITORY_WALK_LEVELS = 128;

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function isEnterableDirectory(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the shell model's path possibilities for one event; see the module comment. */
export class ModelPathResolver implements DirectoryOracle {
  private readonly cwd: string;
  private spent = 0;
  private exhausted = false;
  /** Key -> the directory before the final realpath (logical steps stay lexical). */
  private readonly walked = new Map<string, string>();
  /** Key -> the real directory. */
  private readonly resolved = new Map<string, string>();
  /** Key -> whether the directory exists and can be entered. */
  private readonly enterable = new Map<string, boolean>();
  /**
   * Keys whose physical steps apply a `..` to something `chdir(2)` cannot
   * pass through (missing, a file, not searchable): the shell fails there,
   * whatever the lexical result names (`cd -P missing/../x`,
   * `cd -P README.md/../x`). Any other missing component leaves a path
   * under a missing directory, which the final directory check refuses.
   */
  private readonly untraversable = new Set<string>();

  constructor(
    cwd: string,
    private readonly budget: number = MAX_MODEL_PATH_WORK,
  ) {
    this.cwd = path.resolve(cwd);
  }

  /** True once a request needed more work than the budget had left. */
  get overBudget(): boolean {
    return this.exhausted;
  }

  /** The real directory a path possibility names, or `null` once the budget is spent. */
  resolve(d: PathPossibility): string | null {
    const key = dirPossibilityKey(d);
    const hit = this.resolved.get(key);
    if (hit !== undefined) return hit;
    const walked = this.walk(d);
    if (walked === null || !this.spend(1)) return null;
    const real = realpathOrSelf(walked);
    this.resolved.set(key, real);
    return real;
  }

  /**
   * `DirectoryOracle`: `target` is `base` with `step` applied; true only
   * when that directory exists, is a directory and can be entered, the step
   * is one `stepMayBeConfirmed` accepts (a logical `..` only before every
   * name), and a physical step passes only through directories. Resolved
   * from `base` (normally already walked), so a chain of `cd` costs one step
   * per `cd`, not the whole path each time.
   */
  certainDirectory(base: PathPossibility, step: PathStep, target: PathPossibility): boolean {
    // Before the memo: the same target can also be named by a step that
    // fails in the shell (`missing/../x` and `x` both name `x`).
    if (!stepMayBeConfirmed(step)) return false;
    const key = dirPossibilityKey(target);
    const known = this.enterable.get(key);
    if (known !== undefined) return known;
    let dir = this.walked.get(key);
    if (dir === undefined) {
      const from = this.walk(base);
      if (from === null) return false;
      const next = this.applyStep(from, step);
      if (next === null) return false;
      dir = next.dir;
      this.walked.set(key, dir);
      if (!next.traversed || this.untraversable.has(dirPossibilityKey(base))) this.untraversable.add(key);
    }
    if (!this.spend(1)) return false;
    const enterable = !this.untraversable.has(key) && isEnterableDirectory(dir);
    this.enterable.set(key, enterable);
    return enterable;
  }

  /**
   * Charge the repository walk the gate runs for a directory it has not
   * looked up yet (one unit per level, up to the walk's own bound). False
   * once the budget is spent: the gate then fails closed instead.
   */
  chargeRepositoryLookup(dir: string): boolean {
    const levels = dir.split(path.sep).filter((part) => part.length > 0).length + 1;
    return this.spend(Math.min(levels, REPOSITORY_WALK_LEVELS));
  }

  private spend(units: number): boolean {
    if (this.exhausted) return false;
    if (this.spent + units > this.budget) {
      this.exhausted = true;
      return false;
    }
    this.spent += units;
    return true;
  }

  /** The directory a possibility names before the final realpath; `null` once the budget is spent. */
  private walk(d: PathPossibility): string | null {
    if (d.steps.length === 0) return this.cwd;
    const key = dirPossibilityKey(d);
    const hit = this.walked.get(key);
    if (hit !== undefined) return hit;
    let current = this.cwd;
    let traversed = true;
    for (const step of d.steps) {
      const next = this.applyStep(current, step);
      if (next === null) return null;
      current = next.dir;
      if (!next.traversed) traversed = false;
    }
    this.walked.set(key, current);
    if (!traversed) this.untraversable.add(key);
    return current;
  }

  /**
   * One step from `current`. `traversed` is false when a physical step
   * applies a `..` to something that is not a searchable directory (see
   * `untraversable`); a logical step is lexical and always `true`
   * (`stepMayBeConfirmed` covers its `..`).
   */
  private applyStep(current: string, step: PathStep): { dir: string; traversed: boolean } | null {
    if (step.mode === "logical") {
      if (!this.spend(1)) return null;
      return { dir: path.resolve(current, step.value), traversed: true };
    }
    // Physical: a `chdir(2)` from the real directory, one component at a time.
    if (!this.spend(1)) return null;
    let real = path.isAbsolute(step.value) ? path.sep : realpathOrSelf(current);
    let traversed = true;
    for (const part of step.value.split("/")) {
      if (part.length === 0 || part === ".") continue;
      if (!this.spend(1)) return null;
      // `chdir(2)` passes through `real` to reach `..`, so `real` must be a
      // directory it can search; the joined path alone does not show that
      // (`file/..` names the file's directory, and macOS `realpath(3)`
      // resolves it without an error).
      if (part === ".." && !isEnterableDirectory(real)) traversed = false;
      const named = path.join(real, part);
      try {
        real = fs.realpathSync.native(named);
      } catch {
        real = path.resolve(real, part);
      }
    }
    return { dir: real, traversed };
  }
}
