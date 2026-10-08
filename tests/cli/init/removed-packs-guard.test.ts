// Guard (task 2ce6933f): a pack listed in REMOVED_PACK_NAMES must not be
// offered anywhere a new or documenting operator looks: no init template
// ships it, no docs example names it, the interactive wizard's custom
// composer does not offer it, the builtin registry does not know it, and
// `harness pack add` refuses it. Data-driven over the table, so every
// future removal inherits the same guard. The manifest-bearing checks parse
// YAML and read `policy_packs[].name` rather than matching substrings, so a
// template that merely mentions the pack name in a comment cannot pass by
// accident while a real entry cannot hide.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  COMPOSABLE_MCPS,
  COMPOSABLE_PACKS,
  COMPOSABLE_POLICIES,
  composeCustom,
  type CustomSelection,
} from "../../../src/cli/init/composer.js";
import { getTemplate, type TemplateName } from "../../../src/cli/init/templates.js";
import { packAdd } from "../../../src/cli/pack/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";
import { KNOWN_BUILTIN_PACKS } from "../../../src/policy-packs/registry.js";
import { REMOVED_PACK_NAMES } from "../../../src/schema/index.js";

const TEMPLATE_NAMES: TemplateName[] = ["minimal", "solo", "team", "full"];
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const DOCS_EXAMPLES = [
  "docs/examples/full-manifest.yaml",
  "docs/examples/full-manifest.expected.yaml",
];

// Parse a manifest's YAML text and return every `policy_packs[].name`. Raw
// `parse` (not `parseManifest` / `loadManifest`, which strip removed packs)
// so a template or example that still ships a removed pack surfaces here.
function packNames(text: string): string[] {
  const parsed = parseYaml(text) as { policy_packs?: Array<{ name?: unknown }> } | null;
  const names = (parsed?.policy_packs ?? []).map((p) => p?.name);
  return names.filter((n): n is string => typeof n === "string");
}

describe.each(REMOVED_PACK_NAMES)("removed pack %s", (removed) => {
  it("is not offered by any init template", () => {
    for (const name of TEMPLATE_NAMES) {
      expect(packNames(getTemplate(name)), `template ${name}`).not.toContain(removed.name);
    }
  });

  it("is not named by the docs examples", () => {
    for (const rel of DOCS_EXAMPLES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(packNames(text), rel).not.toContain(removed.name);
    }
  });

  it("is not offered by the interactive wizard's custom composer", () => {
    // Turn on every option the Custom surface offers: each list at its full
    // set of choices (the surface carries no boolean toggles).
    const selection: CustomSelection = {
      packs: COMPOSABLE_PACKS.map((o) => o.key),
      mcps: COMPOSABLE_MCPS.map((o) => o.key),
      policies: COMPOSABLE_POLICIES.map((o) => o.key),
    };
    const result = composeCustom(selection);
    expect(packNames(result.yaml)).not.toContain(removed.name);
  });

  it("is not a known builtin pack", () => {
    expect(KNOWN_BUILTIN_PACKS as readonly string[]).not.toContain(removed.name);
  });

  describe("`harness pack add` against a scratch manifest", () => {
    let tmpHome: string;
    let manifestPath: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-removed-pack-add-"));
      manifestPath = path.join(tmpHome, "harness.yaml");
      fs.writeFileSync(manifestPath, "version: 1\n", "utf8");
    });

    afterEach(() => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("fails with a non-zero exit", async () => {
      let caught: unknown;
      try {
        await packAdd({ name: removed.name }, { configPath: manifestPath });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HarnessExitError);
      expect((caught as HarnessExitError).exitCode).not.toBe(0);
      expect((caught as Error).message).toMatch(/not a known builtin pack/);
    });
  });
});
