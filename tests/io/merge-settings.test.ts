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

describe("summarizeMerge", () => {
  it("includes replaced + added + preserved counts", () => {
    const r = mergeSettings({ env: { FOO: "1" } }, { hooks: { x: 1 } });
    const s = summarizeMerge("/tmp/x.json", r);
    expect(s).toContain("/tmp/x.json");
    expect(s).toContain("added 1");
    expect(s).toContain("preserved 1");
  });
});
