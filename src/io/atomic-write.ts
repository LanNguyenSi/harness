import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Document, parseDocument } from "yaml";

export interface AtomicWriteOptions {
  mode?: number;
}

/**
 * Open flags for the temp file. The temp file is created by this call or the
 * write fails:
 *
 * - `O_EXCL` (with `O_CREAT`) makes the open fail with `EEXIST` on anything
 *   already at the name: a regular file, a FIFO (which a plain `O_WRONLY`
 *   open would block on until a reader shows up), or a symlink (which a
 *   plain open follows, writing through the link). It never follows a
 *   symlink on create and never blocks, so a file planted in the target's
 *   directory (an agent-writable reports directory, for one) can neither
 *   hang the writer nor redirect the write.
 * - `O_NOFOLLOW` repeats the symlink refusal for the final path component on
 *   its own (defence in depth: `O_EXCL | O_CREAT` already refuses a symlink).
 *   On a platform that does not define it (Windows), the constant is absent
 *   and the flag is dropped; `O_EXCL | O_CREAT` alone then carries the
 *   refusal.
 */
export const ATOMIC_WRITE_TEMP_FLAGS: number =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);

/** 64 random bits as lowercase hex, so the temp name cannot be predicted and pre-planted. */
export function randomTempSuffix(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Write `content` to `filePath` through a temp file renamed into place.
 * Successful writes are byte-identical to a plain write and keep the
 * requested mode (default 0o644, subject to the umask, as before).
 *
 * The temp file sits next to the target and is opened with
 * {@link ATOMIC_WRITE_TEMP_FLAGS} under a name carrying a random suffix. A
 * file already at that name makes the call throw (`EEXIST`) at once, without
 * touching it: the caller sees an ordinary write failure and keeps its own
 * failure posture. Once the temp file is open, any later failure (write,
 * fsync, close, rename) removes it again; the one path never removed is the
 * one this call did not create.
 *
 * `suffix` is a seam for tests that plant a file at a chosen candidate name;
 * production callers never pass it.
 */
export function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
  suffix: () => string = randomTempSuffix,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${suffix()}.tmp`);
  const fd = fs.openSync(tmpPath, ATOMIC_WRITE_TEMP_FLAGS, options.mode ?? 0o644);
  try {
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best effort: the original failure is the one worth reporting.
    }
    throw err;
  }
}

export function withDocument(
  yamlString: string,
  mutate: (doc: Document.Parsed) => void,
): string {
  const doc = parseDocument(yamlString);
  mutate(doc);
  // flowCollectionPadding:false matches our manifest style ([a, b], not [ a, b ]).
  // lineWidth:0 disables 80-col folding so long flow-sequences (e.g. an
  // mcp[].command path > 80 chars) are not silently rewritten to block style.
  // Together these make a no-op round-trip on a manifest authored in our
  // convention byte-equivalent.
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

export { parseDocument };
export type { Document };
