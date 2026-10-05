// Doctor advisory (agent-tasks 0c6b2cb9): warn when an operator's explicit
// `policy_packs[understanding-before-execution].config.approval_lifecycle
// .expire_on_tool_match` lists `task_finish` but not `task_merge`.
//
// Why this matters: a `task_finish` that lands the task in `review` keeps
// the approval marker (the work claim is kept, task 5018c0c4), so the
// approval only expires on the later `task_merge`. An explicit list
// without `task_merge` therefore never re-arms the gate on the
// review-then-merge path. Every `harness init` scaffold lists it; a
// hand-written list can miss it.
//
// Deliberately advisory, never an error: the list is the operator's
// explicit choice. Silent for an absent block (the runtime applies
// DEFAULT_BOUNDARY_TOOL_NAMES, which includes `task_merge`), for
// `mode: session` (tool expiry is off by design), for an empty list, and
// for a list that has `task_merge`.
//
// Tool names are matched through `toolNameMatchesAny`, the same
// alias-aware helper the PostToolUse hook uses, so a Claude Code or Codex
// name variant of the two tools counts the way it does at runtime.

import { toolNameMatchesAny } from "../../policy-packs/builtin/understanding-before-execution/post-tool-use-boundary.js";
import {
  TASK_FINISH_TOOL,
  TASK_MERGE_TOOL,
} from "../../runtime/task-providers/agent-tasks.js";
import type { Manifest } from "../../schema/index.js";
import { findEnabledUnderstandingPack } from "./understanding-mode-env.js";

export interface ExpireOnToolMatchWarning {
  /** Rendered as the `⚠` line itself. */
  message: string;
  /** Indented detail lines rendered directly under {@link message}. */
  detail: string[];
}

/**
 * Pure: manifest in, a warning out (or `undefined` when there is nothing
 * to flag). Fires only when the pack is declared and enabled, the
 * `approval_lifecycle` block is an object that is not `mode: session`,
 * and `expire_on_tool_match` is a non-empty array that contains
 * `task_finish` but not `task_merge`.
 */
export function checkExpireOnToolMatch(manifest: Manifest): ExpireOnToolMatchWarning | undefined {
  const pack = findEnabledUnderstandingPack(manifest);
  if (!pack) return undefined;

  const block = pack.config["approval_lifecycle"];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  const lifecycle = block as Record<string, unknown>;
  if (lifecycle["mode"] === "session") return undefined;

  const list = lifecycle["expire_on_tool_match"];
  if (!Array.isArray(list)) return undefined;
  const tools = list.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (tools.length === 0) return undefined;

  const hasFinish = tools.some((t) => toolNameMatchesAny(t, [TASK_FINISH_TOOL]));
  const hasMerge = tools.some((t) => toolNameMatchesAny(t, [TASK_MERGE_TOOL]));
  if (!hasFinish || hasMerge) return undefined;

  return {
    message:
      "approval_lifecycle.expire_on_tool_match lists task_finish but not task_merge (policy_packs[understanding-before-execution].config); a task_finish that lands in review keeps the approval, so it never expires on the review-then-task_merge path",
    detail: [
      `add ${TASK_MERGE_TOOL} to expire_on_tool_match; see docs/policy-packs/understanding-before-execution.md`,
    ],
  };
}
