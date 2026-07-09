// Phase 5 #6 — shared test fixture builders.
//
// `Manifest` is parsed via a strict zod schema, which rejects defaults
// at the schema layer. Tests don't need a fully-populated manifest —
// they need *some* shape that satisfies the runtime's `manifest.tools`,
// `manifest.policies`, etc. accesses without poisoning shared state.
//
// `makeManifest({ policies })` returns the smallest manifest that
// makes the runtime + audit + explain consumers happy. Override
// `hooks` / `mcps` / `classifiers` / `resolvers` when a test needs more.

import type {
  EnvironmentResolver,
  Hook,
  Manifest,
  McpServer,
  Policy,
  RiskClassifier,
} from "../../src/schema/index.js";

export interface MakeManifestOptions {
  policies?: Policy[];
  hooks?: Hook[];
  mcps?: McpServer[];
  /** Risk Gate classifiers — `risk.classifiers[]` (Phase 7 #3/#5). */
  classifiers?: RiskClassifier[];
  /** Risk Gate environment resolvers — `environments.resolvers[]` (Phase 7 #4/#5). */
  resolvers?: EnvironmentResolver[];
}

const DEFAULT_HOOK = {
  name: "h",
  event: "PreToolUse",
  command: "/usr/bin/true",
  blocking: false,
} as Manifest["hooks"][number];

export function makeManifest(opts: MakeManifestOptions = {}): Manifest {
  return {
    version: 1,
    grounding: {} as Manifest["grounding"],
    tools: {
      mcp: opts.mcps ?? [],
      cli: [],
      builtin: { known: [] },
    } as unknown as Manifest["tools"],
    memory: {} as Manifest["memory"],
    hooks: opts.hooks ?? [DEFAULT_HOOK],
    policies: opts.policies ?? [],
    risk: { classifiers: opts.classifiers ?? [] },
    environments: { resolvers: opts.resolvers ?? [] },
  } as Manifest;
}

/**
 * Convenience wrapper for the common `Policy` shape: pin the required
 * keys, default the rest. Mirrors the per-test `policy()` helpers that
 * existed in `tests/runtime/intercept.test.ts`.
 */
export function makePolicy(
  overrides: Partial<Policy> & Pick<Policy, "name" | "trigger" | "requires" | "hook">,
): Policy {
  return {
    description: "test",
    enforcement: "block",
    ...overrides,
  } as Policy;
}
