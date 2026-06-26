// Shared bootstrap helpers for Claude Code pack hooks.
//
// Extracts the three init-phase boilerplate pieces that all (or most) pack
// hooks reimplemented independently:
//
//   1. stdin envelope read (the common event-stream pattern).
//   2. pause-sentinel check with announcement (wrapping checkPauseFromLoader
//      so callers skip the conditional-opts-building block).
//   3. manifest load with injection support (the common if-injected / else
//      loadManifest pattern; callers wrap the call in their own try/catch
//      because error semantics differ per hook).
//
// Not used by:
//   - hook-runtime-reality.ts: its stdin reader uses async iteration + an
//     isTTY guard, which is a legitimately different contract.
//   - hook-solution-acceptance-writeguard.ts: loads no manifest.
//   - hook-stay-in-scope.ts: loads no manifest.
//   - hook-codex-stop.ts / hook-codex-user-prompt-submit.ts: no pause check.
//
// Per-hook decision logic, error envelopes, and early-return shapes stay local
// to each hook. This module covers structural boilerplate only, not semantics.

import { checkPauseFromLoader } from "../pause-check.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import type { Manifest } from "../../schema/index.js";

// ---------------------------------------------------------------------------
// 1. Standard stdin reader
// ---------------------------------------------------------------------------

/**
 * Standard promise-based stdin reader for pack hook events. Resolves to the
 * full UTF-8 string read from the stream. Rejects on stream error.
 *
 * Not suitable for `hook-runtime-reality`, which needs an async-iteration
 * reader with an `isTTY` guard.
 */
export async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", (err) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// 2. Pause-sentinel check helper
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around `checkPauseFromLoader` that removes the
 * conditional-opts-building block each hook previously duplicated. Callers
 * can express the pause check in a single expression:
 *
 *   if (checkHookPause("my-hook", stderr, opts, opts.generatedDir).paused) { ... }
 *
 * Pass `undefined` for `loaderOpts`, `generatedDir`, or `now` when the hook
 * does not supply them — the underlying `checkPauseFromLoader` already handles
 * `undefined` for all optional fields.
 */
export function checkHookPause(
  hookLabel: string,
  stderr: NodeJS.WritableStream,
  loaderOpts?: LoaderOptions,
  generatedDir?: string,
  now?: Date,
): { paused: boolean } {
  return checkPauseFromLoader({ hookLabel, stderr, loaderOpts, generatedDir, now });
}

// ---------------------------------------------------------------------------
// 3. Manifest loader with injection support
// ---------------------------------------------------------------------------

export interface ManifestLoadResult {
  manifest: Manifest;
  /**
   * Resolved on-disk path to the base manifest file. `undefined` when an
   * injected manifest was used (test injection has no on-disk path).
   */
  manifestPath: string | undefined;
}

/**
 * Load the manifest, using `injected` directly when it is provided (test
 * injection path). Throws on disk-load failure so callers can wrap the call
 * in their own hook-specific try/catch.
 *
 * Usage pattern:
 *
 *   let manifest: Manifest, manifestPath: string | undefined;
 *   try {
 *     ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
 *   } catch (err) {
 *     // hook-specific: allow, block, note, etc.
 *   }
 */
export function loadManifestOrInjected(
  loaderOpts: LoaderOptions,
  injected: Manifest | undefined,
): ManifestLoadResult {
  // Narrows on `undefined` only — the `Manifest | undefined` contract makes a
  // `null` injection unreachable; this helper does not support it (a null would
  // be returned as-is rather than re-loaded from disk).
  if (injected !== undefined) {
    return { manifest: injected, manifestPath: undefined };
  }
  const loaded = loadManifest(loaderOpts);
  return { manifest: loaded.manifest, manifestPath: loaded.resolved.base };
}
