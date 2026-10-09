// Per-pack version-floor check. A builtin pack ships inside harness itself and
// has no separate package-side bin to probe, so a declared
// `policy_packs[].min_version` can never be enforced. Doctor uses this to
// surface that as a warning, rather than letting the operator believe the
// floor protects anything. The hook-level floor (`hooks[].min_version` with a
// `version_command`) is a different mechanism checked by `checkHookVersion`
// in `src/cli/doctor/index.ts`.

import { isBuiltinPackName } from "./registry.js";
import type { Manifest } from "../schema/index.js";

export type PolicyPackVersionGapKind =
  /** Pack declares min_version but no version probe is registered (warn). */
  "no_probe_registered";

export interface PolicyPackVersionGap {
  packIndex: number;
  packName: string;
  /** The declared floor from `policy_packs[i].min_version`. */
  declaredMinVersion: string;
  kind: PolicyPackVersionGapKind;
  message: string;
}

/**
 * Walks `manifest.policy_packs` in declared order. For each enabled
 * builtin pack that carries an explicit `min_version`, flags that no
 * probe exists to enforce it. Returns one gap per offending pack; packs
 * without a declared floor produce nothing.
 *
 * `enabled: false` packs are skipped (consistent with the source +
 * config helpers). Non-builtin pack names are skipped: the source
 * check is the source of truth for "this pack does not resolve".
 */
export function checkPolicyPackVersions(
  manifest: Manifest,
): PolicyPackVersionGap[] {
  const gaps: PolicyPackVersionGap[] = [];
  manifest.policy_packs.forEach((pack, packIndex) => {
    if (!pack.enabled) return;
    if (!isBuiltinPackName(pack.name)) return;
    if (!pack.min_version) return;
    gaps.push({
      packIndex,
      packName: pack.name,
      declaredMinVersion: pack.min_version,
      kind: "no_probe_registered",
      message: `no version probe registered for pack "${pack.name}"; the declared min_version cannot be enforced`,
    });
  });
  return gaps;
}
