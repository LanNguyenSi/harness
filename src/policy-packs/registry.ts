// Registry of builtin policy-pack names.
//
// One builtin pack ships: `branch-protection`. A further builtin is added by
// appending to `KNOWN_BUILTIN_PACKS` and a case arm in `resolveBuiltin()`.
// Non-builtin sources (path/npm/git) are out of scope for v1.

import type { z } from "zod";
import type { PolicyPack, PolicyUx } from "../schema/index.js";
import {
  configSchema as branchProtectionConfigSchema,
  defaultUx as branchProtectionDefaultUx,
  PACK_NAME as BRANCH_PROTECTION,
  resolve as resolveBranchProtection,
} from "./builtin/branch-protection.js";
import { DEFAULT_RUNTIME, type Runtime } from "./runtime.js";
import type { PackContribution } from "./types.js";

export const KNOWN_BUILTIN_PACKS = [BRANCH_PROTECTION] as const;
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
): ResolveBuiltinResult | null {
  if (!isBuiltinPackName(pack.name)) return null;
  switch (pack.name as BuiltinPackName) {
    case BRANCH_PROTECTION:
      return resolveBranchProtection(pack, runtime);
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
    case BRANCH_PROTECTION:
      return branchProtectionConfigSchema;
  }
}

/**
 * The shipped-template `config.ux` for a builtin pack, as the operator's OWN
 * pack entry would resolve it today.
 *
 * Returns `null` when the pack name is not a builtin, or when the pack
 * has no canonical shipped default to compare/reseed against. Every
 * remaining builtin ships one. Consumed by `checkPolicyPackUxDrift`
 * (`harness doctor`'s divergence warning) and `harness pack reseed`
 * (task 68b9ad9c) — the single source both read from so the two stay
 * in lockstep by construction.
 */
export interface BuiltinDefaultConfig {
  ux: PolicyUx;
}

export function resolveBuiltinDefaultConfig(
  pack: PolicyPack,
): BuiltinDefaultConfig | null {
  if (!isBuiltinPackName(pack.name)) return null;
  switch (pack.name as BuiltinPackName) {
    case BRANCH_PROTECTION:
      return { ux: branchProtectionDefaultUx() };
  }
}
