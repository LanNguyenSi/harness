// Shared pack-source / builtin-name check, used by both
// `harness validate` (lint-time hard error) and `harness apply`
// (fail-loud before expansion). Without a single source of truth here,
// the two paths drifted: apply silently skipped unknown packs while
// validate erred — so an operator who never ran `validate` would push a
// broken manifest, see "apply succeeded", and only discover the pack
// never wired up at runtime.

import { isBuiltinPackName } from "./registry.js";
import { parsePackSource } from "./source.js";
import type { Manifest } from "../schema/index.js";

export type PolicyPackSourceIssueKind = "unknown-source" | "unknown-builtin";

export interface PolicyPackSourceIssue {
  packIndex: number;
  packName: string;
  kind: PolicyPackSourceIssueKind;
  /** Raw `source:` string for `unknown-source`; absent for `unknown-builtin`. */
  source?: string;
  /**
   * Path suffix matching the validate Diagnostic shape: `source` or `name`.
   * Not independent of `kind` — `unknown-source` always pairs with `source`,
   * `unknown-builtin` with `name`. Carried explicitly so call sites
   * (apply error text, validate Diagnostic.path) don't each re-derive it.
   */
  field: "source" | "name";
  message: string;
}

/**
 * Walks `manifest.policy_packs` in declared order and returns one issue
 * per offending enabled pack. Output order is stable and matches the
 * manifest array order — call sites rely on this when aggregating
 * messages, and `tests/policy-packs/source-check.test.ts` asserts it.
 *
 * `enabled: false` packs are skipped on both sides: an operator who has
 * intentionally stashed an unfinished pack reference shouldn't have
 * apply or validate red until they re-enable it.
 */
export function checkPolicyPackSources(manifest: Manifest): PolicyPackSourceIssue[] {
  const issues: PolicyPackSourceIssue[] = [];
  manifest.policy_packs.forEach((pack, i) => {
    if (!pack.enabled) return;
    const sourceParsed = parsePackSource(pack.source);
    if (sourceParsed.kind === "unknown") {
      issues.push({
        packIndex: i,
        packName: pack.name,
        kind: "unknown-source",
        source: pack.source,
        field: "source",
        message: `unknown source ${JSON.stringify(
          pack.source,
        )}: only "builtin" resolves in v1; see docs/policy-packs/`,
      });
      return;
    }
    if (!isBuiltinPackName(pack.name)) {
      issues.push({
        packIndex: i,
        packName: pack.name,
        kind: "unknown-builtin",
        field: "name",
        message: `not a known builtin pack: ${JSON.stringify(
          pack.name,
        )}. See docs/policy-packs/ for supported names.`,
      });
    }
  });
  return issues;
}
