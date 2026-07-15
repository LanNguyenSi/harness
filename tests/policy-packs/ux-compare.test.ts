import { describe, expect, it } from "vitest";
import {
  producersEqual,
  safeParseProducers,
  safeParseUx,
  uxEqual,
} from "../../src/policy-packs/ux-compare.js";
import type { PolicyUx, Producer } from "../../src/schema/index.js";

const UX_A: PolicyUx = {
  cannot: "You cannot use write-capable tools yet.",
  required: ["an approved Understanding Report for this session"],
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

const ASK: Producer = {
  kind: "ask",
  command: "harness approve understanding",
  description: "d1",
};
const BASH: Producer = {
  kind: "bash",
  command: "harness approve understanding",
  description: "d2",
};
const MCP: Producer = {
  kind: "mcp",
  verb: "mcp__agent-grounding__ledger_add",
  example: '{sessionId:"x"}',
  description: "d3",
};

describe("producersEqual", () => {
  it("is true for structurally identical arrays (fresh instances)", () => {
    expect(producersEqual([ASK, BASH], [{ ...ASK }, { ...BASH }])).toBe(true);
  });

  it("is false when array lengths differ", () => {
    expect(producersEqual([ASK, BASH], [ASK])).toBe(false);
  });

  it("is false when the `kind` at a position differs", () => {
    expect(producersEqual([ASK], [BASH])).toBe(false);
  });

  it("is false when an `ask`/`bash` field differs", () => {
    expect(producersEqual([ASK], [{ ...ASK, command: "different" }])).toBe(false);
    expect(producersEqual([BASH], [{ ...BASH, description: "different" }])).toBe(false);
  });

  it("is false when an `mcp` field differs", () => {
    expect(producersEqual([MCP], [{ ...MCP, verb: "different" }])).toBe(false);
  });

  it("is order-sensitive", () => {
    expect(producersEqual([ASK, BASH], [BASH, ASK])).toBe(false);
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

describe("safeParseProducers", () => {
  it("parses a valid producers array", () => {
    expect(safeParseProducers([ASK, BASH])).toEqual([ASK, BASH]);
  });

  it("returns null for a malformed entry (unknown kind)", () => {
    expect(safeParseProducers([{ kind: "unknown", command: "x" }])).toBeNull();
  });

  it("returns null for a non-array value", () => {
    expect(safeParseProducers({})).toBeNull();
  });
});
