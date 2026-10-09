import { describe, expect, it } from "vitest";
import { checkPolicyPackVersions } from "../../src/policy-packs/version-check.js";
import { parseManifest } from "../../src/schema/index.js";

function manifestWith(packs: unknown[]) {
  return parseManifest({
    version: 1,
    policy_packs: packs,
  });
}

const probe = (stdout: string | null) => () => stdout;

describe("checkPolicyPackVersions — branch-protection (no version probe registered)", () => {
  it("missing min_version is silent (no probe to consult anyway)", () => {
    const m = manifestWith([{ name: "branch-protection" }]);
    expect(checkPolicyPackVersions(m, probe("anything"))).toEqual([]);
  });

  it("declared min_version surfaces no_probe_registered (operator expects a floor for a probe-less pack)", () => {
    const m = manifestWith([{ name: "branch-protection", min_version: "1.0.0" }]);
    const gaps = checkPolicyPackVersions(m, probe("anything"));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("no_probe_registered");
    expect(gaps[0]?.versionCommand).toEqual([]);
    expect(gaps[0]?.actualVersion).toBeNull();
  });
});

describe("checkPolicyPackVersions — cross-pack semantics", () => {
  it("disabled packs are not checked even with min_version", () => {
    const m = manifestWith([
      {
        name: "branch-protection",
        enabled: false,
        min_version: "99.0.0",
      },
    ]);
    expect(checkPolicyPackVersions(m, probe("0.0.0"))).toEqual([]);
  });

  it("unknown pack names are skipped (source-check's job)", () => {
    const m = manifestWith([{ name: "no-such-pack", min_version: "1.0.0" }]);
    expect(checkPolicyPackVersions(m, probe("0.0.0"))).toEqual([]);
  });

  it("preserves manifest order across multiple packs with gaps", () => {
    // Two entries of the same probe-less builtin (`branch-protection`:
    // any declared min_version yields a no_probe_registered gap), the
    // second pushed onto the parsed manifest so the schema's duplicate-
    // name rule never sees it. The check must report both gaps in
    // declared order: packIndex [0, 1] carrying declaredMinVersion
    // ["1.0.0", "2.0.0"]. Fails if the walk loses declared order,
    // re-sorts, or miscounts indexes.
    const m = manifestWith([{ name: "branch-protection", min_version: "1.0.0" }]);
    m.policy_packs.push({ ...m.policy_packs[0]!, min_version: "2.0.0" });
    const gaps = checkPolicyPackVersions(m, probe("anything"));
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => g.packIndex)).toEqual([0, 1]);
    expect(gaps.map((g) => g.declaredMinVersion)).toEqual(["1.0.0", "2.0.0"]);
    expect(gaps.map((g) => g.kind)).toEqual(["no_probe_registered", "no_probe_registered"]);
    expect(gaps.map((g) => g.packName)).toEqual(["branch-protection", "branch-protection"]);
  });
});
