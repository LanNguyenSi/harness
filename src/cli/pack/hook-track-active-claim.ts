// `harness pack hook track-active-claim` — agent-tasks claim tracking.
//
// PostToolUse hook for the understanding-before-execution pack
// (harness/494fd1e5). Maintains a small file at
// `<generatedDir>/active-claim` that names the currently-claimed
// agent-tasks task id. The file lets `harness approve understanding`
// auto-resolve the task id when --task is absent, so the operator
// does not have to type the UUID by hand on every approval.
//
// File lifecycle:
//   - `mcp__agent-tasks__task_start` with `tool_input.taskId` → write
//     the taskId into the file (atomic).
//   - `mcp__agent-tasks__task_finish` / `mcp__agent-tasks__task_abandon`
//     → remove the file (idempotent).
//
// The hook is intentionally separate from `hook-post-tool-use` because
// the existing marker-expiry hook fires on a configurable list of
// task-boundary verbs (`expire_on_tool_match`) that does NOT include
// `task_start`. Folding task_start in there would either expand that
// matcher's semantics (now "boundary + start") or require a parallel
// config field. A dedicated hook keeps each surface single-purpose.
//
// Failure mode mirrors `hook-post-tool-use`: every error path resolves
// to no-op + stderr log. The active-claim file is an ergonomic shortcut,
// not a security-relevant signal — `harness approve understanding`
// still treats explicit --task as authoritative, and falls back to
// session-scoped marker when no claim is resolved.
//
// Hardcoded agent-tasks tool names: the v2 contract is agent-tasks
// specific. Operators on Linear / JIRA can ignore this hook (the
// matcher will never fire for them); a config-driven extension can
// land later if a second tasking system asks for it.

import {
  clearActiveClaim,
  writeActiveClaim,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import type { Manifest } from "../../schema/index.js";
import { loadManifest, type LoaderOptions } from "../loader.js";

const PACK_NAME = "understanding-before-execution";

export const TOOL_NAME_TASK_START = "mcp__agent-tasks__task_start";
export const TOOL_NAME_TASK_FINISH = "mcp__agent-tasks__task_finish";
export const TOOL_NAME_TASK_ABANDON = "mcp__agent-tasks__task_abandon";

export const TRACK_ACTIVE_CLAIM_TOOLS: readonly string[] = [
  TOOL_NAME_TASK_START,
  TOOL_NAME_TASK_FINISH,
  TOOL_NAME_TASK_ABANDON,
];

export interface PackHookTrackActiveClaimOptions extends LoaderOptions {
  pack?: string;
  generatedDir?: string;
  stdin?: NodeJS.ReadableStream;
  stderr?: NodeJS.WritableStream;
  manifest?: Manifest;
}

export interface PackHookTrackActiveClaimResult {
  exitCode: number;
  /** Was the active-claim file written (task_start path)? */
  claimWritten: boolean;
  /** Was the active-claim file cleared (task_finish / abandon path)? */
  claimCleared: boolean;
  /** The taskId acted on, or null when the event carried none. */
  taskId: string | null;
  /** Diagnostic line emitted to stderr. */
  diagnostic: string;
}

interface ToolEventLite {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
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

function extractTaskId(toolInput: unknown): string {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return "";
  }
  const tid = (toolInput as Record<string, unknown>)["taskId"];
  return typeof tid === "string" ? tid : "";
}

function noop(
  diagnostic: string,
  stderr: NodeJS.WritableStream,
): PackHookTrackActiveClaimResult {
  stderr.write(`${diagnostic}\n`);
  return {
    exitCode: 0,
    claimWritten: false,
    claimCleared: false,
    taskId: null,
    diagnostic,
  };
}

export async function runPackHookTrackActiveClaimCli(
  opts: PackHookTrackActiveClaimOptions = {},
): Promise<PackHookTrackActiveClaimResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  const packName = opts.pack ?? PACK_NAME;

  const raw = await readStdin(stdin);
  let event: ToolEventLite = {};
  try {
    event = JSON.parse(raw.trim() || "{}") as ToolEventLite;
  } catch {
    return noop(
      "harness pack hook track-active-claim: malformed event JSON, skipping",
      stderr,
    );
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (toolName === "") {
    return noop(
      "harness pack hook track-active-claim: missing tool_name, skipping",
      stderr,
    );
  }

  // Loader gate: pack must exist and be enabled. Mirrors the same
  // structure as hook-post-tool-use so a single disabled-pack opt-out
  // suppresses BOTH hooks.
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
      `harness pack hook track-active-claim: manifest load failed (${(err as Error).message}), skipping`,
      stderr,
    );
  }

  const declared = manifest.policy_packs.find((p) => p.name === packName);
  if (!declared) {
    return noop(
      `harness pack hook track-active-claim: pack "${packName}" not declared in manifest, skipping`,
      stderr,
    );
  }
  if (!declared.enabled) {
    return noop(
      `harness pack hook track-active-claim: pack "${packName}" is enabled:false, skipping`,
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
      "harness pack hook track-active-claim: generatedDir unresolvable, skipping",
      stderr,
    );
  }

  const taskId = extractTaskId(event.tool_input);

  if (toolName === TOOL_NAME_TASK_START) {
    if (taskId === "") {
      return noop(
        `harness pack hook track-active-claim: task_start without tool_input.taskId, skipping`,
        stderr,
      );
    }
    try {
      writeActiveClaim(generatedDir, taskId);
    } catch (err) {
      return noop(
        `harness pack hook track-active-claim: writeActiveClaim failed for ${taskId}: ${(err as Error).message}`,
        stderr,
      );
    }
    const diagnostic = `harness pack hook track-active-claim: wrote active-claim for ${taskId}`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      claimWritten: true,
      claimCleared: false,
      taskId,
      diagnostic,
    };
  }

  if (
    toolName === TOOL_NAME_TASK_FINISH ||
    toolName === TOOL_NAME_TASK_ABANDON
  ) {
    clearActiveClaim(generatedDir);
    const diagnostic = `harness pack hook track-active-claim: cleared active-claim after ${toolName}`;
    stderr.write(`${diagnostic}\n`);
    return {
      exitCode: 0,
      claimWritten: false,
      claimCleared: true,
      taskId: taskId === "" ? null : taskId,
      diagnostic,
    };
  }

  return noop(
    `harness pack hook track-active-claim: tool ${toolName} not tracked, skipping`,
    stderr,
  );
}
