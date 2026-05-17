// `harness pack hook post-tool-use [--pack <name>]` — task-boundary marker expiry.
//
// PostToolUse hook for the understanding-before-execution pack. Receives
// the Claude Code event JSON on stdin and, when the just-completed tool
// matches the pack's `config.approval_lifecycle.expire_on_tool_match`
// list, deletes the per-session approval marker so the next Edit /
// Write / Bash forces a fresh Understanding Report.
//
// Why a PostToolUse hook and not a PreToolUse one: the marker is the
// canonical "operator approved this interpretation" signal. Expiring it
// AFTER the boundary-marker tool (task_finish / pull_requests_merge /
// task_abandon) is semantically right — the agent has just declared the
// current task done, so the next tool call belongs to a new task and
// deserves a fresh re-interpretation. PostToolUse fires only when the
// tool actually ran (a PreToolUse-blocked call does NOT fire PostToolUse),
// so we never expire a marker for a tool the agent merely attempted.
//
// Failure mode: every error path resolves to no-op + stderr log. The
// gate is opt-in; turning a buggy hook into a session-wide "everything
// is unapproved now" surface would be hostile. Worst case the marker
// persists past the intended boundary, which degrades to the legacy
// per-session contract.

import { existsSync } from "node:fs";
import {
  approvalMarkerPathFor,
  clearApprovalMarker,
  parseApprovalLifecycle,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const PACK_NAME = "understanding-before-execution";

export interface PackHookPostToolUseOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
}

export interface PackHookPostToolUseResult {
  exitCode: number;
  /** Did the just-completed tool match the expiry list? */
  matchedExpiry: boolean;
  /** Was the marker actually cleared (false if it was already absent). */
  markerCleared: boolean;
  /** Diagnostic line emitted to stderr. */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

// Match a tool name against one of the patterns. The pattern is a plain
// tool name like `mcp__agent-tasks__task_finish`; wildcard expansion is
// deliberately not supported in v1 so operators write what they mean
// (a future `Bash(gh pr merge*)`-style shape can layer in later).
function toolMatches(toolName: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === toolName) return true;
  }
  return false;
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
): PackHookPostToolUseResult {
  stderr.write(`${diagnostic}\n`);
  return { exitCode: 0, matchedExpiry: false, markerCleared: false, diagnostic };
}

export async function runPackHookPostToolUseCli(
  opts: PackHookPostToolUseOptions = {},
): Promise<PackHookPostToolUseResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    return noop(
      "harness pack hook post-tool-use: malformed event JSON, skipping marker expiry",
      stderr,
    );
  }

  const sessionId =
    (typeof event.session_id === "string" ? event.session_id : undefined) ??
    process.env.CLAUDE_SESSION_ID ??
    "";
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (sessionId === "" || toolName === "") {
    return noop(
      `harness pack hook post-tool-use: missing session_id (${sessionId === "" ? "absent" : "ok"}) or tool_name (${toolName === "" ? "absent" : "ok"}), skipping`,
      stderr,
    );
  }

  let manifest: Manifest;
  let manifestPath: string | undefined;
  try {
    if (opts.manifest) {
      manifest = opts.manifest;
    } else {
      const loaded = loadManifest(opts);
      manifest = loaded.manifest;
      manifestPath = loaded.resolved.base;
    }
  } catch (err) {
    return noop(
      `harness pack hook post-tool-use: manifest load failed (${(err as Error).message}), skipping`,
      stderr,
    );
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return noop(
      `harness pack hook post-tool-use: pack "${packName}" not declared in manifest, skipping`,
      stderr,
    );
  }
  if (!declared.enabled) {
    return noop(
      `harness pack hook post-tool-use: pack "${packName}" is enabled:false, skipping`,
      stderr,
    );
  }

  const lifecycle = parseApprovalLifecycle(
    (declared.config as Record<string, unknown>)["approval_lifecycle"],
    stderr,
  );
  if (lifecycle.legacyMode || lifecycle.expireOnToolMatch.length === 0) {
    return noop(
      `harness pack hook post-tool-use: no expire_on_tool_match configured (${lifecycle.legacyMode ? "legacy-session mode" : "empty list"}), skipping`,
      stderr,
    );
  }
  if (!toolMatches(toolName, lifecycle.expireOnToolMatch)) {
    return noop(
      `harness pack hook post-tool-use: tool ${toolName} not in expire_on_tool_match, skipping`,
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
      "harness pack hook post-tool-use: generatedDir unresolvable, skipping marker expiry",
      stderr,
    );
  }

  // The marker may already be absent (operator revoked, prior expiry).
  // Always log the attempt so the diagnostic trail names the boundary
  // tool; the markerCleared flag distinguishes the two paths.
  // clearApprovalMarker swallows errors and uses force:true, so we
  // probe the marker path first to set markerCleared accurately.
  const markerPath = approvalMarkerPathFor(generatedDir, sessionId);
  const wasPresent = existsSync(markerPath);
  clearApprovalMarker(generatedDir, sessionId);
  const diagnostic = wasPresent
    ? `harness pack hook post-tool-use: expired approval marker for session ${sessionId} after ${toolName}`
    : `harness pack hook post-tool-use: ${toolName} matched expire_on_tool_match but no marker present for session ${sessionId}`;
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    matchedExpiry: true,
    markerCleared: wasPresent,
    diagnostic,
  };
}
