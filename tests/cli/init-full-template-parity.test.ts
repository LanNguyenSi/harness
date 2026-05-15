import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// Drift guard: the policy + policy_packs sections of FULL_TEMPLATE (emitted
// by `harness init --template full`) must stay in lockstep with
// docs/examples/full-manifest.yaml (the schema-coverage reference, golden-
// tested by tests/cli/describe.test.ts).
//
// The two manifests are intentionally different elsewhere:
//   - tools.mcp commands (FULL_TEMPLATE uses published npm bins;
//     full-manifest.yaml uses local Pandora checkout paths)
//   - hook commands (FULL_TEMPLATE routes through `harness policy intercept`;
//     full-manifest.yaml exercises the external-script shape)
//   - full-manifest.yaml carries workflows, review_templates, audit blocks
//     that FULL_TEMPLATE intentionally omits.
//
// So the guard scopes to what the task author cared about: policy
// definitions and the policy_packs block. A new example policy added to
// one manifest forces the same addition to the other, with the same
// trigger / requires / enforcement.

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

type LoadBearingPolicy = {
  name: string;
  triggerEvent: string;
  triggerMatch: string | undefined;
  triggerBashMatch: string | undefined;
  triggerPathMatch: string | undefined;
  triggerExtract: Record<string, string> | undefined;
  ledgerTag: string;
  within: string | undefined;
  countMin: number | undefined;
  countExact: number | undefined;
  countMax: number | undefined;
  enforcement: string;
  hook: string;
};

function loadBearing(p: Manifest["policies"][number]): LoadBearingPolicy {
  return {
    name: p.name,
    triggerEvent: p.trigger.event,
    triggerMatch: p.trigger.match ?? undefined,
    triggerBashMatch: p.trigger.bash_match ?? undefined,
    triggerPathMatch: p.trigger.path_match ?? undefined,
    triggerExtract: p.trigger.extract,
    ledgerTag: p.requires.ledger_tag,
    within: p.requires.within ?? undefined,
    countMin: p.requires.count?.min ?? undefined,
    countExact: p.requires.count?.exact ?? undefined,
    countMax: p.requires.count?.max ?? undefined,
    enforcement: p.enforcement,
    hook: p.hook,
  };
}

describe("FULL_TEMPLATE ↔ docs/examples/full-manifest.yaml — drift guard", () => {
  it("emits the same set of policy names as the reference manifest", () => {
    const ref = loadReferenceManifest();
    const full = loadFullTemplateManifest();
    const refNames = ref.policies.map((p) => p.name).sort();
    const fullNames = full.policies.map((p) => p.name).sort();
    expect(fullNames).toEqual(refNames);
  });

  it("matches the reference on each policy's load-bearing fields", () => {
    const ref = loadReferenceManifest();
    const full = loadFullTemplateManifest();
    const refByName = new Map(ref.policies.map((p) => [p.name, p]));
    for (const policy of full.policies) {
      const counterpart = refByName.get(policy.name);
      expect(
        counterpart,
        `policy ${policy.name} in FULL_TEMPLATE has no counterpart in full-manifest.yaml`,
      ).toBeDefined();
      if (!counterpart) continue;
      expect(loadBearing(policy)).toEqual(loadBearing(counterpart));
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
