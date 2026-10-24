// Parsed-manifest defaults contract (zod 3 -> 4 migration guard).
//
// The manifest schema fills whole-section defaults (`grounding` etc. default
// to `{}` and every leaf carries its own default). Zod 4 changed `.default(x)`
// to short-circuit: the default is returned WITHOUT parsing, so the leaf
// defaults inside it are not applied; the manifest schema therefore uses
// `.prefault(x)` (parse the default) on every object-typed section default.
// A bare `.default({})` there would silently produce `grounding: {}` with no
// session/evidence_ledger keys.
//
// Each case's fixture was captured on the pre-migration build: `input` is the
// raw manifest, `parsed` the full `parseManifest` output under zod 3.25.76.
// The migration is only correct while these deep-equalities hold.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/schema/index.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "manifest-defaults",
);

function fixture(name: string): { input: unknown; parsed: unknown } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

describe("parseManifest - fully defaulted output, captured on zod 3", () => {
  it("minimal manifest { version: 1 } gets every section and leaf default", () => {
    const { input, parsed } = fixture("minimal");
    expect(parseManifest(input)).toEqual(parsed);
  });

  it("omitting `grounding` still yields the defaulted grounding section", () => {
    const { input, parsed } = fixture("omit-grounding");
    expect(parseManifest(input)).toEqual(parsed);
  });

  it("omitting `tools` still yields the defaulted tools section", () => {
    const { input, parsed } = fixture("omit-tools");
    expect(parseManifest(input)).toEqual(parsed);
  });

  it("omitting `memory` still yields the defaulted memory section", () => {
    const { input, parsed } = fixture("omit-memory");
    expect(parseManifest(input)).toEqual(parsed);
  });

  it("omitting `hooks` still yields the empty hooks array", () => {
    const { input, parsed } = fixture("omit-hooks");
    expect(parseManifest(input)).toEqual(parsed);
  });

  it("omitting `policy_packs` still yields the empty policy_packs array", () => {
    const { input, parsed } = fixture("omit-policy_packs");
    expect(parseManifest(input)).toEqual(parsed);
  });

  it("a present-but-empty section is defaulted the same way as an omitted one", () => {
    const m = parseManifest({ version: 1, memory: {} });
    expect(m.memory).toEqual({
      directories: [],
      retention: { staleness_days: 180, broken_refs: "warn" },
      scopes: { default: "project", allowed: ["project"] },
    });
  });

  it("an empty pack entry gets name-independent field defaults", () => {
    const m = parseManifest({ version: 1, policy_packs: [{ name: "p" }] });
    expect(m.policy_packs[0]).toEqual({
      name: "p",
      source: "builtin",
      enabled: true,
      config: {},
    });
  });
});
