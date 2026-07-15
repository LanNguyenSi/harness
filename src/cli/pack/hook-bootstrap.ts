// Shared bootstrap helpers for Claude Code pack hooks.
//
// Extracts the boilerplate pieces that all (or most) pack hooks
// reimplemented independently:
//
//   1. stdin envelope read (the common event-stream pattern).
//   2. pause-sentinel check with announcement (wrapping checkPauseFromLoader
//      so callers skip the conditional-opts-building block).
//   3. manifest load with injection support (the common if-injected / else
//      loadManifest pattern; callers wrap the call in their own try/catch
//      because error semantics differ per hook).
//   4. pack `config.ux` parsing (label-parameterized; formerly four
//      byte-identical copies, task 19e293c6).
//   5. `pickString` — first-defined-string-wins candidate picker (was three
//      byte-identical copies across the Codex hook trio — pre-tool-use,
//      stop, post-tool-use — before task a1348c89 extracted it here).
//   6. `resolveToolInput` — tool_input-with-raw_input-fallback resolver
//      (task cf4cdc93 review finding: track-active-claim and
//      stay-in-scope read ONLY `tool_input`, silently no-op-ing on a
//      Codex shim that sends `raw_input` instead — the exact shape
//      `hook-codex-post-tool-use.ts`'s own private `resolveToolInput`
//      already handles).
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
import { PolicyUxSchema, type Manifest, type PolicyUx } from "../../schema/index.js";

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

// ---------------------------------------------------------------------------
// 4. First-defined-string-wins candidate picker
// ---------------------------------------------------------------------------

/**
 * Return the first candidate that is a non-empty string, else `undefined`.
 * Used to resolve a field that may arrive under one of several tolerated
 * synonyms (e.g. Codex's `tool_name` vs `tool`, or `last_assistant_message`
 * as a direct shortcut). Was three byte-identical private copies (the Codex
 * pre-tool-use / stop / post-tool-use hooks) before task a1348c89.
 */
export function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 5. tool_input-with-raw_input-fallback resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a PostToolUse-style event's tool arguments: prefer `tool_input`
 * (the field name real Codex sends, matching Claude Code's own
 * convention — `hook-codex-post-tool-use.ts`'s own doc comment) and fall
 * back to `raw_input` (harness's originally-published portable wire
 * format, still accepted for any shim built against harness's earlier
 * Codex adapter). Mirrors that hook's private `resolveToolInput`
 * (task a1348c89); extracted here so the agent-tasks-specific
 * PostToolUse hooks added later for Codex parity (track-active-claim,
 * stay-in-scope — task cf4cdc93) share the identical resolution instead
 * of hand-copying it a second and third time.
 */
export function resolveToolInput(event: {
  tool_input?: unknown;
  raw_input?: unknown;
}): unknown {
  if (event.tool_input !== undefined) return event.tool_input;
  return event.raw_input;
}

// ---------------------------------------------------------------------------
// 6. Pack `config.ux` parser
// ---------------------------------------------------------------------------

/**
 * Parse the optional `ux:` block from a pack config (task 19e293c6). This
 * body existed as four byte-identical copies (hook-pre-tool-use,
 * hook-codex-pre-tool-use, hook-branch-protection, hook-solution-acceptance)
 * whose only difference was the stderr prefix — the exact drift the
 * CHANGELOG had flagged at copy #3 and that landed a 4th time anyway.
 * `hookLabel` carries that prefix so the per-hook stderr warnings stay
 * byte-identical to the pre-extraction output (pinned by a test).
 *
 * Best-effort: a malformed `ux:` is ignored with a one-line warning; the
 * hook then falls back to its legacy message shape.
 */
export function parseConfigUx(
  raw: unknown,
  stderr: NodeJS.WritableStream,
  hookLabel: string,
): PolicyUx | undefined {
  if (raw === undefined) return undefined;
  const result = PolicyUxSchema.safeParse(raw);
  if (!result.success) {
    stderr.write(
      `${hookLabel}: config.ux ignored (${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")})\n`,
    );
    return undefined;
  }
  return result.data;
}
