import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/schema/index.js";
import {
  ACK_TAG_PREFIX,
  DEFAULT_PROTECTED_BRANCHES,
  isProtectedBranch,
  NON_PROTECTED_TAG_PREFIX,
  PACK_NAME,
  PRODUCER_FRESHNESS_MS,
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
  it("exposes the canonical tag prefixes and pack name", () => {
    expect(PACK_NAME).toBe("branch-protection");
    expect(NON_PROTECTED_TAG_PREFIX).toBe("branch:non-protected");
    expect(ACK_TAG_PREFIX).toBe("branch-protection-ack");
  });

  it("uses a 5-minute freshness window", () => {
    expect(PRODUCER_FRESHNESS_MS).toBe(5 * 60 * 1000);
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

  it("returns false for a feature branch", () => {
    expect(isProtectedBranch("feat/cool-thing", list)).toBe(false);
    expect(isProtectedBranch("develop", list)).toBe(false);
  });

  it("treats an empty branch (detached HEAD) as protected", () => {
    // We can't audit-by-name what the agent is about to commit; refuse
    // to declare it safe.
    expect(isProtectedBranch("", list)).toBe(true);
  });
});
