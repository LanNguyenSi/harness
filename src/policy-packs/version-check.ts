// Per-pack version-floor check. Doctor uses this to surface a warning
// when the operator declared `policy_packs[].min_version: x.y.z` and
// the installed package-side bin reports below that. Mirrors the
// hook-level `checkHookVersion` design (see `src/cli/doctor/index.ts`):
// the same warning rungs, the same parse-failure fallback, so an
// operator reading doctor output sees a consistent shape regardless of
// which layer raised the gap.
//
// The split between this and the hook-level check is deliberate: a
// hook-level floor covers each individual hook command, this catches a
// pack-level config-schema mismatch (a `config:` key only the newer
// package honours). Both can fire in the same doctor run.

import { compareNumericVersions } from "../io/version-compare.js";
import { isBuiltinPackName, resolveBuiltinVersionCommand } from "./registry.js";
import type { Manifest } from "../schema/index.js";

export type PolicyPackVersionGapKind =
  /** Pack declares min_version but no version probe is registered (warn). */
  | "no_probe_registered"
  /** Version probe returned null (binary missing / failed to launch). */
  | "probe_failed"
  /** Probe stdout did not match a `digit(.digit)*` token. */
  | "parse_failed"
  /** Probed version is below the declared floor. */
  | "below_floor";

export interface PolicyPackVersionGap {
  packIndex: number;
  packName: string;
  /** The declared floor from `policy_packs[i].min_version`. */
  declaredMinVersion: string;
  /**
   * The version probe command that was (or would have been) invoked.
   * Empty array when no probe is registered for the pack.
   */
  versionCommand: readonly string[];
  /** Parsed version string when the probe succeeded; otherwise null. */
  actualVersion: string | null;
  kind: PolicyPackVersionGapKind;
  message: string;
}

/**
 * Walks `manifest.policy_packs` in declared order. For each enabled
 * builtin pack that carries an explicit `min_version`, runs the
 * registered probe (or flags missing-probe), parses the version, and
 * compares against the floor. Returns one gap per offending pack;
 * green ones produce nothing.
 *
 * `enabled: false` packs are skipped (consistent with the source +
 * config helpers). Non-builtin pack names are skipped: the source
 * check is the source of truth for "this pack does not resolve".
 */
export function checkPolicyPackVersions(
  manifest: Manifest,
  versionProbe: (cmd: readonly string[]) => string | null,
): PolicyPackVersionGap[] {
  const gaps: PolicyPackVersionGap[] = [];
  manifest.policy_packs.forEach((pack, packIndex) => {
    if (!pack.enabled) return;
    if (!isBuiltinPackName(pack.name)) return;
    if (!pack.min_version) return;
    const versionCommand = resolveBuiltinVersionCommand(pack.name);
    if (versionCommand === null) {
      gaps.push({
        packIndex,
        packName: pack.name,
        declaredMinVersion: pack.min_version,
        versionCommand: [],
        actualVersion: null,
        kind: "no_probe_registered",
        message: `no version probe registered for pack "${pack.name}"; the declared min_version cannot be enforced`,
      });
      return;
    }
    const stdout = versionProbe(versionCommand);
    if (stdout === null) {
      gaps.push({
        packIndex,
        packName: pack.name,
        declaredMinVersion: pack.min_version,
        versionCommand,
        actualVersion: null,
        kind: "probe_failed",
        message: `version probe failed for ${versionCommand.join(" ")}`,
      });
      return;
    }
    const match = stdout.match(/(\d+(?:\.\d+){0,3})/);
    if (!match || !match[1]) {
      gaps.push({
        packIndex,
        packName: pack.name,
        declaredMinVersion: pack.min_version,
        versionCommand,
        actualVersion: null,
        kind: "parse_failed",
        message: `could not parse a version from "${stdout.trim()}"`,
      });
      return;
    }
    const actual = match[1];
    if (compareNumericVersions(actual, pack.min_version) < 0) {
      gaps.push({
        packIndex,
        packName: pack.name,
        declaredMinVersion: pack.min_version,
        versionCommand,
        actualVersion: actual,
        kind: "below_floor",
        message: `outdated: installed v${actual} < required ${pack.min_version}`,
      });
    }
  });
  return gaps;
}
