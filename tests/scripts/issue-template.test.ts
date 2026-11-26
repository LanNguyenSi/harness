// Pins `.github/ISSUE_TEMPLATE/bug_report.yml` against the two sources of
// truth it drifts from: package.json (Node floor, current major) and
// docs/CLI.md (the removed manifest keys). The template once still offered a
// "policies section" surface (the `policies` key was removed), asked for a
// "0.x.y" version and a "20.x" Node while engines was already ">=22".
//
// Chosen form of the removed-key check: the "a removed manifest key (...)"
// bullet in docs/CLI.md lists every removed key in backticks; top-level
// removals are the entries without a dot (dotted entries are nested paths,
// e.g. `grounding.policies_source`, which no dropdown option can name).
// Each Surface option is reduced to its leading word ("policies section"
// -> "policies", "policy_packs / packs" -> "policy_packs") and that word
// must not be a removed top-level key.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type TemplateField = {
  type: string;
  id: string;
  attributes?: {
    label?: string;
    description?: string;
    placeholder?: string;
    options?: string[];
  };
};

const TEMPLATE = parse(
  readFileSync(join(REPO_ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.yml"), "utf8"),
) as { body: TemplateField[] };

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
};

function field(id: string): TemplateField {
  const f = TEMPLATE.body.find((b) => b.id === id);
  if (f === undefined) throw new Error(`bug_report.yml has no field with id "${id}"`);
  return f;
}

function leadingMajor(value: string | undefined, what: string): number {
  const m = /(\d+)/.exec(value ?? "");
  if (m === null) throw new Error(`${what} does not start with a major version: ${JSON.stringify(value)}`);
  return Number(m[1]);
}

function removedTopLevelKeys(): Set<string> {
  const cliDoc = readFileSync(join(REPO_ROOT, "docs", "CLI.md"), "utf8");
  const bullet = /a removed manifest key \(([^)]*)\)/.exec(cliDoc);
  if (bullet === null) throw new Error("docs/CLI.md no longer has the 'a removed manifest key (...)' bullet");
  const keys = [...(bullet[1] ?? "").matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined && !k.includes("."));
  return new Set(keys);
}

describe("bug report template", () => {
  it("asks for the harness version as the output of `harness --version` and never names an older major", () => {
    const version = field("version");
    expect(version.attributes?.description).toContain("harness --version");
    const pkgMajor = leadingMajor(PKG.version, "package.json version");
    expect(leadingMajor(version.attributes?.placeholder, "version placeholder")).toBeGreaterThanOrEqual(pkgMajor);
  });

  it("Node placeholder major is >= the package.json engines major", () => {
    const enginesMajor = leadingMajor(PKG.engines.node, "engines.node");
    const nodeMajor = leadingMajor(field("node").attributes?.placeholder, "Node placeholder");
    expect(nodeMajor).toBeGreaterThanOrEqual(enginesMajor);
  });

  it("no Surface option names a manifest key docs/CLI.md lists as removed", () => {
    const removed = removedTopLevelKeys();
    // Guard the guard: the parsing above must actually see the key this
    // test exists for, so a docs rewording cannot silently pass it.
    expect(removed.has("policies")).toBe(true);
    const options = field("surface").attributes?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const word = /^([^\s/]+)/.exec(option.toLowerCase())?.[1] ?? "";
      expect(
        removed.has(word),
        `Surface option "${option}" names removed manifest key "${word}"`,
      ).toBe(false);
    }
  });
});
