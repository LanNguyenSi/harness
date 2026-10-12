import { describe, expect, it } from "vitest";
import { parseManifestWithWarnings, remapDiagnosticPath, runAssetChecks } from "../../src/index.js";

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
};

describe("package root: index remap after a dropped entry", () => {
  it("maps a runAssetChecks diagnostic back to the policy_packs index as written", () => {
    const parsed = parseManifestWithWarnings({
      version: 1,
      policy_packs: [{ name: "post-merge-gate" }, { name: "not-a-real-pack" }],
    });
    expect(parsed.indexMaps).toEqual({ policy_packs: { kept: [1], originalLength: 2 } });
    const paths = runAssetChecks(parsed.manifest, NOOP_PROBES)
      .filter((d) => d.message.includes("not a known builtin pack"))
      .map((d) => d.path);
    expect(paths).toEqual(["policy_packs[0].name"]);
    expect(paths.map((p) => remapDiagnosticPath(p, parsed.indexMaps))).toEqual(["policy_packs[1].name"]);
  });

  it("leaves a path unchanged when nothing was dropped", () => {
    const parsed = parseManifestWithWarnings({ version: 1, policy_packs: [{ name: "not-a-real-pack" }] });
    expect(parsed.indexMaps).toBeUndefined();
    expect(remapDiagnosticPath("policy_packs[0].name", parsed.indexMaps)).toBe("policy_packs[0].name");
  });
});
