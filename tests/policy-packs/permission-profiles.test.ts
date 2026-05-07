import { describe, expect, it } from "vitest";
import {
  HIGH_RISK_GRILL_ME,
  IMPLEMENTATION_AFTER_APPROVAL,
  KNOWN_PROFILE_NAMES,
  SAFE_START,
  isKnownProfileName,
  resolveProfile,
} from "../../src/policy-packs/builtin/permission-profiles.js";
import {
  _internalPatternMap,
  profileToSettingsPermissions,
} from "../../src/policy-packs/permission-translator.js";

describe("isKnownProfileName + KNOWN_PROFILE_NAMES", () => {
  it("returns true for the three v1 builtin profiles", () => {
    expect(isKnownProfileName("safe-start")).toBe(true);
    expect(isKnownProfileName("implementation-after-approval")).toBe(true);
    expect(isKnownProfileName("high-risk-grill-me")).toBe(true);
  });

  it("rejects unknown names", () => {
    expect(isKnownProfileName("custom-profile")).toBe(false);
    expect(isKnownProfileName("")).toBe(false);
  });

  it("KNOWN_PROFILE_NAMES contains exactly the three v1 profiles", () => {
    expect([...KNOWN_PROFILE_NAMES].sort()).toEqual([
      "high-risk-grill-me",
      "implementation-after-approval",
      "safe-start",
    ]);
  });
});

describe("resolveProfile", () => {
  it("returns the SAFE_START profile object", () => {
    expect(resolveProfile("safe-start")).toBe(SAFE_START);
  });

  it("returns IMPLEMENTATION_AFTER_APPROVAL", () => {
    expect(resolveProfile("implementation-after-approval")).toBe(
      IMPLEMENTATION_AFTER_APPROVAL,
    );
  });

  it("returns HIGH_RISK_GRILL_ME", () => {
    expect(resolveProfile("high-risk-grill-me")).toBe(HIGH_RISK_GRILL_ME);
  });

  it("returns null for unknown profile names", () => {
    expect(resolveProfile("ghost-profile")).toBeNull();
  });
});

describe("profileToSettingsPermissions — safe-start", () => {
  const result = profileToSettingsPermissions(SAFE_START);

  it("opens read-only tools (Read/Glob/Grep)", () => {
    expect(result.allow).toEqual(["Glob", "Grep", "Read"]);
  });

  it("asks for Edit/Write/MultiEdit + Bash", () => {
    expect(result.ask).toContain("Edit");
    expect(result.ask).toContain("Write");
    expect(result.ask).toContain("MultiEdit");
    expect(result.ask).toContain("Bash");
  });

  it("denies commit / push / pr / deploy patterns", () => {
    expect(result.deny).toContain("Bash(git commit*)");
    expect(result.deny).toContain("Bash(git push*)");
    expect(result.deny).toContain("mcp__agent-tasks__pull_requests_create");
    expect(result.deny).toContain("Bash(kubectl*)");
    expect(result.deny).toContain("Bash(terraform destroy*)");
  });
});

describe("profileToSettingsPermissions — implementation-after-approval", () => {
  const result = profileToSettingsPermissions(IMPLEMENTATION_AFTER_APPROVAL);

  it("allows Edit/Write/MultiEdit (post-approval working profile)", () => {
    expect(result.allow).toContain("Edit");
    expect(result.allow).toContain("Write");
    expect(result.allow).toContain("MultiEdit");
    expect(result.allow).toContain("Read");
  });

  it("asks for Bash + commit/push/pr (still gated)", () => {
    expect(result.ask).toContain("Bash");
    expect(result.ask).toContain("Bash(git commit*)");
    expect(result.ask).toContain("Bash(git push*)");
    expect(result.ask).toContain("mcp__agent-tasks__pull_requests_create");
  });

  it("denies deploy patterns", () => {
    expect(result.deny).toContain("Bash(kubectl*)");
    expect(result.deny).toContain("Bash(terraform destroy*)");
  });
});

describe("profileToSettingsPermissions — high-risk-grill-me", () => {
  const result = profileToSettingsPermissions(HIGH_RISK_GRILL_ME);

  it("asks Edit + Bash even on the high-friction profile", () => {
    expect(result.ask).toContain("Edit");
    expect(result.ask).toContain("Bash");
  });

  it("denies commit / push / deploy outright", () => {
    expect(result.deny).toContain("Bash(git commit*)");
    expect(result.deny).toContain("Bash(git push*)");
    expect(result.deny).toContain("Bash(kubectl*)");
  });
});

describe("profileToSettingsPermissions — fallbacks for limited / ask_or_deny", () => {
  it("collapses 'limited' onto ask (v1 fallback)", () => {
    const r = profileToSettingsPermissions({
      actions: { bash: { allow: "limited" } },
    });
    expect(r.ask).toContain("Bash");
    expect(r.allow).toEqual([]);
    expect(r.deny).toEqual([]);
  });

  it("collapses 'ask_or_deny' onto ask (v1 fallback)", () => {
    const r = profileToSettingsPermissions({
      actions: { edit: { allow: "ask_or_deny" } },
    });
    expect(r.ask).toContain("Edit");
  });
});

describe("permission action → tool pattern mapping", () => {
  it("covers all 7 action keys with non-empty pattern lists", () => {
    const map = _internalPatternMap();
    for (const key of Object.keys(map)) {
      expect(map[key as keyof typeof map].length).toBeGreaterThan(0);
    }
  });
});
