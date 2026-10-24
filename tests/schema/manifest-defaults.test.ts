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
// The migration is only correct while the JSON encodings stay byte-identical:
// `JSON.stringify` compares key ORDER and the absence of keys whose value is
// `undefined`, both of which `toEqual` ignores and both of which a consumer
// that embeds the parsed manifest in a YAML/JSON document observes.
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

/** Byte identity of the JSON encoding: key order, key set, no undefined values. */
function expectByteIdentical(name: string): void {
  const { input, parsed } = fixture(name);
  expect(JSON.stringify(parseManifest(input))).toBe(JSON.stringify(parsed));
}

describe("parseManifest - fully defaulted output, captured on zod 3", () => {
  it("minimal manifest { version: 1 } gets every section and leaf default", () => {
    expectByteIdentical("minimal");
  });

  it("omitting `grounding` still yields the defaulted grounding section", () => {
    expectByteIdentical("omit-grounding");
  });

  it("omitting `tools` still yields the defaulted tools section", () => {
    expectByteIdentical("omit-tools");
  });

  it("omitting `memory` still yields the defaulted memory section", () => {
    expectByteIdentical("omit-memory");
  });

  it("omitting `hooks` still yields the empty hooks array", () => {
    expectByteIdentical("omit-hooks");
  });

  it("omitting `policy_packs` still yields the empty policy_packs array", () => {
    expectByteIdentical("omit-policy_packs");
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
