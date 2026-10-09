// Apply-time expansion of `policy_packs[]` entries.
//
// Walks the manifest's enabled packs, parses each `source:` string,
// resolves builtin packs through the registry, and aggregates their
// contributions (hooks + files). Unrecognised sources / unknown builtin
// names are caught up front by `checkPolicyPackSources` (called from
// both `harness apply` and `harness validate`), so the warning + skip
// branches below are belt-and-braces: they only trigger if a caller
// invokes `expandPolicyPacks` directly without the pre-check.
//
// Hook-name collision handling: pack hooks are namespaced
// (`policy-pack:<name>:<role>`) by the builtin definitions, so a user
// hook with a colliding name is the user's mistake. Two packs cannot
// contribute the same name: the schema rejects a duplicate
// `policy_packs[].name`. We surface that as
// a warning here rather than blowing up; the schema's duplicate-name
// superRefine will reject it on the augmented manifest's downstream
// re-parse if a caller re-validates.

import type { Manifest } from "../schema/index.js";
import { resolveBuiltin } from "./registry.js";
import { DEFAULT_RUNTIME, type Runtime } from "./runtime.js";
import { parsePackSource } from "./source.js";
import type { PackExpansionResult } from "./types.js";

export function expandPolicyPacks(
  manifest: Manifest,
  runtime: Runtime = DEFAULT_RUNTIME,
): PackExpansionResult {
  const out: PackExpansionResult = { hooks: [], files: [], warnings: [], skipped: [] };
  if (manifest.policy_packs.length === 0) return out;

  const existingHookNames = new Set(manifest.hooks.map((h) => h.name));

  for (const pack of manifest.policy_packs) {
    if (!pack.enabled) {
      out.skipped.push(pack.name);
      continue;
    }
    const sourceParsed = parsePackSource(pack.source);
    if (sourceParsed.kind === "unknown") {
      out.warnings.push(
        `policy_packs[${pack.name}]: source ${JSON.stringify(
          pack.source,
        )} is not recognised in v1 (only "builtin" resolves); skipping.`,
      );
      continue;
    }
    const resolved = resolveBuiltin(pack, runtime);
    if (!resolved) {
      out.warnings.push(
        `policy_packs[${pack.name}]: not a known builtin pack; skipping. See docs/policy-packs/ for supported names.`,
      );
      continue;
    }
    out.warnings.push(...resolved.warnings);
    for (const hook of resolved.contribution.hooks) {
      if (existingHookNames.has(hook.name)) {
        out.warnings.push(
          `policy_packs[${pack.name}]: hook name "${hook.name}" collides with a manifest hooks[] entry; pack contribution dropped to avoid a duplicate-name failure.`,
        );
        continue;
      }
      out.hooks.push(hook);
    }
    out.files.push(...resolved.contribution.files);
  }

  return out;
}
