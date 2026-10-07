import * as fs from "node:fs";

/**
 * The write-side counterpart of `read-regular-file.ts`. A by-path
 * `fs.writeFileSync` / `fs.appendFileSync` opens the path blocking: a FIFO
 * with no reader at the path holds the call until a reader shows up, and on
 * a hook path that means the hook runs past its budget, which the runtime
 * treats as an allow. Every write on a hook path goes through here instead:
 * the path is opened ONCE, non-blocking, and the type of the OPENED
 * descriptor (`fstat`, never a separate stat of the path) must be a regular
 * file before a byte is written, so a node swapped in after any earlier look
 * is refused instead of blocking.
 *
 * `O_NONBLOCK` makes the open of a FIFO that has no reader fail with `ENXIO`
 * at once (a FIFO that does have a reader opens, and the `fstat` check then
 * refuses it); `O_NOCTTY` keeps a tty node from becoming the controlling
 * terminal. Both are POSIX flags and fall back to 0 where `fs.constants`
 * leaves them out (Windows has no FIFO node on the filesystem to swap in).
 */
const O_NONBLOCK: number = fs.constants.O_NONBLOCK ?? 0;
const O_NOCTTY: number = fs.constants.O_NOCTTY ?? 0;
const O_NOFOLLOW: number = fs.constants.O_NOFOLLOW ?? 0;

/** Thrown when the node at a write target is not a regular file. `code` is `E_NOT_REGULAR`. */
export class NotRegularWriteTargetError extends Error {
  readonly code = "E_NOT_REGULAR";
  constructor(filePath: string) {
    super(`E_NOT_REGULAR: ${filePath} is not a regular file (write refused without a write)`);
    this.name = "NotRegularWriteTargetError";
  }
}

export interface RegularFileWriteOptions {
  /** Mode for a file this call creates (default 0o644, subject to the umask). */
  mode?: number;
  /**
   * What to do when nothing is at the path. `"create"` (default) creates it;
   * `"exclusive"` creates it and fails with `EEXIST` on ANYTHING already
   * there (`O_EXCL`: never follows a symlink, never blocks on a FIFO), the
   * shape for a name this call just generated.
   */
  create?: "create" | "exclusive";
  /**
   * Refuse a symlink at the final path component (`O_NOFOLLOW`, `ELOOP`).
   * Default `false`: a link is followed, as a plain `fs.writeFileSync` does,
   * and the type of the opened descriptor still decides.
   */
  noFollow?: boolean;
}

function writeFlags(extra: number, opts: RegularFileWriteOptions): number {
  return (
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    (opts.create === "exclusive" ? fs.constants.O_EXCL : 0) |
    (opts.noFollow === true ? O_NOFOLLOW : 0) |
    O_NONBLOCK |
    O_NOCTTY |
    extra
  );
}

function openRegularForWrite(filePath: string, flags: number, mode: number | undefined): number {
  const fd = fs.openSync(filePath, flags, mode ?? 0o644);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new NotRegularWriteTargetError(filePath);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone; nothing left to release.
    }
    throw err;
  }
  return fd;
}

function writeAll(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

/**
 * Replace the content of `filePath` (the `fs.writeFileSync` shape: create or
 * truncate), opened non-blocking and typed on the descriptor. The file is
 * truncated only AFTER the descriptor proved to be a regular file. Throws the
 * open error (`ENXIO` for a FIFO with no reader, `ELOOP`, `EEXIST`, ...) or a
 * {@link NotRegularWriteTargetError}.
 */
export function writeRegularFileNonBlocking(
  filePath: string,
  data: string | Uint8Array,
  opts: RegularFileWriteOptions = {},
): void {
  const fd = openRegularForWrite(filePath, writeFlags(0, opts), opts.mode);
  try {
    fs.ftruncateSync(fd, 0);
    writeAll(fd, data);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone; nothing left to release.
    }
  }
}

/**
 * Append `data` to `filePath` (the `fs.appendFileSync` shape: `O_APPEND`, so
 * a single short write lands whole even when two hooks race), opened
 * non-blocking and typed on the descriptor.
 */
export function appendRegularFileNonBlocking(
  filePath: string,
  data: string,
  opts: RegularFileWriteOptions = {},
): void {
  const fd = openRegularForWrite(filePath, writeFlags(fs.constants.O_APPEND, opts), opts.mode);
  try {
    writeAll(fd, data);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone; nothing left to release.
    }
  }
}
