// Restart hints emitter — pure function over a manifest delta.
//
// After `harness apply` mutates `harness.generated/`, the user (or AI agent)
// usually has to perform a separate runtime action: reconnect MCP servers,
// restart the session to pick up new hooks, etc. This module computes which
// hints to print based on which manifest sections actually changed.
//
// Per ARCHITECTURE.md / ROADMAP Phase 3 acceptance:
//   - mcp[]                changed → MCP-restart hint
//   - memory.router.command changed → session-restart hint
//   - hooks structure       changed → settings.json reload hint
//   - description-only changes      → no hints (description is metadata)

import type { Hook, Manifest, Policy } from "../schema/index.js";

export const RESTART_HINT_MCP =
  "mcp servers changed; /mcp reconnect required";
export const RESTART_HINT_MEMORY_ROUTER =
  "memory router command changed; restart session for new hooks";
export const RESTART_HINT_HOOKS =
  "hooks changed; restart session to reload settings.json";

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

// Stable JSON canonicalisation: sort object keys recursively. Arrays keep
// their order — for hooks/mcp the array order is meaningful.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function stripDescription<T extends { description?: unknown }>(x: T): Omit<T, "description"> {
  const { description: _ignored, ...rest } = x;
  return rest;
}

function hooksMaterial(hooks: Hook[]): unknown {
  return hooks.map(stripDescription);
}

function policiesMaterial(policies: Policy[]): unknown {
  return policies.map(stripDescription);
}

export function emitRestartHints(prev: Manifest, next: Manifest): string[] {
  const hints: string[] = [];

  if (!deepEqual(prev.tools.mcp, next.tools.mcp)) {
    hints.push(RESTART_HINT_MCP);
  }

  const prevRouterCmd = prev.memory.router?.command ?? null;
  const nextRouterCmd = next.memory.router?.command ?? null;
  if (!deepEqual(prevRouterCmd, nextRouterCmd)) {
    hints.push(RESTART_HINT_MEMORY_ROUTER);
  }

  if (
    !deepEqual(hooksMaterial(prev.hooks), hooksMaterial(next.hooks)) ||
    !deepEqual(policiesMaterial(prev.policies), policiesMaterial(next.policies))
  ) {
    hints.push(RESTART_HINT_HOOKS);
  }

  return hints;
}
