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
    expect(r.replacedKeys).toEqual(["mcpServers"]);
    expect(r.preservedMcpServers).toEqual(["operator-own"]);
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
  });

  it("omits the mcpServers fragment when nothing was kept", () => {
    const r = mergeSettings({ env: { FOO: "1" } }, { hooks: { x: 1 } });
    expect(summarizeMerge("/tmp/x.json", r)).not.toContain("operator-added");
  });
});
