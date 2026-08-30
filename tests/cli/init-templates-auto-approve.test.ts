// D-004 (task 8f637efd, docs/decisions/2026-08-27-ug-auto-mode-approval.md,
// "Amendment: install default"): every `harness init` template that
// enables the `understanding-before-execution` pack must ship the
// `auto_approve` block, active, matching the canonical shipped default
// (`defaultAutoApproveConfig()` / `renderAutoApproveSnippet()` in
// `auto-approve-default.ts`) and validating against the pack's own zod
// `configSchema`.
//
// Mutation probe M1: delete the `auto_approve:` key (or any of its three
// children) from one template and this test's presence/equality
// assertion for that template goes red; restoring the block turns it
// green again.
//
// Review round 2 F3: `harness init --interactive` Custom profile
// (composer.ts's `composeCustom`) is also a template-shaped surface that
// enables this pack, and it had been missed by this default entirely
// (it builds a config OBJECT, not YAML text, so `renderAutoApproveSnippet`
// does not apply; it reads `defaultAutoApproveConfig()` instead). The
// "Custom composer" case below pins that.
//
// Mutation probe M3: drop the `auto_approve: defaultAutoApproveConfig()`
// line from composer.ts's understanding-before-execution branch and the
// "Custom composer" test below goes red; restoring it turns it green.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE, MINIMAL_TEMPLATE } from "../../src/cli/init/templates.js";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { composeCustom } from "../../src/cli/init/composer.js";
import { configSchema } from "../../src/policy-packs/builtin/understanding-before-execution.js";
import { defaultAutoApproveConfig } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

function packConfig(manifest: Manifest, name: string): Record<string, unknown> {
  const pack = manifest.policy_packs.find((p) => p.name === name);
  return (pack?.config ?? {}) as Record<string, unknown>;
}

describe("harness init templates ship an active auto_approve default (task 8f637efd, D-004)", () => {
  it.each([
    ["FULL_TEMPLATE", FULL_TEMPLATE],
    ["SOLO_TEMPLATE", SOLO_TEMPLATE],
    ["TEAM_TEMPLATE", TEAM_TEMPLATE],
  ] as const)("%s's understanding-before-execution config carries auto_approve", (_label, template) => {
    const m = parseManifest(parseYaml(template));
    const cfg = packConfig(m, "understanding-before-execution");

    // Present at all (the mutation this probe pins: a template with the
    // key deleted fails right here).
    expect(cfg["auto_approve"]).toBeDefined();

    // Matches the one canonical default byte-for-byte in shape.
    expect(cfg["auto_approve"]).toEqual(defaultAutoApproveConfig());

    // And validates against the pack's own zod schema, not just against
    // this test's own expectations.
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
  });

  it("MINIMAL_TEMPLATE declares no policy_packs at all, so there is no auto_approve to pin", () => {
    const m = parseManifest(parseYaml(MINIMAL_TEMPLATE));
    expect(m.policy_packs).toEqual([]);
  });

  it("Custom composer (composeCustom) ships the same auto_approve default when understanding-before-execution is selected", () => {
    const { yaml } = composeCustom({
      packs: ["understanding-before-execution"],
      mcps: [],
      policies: [],
    });
    const m = parseManifest(parseYaml(yaml));
    const cfg = packConfig(m, "understanding-before-execution");

    expect(cfg["auto_approve"]).toBeDefined();
    expect(cfg["auto_approve"]).toEqual(defaultAutoApproveConfig());

    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
  });
});
