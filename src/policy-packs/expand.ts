// Apply-time expansion of `policy_packs[]` entries.
//
// Walks the manifest's enabled packs, parses each `source:` string,
// resolves builtin packs through the registry, and aggregates their
// contributions (hooks + files). Unrecognised sources or unknown builtin
// names produce non-fatal warnings here; `harness validate` is the
// place that turns the same conditions into hard errors so the user
// sees them at lint time, not silently at apply time.
//
// Hook-name collision handling: pack hooks are namespaced
// (`policy-pack:<name>:<role>`) by the builtin definitions, so a user
// hook with a colliding name is the user's mistake. We surface that as
// a warning here rather than blowing up; the schema's duplicate-name
// superRefine will reject it on the augmented manifest's downstream
// re-parse if a caller re-validates.

import type { Manifest } from "../schema/index.js";
import { resolveBuiltin } from "./registry.js";
import { DEFAULT_RUNTIME, type Runtime } from "./runtime.js";
import { parsePackSource } from "./source.js";
import type { PackExpansionResult, PackPermissionsContribution } from "./types.js";

export function expandPolicyPacks(
  manifest: Manifest,
  runtime: Runtime = DEFAULT_RUNTIME,
): PackExpansionResult {
  const out: PackExpansionResult = { hooks: [], files: [], warnings: [], skipped: [] };
  if (manifest.policy_packs.length === 0) return out;

  const existingHookNames = new Set(manifest.hooks.map((h) => h.name));
  const seenPackHookNames = new Set<string>();
  const allowSet = new Set<string>();
  const askSet = new Set<string>();
  const denySet = new Set<string>();
  let anyPermissions = false;

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
      if (seenPackHookNames.has(hook.name)) {
        out.warnings.push(
          `policy_packs[${pack.name}]: hook name "${hook.name}" was already contributed by an earlier pack; second copy dropped.`,
        );
        continue;
      }
      seenPackHookNames.add(hook.name);
      out.hooks.push(hook);
    }
    out.files.push(...resolved.contribution.files);
    if (resolved.contribution.permissions) {
      anyPermissions = true;
      for (const p of resolved.contribution.permissions.allow) allowSet.add(p);
      for (const p of resolved.contribution.permissions.ask) askSet.add(p);
      for (const p of resolved.contribution.permissions.deny) denySet.add(p);
    }
  }

  if (anyPermissions) {
    // Deny wins over ask wins over allow at merge time: a stricter
    // intent from any pack should not be silently relaxed by a more
    // permissive sibling. Concretely, a pattern present in deny is
    // stripped from ask + allow; a pattern present in ask is stripped
    // from allow.
    for (const p of denySet) {
      askSet.delete(p);
      allowSet.delete(p);
    }
    for (const p of askSet) {
      allowSet.delete(p);
    }
    const permissions: PackPermissionsContribution = {
      allow: [...allowSet].sort(),
      ask: [...askSet].sort(),
      deny: [...denySet].sort(),
    };
    out.permissions = permissions;
  }

  return out;
}
