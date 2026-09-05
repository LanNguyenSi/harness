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
//   7. `resolveHookPackContext` — the declared-pack-lookup / enabled-check /
//      generatedDir-resolution trio that follows manifest load in nearly
//      every hook. Its shape is closely mirrored by hook-post-tool-use.ts,
//      hook-track-active-claim.ts, hook-pre-tool-use.ts and the Codex
//      siblings, which were deliberately left calling their own inline
//      copies rather than switched over here (out of scope for the task
//      that added this helper); it was extracted for the
//      subagent-start/subagent-stop pair, which would otherwise have
//      re-duplicated it a further two times.
//   8. `resolveSessionAndAgentIds` — session_id + agent_id parse and
//      validation shared by subagent-start/subagent-stop. Pack-agnostic
//      by construction: the agent-id validator is injected by the caller
//      rather than imported here, so this module stays free of any
//      understanding-before-execution-specific dependency.
//   9. `resolveSubagentHookContext` — the pause-check / id-resolution /
//      pack-context preamble shared verbatim by subagent-start and
//      subagent-stop, up to the point where their bodies diverge (write
//      vs. clear). Composes 2, 7, and 8 above.
//
// Not used by:
//   - hook-runtime-reality.ts: its stdin reader uses async iteration + an
//     isTTY guard, which is a legitimately different contract.
//   - hook-solution-acceptance-writeguard.ts: loads no manifest.
//   - hook-stay-in-scope.ts: loads no manifest.
//
// hook-codex-stop.ts and hook-codex-user-prompt-submit.ts now also call
// the pause check (2, `checkHookPause`), on top of the stdin reader (1) and
// manifest loader (3) they already used (tasks 63fefe3a, 1432e053); they
// used to be listed here as "no pause check" exceptions. Neither one pulls
// in 4-6, so "use all of the above" would overstate it.
//
// Per-hook decision logic, error envelopes, and early-return shapes stay local
// to each hook. This module covers structural boilerplate only, not semantics.

import { checkPauseFromLoader } from "../pause-check.js";
import { loadManifest, type LoaderOptions } from "../loader.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import { rejectMalformedSessionId } from "../../runtime/reject-malformed-session-id.js";
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

// ---------------------------------------------------------------------------
// 7. Declared-pack-lookup / enabled-check / generatedDir-resolution trio
// ---------------------------------------------------------------------------

export interface ResolveHookPackContextOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  manifest?: Manifest;
}

export interface ResolvedHookPackContext {
  manifest: Manifest;
  declared: Manifest["policy_packs"][number];
  generatedDir: string;
}

export type ResolveHookPackContextResult =
  | { ok: true; context: ResolvedHookPackContext }
  | { ok: false; diagnostic: string };

/**
 * Load the manifest (or use injection), confirm `packName` is declared and
 * enabled, and resolve `generatedDir` — the fixed sequence that follows
 * `loadManifestOrInjected` in nearly every pack hook. Returns a single
 * failure shape with a ready-to-emit `${hookLabel}: ...` diagnostic instead
 * of three separate early-return blocks, so a caller wires it as:
 *
 *   const ctx = resolveHookPackContext(hookLabel, packName, opts);
 *   if (!ctx.ok) return noop(ctx.diagnostic, stderr, ...);
 */
export function resolveHookPackContext(
  hookLabel: string,
  packName: string,
  opts: ResolveHookPackContextOptions,
): ResolveHookPackContextResult {
  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    return {
      ok: false,
      diagnostic: `${hookLabel}: manifest load failed (${(err as Error).message}), skipping`,
    };
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return {
      ok: false,
      diagnostic: `${hookLabel}: pack "${packName}" not declared in manifest, skipping`,
    };
  }
  if (!declared.enabled) {
    return {
      ok: false,
      diagnostic: `${hookLabel}: pack "${packName}" is enabled:false, skipping`,
    };
  }

  const generatedDir =
    opts.generatedDir ??
    (manifestPath !== undefined
      ? resolveGeneratedDir({
          ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
          manifestPath,
        })
      : undefined);
  if (generatedDir === undefined) {
    return {
      ok: false,
      diagnostic: `${hookLabel}: generatedDir unresolvable, skipping`,
    };
  }

  return { ok: true, context: { manifest, declared, generatedDir } };
}

// ---------------------------------------------------------------------------
// 8. session_id + agent_id parse and validation
// ---------------------------------------------------------------------------

export interface ResolvedSessionAndAgentIds {
  sessionId: string;
  agentId: string;
}

export type ResolveSessionAndAgentIdsResult =
  | { ok: true; ids: ResolvedSessionAndAgentIds }
  | { ok: false; diagnostic: string; sessionId: string | null };

/**
 * Parse and validate `session_id` + `agent_id` off an event body (the
 * subagent-start/subagent-stop shared shape). `validateAgentId` is
 * injected rather than imported here — the agent-id allowlist lives with
 * the understanding-before-execution pack's in-flight records
 * (`rejectMalformedAgentId`), and this module stays pack-agnostic on
 * purpose (see the module header).
 */
export function resolveSessionAndAgentIds(
  hookLabel: string,
  event: { session_id?: unknown; agent_id?: unknown },
  validateAgentId: (agentId: string) => void,
): ResolveSessionAndAgentIdsResult {
  const sessionId = pickString(event.session_id) ?? "";
  const agentId = pickString(event.agent_id) ?? "";

  if (sessionId === "") {
    return { ok: false, diagnostic: `${hookLabel}: missing session_id, skipping`, sessionId: null };
  }
  // Validate sessionId right after the emptiness check, before any other
  // early return, so every ok:false path below carries an already-rejected
  // (never a raw, unvalidated) sessionId — a caller that echoes `sessionId`
  // into a diagnostic or a path.join can never see an unvalidated value.
  try {
    rejectMalformedSessionId(sessionId);
  } catch (err) {
    return {
      ok: false,
      diagnostic: `${hookLabel}: malformed session_id (${(err as Error).message}), skipping`,
      sessionId: null,
    };
  }
  if (agentId === "") {
    return { ok: false, diagnostic: `${hookLabel}: missing agent_id, skipping`, sessionId };
  }
  try {
    validateAgentId(agentId);
  } catch (err) {
    return {
      ok: false,
      diagnostic: `${hookLabel}: malformed agent_id (${(err as Error).message}), skipping`,
      sessionId,
    };
  }

  return { ok: true, ids: { sessionId, agentId } };
}

// ---------------------------------------------------------------------------
// 9. subagent-start/subagent-stop shared preamble: pause check +
//    session/agent id resolution + pack-context resolution
// ---------------------------------------------------------------------------

export interface ResolveSubagentHookContextOptions extends ResolveHookPackContextOptions {
  stderr: NodeJS.WritableStream;
}

export interface ResolvedSubagentHookContext {
  sessionId: string;
  agentId: string;
  declared: Manifest["policy_packs"][number];
  generatedDir: string;
}

export type ResolveSubagentHookContextResult =
  | { ok: true; context: ResolvedSubagentHookContext }
  | { ok: false; diagnostic: string; sessionId: string | null; agentId: string | null };

/**
 * The three-step preamble subagent-start and subagent-stop both ran
 * verbatim before the point where their bodies diverge (write vs. clear):
 * pause-sentinel check, session_id/agent_id resolution, then pack-context
 * resolution. Extracted to close the residual clone between the two hook
 * files (review finding, subagent-gate). `verb` names the hook for both
 * the pause check's own stderr label and the caller-facing "paused,
 * skipping" diagnostic (e.g. "subagent-start"); `hookLabel` is the fuller
 * `harness pack hook: <verb>` prefix used in every other diagnostic.
 *
 * Each ok:false case reports a `sessionId`/`agentId` pair matching exactly
 * what the pre-extraction call sites passed to their own `noop()`: both
 * null on a pause, `sessionId` non-null (once past validation) on a
 * missing/malformed agent_id, and both non-null once ids resolved but the
 * pack context failed.
 */
export function resolveSubagentHookContext(
  hookLabel: string,
  verb: string,
  packName: string,
  event: { session_id?: unknown; agent_id?: unknown },
  validateAgentId: (agentId: string) => void,
  opts: ResolveSubagentHookContextOptions,
): ResolveSubagentHookContextResult {
  if (checkHookPause(verb, opts.stderr, opts, opts.generatedDir).paused) {
    return {
      ok: false,
      diagnostic: `harness paused; ${verb} skipping without evaluating.`,
      sessionId: null,
      agentId: null,
    };
  }

  const idsResult = resolveSessionAndAgentIds(hookLabel, event, validateAgentId);
  if (!idsResult.ok) {
    return {
      ok: false,
      diagnostic: idsResult.diagnostic,
      sessionId: idsResult.sessionId,
      agentId: null,
    };
  }
  const { sessionId, agentId } = idsResult.ids;

  const ctx = resolveHookPackContext(hookLabel, packName, opts);
  if (!ctx.ok) {
    return { ok: false, diagnostic: ctx.diagnostic, sessionId, agentId };
  }

  return {
    ok: true,
    context: {
      sessionId,
      agentId,
      declared: ctx.context.declared,
      generatedDir: ctx.context.generatedDir,
    },
  };
}
