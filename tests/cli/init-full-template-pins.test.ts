import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "../../src/cli/init/profiles.js";
import { COMPOSABLE_MCPS, COMPOSABLE_PACKS, composeCustom } from "../../src/cli/init/composer.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifestWithWarnings } from "../../src/schema/index.js";

// Task d834a065 pinned the `&` command boundary in every policy trigger the
// templates and the composer emitted. The policy engine is gone and the
// install surfaces ship no policies and no bash_match triggers any more
// (task bcdcde36), so the surface is pinned empty instead: no removed manifest
// key, empty or not, and no warning when the output is parsed (task 10e2ff0a).
describe("install surfaces ship no policies, hooks or bash_match triggers", () => {
  const TEMPLATES: Array<[string, string]> = [
    ["SOLO_TEMPLATE", SOLO_TEMPLATE],
    ["TEAM_TEMPLATE", TEAM_TEMPLATE],
    ["FULL_TEMPLATE", FULL_TEMPLATE],
  ];

  it.each(TEMPLATES)("%s: parses with no policies, no hooks and no policy-intercept text", (_, src) => {
    const { manifest: parsed, warnings } = parseManifestWithWarnings(parseYaml(src));
    expect(parsed).not.toHaveProperty("policies");
    expect(src).not.toMatch(/^(policies|workflows|review_templates|doctor):/m);
    expect(warnings).toEqual([]);
    expect(parsed.hooks).toEqual([]);
    expect(src).not.toContain("harness policy intercept");
    expect(src).not.toContain("bash_match");
  });

  it("composeCustom() with every pack and MCP emits no policies, hooks or bash_match", () => {
    const composed = composeCustom({
      packs: COMPOSABLE_PACKS.map((o) => o.key),
      mcps: COMPOSABLE_MCPS.map((o) => o.key),
    });
    const { manifest: parsed, warnings } = parseManifestWithWarnings(parseYaml(composed.yaml));
    expect(parsed).not.toHaveProperty("policies");
    expect(composed.yaml).not.toMatch(/^(policies|workflows|review_templates|doctor):/m);
    expect(warnings).toEqual([]);
    expect(parsed.hooks).toEqual([]);
    expect(composed.yaml).not.toContain("harness policy intercept");
    expect(composed.yaml).not.toContain("bash_match");
  });
});
