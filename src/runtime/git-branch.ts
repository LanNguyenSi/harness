// Branch reader for the branch-protection gate (task a4d8adc5).
//
// The gate asks git which branch a directory is on instead of parsing git's
// files itself. The directory is taken as the operating system resolves it
// (symlinks followed, `..` taken from the directory reached so far), which is
// the directory `git -C` changes into. Two steps, both bounded:
//
//   1. Presence walk: from the physical directory up to the filesystem root,
//      `lstat` an entry named `.git` (any type; nothing is opened or read).
//      When no such entry exists anywhere above, the directory is outside
//      every repository and git is not spawned at all.
//   2. `git -C <dir> symbolic-ref -q HEAD` through `execFile` (no shell,
//      stdin closed at once, each output stream capped), in the process
//      environment minus every `GIT_*` variable (so a `GIT_DIR` or
//      `GIT_WORK_TREE` inherited by the hook cannot point git at another
//      repository) plus `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` and
//      `GIT_OPTIONAL_LOCKS=0`. `HOME` stays, so the user's global git
//      configuration (`safe.directory` and the like) applies exactly as it
//      does to the agent's own git. A timeout ends the call with SIGKILL.
//
// git's answer is classified and never interpreted further: exit 0 with
// `refs/heads/<name>` is a branch, exit 1 with nothing on stdout and nothing
// on stderr is a detached HEAD (`symbolic-ref -q` prints nothing then), and
// anything else (another exit, an exit 1 with any output, a signal, a
// timeout, git missing, output past the cap, an exit-0 answer of another
// shape) is an error carrying git's first stderr line. The caller decides
// what an error means; the branch-protection hook refuses on every one.
//
// `writeTargetDirectories` names the directories a write to a path lands in,
// resolved the same physical way, so the hook asks about the directory the
// write reaches and not about the text of its path.
//
// The process runner is injectable (`GitHeadReader`) so tests can produce a
// timeout, a signal or a missing binary without depending on the host.

import { execFile, type ExecFileException } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Bound on one git call; the child is killed with SIGKILL when it passes. */
export const GIT_BRANCH_TIMEOUT_MS = 2000;
/** Cap on each of git's output streams, in bytes. */
export const GIT_OUTPUT_CAP_BYTES = 4096;
/** Cap on the stderr line carried into a refusal, in characters. */
export const GIT_STDERR_LINE_CAP = 200;

/** What one git call produced, before classification. */
export type GitHeadAnswer =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "signaled"; signal: string; stderr: string }
  | { kind: "timed-out"; timeoutMs: number; stderr: string }
  | { kind: "oversized"; stderr: string }
  | { kind: "spawn-failed"; code: string };

/** Runs `git -C <dir> symbolic-ref -q HEAD` (or a test double of it). */
export type GitHeadReader = (dir: string, timeoutMs: number) => Promise<GitHeadAnswer>;

/** The branch of a directory as the gate sees it. */
export type BranchRead =
  | { kind: "outside" }
  | { kind: "branch"; name: string }
  | { kind: "detached" }
  | { kind: "error"; detail: string };

/**
 * The environment git runs in: the given environment without any variable
 * whose name starts with `GIT_` (compared upper-cased), plus the three fixed
 * settings. Everything else, `HOME` and `PATH` included, is kept.
 */
export function gitReaderEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toUpperCase().startsWith("GIT_")) continue;
    env[key] = value;
  }
  env["LC_ALL"] = "C";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  return env;
}

function decode(out: unknown): string {
  if (Buffer.isBuffer(out)) return out.toString("utf8");
  return typeof out === "string" ? out : "";
}

/** The real reader: one `execFile` of git, never a shell. */
export const readGitHead: GitHeadReader = (dir, timeoutMs) =>
  new Promise<GitHeadAnswer>((resolve) => {
    let settled = false;
    const finish = (answer: GitHeadAnswer): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    try {
      const child = execFile(
        "git",
        ["-C", dir, "symbolic-ref", "-q", "HEAD"],
        {
          env: gitReaderEnv(),
          encoding: "buffer",
          maxBuffer: GIT_OUTPUT_CAP_BYTES,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          windowsHide: true,
          shell: false,
        },
        (err: ExecFileException | null, stdout: unknown, stderr: unknown) => {
          const out = decode(stdout);
          const errText = decode(stderr);
          if (err === null) {
            finish({ kind: "exited", code: 0, stdout: out, stderr: errText });
            return;
          }
          const code: unknown = (err as { code?: unknown }).code;
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            finish({ kind: "oversized", stderr: errText });
          } else if (typeof code === "number") {
            finish({ kind: "exited", code, stdout: out, stderr: errText });
          } else if (err.killed === true) {
            // execFile killed the child itself and the output cap is ruled
            // out above, so its timer fired.
            finish({ kind: "timed-out", timeoutMs, stderr: errText });
          } else if (typeof err.signal === "string" && err.signal.length > 0) {
            finish({ kind: "signaled", signal: err.signal, stderr: errText });
          } else {
            finish({ kind: "spawn-failed", code: typeof code === "string" ? code : "unknown" });
          }
        },
      );
      // stdin is closed at once: git never waits on it.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end();
    } catch (err) {
      const code: unknown = (err as { code?: unknown }).code;
      finish({ kind: "spawn-failed", code: typeof code === "string" ? code : "unknown" });
    }
  });

/** First non-empty line of `text`, control characters replaced, capped. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const clean = line.trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return clean.length > GIT_STDERR_LINE_CAP ? `${clean.slice(0, GIT_STDERR_LINE_CAP)}...` : clean;
}

function withLine(what: string, stderr: string): string {
  const line = firstLine(stderr);
  return line.length > 0 ? `${what}: ${line}` : what;
}

const BRANCH_REF = /^refs\/heads\/([^\n\r\u0000]+)\n?$/;

/** Classify one git answer. Never returns `outside`. */
export function classifyGitHeadAnswer(answer: GitHeadAnswer): BranchRead {
  switch (answer.kind) {
    case "exited": {
      if (answer.code === 0) {
        const m = BRANCH_REF.exec(answer.stdout);
        if (m !== null) return { kind: "branch", name: m[1]! };
        return { kind: "error", detail: `unexpected output from git: "${firstLine(answer.stdout)}"` };
      }
      if (answer.code === 1 && answer.stdout === "" && answer.stderr === "") return { kind: "detached" };
      return { kind: "error", detail: withLine(`git exited ${answer.code}`, answer.stderr) };
    }
    case "signaled":
      return { kind: "error", detail: withLine(`git was killed by ${answer.signal}`, answer.stderr) };
    case "timed-out":
      return { kind: "error", detail: withLine(`git did not answer within ${answer.timeoutMs} ms`, answer.stderr) };
    case "oversized":
      return { kind: "error", detail: withLine(`git's output passed ${GIT_OUTPUT_CAP_BYTES} bytes`, answer.stderr) };
    case "spawn-failed":
      return { kind: "error", detail: `git could not be started (${answer.code})` };
  }
}

/**
 * True when an entry named `.git` exists in `dir` or any directory above it.
 * Only `lstat` is used, so the entry is never opened. An `lstat` that fails
 * for another reason than a missing path counts as present: git decides.
 * `dir` is walked as written; `readBranch` passes the physical directory.
 */
export function hasGitEntryAbove(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Bound on the symlinks followed by their text for one target. */
const MAX_LINK_HOPS = 32;

/** `p` made absolute against `base` without editing its text (`..` and symlinks stay for the filesystem). */
export function absolutePath(p: string, base: string = process.cwd()): string {
  if (path.isAbsolute(p)) return p;
  const b = path.isAbsolute(base) ? base : `${process.cwd()}${path.sep}${base}`;
  return `${b}${path.sep}${p}`;
}

/** The root and the components of an absolute path, `..` kept, `.` and empty ones dropped. */
function splitPath(p: string): { root: string; parts: string[] } {
  const root = path.parse(p).root;
  const separators = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  const parts = p
    .slice(root.length)
    .split(separators)
    .filter((part) => part !== "" && part !== ".");
  return { root, parts };
}

/** The physical path of `p` when it leads to an existing directory; null otherwise. */
function physicalDirectory(p: string): string | null {
  try {
    const real = fs.realpathSync.native(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Walk `parts` from `root` the way the operating system resolves a path:
 * each existing component is resolved through the filesystem (symlinks
 * followed), and `..` steps up from the directory reached so far. From the
 * first component that is not an existing directory on, the rest is kept as
 * text (a write may create it; a `..` there steps back over it). Returns the
 * physical directory reached and how many components below it are missing.
 */
function walkPhysical(root: string, parts: readonly string[]): { dir: string; missing: number } {
  let dir = physicalDirectory(root) ?? root;
  const pending: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (pending.length > 0) pending.pop();
      else dir = path.dirname(dir);
      continue;
    }
    if (pending.length > 0) {
      pending.push(part);
      continue;
    }
    const next = physicalDirectory(path.join(dir, part));
    if (next === null) pending.push(part);
    else dir = next;
  }
  return { dir, missing: pending.length };
}

/**
 * The nearest directory at or above `p` that exists (a Write may create the
 * directories in between), as the operating system resolves `p`: through
 * symlinks, with `..` taken from the directory reached so far. A path that
 * cannot be examined counts as missing.
 */
export function nearestExistingDirectory(p: string): string {
  const { root, parts } = splitPath(absolutePath(p));
  return walkPhysical(root, parts).dir;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The physical directories a write to `target` (relative to `cwd`) lands
 * in: the nearest existing directory holding it and, when the target itself
 * is a symlink, the directory it leads to as well (a write may replace the
 * link or go through it). A link that does not resolve yet is followed by
 * its text, up to a bound.
 */
export function writeTargetDirectories(target: string, cwd: string): string[] {
  const dirs: string[] = [];
  let next: string | null = absolutePath(target, cwd);
  for (let hops = 0; next !== null && hops <= MAX_LINK_HOPS; hops += 1) {
    const { root, parts } = splitPath(next);
    next = null;
    const name = parts[parts.length - 1];
    if (name === undefined || name === "..") {
      dirs.push(walkPhysical(root, parts).dir);
      break;
    }
    const holder = walkPhysical(root, parts.slice(0, -1));
    dirs.push(holder.dir);
    if (holder.missing > 0) break;
    const entry = path.join(holder.dir, name);
    if (!isSymlink(entry)) break;
    try {
      const real = fs.realpathSync.native(entry);
      dirs.push(physicalDirectory(real) ?? path.dirname(real));
    } catch {
      try {
        next = absolutePath(fs.readlinkSync(entry), holder.dir);
      } catch {
        next = null;
      }
    }
  }
  return [...new Set(dirs)];
}

export interface ReadBranchOptions {
  reader?: GitHeadReader;
  timeoutMs?: number;
}

/**
 * Presence walk, then git, both on the physical directory of `dir` (the one
 * `git -C` changes into). `dir` should be an existing directory; one that
 * cannot be resolved is an error.
 */
export async function readBranch(dir: string, opts: ReadBranchOptions = {}): Promise<BranchRead> {
  let physical: string;
  try {
    physical = fs.realpathSync.native(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: "error", detail: `the directory could not be resolved (${typeof code === "string" ? code : "unknown"})` };
  }
  if (!hasGitEntryAbove(physical)) return { kind: "outside" };
  const reader = opts.reader ?? readGitHead;
  return classifyGitHeadAnswer(await reader(physical, opts.timeoutMs ?? GIT_BRANCH_TIMEOUT_MS));
}
