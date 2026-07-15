// Per-pack `config.ux` / `config.producers` divergence check (task
// 68b9ad9c). Used by `harness doctor` to warn when an enabled builtin
// pack's agent-facing deny-message text no longer matches the shipped
// template for that pack.
//
// Motivation (dogfood 2026-07-10, harness 0.40.0): the understanding-gate
// deny message is entirely driven by `config.ux` when the operator has
// declared one — the init templates (Solo/Team/Full/Custom) were fixed to
// teach a new submission form, but that fix only reaches manifests
// generated AFTER the fix landed. An operator who installed before the fix
// has an on-disk `config.ux` that still teaches the old wording, and
// nothing short of a hand-edit ever updated it: `harness apply` projects
// the manifest OUT to settings.json, it never re-seeds pack config FROM
// the shipped template back INTO the manifest.
//
// This check is the read side of that gap (the warning); `harness pack
// reseed <name>` (src/cli/pack/reseed.ts) is the opt-in write side. Both
// consume the same canonical default via `resolveBuiltinDefaultConfig`,
// and the same comparison helpers (ux-compare.ts), so they can never
// independently drift on what "the shipped template" means.
//
// Deliberately doctor-only (not `harness validate`), mirroring
// `checkPolicyPackVersions`: this is an informational nudge about
// wording that still functions, not a schema violation.

import { resolveBuiltinDefaultConfig } from "./registry.js";
import { producersEqual, safeParseProducers, safeParseUx, uxEqual } from "./ux-compare.js";
import type { Manifest } from "../schema/index.js";

export type PolicyPackUxDriftField = "ux" | "producers";

export interface PolicyPackUxDrift {
  packIndex: number;
  packName: string;
  /** Which sub-field(s) diverge from the shipped template. */
  fields: PolicyPackUxDriftField[];
  message: string;
}

/**
 * Walks `manifest.policy_packs` in declared order. For each enabled
 * builtin pack that has a registered shipped default (see
 * `resolveBuiltinDefaultConfig`), compares the operator's declared
 * `config.ux` / `config.producers` (when present) against that default
 * and reports a divergence for each sub-field that differs.
 *
 * A pack that never declared `config.ux` (or `config.producers`) at all
 * is NOT flagged here: that is a distinct, pre-existing gap (the pack
 * falls back to its legacy engine-vocabulary deny text) rather than a
 * stale COPY of the shipped text, and is out of scope for this check —
 * see task 68b9ad9c's framing (an operator whose manifest predates a
 * wording fix has a STALE `ux.run`, not a MISSING one). A malformed
 * `config.ux` / `config.producers` (already reported separately by
 * `checkPolicyPackConfigs`) is treated as diverging here too, rather
 * than being silently skipped.
 */
export function checkPolicyPackUxDrift(manifest: Manifest): PolicyPackUxDrift[] {
  const out: PolicyPackUxDrift[] = [];
  manifest.policy_packs.forEach((pack, packIndex) => {
    if (!pack.enabled) return;
    const canonical = resolveBuiltinDefaultConfig(pack);
    if (!canonical) return;

    const fields: PolicyPackUxDriftField[] = [];
    const currentUx = pack.config["ux"];
    if (canonical.ux && currentUx !== undefined) {
      const parsed = safeParseUx(currentUx);
      if (!parsed || !uxEqual(parsed, canonical.ux)) fields.push("ux");
    }
    const currentProducers = pack.config["producers"];
    if (canonical.producers && currentProducers !== undefined) {
      const parsed = safeParseProducers(currentProducers);
      if (!parsed || !producersEqual(parsed, canonical.producers)) fields.push("producers");
    }
    if (fields.length === 0) return;

    out.push({
      packIndex,
      packName: pack.name,
      fields,
      message:
        `pack "${pack.name}" config.${fields.join(" / config.")} diverges from the shipped ` +
        `builtin template; a supported update exists. Review with ` +
        `\`harness pack reseed ${pack.name} --dry-run\` and apply with \`harness pack reseed ${pack.name}\`.`,
    });
  });
  return out;
}
