// Pre-overwrite backup of the `harness apply --target` settings file.
//
// `apply --target` writes an operator-owned file (today `settings.json`).
// With `--merge` only the keys harness owns are replaced, but a
// hand-maintained hook group is still lost by the rewrite, and `--force`
// discards everything the file held. So before overwriting a target that
// harness itself did not write last, apply copies the current bytes to
// `<target>.bak.<timestamp>` first, beside the requested path, naming the
// copy the same way `harness gate disable` names its settings backup
// (`backupPath`, `src/cli/gate/snapshot.ts`).
//
// The skip condition is content-identity, not a flag: `harness.lock`
// carries a `target` entry holding the sha256 of what the previous apply
// wrote (the entry the target write keeps in step with the file, see the
// comment above it in `apply.ts`). When the bytes now on disk hash to that
// recorded sha, the file is still exactly what apply itself wrote, and the
// overwrite loses nothing a backup could save. Every other state is
// backed up (fail safe): a recorded sha that differs (a hand edit), no
// record at all (a lock without a `target` entry, or no lock), a record
// whose sha can be read but never matches (a corrupted lock line), a
// record naming another path. A target that does not exist is created,
// and with nothing to protect, no backup is written.
//
// The copy is byte-for-byte and never follows a symlink into the backup
// name: the destination is opened `O_WRONLY | O_CREAT | O_EXCL` (plus
// `O_NOFOLLOW` where the platform has it, the one flag set
// `atomicWriteFile` opens its temp files with), so whatever already sits
// at the backup name - a file, a directory, a planted symlink - makes
// the write fail instead of being overwritten or followed. A symlinked
// target is read through (its current bytes are what the overwrite
// replaces) but the copy sits beside the link, never beside the file it
// leads to, the way the Codex installer backs a symlinked config up
// beside the link (`linkPath`, `src/cli/apply/install-codex-config.ts`):
// a settings file can hold secrets and its target directory is typically
// a dotfiles work tree an untracked copy would sit in.
//
// A backup that cannot be written aborts the apply before the target is
// touched: the error names the backup path, and no partial state is
// left, because this runs strictly before the target write.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ATOMIC_WRITE_TEMP_FLAGS } from "../../io/atomic-write.js";
import type { LockEntry } from "../../io/harness-lock.js";
import { backupPath } from "../gate/snapshot.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { existingFileMode } from "./install-codex-config.js";

/** Whether `harness.lock` holds a `target` entry for `targetPath` whose
 * recorded sha equals the sha of the bytes on disk now, i.e. the file is
 * still exactly what a previous apply wrote. `resolve` normalizes a
 * recorded spelling (a trailing separator, a `.` segment) before the
 * compare; any other difference in spelling is not this target's record
 * and decides for a backup, which is the fail-safe direction. */
function harnessWroteTheseBytes(
  lockEntries: readonly LockEntry[],
  targetPath: string,
  currentSha256: string,
): boolean {
  return lockEntries.some(
    (e) => e.kind === "target" && path.resolve(e.path) === targetPath && e.sha256 === currentSha256,
  );
}

/**
 * Copy the current target file aside before the apply overwrites it, and
 * return the backup path (`<target>.bak.<ISO>` beside `targetPath`, the
 * gate's `backupPath` format, stamped with the apply's injectable clock).
 * Returns `undefined` when no backup is due: nothing is on disk to
 * protect (absent path or dangling link: the write creates the file), or
 * the bytes on disk still equal what `harness.lock` records for this
 * target (harness wrote them itself). A backup write that fails throws
 * naming the backup path - the caller must run this before touching the
 * target, so a throw leaves the target untouched.
 */
export function backupTargetBeforeOverwrite(
  targetPath: string,
  lockEntries: readonly LockEntry[] | null,
  now: Date,
): string | undefined {
  let current: Buffer;
  try {
    current = fs.readFileSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new HarnessExitError(`harness apply: cannot read ${targetPath} to back it up before overwriting it (${(err as Error).message}); the target was not written`, EX_FAIL);
  }
  const currentSha256 = crypto.createHash("sha256").update(current).digest("hex");
  if (lockEntries !== null && harnessWroteTheseBytes(lockEntries, targetPath, currentSha256)) {
    return undefined;
  }
  const dest = backupPath(targetPath, now);
  try {
    const mode = existingFileMode(targetPath);
    const fd = fs.openSync(dest, ATOMIC_WRITE_TEMP_FLAGS, mode);
    try {
      fs.writeFileSync(fd, current);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new HarnessExitError(`harness apply: cannot write the target backup ${dest} (${(err as Error).message}); ${targetPath} was not written`, EX_FAIL);
  }
  return dest;
}
