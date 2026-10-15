import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  composeCustom,
  type CustomSelection,
  COMPOSABLE_MCPS,
  COMPOSABLE_PACKS,
} from "../../src/cli/init/composer.js";
import { defaultUx as branchProtectionDefaultUx } from "../../src/policy-packs/builtin/branch-protection.js";
import { parseManifest } from "../../src/schema/index.js";

function compose(sel: Partial<CustomSelection>): { manifest: ReturnType<typeof parseManifest>; warnings: string[]; yaml: string } {
  const full: CustomSelection = {
    packs: sel.packs ?? [],
    mcps: sel.mcps ?? [],
    ...(sel.memoryDir !== undefined ? { memoryDir: sel.memoryDir } : {}),
  };
  const r = composeCustom(full);
  return { manifest: parseManifest(parseYaml(r.yaml)), warnings: r.warnings, yaml: r.yaml };
}

describe("composeCustom — empty selection", () => {
  it("still produces a validate-clean manifest (just version + defaults)", () => {
    const { manifest, warnings, yaml } = compose({});
    expect(manifest.version).toBe(1);
    expect(manifest.hooks).toEqual([]);
    expect(manifest.policies).toEqual([]);
    expect(manifest.policy_packs).toEqual([]);
    expect(warnings).toEqual([]);
    expect(yaml).toContain("Custom profile");
  });
});

describe("composeCustom — single pack", () => {
  it("emits policy_packs.branch-protection with the canonical ux", () => {
    const { manifest } = compose({ packs: ["branch-protection"] });
    expect(manifest.policy_packs).toHaveLength(1);
    const pack = manifest.policy_packs[0];
    expect(pack?.name).toBe("branch-protection");
    expect(pack?.source).toBe("builtin");
    expect(pack?.enabled).toBe(true);
    const cfg = pack?.config as { ux?: unknown } | undefined;
    expect(cfg?.ux).toEqual(branchProtectionDefaultUx());
  });
});

describe("composeCustom — MCPs", () => {
  it("routes memory-router into memory.router, not tools.mcp[]", () => {
    const { manifest } = compose({ mcps: ["memory-router"] });
    expect(manifest.tools.mcp).toEqual([]);
    expect(manifest.memory.router?.command).toEqual(["memory-router-user-prompt-submit"]);
    expect(manifest.memory.router?.enabled).toBe(true);
  });

  it("emits agent-tasks + grounding-mcp under tools.mcp[] with version floors", () => {
    const { manifest } = compose({ mcps: ["agent-tasks", "grounding-mcp"] });
    expect(manifest.tools.mcp).toHaveLength(2);
    const at = manifest.tools.mcp.find((m) => m.name === "agent-tasks");
    const gm = manifest.tools.mcp.find((m) => m.name === "grounding-mcp");
    expect(at?.min_version).toBe("0.6.0");
    expect(gm?.min_version).toBe("0.2.0");
    expect(at?.command).toEqual(["agent-tasks-mcp-bridge"]);
    expect(gm?.command).toEqual(["grounding-mcp"]);
  });
});

describe("composeCustom — codebase-oracle MCP", () => {
  it("emits codebase-oracle under tools.mcp[] without env defaults; surfaces an env-var warning", () => {
    const { manifest, warnings } = compose({ mcps: ["codebase-oracle"] });
    const mcp = manifest.tools.mcp.find((m) => m.name === "codebase-oracle");
    expect(mcp).toBeDefined();
    expect(mcp?.command).toEqual(["codebase-oracle", "mcp"]);
    // The composer does NOT inject env defaults — a literal tilde in
    // ORACLE_SCAN_ROOT bypasses shell expansion (see grounding-mcp
    // incident); the operator must set it themselves.
    expect(mcp?.env).toBeUndefined();
    expect(warnings.some((w) => /codebase-oracle/.test(w) && /ORACLE_SCAN_ROOT/.test(w))).toBe(true);
  });
});

describe("composeCustom — no policies and no hooks (task bcdcde36)", () => {
  it("emits no policies, hooks or bash_match for the fullest selection, whatever the packs and MCPs", () => {
    const { manifest, warnings, yaml } = compose({
      packs: COMPOSABLE_PACKS.map((p) => p.key),
      mcps: COMPOSABLE_MCPS.map((m) => m.key),
    });
    expect(manifest.policies).toEqual([]);
    expect(manifest.hooks).toEqual([]);
    expect(yaml).not.toContain("harness policy intercept");
    expect(yaml).not.toContain("harness record");
    expect(yaml).not.toContain("bash_match");
    expect(yaml).not.toMatch(/^policies:/m);
    expect(yaml).not.toMatch(/^hooks:/m);
    // Only the codebase-oracle env-var advisory remains.
    expect(warnings).toHaveLength(1);
  });

  it("does not auto-wire grounding-mcp: only the picked MCPs reach tools.mcp[]", () => {
    const { manifest, warnings } = compose({ packs: ["branch-protection"], mcps: ["agent-tasks"] });
    expect(manifest.tools.mcp.map((m) => m.name)).toEqual(["agent-tasks"]);
    expect(warnings).toEqual([]);
  });

  it("emits the picked MCP set without a policy-driven grounding-mcp entry", () => {
    const { manifest } = compose({ packs: ["branch-protection"] });
    expect(manifest.tools.mcp).toEqual([]);
  });
});

describe("composeCustom — memoryDir override", () => {
  it("threads the operator-provided memory dir into memory.directories[0].path", () => {
    const { manifest } = compose({ memoryDir: "~/my-custom-memory/{project}" });
    expect(manifest.memory.directories[0]?.path).toBe("~/my-custom-memory/{project}");
  });
});

describe("composer surface (catalogues)", () => {
  it("exposes the composer-surfaced subset (1 pack, 4 MCPs; no policy catalogue)", () => {
    expect(COMPOSABLE_PACKS.map((p) => p.key)).toEqual(["branch-protection"]);
    expect(COMPOSABLE_MCPS.map((m) => m.key)).toEqual([
      "agent-tasks",
      "grounding-mcp",
      "memory-router",
      "codebase-oracle",
    ]);
  });
});
