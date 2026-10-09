// Guard (task e2d5e87e): the install surfaces no longer offer the
// understanding-before-execution pack. Every init template, the interactive
// composer with every composable pack ticked, and the dependency resolver
// are checked structurally (parsed YAML, key walks, resolved binaries), so
// a comment that merely mentions the pack cannot hide a real entry. The
// pack itself and manifests that already carry it stay supported
// elsewhere; this file only pins that nothing here offers it.
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  COMPOSABLE_MCPS,
  COMPOSABLE_PACKS,
  COMPOSABLE_POLICIES,
  composeCustom,
} from "../../../src/cli/init/composer.js";
import {
  PROFILE_DEPENDENCIES,
  dependenciesForCustom,
  dependenciesForProfile,
} from "../../../src/cli/init/dependencies.js";
import { getTemplate, type TemplateName } from "../../../src/cli/init/templates.js";

const UG_PACK = "understanding-before-execution";
const TEMPLATE_NAMES: TemplateName[] = ["minimal", "solo", "team", "full"];
const PROFILES = ["solo", "team", "full"] as const;

function hasKeyDeep(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => hasKeyDeep(n, key));
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).some(
      ([k, v]) => k === key || hasKeyDeep(v, key),
    );
  }
  return false;
}

function packNames(doc: unknown): string[] {
  const packs = (doc as { policy_packs?: Array<{ name?: string }> }).policy_packs ?? [];
  return packs.map((p) => String(p.name));
}

const composedEverything = composeCustom({
  packs: COMPOSABLE_PACKS.map((p) => p.key),
  mcps: COMPOSABLE_MCPS.map((m) => m.key),
  policies: COMPOSABLE_POLICIES.map((p) => p.key),
});

describe("init templates do not offer the understanding gate", () => {
  it.each(TEMPLATE_NAMES)("%s: no understanding pack entry, no auto_approve key, no approve-understanding text", (name) => {
    const text = getTemplate(name);
    const doc = parseYaml(text);
    expect(packNames(doc)).not.toContain(UG_PACK);
    expect(hasKeyDeep(doc, "auto_approve")).toBe(false);
    expect(text).not.toContain("harness approve understanding");
  });

  it.each(PROFILES)("%s: carries an enabled builtin branch-protection entry", (name) => {
    const doc = parseYaml(getTemplate(name)) as {
      policy_packs: Array<{ name: string; source: string; enabled: boolean }>;
    };
    const bp = doc.policy_packs.filter((p) => p.name === "branch-protection");
    expect(bp).toHaveLength(1);
    expect(bp[0]?.source).toBe("builtin");
    expect(bp[0]?.enabled).toBe(true);
  });

  it("minimal ships no policy pack at all", () => {
    const doc = parseYaml(getTemplate("minimal")) as { policy_packs?: unknown[] };
    expect(doc.policy_packs ?? []).toEqual([]);
  });
});

describe("the interactive composer does not offer the understanding gate", () => {
  it("COMPOSABLE_PACKS does not contain the understanding key", () => {
    expect(COMPOSABLE_PACKS.map((p) => String(p.key))).not.toContain(UG_PACK);
  });

  it("with every composable pack, MCP and policy selected the manifest has no understanding pack, auto_approve key or approve-understanding text", () => {
    const doc = parseYaml(composedEverything.yaml);
    expect(packNames(doc)).not.toContain(UG_PACK);
    expect(packNames(doc)).toContain("branch-protection");
    expect(hasKeyDeep(doc, "auto_approve")).toBe(false);
    expect(composedEverything.yaml).not.toContain("harness approve understanding");
  });

  it("an understanding selection is refused instead of silently emitted", () => {
    expect(() =>
      composeCustom({
        // The key is no longer part of the selection type; force it through
        // to prove the composer has no branch left for it.
        packs: [UG_PACK as never],
        mcps: [],
        policies: [],
      }),
    ).toThrow(/unknown pack/);
  });
});

describe("the dependency installer does not list understanding-gate binaries", () => {
  it.each(PROFILES)("%s profile resolves no understanding-gate binary or package", (profile) => {
    for (const dep of dependenciesForProfile(profile)) {
      expect(dep.binary.startsWith("understanding-gate")).toBe(false);
      expect(dep.npmPackage).not.toContain("understanding-gate");
    }
  });

  it("no PROFILE_DEPENDENCIES layer names an understanding-gate binary or package", () => {
    for (const layer of Object.values(PROFILE_DEPENDENCIES)) {
      for (const dep of layer) {
        expect(dep.binary.startsWith("understanding-gate")).toBe(false);
        expect(dep.npmPackage).not.toContain("understanding-gate");
      }
    }
  });

  it("the Custom resolver with every pack, MCP and policy selected resolves no understanding-gate binary", () => {
    const deps = dependenciesForCustom({
      packs: COMPOSABLE_PACKS.map((p) => p.key),
      mcps: COMPOSABLE_MCPS.map((m) => m.key),
      policies: COMPOSABLE_POLICIES.map((p) => p.key),
    });
    expect(deps.length).toBeGreaterThan(0);
    for (const dep of deps) {
      expect(dep.binary.startsWith("understanding-gate")).toBe(false);
      expect(dep.npmPackage).not.toContain("understanding-gate");
    }
  });
});
