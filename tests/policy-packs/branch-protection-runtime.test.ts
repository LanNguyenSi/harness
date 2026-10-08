import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/schema/index.js";
import * as runtime from "../../src/policy-packs/builtin/branch-protection-runtime.js";
import {
  DEFAULT_PROTECTED_BRANCHES,
  isProtectedBranch,
  PACK_NAME,
  resolveProtectedBranches,
} from "../../src/policy-packs/builtin/branch-protection-runtime.js";

function buildPack(config: Record<string, unknown> = {}): ReturnType<typeof parseManifest>["policy_packs"][number] {
  const manifest = parseManifest({
    version: 1,
    policy_packs: [{ name: PACK_NAME, config }],
  });
  const pack = manifest.policy_packs[0];
  if (!pack) throw new Error("test fixture: pack not present");
  return pack;
}

describe("constants", () => {
  it("exposes the pack name", () => {
    expect(PACK_NAME).toBe("branch-protection");
  });

  it("exports no producer tag, ledger tag, freshness window or override marker (task a4d8adc5)", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "DEFAULT_PROTECTED_BRANCHES",
      "PACK_NAME",
      "isProtectedBranch",
      "resolveProtectedBranches",
    ]);
  });

  it("defaults protected_branches to master/main/develop", () => {
    expect([...DEFAULT_PROTECTED_BRANCHES]).toEqual(["master", "main", "develop"]);
  });
});

describe("resolveProtectedBranches", () => {
  it("returns defaults + no warning when config is empty", () => {
    const r = resolveProtectedBranches(buildPack());
    expect(r.branches).toEqual(["master", "main", "develop"]);
    expect(r.warning).toBeNull();
  });

  it("honors a custom non-empty string array", () => {
    const r = resolveProtectedBranches(
      buildPack({ protected_branches: ["main", "release/*", "production"] }),
    );
    expect(r.branches).toEqual(["main", "release/*", "production"]);
    expect(r.warning).toBeNull();
  });

  it("falls back to defaults + warns when the value is not an array", () => {
    const r = resolveProtectedBranches(buildPack({ protected_branches: "main" }));
    expect(r.branches).toEqual(["master", "main", "develop"]);
    expect(r.warning).toMatch(/expected an array of strings/);
  });

  it("falls back to defaults + warns when every entry is invalid", () => {
    const r = resolveProtectedBranches(
      buildPack({ protected_branches: [123, true, null, ""] }),
    );
    expect(r.branches).toEqual(["master", "main", "develop"]);
    expect(r.warning).toMatch(/every entry was rejected/);
  });

  it("keeps the valid entries + warns when some are invalid", () => {
    const r = resolveProtectedBranches(
      buildPack({ protected_branches: ["main", 42, "develop"] }),
    );
    expect(r.branches).toEqual(["main", "develop"]);
    expect(r.warning).toMatch(/skipped 1 non-string entry/);
  });
});

describe("isProtectedBranch", () => {
  const list = ["master", "main"] as const;

  it("returns true for an exact match", () => {
    expect(isProtectedBranch("master", list)).toBe(true);
    expect(isProtectedBranch("main", list)).toBe(true);
  });

  it("compares case-insensitively, in both directions", () => {
    expect(isProtectedBranch("Master", list)).toBe(true);
    expect(isProtectedBranch("MAIN", list)).toBe(true);
    expect(isProtectedBranch("main", ["MAIN"])).toBe(true);
  });

  it("returns false for a feature branch", () => {
    expect(isProtectedBranch("feat/cool-thing", list)).toBe(false);
    expect(isProtectedBranch("develop", list)).toBe(false);
    expect(isProtectedBranch("master2", list)).toBe(false);
    expect(isProtectedBranch("feat/master", list)).toBe(false);
  });

  it("an empty name matches nothing (the hook never passes one: a detached HEAD is its own outcome)", () => {
    expect(isProtectedBranch("", list)).toBe(false);
  });
});
