// Registry of builtin policy-pack names.
//
// Phase 6 #2 shipped `understanding-before-execution`; subsequent
// builtins are added by appending to `KNOWN_BUILTIN_PACKS` and a case
// arm in `resolveBuiltin()`. Non-builtin sources (path/npm/git) are
// out of scope for v1; their resolution lands in a later sub-task.

import type { PolicyPack } from "../schema/index.js";
import {
  PACK_NAME as BRANCH_PROTECTION,
  resolve as resolveBranchProtection,
} from "./builtin/branch-protection.js";
import {
  PACK_NAME as UNDERSTANDING_BEFORE_EXECUTION,
  resolve as resolveUnderstandingBeforeExecution,
  type ResolvePackOptions,
} from "./builtin/understanding-before-execution.js";
import { DEFAULT_RUNTIME, type Runtime } from "./runtime.js";
import type { PackContribution } from "./types.js";

export const KNOWN_BUILTIN_PACKS = [
  UNDERSTANDING_BEFORE_EXECUTION,
  BRANCH_PROTECTION,
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
  }
}
