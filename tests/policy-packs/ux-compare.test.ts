import { describe, expect, it } from "vitest";
import { safeParseUx, uxEqual } from "../../src/policy-packs/ux-compare.js";
import type { PolicyUx } from "../../src/schema/index.js";

const UX_A: PolicyUx = {
  cannot: "You cannot edit files on a protected branch yet.",
  required: ["a checkout of a non-protected branch"],
  run: ["step one", "step two"],
};

describe("uxEqual", () => {
  it("is true for structurally identical objects (fresh instances)", () => {
    expect(uxEqual(UX_A, { ...UX_A, run: [...UX_A.run] })).toBe(true);
  });

  it("is false when `cannot` differs", () => {
    expect(uxEqual(UX_A, { ...UX_A, cannot: "different" })).toBe(false);
  });

  it("is false when `required` differs", () => {
    expect(uxEqual(UX_A, { ...UX_A, required: ["different"] })).toBe(false);
  });

  it("is false when `run` differs by content", () => {
    expect(uxEqual(UX_A, { ...UX_A, run: ["step one", "step TWO"] })).toBe(false);
  });

  it("is false when `run` differs by order (order is meaningful, agent reads it top to bottom)", () => {
    expect(uxEqual(UX_A, { ...UX_A, run: [...UX_A.run].reverse() })).toBe(false);
  });

  it("is false when `run` differs by length", () => {
    expect(uxEqual(UX_A, { ...UX_A, run: [UX_A.run[0]!] })).toBe(false);
  });
});

describe("safeParseUx", () => {
  it("parses a valid ux object", () => {
    expect(safeParseUx(UX_A)).toEqual(UX_A);
  });

  it("returns null for a malformed value (missing required field)", () => {
    expect(safeParseUx({ cannot: "x" })).toBeNull();
  });

  it("returns null for a non-object value", () => {
    expect(safeParseUx("not an object")).toBeNull();
    expect(safeParseUx(undefined)).toBeNull();
  });
});
