// Guard (task 2ce6933f): a pack listed in REMOVED_PACK_NAMES must not be
// offered anywhere a new or documenting operator looks: no init template
// ships it, no docs example names it, the builtin registry does not know it,
// and `harness pack add` refuses it. Data-driven over the table, so every
// future removal inherits the same guard.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe.each(REMOVED_PACK_NAMES)("removed pack %s", (removed) => {
  it("is not offered by any init template", () => {
    for (const name of TEMPLATE_NAMES) {
      expect(getTemplate(name), `template ${name}`).not.toContain(`- name: ${removed.name}`);
    }
  });

  it("is not named by the docs examples", () => {
    for (const rel of DOCS_EXAMPLES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(text, rel).not.toContain(`name: ${removed.name}`);
    }
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
