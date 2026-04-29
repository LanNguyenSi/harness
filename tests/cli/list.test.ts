import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { list } from "../../src/cli/list.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const FULL_MANIFEST = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

describe("list — categories", () => {
  it("lists mcp servers from the reference manifest", () => {
    const r = list("mcp", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual(["codebase-oracle", "agent-tasks"]);
    expect(r.output).toMatch(/^name/);
  });

  it("lists cli tools", () => {
    const r = list("cli", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual(["git-batch", "gh", "ledger"]);
  });

  it("lists skills with required flag", () => {
    const r = list("skills", { configPath: FULL_MANIFEST });
    expect(r.rows).toEqual([
      { name: "simplify", required: false },
      { name: "init", required: false },
      { name: "review", required: false },
      { name: "security-review", required: false },
    ]);
  });

  it("lists hook entries", () => {
    const r = list("hooks", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual([
      "git-preflight",
      "require-review-evidence",
      "require-dogfood-evidence",
      "require-preflight-evidence",
    ]);
    const head = r.rows[0]!;
    expect(head.event).toBe("SessionStart");
    expect(head.blocking).toBe("false");
  });

  it("lists policies", () => {
    const r = list("policies", { configPath: FULL_MANIFEST });
    expect(r.rows.map((row) => row.name)).toEqual([
      "review-before-merge",
      "dogfood-before-release",
      "two-reviewers-required",
      "preflight-before-investigation",
    ]);
    expect(r.rows[0]!.enforcement).toBe("block");
  });

  it("lists memory directories", () => {
    const r = list("memories", { configPath: FULL_MANIFEST });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]).toHaveProperty("path");
    expect(r.rows[0]).toHaveProperty("scope");
  });
});

describe("list — --filter", () => {
  it("returns only entries whose name contains the filter substring (case-insensitive)", () => {
    const r = list("mcp", { configPath: FULL_MANIFEST, filter: "ORACLE" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.name).toBe("codebase-oracle");
  });

  it("returns empty when filter matches nothing", () => {
    const r = list("policies", { configPath: FULL_MANIFEST, filter: "nope" });
    expect(r.rows).toHaveLength(0);
    expect(r.output).toMatch(/no entries|^\[\]/);
  });
});

describe("list — --json", () => {
  it("emits a parseable JSON array with no leading prose", () => {
    const r = list("policies", { configPath: FULL_MANIFEST, json: true });
    const trimmed = r.output.trim();
    expect(trimmed.startsWith("[")).toBe(true);
    const parsed = JSON.parse(trimmed);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("enforcement");
  });
});
