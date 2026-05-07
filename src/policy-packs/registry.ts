// Registry of builtin policy-pack names.
//
// Phase 6 #2 ships exactly one builtin: `understanding-before-execution`.
// Future builtins are added here. Non-builtin sources (path/npm/git) are
// out of scope for v1; their resolution lands in a later sub-task.

import type { PolicyPack } from "../schema/index.js";
import {
  PACK_NAME as UNDERSTANDING_BEFORE_EXECUTION,
  resolve as resolveUnderstandingBeforeExecution,
} from "./builtin/understanding-before-execution.js";
import type { PackContribution } from "./types.js";

export const KNOWN_BUILTIN_PACKS = [UNDERSTANDING_BEFORE_EXECUTION] as const;
export type BuiltinPackName = (typeof KNOWN_BUILTIN_PACKS)[number];

export function isBuiltinPackName(name: string): name is BuiltinPackName {
  return (KNOWN_BUILTIN_PACKS as readonly string[]).includes(name);
}

export interface ResolveBuiltinResult {
  contribution: PackContribution;
  warnings: string[];
}

export function resolveBuiltin(pack: PolicyPack): ResolveBuiltinResult | null {
  if (!isBuiltinPackName(pack.name)) return null;
  switch (pack.name as BuiltinPackName) {
    case UNDERSTANDING_BEFORE_EXECUTION:
      return resolveUnderstandingBeforeExecution(pack);
  }
}
