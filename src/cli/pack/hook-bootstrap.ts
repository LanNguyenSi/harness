// Shared bootstrap helpers for Claude Code pack hooks.
//
// Extracts the boilerplate pieces that the pack hooks reimplemented
// independently:
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
//      byte-identical copies across the Codex hook trio before task
//      a1348c89 extracted it here).
//
// Not used by:
//   - hook-runtime-reality.ts: it keeps an `isTTY` guard in front of the
//     same shared idle-bounded reader (`src/cli/bounded-stdin.ts`) and
//     composes the read itself, which is a legitimately different contract.
//
// Per-hook decision logic, error envelopes, and early-return shapes stay local
// to each hook. This module covers structural boilerplate only, not semantics.

import { readStdinBounded, STDIN_IDLE_TIMEOUT_MS } from "../bounded-stdin.js";
import { checkPauseFromLoader } from "../pause-check.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import { PolicyUxSchema, type Manifest, type PolicyUx } from "../../schema/index.js";

// ---------------------------------------------------------------------------
// 1. Standard stdin reader
// ---------------------------------------------------------------------------

export interface ReadStdinOptions {
  /** Idle bound in ms; defaults to the shared 3000 ms bound. */
  idleTimeoutMs?: number;
  /** Where the timeout note goes; defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
}

/** What `readStdinChecked` reports: the text read and whether the bound fired. */
export interface CheckedStdinRead {
  text: string;
  /** True when the idle bound fired before `end` (the stdin was never closed). */
  timedOut: boolean;
  /** The idle bound that applied, in ms. */
  idleTimeoutMs: number;
}

/**
 * Idle-bounded stdin read that tells the caller whether it timed out and
 * writes no note. A PreToolUse gate uses this so it can fail closed on a
 * timed-out read: a timeout means the event never finished arriving, so the
 * gate cannot judge the tool call and must not treat it as an allow (a writer
 * that is merely late, then writes a complete gated event and closes, was
 * decided on its content when the read was end-only). Rejects on stream error.
 */
export async function readStdinChecked(
  stream: NodeJS.ReadableStream,
  opts: Pick<ReadStdinOptions, "idleTimeoutMs"> = {},
): Promise<CheckedStdinRead> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? STDIN_IDLE_TIMEOUT_MS;
  const read = await readStdinBounded(stream, idleTimeoutMs);
  return { text: read.text, timedOut: read.timedOut, idleTimeoutMs };
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
// 5. Pack `config.ux` parser
// ---------------------------------------------------------------------------

/**
 * Parse the optional `ux:` block from a pack config (task 19e293c6). This
 * body existed as four byte-identical copies (hook-branch-protection was
 * the only survivor of the removals; the others named their own stderr
 * prefix) whose only difference was that prefix — the exact drift the
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
