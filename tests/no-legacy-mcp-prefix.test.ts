import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for task `ca9b0026` (grounding MCP tool-prefix rename). The rename's
// review measured that only the FULL_TEMPLATE surface is pinned by existing
// tests: reverting the non-template surfaces (the team-profile verb in
// `src/cli/init/profiles.ts`, the solution-acceptance hook guidance strings,
// the validate diagnostic) shipped green. This guard closes that gap the
// cheap way: the literal legacy prefix must not occur ANYWHERE under `src/`.
//
// Deliberately NOT guarded: bare `agent-grounding` references (the REPO /
// package name in comments, `VERDICT_DIR_TAIL`'s on-disk path, uninstall's
// legacy-registration cleanup) — those are correct and stay. Only the
// `mcp__…__` TOOL prefix is legacy. The needle is assembled from halves so
// this guard itself never surfaces in repo-wide greps for the legacy
// spelling (which are used to verify the rename's completeness).
const LEGACY_TOOL_PREFIX = ["mcp__agent-", "grounding__"].join("");

const SRC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

function scanTreeForLegacyPrefix(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...scanTreeForLegacyPrefix(full));
    } else if (entry.isFile()) {
      const text = fs.readFileSync(full, "utf8");
      if (text.includes(LEGACY_TOOL_PREFIX)) {
        hits.push(full);
      }
    }
  }
  return hits;
}

describe("legacy grounding MCP tool prefix must not reappear under src/", () => {
  it("finds zero occurrences in the shipped tree", () => {
    expect(scanTreeForLegacyPrefix(SRC_DIR)).toEqual([]);
  });

  it("positive control: the scan detects a planted occurrence one directory down in a fixture tree (guard cannot rot into a no-op)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-prefix-guard-"));
    try {
      fs.mkdirSync(path.join(tmp, "nested"));
      const planted = path.join(tmp, "nested", "planted.ts");
      fs.writeFileSync(
        planted,
        `const verb = "${LEGACY_TOOL_PREFIX}ledger_add";\n`,
      );
      expect(scanTreeForLegacyPrefix(tmp)).toEqual([planted]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
