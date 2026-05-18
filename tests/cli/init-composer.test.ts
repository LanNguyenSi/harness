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

describe("composeCustom — new policy entries (task 5dd3d8a6)", () => {
  it("preflight-before-push: emits the push-specific hook + within:10m requires", () => {
    const { manifest } = compose({ policies: ["preflight-before-push"] });
    const policy = manifest.policies.find((p) => p.name === "preflight-before-push");
    expect(policy?.requires?.within).toBe("10m");
    expect(policy?.requires?.ledger_tag).toBe("preflight:${BRANCH}");
    expect(manifest.hooks.find((h) => h.name === "require-preflight-push-evidence")).toBeDefined();
  });

  it("dogfood-before-release: matches the npm-publish/git-tag bash_match + within:24h", () => {
    const { manifest } = compose({ policies: ["dogfood-before-release"] });
    const policy = manifest.policies.find((p) => p.name === "dogfood-before-release");
    expect(policy?.requires?.within).toBe("24h");
    expect(policy?.requires?.ledger_tag).toBe("dogfood:${SESSION_ID}");
    expect(policy?.enforcement).toBe("block");
    const hook = manifest.hooks.find((h) => h.name === "require-dogfood-evidence");
    expect(hook?.bash_match).toMatch(/npm publish/);
    expect(hook?.bash_match).toMatch(/tag v/);
  });

  it("ux.run examples name sessionId: \"${SESSION_ID}\" on all ledger_add-producing policies (PR #206)", () => {
    // Pre-#206 the ux.run renderer omitted the sessionId param from the
    // ledger_add example, so operators bound sessionId to the tag UUID
    // (review-subagent's TASK_ID for instance) and the gate kept refusing
    // with the same opaque message. Pin that all four ledger-add policies
    // now emit a sessionId hint pointing at the current session id.
    const { manifest } = compose({
      policies: [
        "review-before-merge",
        "review-subagent-before-pr-create",
        "dogfood-before-release",
      ],
    });
    const ledgerPolicies = manifest.policies.filter(
      (p) =>
        p.ux?.run?.some((r) => r.includes("mcp__agent-grounding__ledger_add")),
    );
    expect(ledgerPolicies.length).toBeGreaterThan(0);
    for (const p of ledgerPolicies) {
      const runs = p.ux?.run ?? [];
      const ledgerCall = runs.find((r) => r.includes("mcp__agent-grounding__ledger_add"));
      expect(ledgerCall, `policy ${p.name} missing ledger_add line`).toBeDefined();
      expect(
        ledgerCall,
        `policy ${p.name} ux.run ledger_add example must include sessionId: "\${SESSION_ID}"`,
      ).toContain('sessionId: "${SESSION_ID}"');
    }
  });

  it("two-reviewers-required: warn-level enforcement + count.min:2, dedups hook with review-before-merge", () => {
    const { manifest } = compose({
      policies: ["review-before-merge", "two-reviewers-required"],
    });
    const two = manifest.policies.find((p) => p.name === "two-reviewers-required");
    expect(two?.enforcement).toBe("warn");
    expect(two?.requires?.count?.min).toBe(2);
    // Both policies reference require-review-evidence; the composer must
    // emit that hook exactly once (schema rejects duplicate hook names).
    const reviewHooks = manifest.hooks.filter((h) => h.name === "require-review-evidence");
    expect(reviewHooks).toHaveLength(1);
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

  it("still warns when the only thing selected alongside preflight-before-investigation is the understanding-before-execution pack (the pack does NOT produce preflight tags)", () => {
    const { warnings } = compose({
      packs: ["understanding-before-execution"],
      policies: ["preflight-before-investigation"],
    });
    expect(
      warnings.some((w) => /preflight-before-investigation/.test(w) && /producer/.test(w)),
    ).toBe(true);
  });

  it("does NOT warn when policy producers are satisfied (full pick, sans codebase-oracle)", () => {
    const { warnings } = compose({
      packs: ["understanding-before-execution"],
      mcps: ["agent-tasks", "grounding-mcp", "memory-router"],
      policies: [
        "review-before-merge",
        "preflight-before-investigation",
        "review-subagent-before-pr-create",
        "preflight-before-push",
        "dogfood-before-release",
        "two-reviewers-required",
      ],
    });
    expect(warnings).toEqual([]);
  });

  it("warns when preflight-before-push is selected without grounding-mcp", () => {
    const { warnings } = compose({ policies: ["preflight-before-push"] });
    expect(
      warnings.some((w) => /preflight-before-push/.test(w) && /producer/.test(w)),
    ).toBe(true);
  });

  it("warns when dogfood-before-release is selected without grounding-mcp (every npm publish would block)", () => {
    const { warnings } = compose({ policies: ["dogfood-before-release"] });
    expect(
      warnings.some((w) => /dogfood-before-release/.test(w) && /every npm publish/.test(w)),
    ).toBe(true);
  });

  it("warns when two-reviewers-required is selected without agent-tasks (no merge events to evaluate)", () => {
    const { warnings } = compose({ policies: ["two-reviewers-required"] });
    expect(
      warnings.some((w) => /two-reviewers-required/.test(w) && /agent-tasks/.test(w)),
    ).toBe(true);
  });
});

describe("composeCustom — memoryDir override", () => {
  it("threads the operator-provided memory dir into memory.directories[0].path", () => {
    const { manifest } = compose({ memoryDir: "~/my-custom-memory/{project}" });
    expect(manifest.memory.directories[0]?.path).toBe("~/my-custom-memory/{project}");
  });
});

describe("composer surface (catalogues)", () => {
  it("exposes the composer-surfaced subset (2 packs, 4 MCPs, 6 reference policies; intentionally smaller than FULL_TEMPLATE, which ships 8 policies including the bash-surface parallels)", () => {
    expect(COMPOSABLE_PACKS.map((p) => p.key)).toEqual([
      "understanding-before-execution",
      "branch-protection",
    ]);
    expect(COMPOSABLE_MCPS.map((m) => m.key)).toEqual([
      "agent-tasks",
      "grounding-mcp",
      "memory-router",
      "codebase-oracle",
    ]);
    expect(COMPOSABLE_POLICIES.map((p) => p.key)).toEqual([
      "review-before-merge",
      "preflight-before-investigation",
      "review-subagent-before-pr-create",
      "preflight-before-push",
      "dogfood-before-release",
      "two-reviewers-required",
    ]);
  });
});
