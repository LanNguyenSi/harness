// Hand-built git directories (task 51bfba5a). Repository detection accepts
// a git directory only when git would: a `HEAD` git accepts AND an
// `objects/` and a `refs/` directory in its common directory. A fixture that
// means a repository but writes only `HEAD` is refused now, so a test that
// expects a block on a protected branch could pass for the wrong reason.
// Every hand-built fixture that means a repository calls this beside its
// `HEAD` write.
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Create the `objects/` and `refs/` directories git requires of `gitDir`
 * (a `.git` directory, a bare repository, or the common directory a linked
 * worktree's `commondir` names). Idempotent; creates `gitDir` itself too.
 */
export function addGitDirSkeleton(gitDir: string): void {
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs"), { recursive: true });
}
