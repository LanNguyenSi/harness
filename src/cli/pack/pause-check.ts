// Hook-side wrapper around the pause sentinel. Every PreToolUse /
// PostToolUse pack hook calls `checkPauseFromLoader` immediately after
// parsing stdin and BEFORE attempting to load the manifest — a broken
// install (corrupted YAML, missing file) must still honour an operator
// pause, since the lockout-recovery flow is the exact scenario where
// the install is in a degraded state.
//
// Keeping this helper out of `src/runtime/pause-sentinel.ts` preserves
// the runtime tree's no-loader rule (runtime/ already imports io/, but
// pulling in cli/loader.ts would transitively drag YAML parsing into
// every pack-pack import).

import { resolveGeneratedDir } from "../../io/generated-dir.js";
import { maybeAnnouncePause } from "../../runtime/pause-sentinel.js";
import { resolvePaths, type LoaderOptions } from "../loader.js";

export interface CheckPauseOptions {
  /** Loader options (configPath, homeDir, project). */
  loaderOpts?: LoaderOptions;
  /** Test-injected generatedDir; bypasses path resolution when supplied. */
  generatedDir?: string;
  /** Short label identifying the hook in the stderr notice. */
  hookLabel: string;
  /** Where to write the notice. Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Override "now" for tests. */
  now?: Date;
}

/**
 * Returns `{ paused: true }` when a non-expired pause sentinel exists at
 * the resolved generatedDir, after emitting a one-line stderr notice.
 * Returns `{ paused: false }` for absent, expired (auto-resumes), or
 * resolution-failure cases.
 */
export function checkPauseFromLoader(opts: CheckPauseOptions): { paused: boolean } {
  let generatedDir: string;
  if (opts.generatedDir !== undefined) {
    generatedDir = opts.generatedDir;
  } else {
    try {
      const loader = opts.loaderOpts ?? {};
      generatedDir = resolveGeneratedDir({
        ...(loader.homeDir !== undefined ? { homeDir: loader.homeDir } : {}),
        manifestPath: resolvePaths(loader).base,
      });
    } catch {
      // resolvePaths only fails in pathological env states (HOME unset,
      // unreadable cwd). Degrade silently: a broken path resolver should
      // never escalate into a hook block.
      return { paused: false };
    }
  }
  const announceOpts: Parameters<typeof maybeAnnouncePause>[0] = {
    generatedDir,
    hookLabel: opts.hookLabel,
  };
  if (opts.stderr !== undefined) announceOpts.stderr = opts.stderr;
  if (opts.now !== undefined) announceOpts.now = opts.now;
  return maybeAnnouncePause(announceOpts);
}
