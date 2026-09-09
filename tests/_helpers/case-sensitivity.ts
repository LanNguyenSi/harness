// Shared case-sensitivity probe (task 6c8c1bae):
// writes a lowercase marker file into `dir`, stats the uppercase
// spelling, and compares inodes. A case-insensitive filesystem (APFS's
// default, some Windows filesystems) resolves both spellings to the
// same inode; a case-sensitive one (ext4, a case-sensitive APFS volume)
// either reports a distinct inode or fails to find the uppercase
// spelling at all, both treated as case-sensitive here.
//
// Consolidates what were three independent copies of this probe
// (tests/runtime/git-context.test.ts inline, tests/cli/session-start/
// preflight.test.ts, tests/cli/loader-project-layer.test.ts) into one.
// tests/runtime/git-context.test.ts keeps its own inline copy (left
// alone per the task brief); the other two use this export.
import * as fs from "node:fs";
import * as path from "node:path";

export function isCaseInsensitiveFilesystem(dir: string): boolean {
  const markerLower = path.join(dir, "case-probe-marker");
  fs.writeFileSync(markerLower, "x");
  const markerUpper = path.join(dir, "CASE-PROBE-MARKER");
  let caseInsensitive: boolean;
  try {
    caseInsensitive = fs.statSync(markerUpper).ino === fs.statSync(markerLower).ino;
  } catch {
    caseInsensitive = false;
  }
  fs.rmSync(markerLower, { force: true });
  return caseInsensitive;
}
