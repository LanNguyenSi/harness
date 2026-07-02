import { describe, expect, it } from "vitest";
import { mergeSettings, summarizeMerge } from "../../src/io/merge-settings.js";

describe("mergeSettings", () => {
  it("replaces owned keys, preserves the rest", () => {
    const r = mergeSettings(
      { env: { FOO: "1" }, hooks: { old: 1 }, permissions: { allow: ["x"] } },
      { hooks: { new: 1 } },
    );
    expect(r.merged).toEqual({
      env: { FOO: "1" },
      hooks: { new: 1 },
      permissions: { allow: ["x"] },
    });
    expect(r.replacedKeys).toEqual(["hooks"]);
    expect(r.preservedKeys.sort()).toEqual(["env", "permissions"]);
    expect(r.addedKeys).toEqual([]);
  });

  it("creates owned keys when target lacks them", () => {
    const r = mergeSettings({ env: { FOO: "1" } }, { hooks: { x: 1 } });
    expect(r.merged).toEqual({ env: { FOO: "1" }, hooks: { x: 1 } });
    expect(r.replacedKeys).toEqual([]);
    expect(r.preservedKeys).toEqual(["env"]);
    expect(r.addedKeys).toEqual(["hooks"]);
  });

  it("with null existing returns the generated object verbatim", () => {
    const r = mergeSettings(null, { hooks: { x: 1 } });
    expect(r.merged).toEqual({ hooks: { x: 1 } });
    expect(r.addedKeys).toEqual(["hooks"]);
    expect(r.preservedKeys).toEqual([]);
  });

  it("preserves existing key order, appends new generated keys at the end", () => {
    const r = mergeSettings({ a: 1, b: 2, c: 3 }, { b: 99, d: 4 });
    expect(Object.keys(r.merged)).toEqual(["a", "b", "c", "d"]);
  });

  it("idempotent on second invocation against the merged output", () => {
    const generated = { hooks: { x: 1 } };
    const r1 = mergeSettings({ env: { FOO: "1" } }, generated);
    const r2 = mergeSettings(r1.merged, generated);
    expect(r2.merged).toEqual(r1.merged);
  });
});

describe("mergeSettings — mcpServers deep merge (task 059b669c)", () => {
  it("operator-added server survives; harness-declared name wins", () => {
    const r = mergeSettings(
      {
        mcpServers: {
          "harness-declared": { command: "old-binary" },
          "operator-own": { command: "my-server", args: ["--port", "9"] },
        },
      },
      { mcpServers: { "harness-declared": { command: "new-binary" } } },
    );
    expect(r.merged).toEqual({
      mcpServers: {
        "harness-declared": { command: "new-binary" },
        "operator-own": { command: "my-server", args: ["--port", "9"] },
      },
    });
    expect(r.replacedKeys).toEqual([]);
    expect(r.deepMergedKeys).toEqual(["mcpServers"]);
    expect(r.preservedMcpServers).toEqual(["operator-own"]);
  });

  it("drops a previously harness-written server the manifest no longer emits (kill-switch pin)", () => {
    const r = mergeSettings(
      {
        mcpServers: {
          "was-harness": { command: "old" },
          "operator-own": { command: "mine" },
        },
      },
      { mcpServers: { "still-declared": { command: "s" } } },
      { previouslyGeneratedMcpNames: new Set(["was-harness", "still-declared"]) },
    );
    expect(r.merged["mcpServers"]).toEqual({
      "operator-own": { command: "mine" },
      "still-declared": { command: "s" },
    });
    expect(r.removedMcpServers).toEqual(["was-harness"]);
    expect(r.preservedMcpServers).toEqual(["operator-own"]);
  });

  it("preserves unknown names when no provenance is available (first merge)", () => {
    const r = mergeSettings(
      { mcpServers: { unknown: { command: "u" } } },
      { mcpServers: { declared: { command: "d" } } },
    );
    expect(r.merged["mcpServers"]).toEqual({
      unknown: { command: "u" },
      declared: { command: "d" },
    });
    expect(r.removedMcpServers).toEqual([]);
  });

  it("round-trips a server literally named __proto__ as an own property", () => {
    const r = mergeSettings(
      { mcpServers: { ["__proto__"]: { command: "weird" } } },
      { mcpServers: { declared: { command: "d" } } },
    );
    const mcp = r.merged["mcpServers"] as Record<string, unknown>;
    expect(Object.keys(mcp)).toEqual(["__proto__", "declared"]);
    expect(JSON.stringify(r.merged)).toContain('"__proto__":{"command":"weird"}');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("drops harness-written leftovers even when the manifest emits NO servers (all disabled)", () => {
    // generateSettings omits the mcpServers key entirely when every
    // declared server is disabled — the provenance-based drop must still
    // fire on that shape.
    const r = mergeSettings(
      {
        mcpServers: {
          "was-harness": { command: "old" },
          "operator-own": { command: "mine" },
        },
      },
      { hooks: {} },
      { previouslyGeneratedMcpNames: new Set(["was-harness"]) },
    );
    expect(r.merged["mcpServers"]).toEqual({ "operator-own": { command: "mine" } });
    expect(r.removedMcpServers).toEqual(["was-harness"]);
    expect(r.deepMergedKeys).toEqual(["mcpServers"]);
  });

  it("omits the mcpServers key when everything harness-written is dropped and nothing remains", () => {
    const r = mergeSettings(
      { mcpServers: { "was-harness": { command: "old" } }, env: { KEEP: "1" } },
      { hooks: {} },
      { previouslyGeneratedMcpNames: new Set(["was-harness"]) },
    );
    expect("mcpServers" in r.merged).toBe(false);
    expect(r.merged["env"]).toEqual({ KEEP: "1" });
    expect(r.removedMcpServers).toEqual(["was-harness"]);
  });

  it("leaves an existing mcpServers untouched when the manifest emits none and no provenance exists", () => {
    const r = mergeSettings(
      { mcpServers: { unknown: { command: "u" } } },
      { hooks: {} },
    );
    expect(r.merged["mcpServers"]).toEqual({ unknown: { command: "u" } });
    expect(r.preservedKeys).toContain("mcpServers");
    expect(r.deepMergedKeys).toEqual([]);
  });

  it("keeps existing server order and appends new generated names", () => {
    const r = mergeSettings(
      { mcpServers: { zeta: { command: "z" }, own: { command: "o" } } },
      { mcpServers: { alpha: { command: "a" }, zeta: { command: "z2" } } },
    );
    expect(Object.keys(r.merged["mcpServers"] as Record<string, unknown>)).toEqual([
      "zeta",
      "own",
      "alpha",
    ]);
  });

  it("falls back to wholesale replace when the existing mcpServers is not an object", () => {
    const r = mergeSettings(
      { mcpServers: ["corrupt"] },
      { mcpServers: { a: { command: "a" } } },
    );
    expect(r.merged["mcpServers"]).toEqual({ a: { command: "a" } });
    expect(r.preservedMcpServers).toEqual([]);
  });

  it("hooks stay wholesale-replaced (must-pass control: no deep merge leaks)", () => {
    const r = mergeSettings(
      { hooks: { PreToolUse: [{ hooks: [{ command: "operator-hook" }] }] } },
      { hooks: { Stop: [{ hooks: [{ command: "harness-hook" }] }] } },
    );
    expect(r.merged["hooks"]).toEqual({
      Stop: [{ hooks: [{ command: "harness-hook" }] }],
    });
    expect(r.preservedMcpServers).toEqual([]);
  });

  it("stays idempotent: re-merging the merged output changes nothing", () => {
    const generated = { mcpServers: { declared: { command: "d" } } };
    const r1 = mergeSettings(
      { mcpServers: { own: { command: "o" } } },
      generated,
    );
    const r2 = mergeSettings(r1.merged, generated);
    expect(r2.merged).toEqual(r1.merged);
    expect(r2.preservedMcpServers).toEqual(["own"]);
  });
});

describe("summarizeMerge", () => {
  it("includes replaced + added + preserved counts", () => {
    const r = mergeSettings({ env: { FOO: "1" } }, { hooks: { x: 1 } });
    const s = summarizeMerge("/tmp/x.json", r);
    expect(s).toContain("/tmp/x.json");
    expect(s).toContain("added 1");
    expect(s).toContain("preserved 1");
  });

  it("names kept operator-added mcpServers", () => {
    const r = mergeSettings(
      { mcpServers: { own: { command: "o" }, declared: { command: "x" } } },
      { mcpServers: { declared: { command: "y" } } },
    );
    const s = summarizeMerge("/tmp/x.json", r);
    expect(s).toContain("kept 1 operator-added mcpServer (own)");
    expect(s).toContain("deep-merged mcpServers");
  });

  it("names dropped manifest-removed mcpServers", () => {
    const r = mergeSettings(
      { mcpServers: { gone: { command: "g" }, declared: { command: "x" } } },
      { mcpServers: { declared: { command: "y" } } },
      { previouslyGeneratedMcpNames: new Set(["gone", "declared"]) },
    );
    expect(summarizeMerge("/tmp/x.json", r)).toContain(
      "dropped 1 manifest-removed mcpServer (gone)",
    );
  });

  it("omits the mcpServers fragment when nothing was kept", () => {
    const r = mergeSettings({ env: { FOO: "1" } }, { hooks: { x: 1 } });
    expect(summarizeMerge("/tmp/x.json", r)).not.toContain("operator-added");
  });
});
