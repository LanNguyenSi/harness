import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/cli/validate/index.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const RECIPES_DIR = path.join(REPO_ROOT, "docs", "examples", "policies");

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
};

const recipeFiles = fs
  .readdirSync(RECIPES_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

describe("docs/examples/policies — recipe YAMLs validate cleanly", () => {
  it("recipes dir has the expected number of files (guard against accidental drop)", () => {
    expect(recipeFiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of recipeFiles) {
    it(`${file} has 0 schema errors`, () => {
      const recipePath = path.join(RECIPES_DIR, file);
      const result = validate({
        homeDir: RECIPES_DIR,
        configPath: recipePath,
        ...NOOP_PROBES,
      });
      if (result.errorCount > 0) {
        const messages = result.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => `  - ${d.message}`)
          .join("\n");
        throw new Error(`${file} produced ${result.errorCount} error(s):\n${messages}`);
      }
      expect(result.errorCount).toBe(0);
    });
  }
});
