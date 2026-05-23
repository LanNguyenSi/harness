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
const failingProbe = () => null;

describe("checkPolicyPackVersions — understanding-before-execution", () => {
  it("missing min_version is silent (legacy manifest)", () => {
    const m = manifestWith([{ name: "understanding-before-execution" }]);
    expect(checkPolicyPackVersions(m, probe("0.0.0"))).toEqual([]);
  });

  it("installed version at the floor is silent", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", min_version: "0.3.1" },
    ]);
    expect(checkPolicyPackVersions(m, probe("understanding-gate 0.3.1"))).toEqual([]);
  });

  it("installed version above the floor is silent", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", min_version: "0.3.1" },
    ]);
    expect(checkPolicyPackVersions(m, probe("understanding-gate 0.5.0"))).toEqual([]);
  });

  it("installed version below the floor surfaces a below_floor gap", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", min_version: "0.25.0" },
    ]);
    const gaps = checkPolicyPackVersions(m, probe("understanding-gate 0.24.0"));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      packIndex: 0,
      packName: "understanding-before-execution",
      declaredMinVersion: "0.25.0",
      actualVersion: "0.24.0",
      kind: "below_floor",
    });
    expect(gaps[0]?.message).toMatch(/0\.24\.0/);
    expect(gaps[0]?.message).toMatch(/0\.25\.0/);
  });

  it("probe returning null surfaces a probe_failed gap (binary missing)", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", min_version: "0.25.0" },
    ]);
    const gaps = checkPolicyPackVersions(m, failingProbe);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("probe_failed");
    expect(gaps[0]?.actualVersion).toBeNull();
    expect(gaps[0]?.versionCommand).toEqual(["understanding-gate", "--version"]);
  });

  it("probe stdout without a parseable version surfaces a parse_failed gap", () => {
    const m = manifestWith([
      { name: "understanding-before-execution", min_version: "0.25.0" },
    ]);
    const gaps = checkPolicyPackVersions(m, probe("understanding-gate: command not found"));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("parse_failed");
  });
});

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
        name: "understanding-before-execution",
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
    const m = manifestWith([
      { name: "understanding-before-execution", min_version: "99.0.0" },
      { name: "branch-protection", min_version: "1.0.0" },
    ]);
    const gaps = checkPolicyPackVersions(m, probe("understanding-gate 0.3.1"));
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.packName).toBe("understanding-before-execution");
    expect(gaps[0]?.kind).toBe("below_floor");
    expect(gaps[1]?.packName).toBe("branch-protection");
    expect(gaps[1]?.kind).toBe("no_probe_registered");
  });
});
