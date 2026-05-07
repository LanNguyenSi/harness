import { describe, expect, it } from "vitest";
import { parsePackSource } from "../../src/policy-packs/source.js";

describe("parsePackSource", () => {
  it("classifies the literal 'builtin' as kind 'builtin'", () => {
    expect(parsePackSource("builtin")).toEqual({ kind: "builtin", raw: "builtin" });
  });

  it("classifies any other string as kind 'unknown'", () => {
    for (const raw of ["path:./foo", "npm:@scope/pack@1.0.0", "git:https://x.git", "BUILTIN", ""]) {
      const result = parsePackSource(raw);
      expect(result.kind).toBe("unknown");
      expect(result.raw).toBe(raw);
    }
  });
});
