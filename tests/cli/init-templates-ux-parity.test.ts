// Drift guard for task 68b9ad9c: the whole point of `harness pack reseed`
// / the `harness doctor` ux-drift warning is that `defaultUx()` /
// `defaultProducers()` (src/policy-packs/builtin/*.ts) ARE "the shipped
// template" an operator's manifest is compared against. If a future wording
// fix lands in FULL_TEMPLATE / SOLO_TEMPLATE / TEAM_TEMPLATE / the Custom
// composer WITHOUT also updating those functions, reseed would silently
// reseed operators AWAY from the actually-shipped wording and back to a
// stale one — reintroducing the exact bug class this task fixes, just one
// layer removed. This test pins every init-generation surface's
// `policy_packs[].config.ux` / `config.producers` to the same canonical
// functions, so such a divergence fails the build instead of shipping
// unnoticed (the same reasoning as the sibling FULL_TEMPLATE vs.
// docs/examples/full-manifest.yaml parity test).

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { composeCustom } from "../../src/cli/init/composer.js";
import {
  defaultProducers,
  defaultUx,
} from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { defaultUx as branchProtectionDefaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

function packConfig(
  manifest: Manifest,
  name: string,
): { ux?: unknown; producers?: unknown } {
  const pack = manifest.policy_packs.find((p) => p.name === name);
  return (pack?.config ?? {}) as { ux?: unknown; producers?: unknown };
}

describe("init generation surfaces stay in lockstep with the canonical defaults (task 68b9ad9c)", () => {
  it("SOLO_TEMPLATE's understanding-before-execution ux matches defaultUx(\"grill_me\")", () => {
    const m = parseManifest(parseYaml(SOLO_TEMPLATE));
    const cfg = packConfig(m, "understanding-before-execution");
    expect(cfg.ux).toEqual(defaultUx("grill_me"));
  });

  it("TEAM_TEMPLATE's understanding-before-execution ux matches defaultUx(\"grill_me\")", () => {
    const m = parseManifest(parseYaml(TEAM_TEMPLATE));
    const cfg = packConfig(m, "understanding-before-execution");
    expect(cfg.ux).toEqual(defaultUx("grill_me"));
  });

  it("FULL_TEMPLATE's understanding-before-execution ux + producers match the canonical defaults", () => {
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    const cfg = packConfig(m, "understanding-before-execution");
    expect(cfg.ux).toEqual(defaultUx("grill_me"));
    expect(cfg.producers).toEqual(defaultProducers());
  });

  it("FULL_TEMPLATE's branch-protection ux matches the canonical default", () => {
    const m = parseManifest(parseYaml(FULL_TEMPLATE));
    const cfg = packConfig(m, "branch-protection");
    expect(cfg.ux).toEqual(branchProtectionDefaultUx());
  });

  it("the Custom composer's understanding-before-execution ux + producers match the canonical defaults", () => {
    const r = composeCustom({
      packs: ["understanding-before-execution"],
      mcps: [],
      policies: [],
    });
    const m = parseManifest(parseYaml(r.yaml));
    const cfg = packConfig(m, "understanding-before-execution");
    expect(cfg.ux).toEqual(defaultUx("grill_me"));
    expect(cfg.producers).toEqual(defaultProducers());
  });

  it("the Custom composer's branch-protection ux matches the canonical default", () => {
    const r = composeCustom({ packs: ["branch-protection"], mcps: [], policies: [] });
    const m = parseManifest(parseYaml(r.yaml));
    const cfg = packConfig(m, "branch-protection");
    expect(cfg.ux).toEqual(branchProtectionDefaultUx());
  });
});
