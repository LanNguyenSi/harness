import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  validateBeforeWrite,
} from "../../src/io/validate-before-write.js";

const VALID_MIN: unknown = {
  version: 1,
};

describe("validateBeforeWrite", () => {
  it("accepts a minimal valid manifest", () => {
    const r = validateBeforeWrite(VALID_MIN);
    expect(r).toEqual({ ok: true });
  });

  it("rejects an unknown top-level key in strict mode", () => {
    const r = validateBeforeWrite({ version: 1, weird: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /weird/.test(e.path) || /weird/.test(e.message))).toBe(true);
    }
  });

  it("rejects a manifest with a duplicate mcp[].name (Phase 2 #1 acceptance criterion)", () => {
    const r = validateBeforeWrite({
      version: 1,
      tools: {
        mcp: [
          { name: "codebase-oracle", command: "/bin/true" },
          { name: "codebase-oracle", command: "/bin/true" },
        ],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a manifest with a duplicate hook name", () => {
    const r = validateBeforeWrite({
      version: 1,
      hooks: [
        { name: "h", event: "PreToolUse", command: "/bin/true", blocking: false },
        { name: "h", event: "PreToolUse", command: "/bin/true", blocking: false },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a policy referencing a missing hook", () => {
    const r = validateBeforeWrite({
      version: 1,
      hooks: [{ name: "h", event: "PreToolUse", command: "/bin/true", blocking: false }],
      policies: [
        {
          name: "p",
          description: "x",
          trigger: { event: "PreToolUse", match: "Bash" },
          requires: { ledger_tag: "x" },
          hook: "missing-hook",
          enforcement: "block",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("formats errors with leading two-space indent", () => {
    const r = validateBeforeWrite({ version: 99 });
    if (!r.ok) {
      const out = formatValidationErrors(r.errors);
      expect(out.startsWith("  ")).toBe(true);
    }
  });
});

describe("validateBeforeWrite — friendly version message propagation (task 50a94127)", () => {
  it("surfaces the upgrade guidance on the write path (add/adopt/init consumers)", () => {
    const r = validateBeforeWrite({ version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = formatValidationErrors(r.errors);
      expect(text).toMatch(/this CLI supports manifest version 1/);
      expect(text).toMatch(/npm i -g @lannguyensi\/harness/);
      expect(text).not.toMatch(/Invalid literal/);
    }
  });
});
