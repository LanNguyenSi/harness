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
//
// Codex parity (task cf4cdc93): this hook is now also wired on the
// Codex adapter (`understanding-before-execution.ts`, `runtime ===
// "codex"` branch), reusing this exact command — no Codex-specific
// CLI verb needed. The tool-name comparisons below are alias-aware
// (`toolNameMatchesAny`, not raw `===`): a Codex session can emit an
// MCP tool name in a variant form for the identical tool (server
// hyphen/underscore swap, the `mcp__server__.tool` dotted form), and
// the emitted Codex matcher is alias-EXPANDED at `harness apply` time
// (`expandCodexHookMatchPattern`) so the dispatcher DOES invoke this
// hook for a variant — a raw `===` here would then silently miss it,
// the exact bug class task a1348c89 fixed once already for the
// marker-expiry PostToolUse hook.
//
// Review finding on task cf4cdc93 (empirically confirmed, MEDIUM): the
// event envelope's field NAMES also vary across the tolerated Codex
// synonyms — `tool` as well as `tool_name`, `raw_input` as well as
// `tool_input` (`hook-codex-post-tool-use.ts`'s own doc comment and
// `docs/policy-packs/understanding-before-execution.md`'s wire-format
// block both document this). A payload shaped `{ tool, raw_input }`
// (or any mix) used to silently no-op here while the sibling
// `codex-post-tool-use` hook already handled it via its own
// `pickString(event.tool_name, event.tool)` / `resolveToolInput`. Now
// mirrored via the same shared helpers (`hook-bootstrap.ts`).

import {
  clearActiveClaim,
  toolNameMatchesAny,
  writeActiveClaim,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import { resolveGeneratedDir } from "../../runtime/pending-approval.js";
import type { Manifest } from "../../schema/index.js";
import { type LoaderOptions } from "../loader.js";
import {
  checkHookPause,
  loadManifestOrInjected,
  pickString,
  readStdin,
  resolveToolInput,
} from "./hook-bootstrap.js";

const PACK_NAME = "understanding-before-execution";

export const TOOL_NAME_TASK_START = "mcp__agent-tasks__task_start";
export const TOOL_NAME_TASK_FINISH = "mcp__agent-tasks__task_finish";
export const TOOL_NAME_TASK_ABANDON = "mcp__agent-tasks__task_abandon";
// Legacy v1 verb: takes an explicit `status` param ("open" | "in_progress" |
// "review" | "done"). Only `done` is a terminal "work claim released" state
// in v2 semantics (per task_finish docs: "The work claim is cleared when
// going to done and kept when going to review"). open / review / in_progress
// keep the claim, so the hook treats them as no-op (PR #200, agent-tasks
// 9e06175f). Adding this verb closes the marker-GC gap left by PR #198,
// which fixed the auto-bypass but did not GC the stale markers themselves.
export const TOOL_NAME_TASKS_TRANSITION = "mcp__agent-tasks__tasks_transition";

export const TRACK_ACTIVE_CLAIM_TOOLS: readonly string[] = [
  TOOL_NAME_TASK_START,
  TOOL_NAME_TASK_FINISH,
  TOOL_NAME_TASK_ABANDON,
  TOOL_NAME_TASKS_TRANSITION,
];

/** Status values that cause `tasks_transition` to behave like task_finish→done. */
const TASKS_TRANSITION_CLEAR_STATUSES: ReadonlySet<string> = new Set(["done"]);

function extractStatus(toolInput: unknown): string {
  if (
    typeof toolInput !== "object" ||
    toolInput === null ||
    Array.isArray(toolInput)
  ) {
    return "";
  }
  const s = (toolInput as Record<string, unknown>)["status"];
  return typeof s === "string" ? s : "";
}

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
  // Codex synonym tolerated alongside tool_name (mirrors the sibling
  // codex-post-tool-use hook's `pickString(event.tool_name, event.tool)`).
  tool?: unknown;
  tool_input?: unknown;
  // Codex-shim fallback tolerated alongside tool_input (mirrors the
  // sibling codex-post-tool-use hook's `resolveToolInput`).
  raw_input?: unknown;
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

  // Pause sentinel — skip claim-file mutations while paused.
  if (checkHookPause("track-active-claim", stderr, opts, opts.generatedDir).paused) {
    return noop(
      "harness paused; track-active-claim skipping without evaluating.",
      stderr,
    );
  }

  const toolName = pickString(event.tool_name, event.tool) ?? "";
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
    ({ manifest, manifestPath } = loadManifestOrInjected(opts, opts.manifest));
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

  const toolInput = resolveToolInput(event);
  const taskId = extractTaskId(toolInput);

  if (toolNameMatchesAny(toolName, [TOOL_NAME_TASK_START])) {
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
    toolNameMatchesAny(toolName, [TOOL_NAME_TASK_FINISH, TOOL_NAME_TASK_ABANDON])
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

  if (toolNameMatchesAny(toolName, [TOOL_NAME_TASKS_TRANSITION])) {
    const status = extractStatus(toolInput);
    if (!TASKS_TRANSITION_CLEAR_STATUSES.has(status)) {
      // open / in_progress / review keep the work claim per v2 semantics
      // (see task_finish docs). Malformed / missing status also falls
      // here, since we cannot prove the agent meant to release.
      return noop(
        `harness pack hook track-active-claim: tasks_transition status=${status || "(missing)"} keeps claim, skipping`,
        stderr,
      );
    }
    clearActiveClaim(generatedDir);
    const diagnostic = `harness pack hook track-active-claim: cleared active-claim after tasks_transition status=${status}`;
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
