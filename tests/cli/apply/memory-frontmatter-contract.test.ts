import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateMemoryIndex } from "../../../src/cli/apply/generate-memory-index.js";
import { parseManifest } from "../../../src/schema/index.js";

interface CorpusCase {
  file: string;
  accepted: boolean;
  resolvedType?: string;
}

interface CorpusManifest {
  cases: CorpusCase[];
}

const contractDirectory = fileURLToPath(
  new URL("../../contracts/memory-frontmatter-v1/", import.meta.url),
);
const vendorDirectory = path.join(contractDirectory, "vendor");
const corpusManifest = JSON.parse(
  fs.readFileSync(path.join(vendorDirectory, "manifest.json"), "utf8"),
) as CorpusManifest;

describe("memory-frontmatter/v1 consumer contract", () => {
  it("matches every pinned producer inclusion decision", () => {
    expect(Array.isArray(corpusManifest.cases)).toBe(true);
    expect(corpusManifest.cases.length).toBeGreaterThan(0);

    const result = generateMemoryIndex(
      parseManifest({
        version: 1,
        tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
        memory: { directories: [{ path: path.join(vendorDirectory, "cases"), scope: "project" }] },
        hooks: [],
        policies: [],
      }),
    );
    const included = new Set(result.entries.map((entry) => entry.basename));
    const expected = corpusManifest.cases
      .filter((testCase) => testCase.accepted)
      .map((testCase) => path.basename(testCase.file))
      .sort();

    expect([...included].sort()).toEqual(expected);
    for (const testCase of corpusManifest.cases) {
      expect(fs.existsSync(path.join(vendorDirectory, testCase.file))).toBe(true);
      expect(included.has(path.basename(testCase.file))).toBe(testCase.accepted);
    }
    expect(new Set(corpusManifest.cases.map((testCase) => testCase.file)).size).toBe(
      corpusManifest.cases.length,
    );
  });
});
