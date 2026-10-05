import * as fs from "node:fs";

/**
 * Result of a symlink-rejecting regular-file read. The kinds are deliberately
 * fine-grained because the gate readers need to keep their distinct deny
 * details (missing vs symlink vs not-regular) and one caller treats
 * exists-but-unreadable as "existence already satisfied the gate".
 */
export type RegularFileRead =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "not-regular" }
  | { kind: "unreadable" };

/**
 * Result of a stat-only existence probe (see `probePathPresence`). No
 * `content`: this never reads the file, only classifies what lstat sees at
 * the path. `present` covers a symlink, a directory, or any other non-regular
 * node the caller wants to treat as "something is there" without yet reading
 * it or deciding whether it is a valid regular file.
 */
export type PathPresence = { kind: "missing" } | { kind: "present" };

/**
 * The single `fs.lstatSync` call both exports below stand on. Returns `null`
 * on any lstat failure (absent path, or unreachable for another reason:
 * `EACCES`, `ENOTDIR`, ...); lstat cannot distinguish those cases from each
 * other, so neither export tries to. A future defensive fix here
 * (e.g. `ENOTDIR` handling) lands in this one place and is inherited by both
 * callers.
 */
function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Open flags for the gate-marker read. `O_NOFOLLOW` makes the open itself
 * refuse a symbolic link at the final path component (`ELOOP`), so no
 * earlier `lstat` is needed for a swap to race. `O_NONBLOCK` keeps an open
 * of a FIFO with no writer from waiting for one: the open returns at once
 * and the descriptor's type then refuses it. Both are POSIX-only flags;
 * `fs.constants` leaves them `undefined` on Windows (see
 * `readRegularFileRejectingSymlink` for that fallback).
 */
const O_NOFOLLOW: number | undefined = fs.constants.O_NOFOLLOW;
const O_NONBLOCK: number = fs.constants.O_NONBLOCK ?? 0;

/**
 * Classify a failed open by what `lstat` sees at the path now, so the
 * caller-visible kinds stay what they were when `lstat` came first: an
 * unreachable path (absent, `ENOTDIR`, an unsearchable parent) is `missing`,
 * a symlink (dangling included) is `symlink`, any other non-regular node is
 * `not-regular`, and a regular file the open could not read (`EACCES`, ...)
 * is `unreadable`. A path that raced into a different state between the
 * failed open and this `lstat` still lands on one of the five kinds, never
 * on `ok`.
 */
function classifyOpenFailure(filePath: string): RegularFileRead {
  const stat = lstatOrNull(filePath);
  if (stat === null) return { kind: "missing" };
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "not-regular" };
  return { kind: "unreadable" };
}

/**
 * Read a marker/verdict file as utf8, refusing symlinks and non-regular
 * files. The path is opened once, read-only, with `O_NOFOLLOW` (a symlink at
 * the path is refused by the open itself) and `O_NONBLOCK` (opening a FIFO
 * with no writer returns at once instead of waiting for one). The type of
 * the OPENED descriptor then decides (`fstat`, never a separate stat of the
 * path), and the content is read through that same descriptor, so nothing
 * can be swapped in between a check and the read: a writer that replaces the
 * file with a FIFO or a symlink after any earlier look gets `not-regular` /
 * `symlink` back, not a read that blocks the hook past its budget (which the
 * runtime treats as an allow). The descriptor is always closed.
 *
 * Why refuse symlinks at all: defense-in-depth against a symlink at the
 * marker path pointing at an arbitrary target the agent controls. In
 * today's threat model the agent has no Edit / Write / Bash path to plant
 * such a symlink (the same PreToolUse hook gates all three), but the gate
 * contract is to assume the agent is hostile, so the refusal is cheap
 * insurance (agent-tasks/d39f160e).
 *
 * Platforms without `O_NOFOLLOW` (Windows): an `lstat` runs first and
 * refuses a symlink or a non-regular node before the open, because the open
 * alone would follow a link. That leaves the old lstat-to-open window on
 * those platforms; there is no FIFO node on the filesystem there to swap in
 * (named pipes live in a separate namespace), and `O_NONBLOCK` is a no-op
 * flag that is simply left out. The descriptor type check still runs.
 *
 * This is THE shared implementation for every gate-marker read; a future
 * defensive fix belongs here and in `classifyOpenFailure`/`lstatOrNull`, and
 * nowhere else. Its lighter-weight sibling `probePathPresence`, below,
 * shares this file for the same reason: both stand on the same
 * `lstatOrNull` helper, and a caller that only needs to know "is anything
 * there" before deciding whether to pay for the full read (e.g.
 * `verifyDelegation`'s existence-before-path-hash check in
 * `src/policy-packs/builtin/understanding-before-execution/delegation-markers.ts`)
 * gets that from here instead of hand-rolling its own `lstatSync` try/catch.
 */
export function readRegularFileRejectingSymlink(filePath: string): RegularFileRead {
  if (O_NOFOLLOW === undefined) {
    const stat = lstatOrNull(filePath);
    if (stat === null) return { kind: "missing" };
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (!stat.isFile()) return { kind: "not-regular" };
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (O_NOFOLLOW ?? 0) | O_NONBLOCK);
  } catch {
    return classifyOpenFailure(filePath);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: "not-regular" };
    return { kind: "ok", content: fs.readFileSync(fd, "utf8") };
  } catch {
    return { kind: "unreadable" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone; nothing left to release.
    }
  }
}

/**
 * Stat-only existence probe: "is anything there", nothing more. Uses the
 * same `lstatOrNull` helper (not `stat`) as `readRegularFileRejectingSymlink`
 * so a symlink or a directory answers `present`, not `missing`; this probe
 * cannot and does not classify WHAT is there (regular file, symlink,
 * directory), only whether lstat can see anything at all. A path lstat
 * cannot reach for any reason (absent, or unreachable: `EACCES`, `ENOTDIR`,
 * ...) comes back `missing`; lstat cannot distinguish those cases, so
 * neither does this probe. Callers that need the file-type distinction
 * (symlink vs directory vs regular) read the file instead, through
 * `readRegularFileRejectingSymlink`.
 */
export function probePathPresence(filePath: string): PathPresence {
  return lstatOrNull(filePath) === null ? { kind: "missing" } : { kind: "present" };
}
