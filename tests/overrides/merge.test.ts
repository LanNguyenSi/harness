import { describe, expect, it } from "vitest";
import { OverrideMergeError, applyLayers, mergeManifest } from "../../src/overrides/merge.js";

describe("override merge — §8 rules", () => {
  it("scalar replaces user value", () => {
    const result = mergeManifest(
      { memory: { retention: { staleness_days: 180 } } },
      { memory: { retention: { staleness_days: 30 } } },
    );
    expect(result).toEqual({ memory: { retention: { staleness_days: 30 } } });
  });

  it("map merges by key (per-key wins)", () => {
    const result = mergeManifest(
      {
        grounding: {
          evidence_ledger: { path: "/old/ledger.db", retention_days: 90 },
        },
      },
      { grounding: { evidence_ledger: { path: "/new/ledger.db" } } },
    );
    expect(result).toEqual({
      grounding: {
        evidence_ledger: { path: "/new/ledger.db", retention_days: 90 },
      },
    });
  });

  it("name-keyed list patches matching entries and preserves the rest", () => {
    const result = mergeManifest(
      {
        tools: {
          mcp: [
            { name: "codebase-oracle", enabled: true, command: ["npx", "tsx", "/a.ts"] },
            { name: "agent-tasks", enabled: true, command: ["node", "/b.js"] },
          ],
        },
      },
      {
        tools: {
          mcp: [{ name: "codebase-oracle", enabled: false }],
        },
      },
    );
    expect(result).toEqual({
      tools: {
        mcp: [
          { name: "codebase-oracle", enabled: false, command: ["npx", "tsx", "/a.ts"] },
          { name: "agent-tasks", enabled: true, command: ["node", "/b.js"] },
        ],
      },
    });
  });

  it("name-keyed list appends new entries from override after base entries", () => {
    const result = mergeManifest(
      { tools: { mcp: [{ name: "a", command: "x" }] } },
      { tools: { mcp: [{ name: "b", command: "y" }] } },
    );
    expect(result).toEqual({
      tools: {
        mcp: [
          { name: "a", command: "x" },
          { name: "b", command: "y" },
        ],
      },
    });
  });

  it("list without `name` replaces wholesale", () => {
    const result = mergeManifest(
      { memory: { directories: [{ path: "/old", scope: "project" }] } },
      { memory: { directories: [{ path: "/new", scope: "user" }] } },
    );
    expect(result).toEqual({
      memory: { directories: [{ path: "/new", scope: "user" }] },
    });
  });

  it("null tombstone removes the key", () => {
    const result = mergeManifest(
      {
        memory: {
          router: { command: ["node", "/router.js"], enabled: true },
          retention: { staleness_days: 180 },
        },
      },
      { memory: { router: null } },
    );
    expect(result).toEqual({
      memory: { retention: { staleness_days: 180 } },
    });
  });

  it("empty list `[]` clears the list", () => {
    const result = mergeManifest(
      {
        tools: {
          mcp: [{ name: "a", command: "x" }],
        },
      },
      { tools: { mcp: [] } },
    );
    expect(result).toEqual({ tools: { mcp: [] } });
  });

  it("rejects mixed-shape lists", () => {
    expect(() =>
      mergeManifest({ items: [{ name: "a" }] }, { items: [{ name: "b" }, { other: 1 }] }),
    ).toThrow(OverrideMergeError);
  });

  it("_delete: true removes a name-keyed entry", () => {
    const result = mergeManifest(
      {
        tools: {
          mcp: [
            { name: "codebase-oracle", enabled: true },
            { name: "agent-tasks", enabled: true },
          ],
        },
      },
      { tools: { mcp: [{ name: "codebase-oracle", _delete: true }] } },
    );
    expect(result).toEqual({
      tools: { mcp: [{ name: "agent-tasks", enabled: true }] },
    });
  });

  it("_delete on a brand-new entry is a no-op append-suppression", () => {
    const result = mergeManifest(
      { tools: { mcp: [{ name: "a", command: "x" }] } },
      { tools: { mcp: [{ name: "b", _delete: true }] } },
    );
    expect(result).toEqual({ tools: { mcp: [{ name: "a", command: "x" }] } });
  });

  it("project override sets a key user omitted entirely", () => {
    const result = mergeManifest({ version: 1 }, { hooks: [{ name: "x" }] });
    expect(result).toEqual({ version: 1, hooks: [{ name: "x" }] });
  });

  it("rejects merging a name-keyed list onto a plain-list base", () => {
    expect(() => mergeManifest({ items: [1, 2, 3] }, { items: [{ name: "a" }] })).toThrow(
      OverrideMergeError,
    );
  });
});

describe("applyLayers — multi-layer merge", () => {
  it("applies layers left-to-right with later layers winning", () => {
    const result = applyLayers(
      { a: 1, b: 2, c: 3 },
      { b: 20 },
      { c: 30 },
    );
    expect(result).toEqual({ a: 1, b: 20, c: 30 });
  });

  it("skips undefined layers", () => {
    const result = applyLayers({ a: 1 }, undefined, { b: 2 }, undefined);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("preserves base when no layers given", () => {
    const result = applyLayers({ a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("composes name-keyed list updates across layers", () => {
    const result = applyLayers(
      { mcp: [{ name: "a", v: 1 }, { name: "b", v: 1 }] },
      { mcp: [{ name: "a", v: 2 }] },
      { mcp: [{ name: "b", v: 3 }] },
    );
    expect(result).toEqual({ mcp: [{ name: "a", v: 2 }, { name: "b", v: 3 }] });
  });
});
