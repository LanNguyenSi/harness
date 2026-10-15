import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Drift guard: the policy_packs section of FULL_TEMPLATE (emitted by
// `harness init --template full`) must stay in lockstep with
// docs/examples/full-manifest.yaml (the schema-coverage reference, golden-
// tested by tests/cli/describe.test.ts). Neither ships policies or policy
// hooks any more (task bcdcde36); both are pinned empty below.
//
// The two manifests are intentionally different elsewhere:
//   - tools.mcp commands (FULL_TEMPLATE uses published npm bins;
//     full-manifest.yaml uses local Pandora checkout paths)
//   - full-manifest.yaml carries workflows, review_templates, audit blocks
//     that FULL_TEMPLATE intentionally omits.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const REFERENCE_YAML = path.join(
  REPO_ROOT,
  "docs",
  "examples",
  "full-manifest.yaml",
);

function loadReferenceManifest(): Manifest {
  return parseManifest(parseYaml(fs.readFileSync(REFERENCE_YAML, "utf8")));
}

function loadFullTemplateManifest(): Manifest {
  return parseManifest(parseYaml(FULL_TEMPLATE));
}

describe("FULL_TEMPLATE ↔ docs/examples/full-manifest.yaml — drift guard", () => {
  it("neither manifest ships policies or hooks", () => {
    for (const m of [loadReferenceManifest(), loadFullTemplateManifest()]) {
      expect(m.policies).toEqual([]);
      expect(m.hooks).toEqual([]);
    }
  });

  it("emits the same set of policy_packs names as the reference manifest", () => {
    const ref = loadReferenceManifest();
    const full = loadFullTemplateManifest();
    const refNames = ref.policy_packs.map((p) => p.name).sort();
    const fullNames = full.policy_packs.map((p) => p.name).sort();
    expect(fullNames).toEqual(refNames);
  });

  it("matches the reference on each policy_pack's source / enabled / config", () => {
    const ref = loadReferenceManifest();
    const full = loadFullTemplateManifest();
    const refByName = new Map(ref.policy_packs.map((p) => [p.name, p]));
    for (const pack of full.policy_packs) {
      const counterpart = refByName.get(pack.name);
      expect(counterpart).toBeDefined();
      if (!counterpart) continue;
      expect({
        source: pack.source,
        enabled: pack.enabled,
        config: pack.config,
      }).toEqual({
        source: counterpart.source,
        enabled: counterpart.enabled,
        config: counterpart.config,
      });
    }
  });
});
