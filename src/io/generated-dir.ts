import * as path from "node:path";
import { expandHome } from "./expand-home.js";

// `harness.generated/` lives next to whichever manifest is in use. If the
// user passed `--config /repo/path/harness.yaml`, generated artefacts go to
// `/repo/path/harness.generated/` (NOT `~/.claude/harness.generated/`). This
// avoids the footgun of `harness apply --config <some-other-tree>` writing
// state into the user's global runtime directory. The `homeDir` override
// path is for tests and non-default-home installs.

export const GENERATED_DIRNAME = "harness.generated";

/**
 * Single normalization point for every `generatedDir` consumer (task
 * 8254e357, follow-up to review round H1-R2 on task 03a917fd). Normalizes
 * EXACTLY ONCE, here, via `expandHome` + `path.resolve` — the same
 * `~`-then-resolve idiom `signingKeyEnvValue` (generate-settings.ts)
 * already applies to the projected `SOLUTION_VERDICT_SIGNING_KEY` env
 * value. Before this, the raw (possibly relative or literal-`~`) result
 * flowed unnormalized into `fs.mkdirSync` (apply.ts) and the
 * approval-signing key writer (`getOrCreateSigningKey`,
 * approval-signing.ts), while only the projected ENV VALUE was
 * normalized. A literal-`~` `homeDir` (e.g. `HARNESS_HOME='~/...'` from a
 * docker/systemd env where the shell never expands it — `resolveHomeDir`,
 * runtime/home-dir.ts, passes the env var through verbatim) then pointed
 * the env at a normalized path while the key FILE was written under the
 * raw, un-expanded one: a silent dangling pointer instead of a loud
 * failure. Normalizing once here means every caller (apply's mkdirSync,
 * the approval-signing key writer, adopt, doctor, and the signing-key env
 * projection, all of which receive their `generatedDir` from this
 * function or re-derive it via the same `resolveGeneratedDir({homeDir,
 * manifestPath})` call shape) sees the identical, already-real path — no
 * per-consumer re-normalization needed or wanted.
 *
 * Behaviour change for previously-raw inputs: a relative `manifestPath`
 * was already resolved against `process.cwd()` by the time it reaches
 * here in every known call site (the CLI resolves `--config` before
 * calling), so `path.dirname` was already absolute in practice; a
 * relative `homeDir`, if ever passed, now resolves against
 * `process.cwd()` at CALL time via `path.resolve`, matching how
 * `signingKeyEnvValue` already resolves a relative `generatedDir` — same
 * base, same timing, no new divergence between the two.
 */
export function resolveGeneratedDir(opts: {
  homeDir?: string;
  manifestPath: string;
}): string {
  const raw =
    opts.homeDir !== undefined
      ? path.join(opts.homeDir, GENERATED_DIRNAME)
      : path.join(path.dirname(opts.manifestPath), GENERATED_DIRNAME);
  return path.resolve(expandHome(raw));
}
