// Task a1348c89 — `harness pack hook codex-post-tool-use` runtime verb.
//
// Codex sibling of the Claude Code marker-expiry hook
// (hook-post-tool-use.ts): when the just-completed tool matches the
// pack's `config.approval_lifecycle.expire_on_tool_match` /
// `expire_on_bash_match` boundaries, clears the per-session (and, when
// applicable, per-task) approval marker and expires the persisted
// report, so the next Edit/apply_patch/Bash forces a fresh Understanding
// Report. Before this hook existed, Codex sessions had NO PostToolUse
// wiring at all (docs/okf/codex-adapter-parity-gaps.md gap #1) — an
// approval only ever died via `approval_lifecycle.max_age` or a manual
// `rm`, no matter how many tasks the session completed.
//
// Codex hook-surface finding (verified against the published Codex
// hooks reference, developers.openai.com/codex/hooks, current as of
// this task): `PostToolUse` IS a first-class Codex hook event —
// `[[hooks.PostToolUse]]` with a `matcher` on `tool_name`, stdin payload
// carrying `session_id`, `tool_name`, `tool_input`, `tool_response`, and
// an allow/exit-0 or block/exit-2-with-stderr-reason contract identical
// in shape to Claude Code's. `generate-codex-config.ts`'s `eventKey`
// already mapped `"PostToolUse"` to the TOML table key `PostToolUse`
// (added in #211 alongside the real `PreToolUse`/`Stop`/
// `UserPromptSubmit` mappings) — the adapter could already EMIT this
// hook group, it was simply never contributed by the pack. This file
// closes that gap.
//
// Wire format on stdin: same generic envelope the sibling Codex hooks
// read (`{ session_id?, tool_name?, tool?, tool_input?, raw_input?,
// event? }`, docs/policy-packs/understanding-before-execution.md
// "Adapter notes / Codex"). `tool_input` is tried first (the field name
// real Codex sends, matching Claude Code's own convention); `raw_input`
// is accepted as a fallback for any shim built against harness's
// originally-published portable format (Phase 6 #6, when Codex's hook
// contract was not yet documented/stable).
//
// Matching + clearing logic is shared with the Claude hook via
// `matchPostToolUseBoundary` / `applyPostToolUseExpiry`
// (understanding-before-execution-runtime.ts) — a hand-copied duplicate
// here would repeat the exact Claude/Codex drift class task e7c2ec3c
// fixed on the PreToolUse side.
//
// Failure mode: every error path resolves to no-op + stderr diagnostic,
// exit 0. This hook never blocks — expiry is advisory cleanup, not a
// gate; a buggy pause/config/manifest state must degrade to "marker
// persists past the intended boundary" (the legacy per-session
// contract), never to a blocked tool call.

import {
  applyPostToolUseExpiry,
  defaultReportsDir,
  describePostToolUseExpiry,
  matchPostToolUseBoundary,
  parseApprovalLifecycle,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import { CODEX_SHELL_TOOLS } from "./hook-codex-pre-tool-use.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  pickString,
  readStdin,
} from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookCodexPostToolUseOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  reportsDir?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface PackHookCodexPostToolUseResult {
  exitCode: number;
  /** Did the just-completed tool match a configured expiry boundary? */
  matchedExpiry: boolean;
  /** Was the session marker actually cleared (false if already absent). */
  markerCleared: boolean;
  /** Was a task-scoped marker also cleared (harness/1ee26e77 parity)? */
  taskMarkerCleared: boolean;
  /** Was the persisted report flipped from `approved` to `expired`? */
  persistedReportExpired: boolean;
  diagnostic: string;
}

interface CodexToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  // One Codex-native synonym tolerated, mirroring the sibling
  // PreToolUse hook (some integrations pass `tool` instead of
  // `tool_name`).
  tool?: unknown;
  tool_input?: unknown;
  raw_input?: unknown;
}

/** Prefer `tool_input` (the field name real Codex sends; matches Claude
 * Code's own convention) and fall back to `raw_input` (harness's
 * originally-published portable wire format, docs/policy-packs/
 * understanding-before-execution.md "Adapter notes / Codex") for any
 * shim still emitting the older shape. */
function resolveToolInput(event: CodexToolEventLite): unknown {
  if (event.tool_input !== undefined) return event.tool_input;
  return event.raw_input;
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
): PackHookCodexPostToolUseResult {
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matchedExpiry: false,
    markerCleared: false,
    taskMarkerCleared: false,
    persistedReportExpired: false,
    diagnostic,
  };
}

export async function runPackHookCodexPostToolUseCli(
  opts: PackHookCodexPostToolUseOptions = {},
): Promise<PackHookCodexPostToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin);
  let event: CodexToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as CodexToolEventLite;
  } catch {
    return noop(
      "harness pack hook codex-post-tool-use: malformed event JSON, skipping marker expiry",
      stderr,
    );
  }

  // Pause sentinel — skip marker expiry while paused, mirroring the
  // Claude sibling, so a debug A/B-test does not silently invalidate
  // the operator's approval state.
  if (checkHookPause("codex-post-tool-use", stderr, opts, opts.generatedDir).paused) {
    return noop(
      "harness paused; codex-post-tool-use skipping marker expiry without evaluating.",
      stderr,
    );
  }

  const sessionId =
    pickString(event.session_id) ??
    process.env["CODEX_SESSION_ID"] ??
    process.env["CLAUDE_CODE_SESSION_ID"] ??
    process.env["CLAUDE_SESSION_ID"] ??
    "";
  const toolName = pickString(event.tool_name, event.tool) ?? "";
  if (sessionId === "" || toolName === "") {
    return noop(
      `harness pack hook codex-post-tool-use: missing session_id (${sessionId === "" ? "absent" : "ok"}) or tool_name (${toolName === "" ? "absent" : "ok"}), skipping`,
      stderr,
    );
  }

  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
  } catch (err) {
    return noop(
      `harness pack hook codex-post-tool-use: manifest load failed (${(err as Error).message}), skipping`,
      stderr,
    );
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return noop(
      `harness pack hook codex-post-tool-use: pack "${packName}" not declared in manifest, skipping`,
      stderr,
    );
  }
  if (!declared.enabled) {
    return noop(
      `harness pack hook codex-post-tool-use: pack "${packName}" is enabled:false, skipping`,
      stderr,
    );
  }

  const lifecycle = parseApprovalLifecycle(
    (declared.config as Record<string, unknown>)["approval_lifecycle"],
    stderr,
  );
  if (lifecycle.legacyMode) {
    return noop(
      `harness pack hook codex-post-tool-use: legacy-session mode, skipping`,
      stderr,
    );
  }
  const noBoundariesConfigured =
    lifecycle.expireOnToolMatch.length === 0 && lifecycle.expireOnBashMatch.length === 0;
  if (noBoundariesConfigured) {
    return noop(
      `harness pack hook codex-post-tool-use: no expire_on_tool_match or expire_on_bash_match configured, skipping`,
      stderr,
    );
  }

  const toolInput = resolveToolInput(event);
  // Codex's shell surface has several accepted tool-name aliases
  // (Bash/shell/exec_command/functions.exec_command, same set the
  // sibling PreToolUse blocker treats as shell-equivalent); any of
  // those counts as "the Bash tool" for expire_on_bash_match.
  const boundary = matchPostToolUseBoundary(toolName, toolInput, lifecycle, CODEX_SHELL_TOOLS);
  if (!boundary.matched) {
    const detail = !boundary.rawToolNameMatched
      ? CODEX_SHELL_TOOLS.has(toolName)
        ? `Bash command did not match any expire_on_bash_match regex`
        : `tool ${toolName} not in expire_on_tool_match`
      : `tasks_transition status keeps work claim, skipping`;
    return noop(
      `harness pack hook codex-post-tool-use: ${detail}, skipping`,
      stderr,
    );
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
    return noop(
      "harness pack hook codex-post-tool-use: generatedDir unresolvable, skipping marker expiry",
      stderr,
    );
  }

  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const expiry = applyPostToolUseExpiry(
    generatedDir,
    sessionId,
    toolInput,
    boundary.toolNameMatched,
    reportsDir,
    opts.now,
  );

  const diagnostic = describePostToolUseExpiry(
    "harness pack hook codex-post-tool-use",
    sessionId,
    toolName,
    boundary.bashRegex,
    expiry,
  );
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matchedExpiry: true,
    markerCleared: expiry.wasMarkerPresent,
    taskMarkerCleared: expiry.taskMarkerCleared,
    persistedReportExpired: expiry.persistedReportExpired,
    diagnostic,
  };
}
