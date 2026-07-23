// Registry of builtin policy-pack names.
//
// Phase 6 #2 shipped `understanding-before-execution`; subsequent
// builtins are added by appending to `KNOWN_BUILTIN_PACKS` and a case
// arm in `resolveBuiltin()`. Non-builtin sources (path/npm/git) are
// out of scope for v1; their resolution lands in a later sub-task.

import type { z } from "zod";
import type { PolicyPack, PolicyUx, Producer } from "../schema/index.js";
import {
  configSchema as branchProtectionConfigSchema,
  defaultUx as branchProtectionDefaultUx,
  PACK_NAME as BRANCH_PROTECTION,
  resolve as resolveBranchProtection,
} from "./builtin/branch-protection.js";
import {
  configSchema as understandingBeforeExecutionConfigSchema,
  defaultProducers as understandingBeforeExecutionDefaultProducers,
  defaultUx as understandingBeforeExecutionDefaultUx,
  PACK_NAME as UNDERSTANDING_BEFORE_EXECUTION,
  resolve as resolveUnderstandingBeforeExecution,
  resolveMode as resolveUnderstandingBeforeExecutionMode,
  VERSION_COMMAND as UNDERSTANDING_BEFORE_EXECUTION_VERSION_COMMAND,
  type ResolvePackOptions,
} from "./builtin/understanding-before-execution.js";
import {
  configSchema as solutionAcceptanceConfigSchema,
  PACK_NAME as SOLUTION_ACCEPTANCE,
  resolve as resolveSolutionAcceptance,
} from "./builtin/solution-acceptance.js";
import {
  configSchema as postMergeGateConfigSchema,
  defaultUx as postMergeGateDefaultUx,
  PACK_NAME as POST_MERGE_GATE,
  resolve as resolvePostMergeGate,
} from "./builtin/post-merge-gate.js";
import { DEFAULT_RUNTIME, type Runtime } from "./runtime.js";
import type { PackContribution } from "./types.js";

export const KNOWN_BUILTIN_PACKS = [
  UNDERSTANDING_BEFORE_EXECUTION,
  BRANCH_PROTECTION,
  SOLUTION_ACCEPTANCE,
  POST_MERGE_GATE,
] as const;
export type BuiltinPackName = (typeof KNOWN_BUILTIN_PACKS)[number];

export function isBuiltinPackName(name: string): name is BuiltinPackName {
  return (KNOWN_BUILTIN_PACKS as readonly string[]).includes(name);
}

export interface ResolveBuiltinResult {
  contribution: PackContribution;
  warnings: string[];
}

export function resolveBuiltin(
  pack: PolicyPack,
  runtime: Runtime = DEFAULT_RUNTIME,
  opts: ResolvePackOptions = {},
): ResolveBuiltinResult | null {
  if (!isBuiltinPackName(pack.name)) return null;
  switch (pack.name as BuiltinPackName) {
    case UNDERSTANDING_BEFORE_EXECUTION:
      return resolveUnderstandingBeforeExecution(pack, runtime, opts);
    case BRANCH_PROTECTION:
      return resolveBranchProtection(pack, runtime);
    case SOLUTION_ACCEPTANCE:
      return resolveSolutionAcceptance(pack, runtime, opts);
    case POST_MERGE_GATE:
      return resolvePostMergeGate(pack, runtime);
  }
}

/**
 * Per-builtin `config:` schema lookup. Returns null when the pack name
 * is not a builtin (caller should already have flagged that via
 * `checkPolicyPackSources`), and a schema when one is registered.
 * Consumed by `checkPolicyPackConfigs` so `harness validate` /
 * `harness doctor` catch typo'd keys at lint time.
 */
export function resolveBuiltinConfigSchema(
  packName: string,
): z.ZodTypeAny | null {
  if (!isBuiltinPackName(packName)) return null;
  switch (packName as BuiltinPackName) {
    case UNDERSTANDING_BEFORE_EXECUTION:
      return understandingBeforeExecutionConfigSchema;
    case BRANCH_PROTECTION:
      return branchProtectionConfigSchema;
    case SOLUTION_ACCEPTANCE:
      return solutionAcceptanceConfigSchema;
    case POST_MERGE_GATE:
      return postMergeGateConfigSchema;
  }
}

/**
 * Canonical version-probe command for a builtin pack's package-side bin.
 * Returns `null` when the pack name is not a builtin (caller should
 * already have flagged that via `checkPolicyPackSources`), or when the
 * pack has no separate package-side bin (e.g. `branch-protection`'s
 * blocker is harness itself, no external binary to probe). Consumed by
 * `checkPolicyPackVersions` so `harness doctor` can compare the
 * installed version against an operator-declared pack-level
 * `min_version` floor.
 */
export function resolveBuiltinVersionCommand(
  packName: string,
): readonly [string, string] | null {
  if (!isBuiltinPackName(packName)) return null;
  switch (packName as BuiltinPackName) {
    case UNDERSTANDING_BEFORE_EXECUTION:
      return UNDERSTANDING_BEFORE_EXECUTION_VERSION_COMMAND;
    case BRANCH_PROTECTION:
      return null;
    case SOLUTION_ACCEPTANCE:
      // Blocker is harness itself; the producer (grounding-mcp) is probed
      // via its tools.mcp min_version, not a pack-side bin.
      return null;
    case POST_MERGE_GATE:
      // Both the producer and the blocker are harness itself; no
      // separate package-side bin to probe.
      return null;
  }
}

/**
 * The shipped-template `config.ux` / `config.producers` for a builtin pack,
 * as the operator's OWN pack entry would resolve them today (e.g. `ux`'s
 * `required:` line is derived from the pack's currently-configured `mode`,
 * not a hardcoded default mode — an operator on `strict` should be
 * compared against, and reseeded with, the `strict` wording, not
 * `grill_me`'s).
 *
 * Returns `null` when the pack name is not a builtin, or when the pack
 * has no canonical shipped default to compare/reseed against (e.g.
 * `solution-acceptance`, which ships `enabled: false` with no `config:`
 * block in any init template). Consumed by `checkPolicyPackUxDrift`
 * (`harness doctor`'s divergence warning) and `harness pack reseed`
 * (task 68b9ad9c) — the single source both read from so the two stay
 * in lockstep by construction.
 */
export interface BuiltinDefaultConfig {
  ux?: PolicyUx;
  producers?: Producer[];
}

export function resolveBuiltinDefaultConfig(
  pack: PolicyPack,
): BuiltinDefaultConfig | null {
  if (!isBuiltinPackName(pack.name)) return null;
  switch (pack.name as BuiltinPackName) {
    case UNDERSTANDING_BEFORE_EXECUTION: {
      const { mode } = resolveUnderstandingBeforeExecutionMode(pack);
      return {
        ux: understandingBeforeExecutionDefaultUx(mode),
        producers: understandingBeforeExecutionDefaultProducers(),
      };
    }
    case BRANCH_PROTECTION:
      return { ux: branchProtectionDefaultUx() };
    case SOLUTION_ACCEPTANCE:
      return null;
    case POST_MERGE_GATE:
      return { ux: postMergeGateDefaultUx() };
  }
}
