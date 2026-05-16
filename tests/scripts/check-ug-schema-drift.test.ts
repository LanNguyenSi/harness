import { describe, expect, it } from "vitest";
import {
  diffKeys,
  extractUpstreamSectionKeys,
  labelToCamelKey,
} from "../../scripts/check-ug-schema-drift.mjs";

describe("labelToCamelKey", () => {
  it("strips a trailing (kind) hint and camel-cases the rest", () => {
    expect(labelToCamelKey("Current Understanding (paragraph)")).toBe("currentUnderstanding");
    expect(labelToCamelKey("Verification Plan (list)")).toBe("verificationPlan");
    expect(labelToCamelKey("Out Of Scope (list)")).toBe("outOfScope");
  });

  it("handles labels without a kind annotation", () => {
    expect(labelToCamelKey("Assumptions")).toBe("assumptions");
    expect(labelToCamelKey("Open Questions")).toBe("openQuestions");
  });
});

describe("extractUpstreamSectionKeys", () => {
  it("returns the keys inside `const SECTIONS = [...]` in declaration order", () => {
    const fixture = `
const SECTIONS = [
  { key: "currentUnderstanding", kind: "paragraph", aliases: ["my current understanding"] },
  { key: "intendedOutcome", kind: "paragraph", aliases: ["intended outcome"] },
  { key: "derivedTodos", kind: "list", aliases: ["todos"] },
];
const BULLET_TABLE = [
  { prefix: /^x/, key: "shouldBeIgnored" },
];
`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual([
      "currentUnderstanding",
      "intendedOutcome",
      "derivedTodos",
    ]);
  });

  it("does NOT pick up `key: \"...\"` matches outside the SECTIONS array", () => {
    // The real parser.js has a fast_confirm bullet-prefix table further
    // down the file with its own `key: "..."` entries. Without bracket-
    // balanced slicing the extractor would over-count.
    const fixture = `
const SECTIONS = [
  { key: "currentUnderstanding", kind: "paragraph" },
];
const FAST_CONFIRM_PREFIXES = [
  { prefix: /^a/, key: "extraKey1" },
  { prefix: /^b/, key: "extraKey2" },
];
`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["currentUnderstanding"]);
  });

  it("throws when SECTIONS declaration is missing (layout drift signal)", () => {
    expect(() => extractUpstreamSectionKeys("// no SECTIONS here")).toThrow(/parser.js layout changed/);
  });

  it("handles nested arrays inside SECTIONS entries (aliases: [...])", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["x", "y"] },
  { key: "b", aliases: ["z"] },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });
});

describe("diffKeys", () => {
  it("returns null on identical lists in identical order", () => {
    expect(diffKeys(["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });

  it("flags an order mismatch when sets are equal but sequence differs", () => {
    const diff = diffKeys(["a", "b", "c"], ["c", "b", "a"]);
    expect(diff).not.toBeNull();
    expect(diff!.orderMismatch).toBe(true);
    expect(diff!.onlyLocal).toEqual([]);
    expect(diff!.onlyUpstream).toEqual([]);
  });

  it("reports upstream additions (local missing)", () => {
    const diff = diffKeys(["a", "b"], ["a", "b", "c"]);
    expect(diff!.onlyUpstream).toEqual(["c"]);
    expect(diff!.onlyLocal).toEqual([]);
    expect(diff!.orderMismatch).toBe(false);
  });

  it("reports upstream removals (local stale)", () => {
    const diff = diffKeys(["a", "b", "x"], ["a", "b"]);
    expect(diff!.onlyLocal).toEqual(["x"]);
    expect(diff!.onlyUpstream).toEqual([]);
    expect(diff!.orderMismatch).toBe(false);
  });

  it("reports both additions and removals in the same drift", () => {
    const diff = diffKeys(["a", "stale"], ["a", "new"]);
    expect(diff!.onlyLocal).toEqual(["stale"]);
    expect(diff!.onlyUpstream).toEqual(["new"]);
  });
});
