// Pre-overwrite backup of the `harness apply --target` settings file.
//
// `apply --target` writes an operator-owned file (today `settings.json`).
// With `--merge` only the keys harness owns are replaced, but a
// hand-maintained hook group is still lost by the rewrite, and `--force`
// discards everything the file held. So whenever the target exists and
// this apply is about to change it, apply copies the current bytes to
// `<target>.bak.<timestamp>` first, beside the requested path, naming the
// copy the same way `harness gate disable` names its settings backup
// (`backupPath`, `src/cli/gate/snapshot.ts`).
//
// There is no content-based skip. The `target` sha in `harness.lock` is a
// drift baseline, not a record of what apply wrote: a plain `harness
// apply` without `--target` re-hashes the on-disk target into the lock
// (the carry path in `appendTargetEntry`, `apply.ts`, and the no-changes
// drift refresh), so after such a run a hand edit matches the record and
// a "the lock already hashes these bytes" skip would let the next
// `apply --target --merge` overwrite it without a copy. Every overwrite
// that changes an existing target therefore leaves a copy, whatever the
// lock says. A target that does not exist is created, and with nothing to
// protect, no backup is written; a target that already holds exactly the
// bytes apply would write is not rewritten at all and needs no backup.
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
// A backup that cannot be written aborts the apply before anything is
// written: the error names the backup path, and the caller runs this
// before `harness.generated/` or the target is touched, so no partial
// apply state is left. If the destination was created but the copy then
// fails (a write or fsync error), the partial backup is removed before
// the error is thrown: like `atomicWriteFile`, a failed write never
// leaves a file the call created sitting around.

import * as fs from "node:fs";
import { ATOMIC_WRITE_TEMP_FLAGS } from "../../io/atomic-write.js";
import { backupPath } from "../gate/snapshot.js";
import { EX_FAIL, HarnessExitError } from "../exit-codes.js";
import { existingFileMode } from "./install-codex-config.js";

/**
 * Copy the current target file aside before the apply overwrites it, and
 * return the backup path (`<target>.bak.<ISO>` beside `targetPath`, the
 * gate's `backupPath` format, stamped with the apply's injectable clock).
 * Returns `undefined` only when nothing is on disk to protect (absent
 * path or dangling link: the write creates the file). A backup write
 * that fails throws naming the backup path - the caller must run this
 * before touching anything, so a throw leaves the apply unwritten.
 */
export function backupTargetBeforeOverwrite(targetPath: string, now: Date): string | undefined {
  let current: Buffer;
  try {
    current = fs.readFileSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new HarnessExitError(`harness apply: cannot read ${targetPath} to back it up before overwriting it (${(err as Error).message}); the target was not written`, EX_FAIL);
  }
  const dest = backupPath(targetPath, now);
  let created = false;
  try {
    const mode = existingFileMode(targetPath);
    const fd = fs.openSync(dest, ATOMIC_WRITE_TEMP_FLAGS, mode);
    // O_EXCL means openSync just created `dest`; anything written into it
    // from here on is ours to remove if the copy fails.
    created = true;
    try {
      fs.writeFileSync(fd, current);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (created) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // Best effort: the abort error below is what the operator sees.
      }
    }
    throw new HarnessExitError(`harness apply: cannot write the target backup ${dest} (${(err as Error).message}); ${targetPath} was not written`, EX_FAIL);
  }
  return dest;
}
