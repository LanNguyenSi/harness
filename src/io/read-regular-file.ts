import * as fs from "node:fs";

/**
 * Result of a symlink-rejecting regular-file read. The kinds are deliberately
 * fine-grained because the gate readers need to keep their distinct deny
 * details (missing vs symlink vs not-regular); every caller treats
 * `unreadable` (an oversized file included) as fail-closed.
 */
export type RegularFileRead =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "symlink" }
  | { kind: "not-regular" }
  | { kind: "unreadable" };

/**
 * The single `fs.lstatSync` call the readers below stand on. Returns `null`
 * on any lstat failure (absent path, or unreachable for another reason:
 * `EACCES`, `ENOTDIR`, ...); lstat cannot distinguish those cases from each
 * other, so no caller tries to. A future defensive fix here
 * (e.g. `ENOTDIR` handling) lands in this one place.
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
 * and the descriptor's type then refuses it. `O_NOFOLLOW` covers only the
 * LAST path component; a symlinked parent directory is followed, as it was
 * under the earlier lstat. `O_NOCTTY` is belt and braces for a tty node at
 * the path. All three are POSIX-only flags; `fs.constants` leaves them
 * `undefined` on Windows, where the code falls back to 0 (see
 * `readRegularFileBytesBounded` for that fallback).
 */
const O_NOFOLLOW: number | undefined = fs.constants.O_NOFOLLOW;
const O_NONBLOCK: number = fs.constants.O_NONBLOCK ?? 0;
/** A marker read must never make a terminal the process's controlling one. */
const O_NOCTTY: number = fs.constants.O_NOCTTY ?? 0;

/**
 * The most bytes the gate-marker read will return. Every caller reads a small
 * JSON record (an approval or delegation marker, an in-flight record, a
 * verdict, a launcher report, one adoption ledger of entry ids). A file over the
 * cap is refused as `unreadable` (fail-closed in every caller) before any
 * byte is read: a sparse multi-gigabyte file at a marker path otherwise
 * takes the hook past its budget, which the runtime treats as an allow, the
 * same fail-open a FIFO used to cause.
 */
export const MAX_REGULAR_FILE_READ_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read the opened descriptor to EOF, never more than `maxBytes + 1` bytes: a
 * file that grows after the `fstat` size check stays bounded too. Returns
 * `null` when the file is over the cap. Any read error propagates to the
 * caller.
 */
function readDescriptorBounded(fd: number, maxBytes: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
    const chunk = Buffer.allocUnsafe(want);
    const got = fs.readSync(fd, chunk, 0, want, null);
    if (got === 0) break;
    total += got;
    if (total > maxBytes) return null;
    chunks.push(got === want ? chunk : chunk.subarray(0, got));
  }
  return Buffer.concat(chunks);
}

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
function classifyOpenFailure(
  filePath: string,
  followSymlinks = false,
): Exclude<RegularFileRead, { kind: "ok" }> {
  if (followSymlinks) {
    // A link is followed by this read, so what matters is what it leads to:
    // a dangling link (or an unreachable parent) is absent, exactly as a
    // by-path read of it reports `ENOENT`; a link loop or an unreadable
    // target is something there that cannot be read.
    try {
      return fs.statSync(filePath).isFile() ? { kind: "unreadable" } : { kind: "not-regular" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
    }
  }
  const stat = lstatOrNull(filePath);
  if (stat === null) return { kind: "missing" };
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "not-regular" };
  return { kind: "unreadable" };
}

/**
 * Options of the readers below. They default to the gate-marker read's
 * behaviour (the 1 MiB cap, a symlink refused).
 */
export interface BoundedReadOptions {
  /**
   * The most bytes the read returns; a file over it is refused as
   * `unreadable` before any byte is read, exactly like the gate-marker
   * read's cap. Defaults to {@link MAX_REGULAR_FILE_READ_BYTES}. A caller
   * with a legitimately larger input (a packed-refs file, a kubeconfig, a
   * Claude Code user registry) passes its own, larger bound and justifies
   * it at the call site; there is deliberately no way to ask for no bound.
   */
  maxBytes?: number;
  /**
   * Follow a symbolic link at the path (the open drops `O_NOFOLLOW`). For a
   * reader of a file the operator or git legitimately keeps behind a link
   * (a dotfiles-managed manifest, a kubeconfig); it never weakens the
   * rest: the type of the OPENED descriptor still decides, so a link to a
   * FIFO, a device or a directory is `not-regular` and never blocks.
   * Defaults to `false` (a link is refused as `symlink`).
   */
  followSymlinks?: boolean;
}

export type RegularFileBytesRead =
  | { kind: "ok"; bytes: Buffer }
  | Exclude<RegularFileRead, { kind: "ok" }>;

/**
 * The one open-once, type-checked-on-the-descriptor, size-bounded read every
 * by-path reader on a hook path stands on, returning raw bytes (a binary key
 * file needs them, `readRegularFileBounded` decodes them). The cap and the
 * symlink policy are options.
 *
 * The path is opened once, read-only, with `O_NOFOLLOW` (a symlink at the
 * path is refused by the open itself) and `O_NONBLOCK` (opening a FIFO with
 * no writer returns at once instead of waiting for one). The type of the
 * OPENED descriptor then decides (`fstat`, never a separate stat of the
 * path), and the content is read through that same descriptor, so nothing
 * can be swapped in between a check and the read: a writer that replaces the
 * file with a FIFO or a symlink after any earlier look gets `not-regular` /
 * `symlink` back, not a read that blocks the hook past its budget (which the
 * runtime treats as an allow). The descriptor is always closed. The size is
 * bounded too: a file over the cap by `fstat` is refused as `unreadable`
 * without a read, and the read itself stops one byte past the cap, so a file
 * that grows after the `fstat` is bounded as well.
 *
 * Why refuse symlinks at all: defense-in-depth against a symlink at the
 * path pointing at an arbitrary target the agent controls. The gate contract
 * is to assume the agent is hostile, so the refusal is cheap insurance
 * (agent-tasks/d39f160e).
 *
 * Platforms without `O_NOFOLLOW` (Windows): an `lstat` runs first and
 * refuses a symlink or a non-regular node before the open, because the open
 * alone would follow a link. That leaves the old lstat-to-open window on
 * those platforms; there is no FIFO node on the filesystem there to swap in
 * (named pipes live in a separate namespace), and `O_NONBLOCK` is a no-op
 * flag that is simply left out. The descriptor type check still runs.
 *
 * A future defensive fix belongs here and in `classifyOpenFailure` /
 * `lstatOrNull`, and nowhere else.
 */
export function readRegularFileBytesBounded(
  filePath: string,
  opts: BoundedReadOptions = {},
): RegularFileBytesRead {
  const maxBytes = opts.maxBytes ?? MAX_REGULAR_FILE_READ_BYTES;
  const noFollow = opts.followSymlinks !== true;
  if (noFollow && O_NOFOLLOW === undefined) {
    const stat = lstatOrNull(filePath);
    if (stat === null) return { kind: "missing" };
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (!stat.isFile()) return { kind: "not-regular" };
  }
  let fd: number;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (noFollow ? (O_NOFOLLOW ?? 0) : 0) | O_NONBLOCK | O_NOCTTY,
    );
  } catch {
    return classifyOpenFailure(filePath, !noFollow);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "not-regular" };
    if (st.size > maxBytes) return { kind: "unreadable" };
    const bytes = readDescriptorBounded(fd, maxBytes);
    if (bytes === null) return { kind: "unreadable" };
    return { kind: "ok", bytes };
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
 * {@link readRegularFileBytesBounded} decoded as utf8, for the by-path
 * readers of a file a symlink at the path is acceptable for or a larger cap
 * is justified (see {@link BoundedReadOptions}). Same five result kinds as
 * {@link readRegularFileBytesBounded}; `missing` is the one a caller may
 * treat as "legitimately absent", every other non-`ok` kind means something
 * is at the path that must not be read as the file (a FIFO, a device, a
 * directory, an oversized or unreadable file) and is fail-closed or
 * explicitly reported by the caller.
 */
export function readRegularFileBounded(
  filePath: string,
  opts: BoundedReadOptions = {},
): RegularFileRead {
  const read = readRegularFileBytesBounded(filePath, opts);
  return read.kind === "ok" ? { kind: "ok", content: read.bytes.toString("utf8") } : read;
}

/**
 * Thrown by {@link readTextFileBoundedOrThrow}. `code` is `ENOENT` for a
 * path that is not there (so a caller's existing `ENOENT` branch keeps
 * meaning "absent") and `E_<KIND>` (`E_SYMLINK`, `E_NOT_REGULAR`,
 * `E_UNREADABLE`) for anything else, which never matches `ENOENT`.
 */
export class BoundedReadError extends Error {
  readonly code: string;
  readonly kind: Exclude<RegularFileRead["kind"], "ok">;
  constructor(filePath: string, kind: Exclude<RegularFileRead["kind"], "ok">) {
    const code = kind === "missing" ? "ENOENT" : `E_${kind.toUpperCase().replace(/-/g, "_")}`;
    super(`${code}: ${filePath} ${DESCRIBE_KIND[kind]}`);
    this.name = "BoundedReadError";
    this.code = code;
    this.kind = kind;
  }
}

const DESCRIBE_KIND: Record<Exclude<RegularFileRead["kind"], "ok">, string> = {
  missing: "does not exist",
  symlink: "is a symbolic link (refused)",
  "not-regular": "is not a regular file (refused without a read)",
  unreadable: "is unreadable or larger than the read cap",
};

/**
 * {@link readRegularFileBounded} for the call sites that already wrap a
 * `fs.readFileSync(path, "utf8")` in a try/catch (and, some of them, branch
 * on `ENOENT`): the same bounded, non-blocking read, thrown as a
 * {@link BoundedReadError} instead of returned, so the existing catch blocks
 * keep their shape and every FIFO, device, directory or oversized file now
 * lands in the catch block it would have reached on any other read error,
 * rather than blocking the process.
 */
export function readTextFileBoundedOrThrow(filePath: string, opts: BoundedReadOptions = {}): string {
  const read = readRegularFileBounded(filePath, opts);
  if (read.kind === "ok") return read.content;
  throw new BoundedReadError(filePath, read.kind);
}
