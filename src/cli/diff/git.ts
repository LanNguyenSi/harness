import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EX_UNAVAILABLE, EX_USAGE, HarnessExitError } from "../exit-codes.js";

export interface GitContext {
  root: string;
  manifestRelPath: string;
}

// `git rev-parse --show-toplevel` reports the PHYSICAL work-tree path
// (symlinks resolved), so every path we relativize against that root must
// be resolved the same way, or `path.relative` climbs out of the repo.
// Bites on macOS out of the box: os.tmpdir() is /var/folders/…, a symlink
// to /private/var/folders/…. Nonexistent paths stay merely resolved; the
// callers' existing not-found error paths own that case.
function toPhysicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function locateGitContext(manifestPath: string): GitContext {
  const physicalManifestPath = toPhysicalPath(manifestPath);
  const dir = path.dirname(physicalManifestPath);
  let root: string;
  try {
    root = runGit(["rev-parse", "--show-toplevel"], dir).trim();
  } catch (err) {
    throw new HarnessExitError(
      `git is not available or ${dir} is not inside a git work tree: ${(err as Error).message.trim()}`,
      EX_UNAVAILABLE,
    );
  }
  const relPath = path.relative(root, physicalManifestPath);
  return { root, manifestRelPath: relPath };
}

export function readManifestAtRef(ctx: GitContext, ref: string): string {
  try {
    return runGit(["show", `${ref}:${ctx.manifestRelPath}`], ctx.root);
  } catch (err) {
    const message = (err as Error & { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new HarnessExitError(
      `cannot read ${ctx.manifestRelPath} at git ref "${ref}": ${message}`,
      EX_USAGE,
    );
  }
}

/**
 * Repo-relative path for `absPath` in git's forward-slash form, or null
 * when the file lives outside the repo work tree (e.g. an override layer
 * under a ~/.harness home that is not the manifest's repo).
 *
 * Callers pass paths that exist on disk (layers are existsSync-gated at
 * resolve time). A nonexistent path under a symlinked parent would skip
 * realpath resolution and could misreport as outside-repo (null) — null
 * stays the safe, non-crashing failure mode either way.
 */
export function repoRelativePath(ctx: GitContext, absPath: string): string | null {
  const rel = path.relative(ctx.root, toPhysicalPath(absPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Read a repo file at a git ref, or null when it does not exist at that
 * ref. Callers must have validated the ref itself first (the base-manifest
 * read via {@link readManifestAtRef} hard-errors on a bad ref), so a null
 * here means "file absent at ref", not "bad ref".
 */
export function readFileAtRefOrNull(
  ctx: GitContext,
  ref: string,
  relPath: string,
): string | null {
  try {
    return runGit(["show", `${ref}:${relPath}`], ctx.root);
  } catch {
    return null;
  }
}
