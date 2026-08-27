import { describe, expect, it } from "vitest";
import {
  AUTO_APPROVED_BY_PREFIX,
  CLAUDE_CODE_HARNESS,
  autoApprovedByFor,
  autoApprovedLedgerTagFor,
  parseAutoApprove,
  parseAutoApprovedBy,
  permissionModeAllowed,
} from "../../src/policy-packs/builtin/understanding-before-execution/auto-approve.js";

function fakeStderr() {
  const lines: string[] = [];
  return { stderr: { write: (s: string) => void lines.push(s) }, lines };
}

describe("parseAutoApprove", () => {
  it("accepts a well-formed block", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ when: ["bypassPermissions"], require_report: true }, stderr);
    expect(cfg).toEqual({ when: ["bypassPermissions"] });
    expect(lines).toEqual([]);
  });

  it("returns null silently for undefined (not opted in)", () => {
    const { stderr, lines } = fakeStderr();
    expect(parseAutoApprove(undefined, stderr)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("returns null silently for null (not opted in)", () => {
    const { stderr, lines } = fakeStderr();
    expect(parseAutoApprove(null, stderr)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("returns null and warns for a non-object", () => {
    const { stderr, lines } = fakeStderr();
    expect(parseAutoApprove("nope", stderr)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/config\.auto_approve/);
  });

  it("returns null and warns for an array", () => {
    const { stderr, lines } = fakeStderr();
    expect(parseAutoApprove(["bypassPermissions"], stderr)).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("returns null and warns for an unknown key", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove(
      { when: ["bypassPermissions"], require_report: true, mode: "auto" },
      stderr,
    );
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/mode/);
  });

  it("returns null and warns for a missing when", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ require_report: true }, stderr);
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/auto_approve\.when/);
  });

  it("returns null and warns for an empty when (require_report:false is a schema error test's runtime counterpart)", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ when: [], require_report: true }, stderr);
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/auto_approve\.when/);
  });

  it("returns null and warns for a non-string when entry", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ when: [1], require_report: true }, stderr);
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("returns null and warns for an empty-string when entry", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ when: [""], require_report: true }, stderr);
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("returns null and warns when require_report is false", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ when: ["bypassPermissions"], require_report: false }, stderr);
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/require_report/);
  });

  it("returns null and warns when require_report is missing", () => {
    const { stderr, lines } = fakeStderr();
    const cfg = parseAutoApprove({ when: ["bypassPermissions"] }, stderr);
    expect(cfg).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/require_report/);
  });

  it("returns null with no stderr argument (no throw)", () => {
    expect(parseAutoApprove({ when: [""], require_report: true })).toBeNull();
  });
});

describe("autoApprovedByFor / parseAutoApprovedBy round trip", () => {
  it("round-trips harness and mode", () => {
    const value = autoApprovedByFor(CLAUDE_CODE_HARNESS, "bypassPermissions");
    expect(value).toBe("auto-mode:claude-code:bypassPermissions");
    expect(value.startsWith(AUTO_APPROVED_BY_PREFIX)).toBe(true);
    expect(parseAutoApprovedBy(value)).toEqual({
      harness: "claude-code",
      mode: "bypassPermissions",
    });
  });

  it("tolerates a trailing ;delegated:<sid> suffix", () => {
    const value = "auto-mode:claude-code:bypassPermissions;delegated:parent-session-123";
    expect(parseAutoApprovedBy(value)).toEqual({
      harness: "claude-code",
      mode: "bypassPermissions",
    });
  });

  it("rejects a plain non-prefixed string", () => {
    expect(parseAutoApprovedBy("harness-approve-cli")).toBeNull();
  });

  it("rejects a bare prefix with nothing after it", () => {
    expect(parseAutoApprovedBy("auto-mode:")).toBeNull();
  });

  it("rejects a prefix with an empty mode segment", () => {
    expect(parseAutoApprovedBy("auto-mode:claude-code:")).toBeNull();
  });

  it("rejects an uppercase prefix (case-sensitive)", () => {
    expect(parseAutoApprovedBy("AUTO-MODE:claude-code:bypassPermissions")).toBeNull();
  });

  it("rejects a non-string input", () => {
    expect(parseAutoApprovedBy(undefined)).toBeNull();
    expect(parseAutoApprovedBy(42)).toBeNull();
  });
});

describe("autoApprovedLedgerTagFor", () => {
  it("builds the understanding-auto-approved:<sid> tag", () => {
    expect(autoApprovedLedgerTagFor("sess-1")).toBe("understanding-auto-approved:sess-1");
  });
});

describe("permissionModeAllowed", () => {
  const cfg = { when: ["bypassPermissions"] };

  it("allows an exact allowlisted mode", () => {
    expect(permissionModeAllowed(cfg, "bypassPermissions")).toBe(true);
  });

  it.each([
    ["default", "default"],
    ["acceptEdits", "acceptEdits"],
    ["plan", "plan"],
    ["empty string", ""],
    ["undefined", undefined],
    ["uppercase (no case folding)", "BYPASSPERMISSIONS"],
    ["substring superset (no substring matching)", "bypassPermissionsX"],
  ])("rejects %s", (_label, mode) => {
    expect(permissionModeAllowed(cfg, mode)).toBe(false);
  });

  it("rejects when cfg is null regardless of mode", () => {
    expect(permissionModeAllowed(null, "bypassPermissions")).toBe(false);
  });
});
