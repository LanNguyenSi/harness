import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require("../.dependency-cruiser.cjs");

// Ratchet test (task 9bc0d546): no rule in .dependency-cruiser.cjs may use a
// `to.pathNot` exemption. `to.pathNot` is the grandfather shape this repo
// deliberately moved away from (structural-concentration slice 4,
// agent-tasks 61a37b25, replaced per-file target exemptions with a real
// relocation instead); this test exists so that shape cannot silently
// creep back in on a future rule. The two known src/io upward-import
// exceptions (src/io/claude-mcp.ts, src/io/ledger-record.ts) use a
// documented `from.pathNot` exemption instead, which this test does not
// forbid -- `from.pathNot` narrows which SOURCE files a rule applies to
// (an explicit, reviewable allowlist of exempted files), not which target
// paths a rule silently stops checking.
//
// Mutation-verified (M2, task 9bc0d546): temporarily adding `pathNot: "x"` to
// the `to` clause of an existing rule (e.g. schema-no-upward-imports)
// turns this test red; removing it turns it green again.
describe("dependency-cruiser config ratchet", () => {
  it("has no rule with a to.pathNot exemption", () => {
    const offenders = (config.forbidden as Array<{ name: string; to?: { pathNot?: unknown } }>)
      .filter((rule) => rule.to && Object.prototype.hasOwnProperty.call(rule.to, "pathNot"))
      .map((rule) => rule.name);
    expect(offenders).toEqual([]);
  });

  it("names exactly the two known io-no-upward-imports exemptions via from.pathNot", () => {
    const rule = (config.forbidden as Array<{ name: string; from?: { pathNot?: unknown } }>).find(
      (r) => r.name === "io-no-upward-imports",
    );
    expect(rule).toBeDefined();
    expect(rule?.from?.pathNot).toBe("^src/io/(claude-mcp|ledger-record)\\.ts$");
  });
});
