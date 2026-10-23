// Independent presence check for the git-branch tests: a plain filesystem
// walk from `dir` up to the root looking for an entry named `.git`, written
// on `node:fs` alone and importing nothing from src/runtime/git-branch.js.
//
// The cases outside every repository need this to decide their skip: a skip
// decided by the very function under test is not a skip at all, because a
// walk that reports a repository at the filesystem root (for example) turns
// every such case into a silent pass instead of a failure. Walking the
// filesystem separately keeps the decision independent of the code under
// test.
//
// Like the walk under test, an `lstat` that fails for a reason other than a
// missing path counts as present: the case cannot show anything on such a
// host, and git itself defers in the same situation.
import * as fs from "node:fs";
import * as path from "node:path";
import type { TestContext } from "vitest";

export const GIT_ABOVE_TMP_REASON = "the host keeps a repository above the temp directory";

/** True when an entry named `.git` exists in `dir` or in any directory above it. */
export function gitEntryAboveOnFilesystem(dir: string): boolean {
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

/** The reason a case that needs no `.git` above `dir` fails rather than skips on CI. */
export function outsideRepositoryFailureReason(dir: string): string {
  return (
    `${GIT_ABOVE_TMP_REASON} (${dir}): these cases must not skip when CI=true, ` +
    "so a host whose temp directory sits inside a repository fails visibly here"
  );
}

/**
 * Skip the running case when an entry named `.git` exists above `dir`, as
 * decided by the independent walk, not by the function under test. On CI
 * (`CI=true`) an outside-repository case never skips: it fails with the
 * reason, so a host that cannot run it is seen instead of hidden.
 */
export function skipIfGitEntryAbove(ctx: TestContext, dir: string): void {
  if (!gitEntryAboveOnFilesystem(dir)) return;
  if (process.env.CI === "true") throw new Error(outsideRepositoryFailureReason(dir));
  ctx.skip(GIT_ABOVE_TMP_REASON);
}
