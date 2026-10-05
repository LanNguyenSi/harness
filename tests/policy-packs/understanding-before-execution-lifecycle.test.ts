// parseApprovalLifecycle config shapes (task 0c6b2cb9): when no explicit
// expire_on_tool_match is configured the runtime applies the same default
// boundary list the generator emits into the PostToolUse matcher.

import { describe, expect, it } from "vitest";
import { parseApprovalLifecycle } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { DEFAULT_BOUNDARY_TOOL_NAMES } from "../../src/runtime/task-providers/agent-tasks.js";

const DEFAULTS = [...DEFAULT_BOUNDARY_TOOL_NAMES];

function sink(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s) => void lines.push(s), lines };
}

describe("parseApprovalLifecycle: default boundary tools", () => {
  it("undefined block returns the default list, no bash patterns, not legacy", () => {
    const l = parseApprovalLifecycle(undefined);
    expect(l.expireOnToolMatch).toEqual(DEFAULTS);
    expect(l.expireOnToolMatch).toContain("mcp__agent-tasks__task_merge");
    expect(l.expireOnBashMatch).toEqual([]);
    expect(l.legacyMode).toBe(false);
    expect(l.maxAgeMs).toBeUndefined();
  });

  it("null block returns the default list", () => {
    expect(parseApprovalLifecycle(null).expireOnToolMatch).toEqual(DEFAULTS);
  });

  it("returns a fresh array per call (mutating one result cannot leak into the next)", () => {
    const a = parseApprovalLifecycle(undefined);
    a.expireOnToolMatch.push("mutated");
    expect(parseApprovalLifecycle(undefined).expireOnToolMatch).toEqual(DEFAULTS);
    const b = parseApprovalLifecycle({ max_age: "1h" });
    b.expireOnToolMatch.push("mutated");
    expect(parseApprovalLifecycle({ max_age: "1h" }).expireOnToolMatch).toEqual(DEFAULTS);
  });

  it.each([["a string", "session"], ["a number", 7], ["an array", ["x"]]])(
    "a non-object block (%s) returns the default list and warns",
    (_label, raw) => {
      const err = sink();
      const l = parseApprovalLifecycle(raw, err);
      expect(l.expireOnToolMatch).toEqual(DEFAULTS);
      expect(l.legacyMode).toBe(false);
      expect(err.lines.join("")).toMatch(/approval_lifecycle ignored/);
    },
  );

  it("an empty object returns the default list", () => {
    expect(parseApprovalLifecycle({}).expireOnToolMatch).toEqual(DEFAULTS);
  });

  it("a max_age-only block keeps the default list and parses max_age", () => {
    const l = parseApprovalLifecycle({ max_age: "4h" });
    expect(l.expireOnToolMatch).toEqual(DEFAULTS);
    expect(l.maxAgeMs).toBe(4 * 60 * 60 * 1000);
  });

  it("an expire_on_bash_match-only block keeps the default list and compiles the patterns", () => {
    const l = parseApprovalLifecycle({ expire_on_bash_match: ["^gh pr merge\\b"] });
    expect(l.expireOnToolMatch).toEqual(DEFAULTS);
    expect(l.expireOnBashMatch).toHaveLength(1);
    expect(l.expireOnBashMatch[0]!.test("gh pr merge 5")).toBe(true);
  });

  it("an explicit list is used as given (the default is not merged in)", () => {
    const l = parseApprovalLifecycle({ expire_on_tool_match: ["mcp__agent-tasks__task_finish", "", 3] });
    expect(l.expireOnToolMatch).toEqual(["mcp__agent-tasks__task_finish"]);
  });

  it("an explicit empty list stays empty", () => {
    expect(parseApprovalLifecycle({ expire_on_tool_match: [] }).expireOnToolMatch).toEqual([]);
  });

  it("a malformed expire_on_tool_match falls back to the default list and warns", () => {
    const err = sink();
    const l = parseApprovalLifecycle({ expire_on_tool_match: "task_merge" }, err);
    expect(l.expireOnToolMatch).toEqual(DEFAULTS);
    expect(err.lines.join("")).toMatch(/expire_on_tool_match ignored \(expected string\[\], got string\)/);
  });

  it("mode: session has no tool or bash boundary, keeps max_age, and is legacy", () => {
    const l = parseApprovalLifecycle({ mode: "session", max_age: "2h", expire_on_tool_match: ["x"] });
    expect(l.expireOnToolMatch).toEqual([]);
    expect(l.expireOnBashMatch).toEqual([]);
    expect(l.legacyMode).toBe(true);
    expect(l.maxAgeMs).toBe(2 * 60 * 60 * 1000);
  });
});
