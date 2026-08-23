import * as path from "node:path";
import { expandHome } from "./expand-home.js";

// `harness.generated/` lives next to whichever manifest is in use. If the
// user passed `--config /repo/path/harness.yaml`, generated artefacts go to
// `/repo/path/harness.generated/` (NOT `~/.claude/harness.generated/`). This
// avoids the footgun of `harness apply --config <some-other-tree>` writing
// state into the user's global runtime directory. The `homeDir` override
// path is for tests and non-default-home installs.
//
// Sibling manifest/lock paths (e.g. the lockfile next to `harness.yaml`)
// are NOT normalized here — only the `generatedDir` this function returns.

export const GENERATED_DIRNAME = "harness.generated";

/**
 * Single normalization point for every `generatedDir` consumer (task
 * 8254e357, follow-up to review round H1-R2 on task 03a917fd). Normalizes
 * EXACTLY ONCE, here, via `expandHome` + `path.resolve`.
 *
 * - Tilde expansion: a leading `~/` or bare `~` in `homeDir` expands
 *   against `opts.userHome` (default: the process home, `os.homedir()`
 *   via `expandHome`'s own default). `~user/x` and `${HOME}/x` do NOT
 *   expand (see `expandHome`'s own doc comment for that scope).
 * - Relative inputs resolve against `process.cwd()` at CALL time.
 * - Idempotent: re-applying this function to its own output returns the
 *   same absolute path unchanged.
 */
export function resolveGeneratedDir(opts: {
  homeDir?: string;
  manifestPath: string;
  /** Overrides the home tilde expansion resolves against; defaults to `os.homedir()` (see `expandHome`). */
  userHome?: string;
}): string {
  const raw =
    opts.homeDir !== undefined
      ? path.join(opts.homeDir, GENERATED_DIRNAME)
      : path.join(path.dirname(opts.manifestPath), GENERATED_DIRNAME);
  return path.resolve(expandHome(raw, opts.userHome));
}
