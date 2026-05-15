import * as path from "node:path";

// `harness.generated/` lives next to whichever manifest is in use. If the
// user passed `--config /repo/path/harness.yaml`, generated artefacts go to
// `/repo/path/harness.generated/` (NOT `~/.claude/harness.generated/`). This
// avoids the footgun of `harness apply --config <some-other-tree>` writing
// state into the user's global runtime directory. The `homeDir` override
// path is for tests and non-default-home installs.

export const GENERATED_DIRNAME = "harness.generated";

export function resolveGeneratedDir(opts: {
  homeDir?: string;
  manifestPath: string;
}): string {
  if (opts.homeDir !== undefined) return path.join(opts.homeDir, GENERATED_DIRNAME);
  return path.join(path.dirname(opts.manifestPath), GENERATED_DIRNAME);
}
