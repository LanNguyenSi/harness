import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  composeCustom,
  type CustomSelection,
  COMPOSABLE_MCPS,
  COMPOSABLE_PACKS,
  COMPOSABLE_POLICIES,
} from "../../src/cli/init/composer.js";
import { parseManifest } from "../../src/schema/index.js";

function compose(sel: Partial<CustomSelection>): { manifest: ReturnType<typeof parseManifest>; warnings: string[]; yaml: string } {
  const full: CustomSelection = {
    packs: sel.packs ?? [],
    mcps: sel.mcps ?? [],
    policies: sel.policies ?? [],
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
  it("emits policy_packs.understanding-before-execution with mode and producers", () => {
    const { manifest } = compose({ packs: ["understanding-before-execution"] });
    expect(manifest.policy_packs).toHaveLength(1);
    const pack = manifest.policy_packs[0];
    expect(pack?.name).toBe("understanding-before-execution");
    expect(pack?.source).toBe("builtin");
    expect(pack?.enabled).toBe(true);
    // The pack's config carries the operator-approve producers introduced
    // in agent-tasks/25bced52; an at-least-one `ask` producer is the
    // load-bearing requirement of the gate.
    const cfg = pack?.config as { mode?: string; producers?: Array<{ kind: string }> } | undefined;
    expect(cfg?.mode).toBe("grill_me");
    expect(cfg?.producers?.some((p) => p.kind === "ask")).toBe(true);
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

describe("composeCustom — policies", () => {
  it("pairs each policy with its required hook (hooks[] referenced by policies[].hook stays consistent)", () => {
    const { manifest } = compose({
      policies: ["review-before-merge", "preflight-before-investigation", "review-subagent-before-pr-create"],
    });
    expect(manifest.policies).toHaveLength(3);
    expect(manifest.hooks).toHaveLength(3);
    const hookNames = new Set(manifest.hooks.map((h) => h.name));
    for (const p of manifest.policies) {
      expect(hookNames.has(p.hook)).toBe(true);
    }
  });
});

describe("composeCustom — producer-coupling warnings", () => {
  it("warns when review-before-merge is selected without agent-tasks", () => {
    const { warnings } = compose({ policies: ["review-before-merge"] });
    expect(warnings.some((w) => /review-before-merge/.test(w) && /agent-tasks/.test(w))).toBe(true);
  });

  it("warns when preflight-before-investigation has no producer (no grounding-mcp, no pack)", () => {
    const { warnings } = compose({ policies: ["preflight-before-investigation"] });
    expect(
      warnings.some((w) => /preflight-before-investigation/.test(w) && /producer/.test(w)),
    ).toBe(true);
  });

  it("does NOT warn when policy producers are satisfied (full pick)", () => {
    const { warnings } = compose({
      packs: ["understanding-before-execution"],
      mcps: ["agent-tasks", "grounding-mcp", "memory-router"],
      policies: [
        "review-before-merge",
        "preflight-before-investigation",
        "review-subagent-before-pr-create",
      ],
    });
    expect(warnings).toEqual([]);
  });
});

describe("composeCustom — memoryDir override", () => {
  it("threads the operator-provided memory dir into memory.directories[0].path", () => {
    const { manifest } = compose({ memoryDir: "~/my-custom-memory/{project}" });
    expect(manifest.memory.directories[0]?.path).toBe("~/my-custom-memory/{project}");
  });
});

describe("composer surface (catalogues)", () => {
  it("keeps the v1 surface small and stable for snapshot review", () => {
    expect(COMPOSABLE_PACKS.map((p) => p.key)).toEqual(["understanding-before-execution"]);
    expect(COMPOSABLE_MCPS.map((m) => m.key)).toEqual([
      "agent-tasks",
      "grounding-mcp",
      "memory-router",
    ]);
    expect(COMPOSABLE_POLICIES.map((p) => p.key)).toEqual([
      "review-before-merge",
      "preflight-before-investigation",
      "review-subagent-before-pr-create",
    ]);
  });
});
