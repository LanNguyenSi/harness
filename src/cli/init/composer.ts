// À la carte manifest composer for `harness init --interactive` Custom
// profile (tasks 31d2fbb5 + 5dd3d8a6). The composer turns a discrete
// checkbox selection into a YAML manifest that `harness validate`
// accepts.
//
// Current surface (parity with FULL_TEMPLATE): one policy pack
// (branch-protection) and four MCPs (agent-tasks,
// grounding-mcp, memory-router — wired under memory.router, NOT
// tools.mcp[] — and codebase-oracle). The composer emits no policies and
// no hooks. The opencode pack stays disabled in the wire-now multiselect
// until its runtime adapter (agent-tasks/f34eb233) lands.
//
// Design: build a plain object matching the Manifest schema, then
// serialise via the `yaml` library. The shared `init()` path
// (validateBeforeWrite, file lock, overwrite guard) handles persistence
// so Custom rejoins the same write/validate semantics as
// solo/team/full.

import { stringify } from "yaml";
import { defaultUx as branchProtectionDefaultUx } from "../../policy-packs/builtin/branch-protection.js";

export type CustomPackKey = "branch-protection";
export type CustomMcpKey =
  | "agent-tasks"
  | "grounding-mcp"
  | "memory-router"
  | "codebase-oracle";

export interface ComposableOption<K extends string> {
  key: K;
  label: string;
  description: string;
}

export const COMPOSABLE_PACKS: ReadonlyArray<ComposableOption<CustomPackKey>> = [
  {
    key: "branch-protection",
    label: "branch-protection",
    description:
      "Block Write/Edit (claude-code) or apply_patch (codex) when git names a protected branch (master, main, develop) for the target, at the first source mutation. Complements the push-time gates at the LAST step. The way forward is a feature branch (`git checkout -b <feature>`).",
  },
];

export const COMPOSABLE_MCPS: ReadonlyArray<ComposableOption<CustomMcpKey>> = [
  {
    key: "agent-tasks",
    label: "agent-tasks",
    description: "Backlog + PR workflow MCP bridge (agent-tasks-mcp-bridge).",
  },
  {
    key: "grounding-mcp",
    label: "grounding-mcp",
    description: "Evidence ledger (ledger_add / ledger_status).",
  },
  {
    key: "memory-router",
    label: "memory-router  (wired under memory.router, not tools.mcp[])",
    description: "Cross-conversation memory routing via UserPromptSubmit.",
  },
  {
    key: "codebase-oracle",
    label: "codebase-oracle  (needs ORACLE_SCAN_ROOT + OPENAI_API_KEY env vars)",
    description:
      "Multi-repo semantic search MCP server. Set ORACLE_SCAN_ROOT to an absolute path (tilde is NOT expanded) and an embedding-provider key before the first call.",
  },
];

export interface CustomSelection {
  packs: CustomPackKey[];
  mcps: CustomMcpKey[];
  /** Optional override for memory.directories[0].path; defaults to the wizard's standard. */
  memoryDir?: string;
}

export interface ComposeResult {
  yaml: string;
  /**
   * Non-fatal advisories (an MCP that needs env vars the wizard cannot
   * prompt for, etc.). These are surfaced
   * to stderr by the wizard so the operator can adjust without the
   * manifest itself being rejected (`harness validate` stays clean).
   */
  warnings: string[];
}

interface McpEntry {
  name: string;
  command: string[];
  min_version?: string;
  health?: { verb: string; timeout_ms: number };
  enabled: boolean;
  env?: Record<string, string>;
}

const MCP_ENTRY: Record<Exclude<CustomMcpKey, "memory-router">, McpEntry> = {
  "agent-tasks": {
    name: "agent-tasks",
    command: ["agent-tasks-mcp-bridge"],
    min_version: "0.6.0",
    health: { verb: "projects_list", timeout_ms: 5000 },
    enabled: true,
  },
  "grounding-mcp": {
    name: "grounding-mcp",
    command: ["grounding-mcp"],
    min_version: "0.2.0",
    health: { verb: "ledger_status", timeout_ms: 5000 },
    enabled: true,
  },
  // codebase-oracle: harness wires the MCP entry but cannot prompt for
  // the absolute ORACLE_SCAN_ROOT path or the OPENAI_API_KEY (or any
  // other embedding-provider key). The wizard emits a composer.warning
  // when this is picked so the operator knows the env vars still need
  // to be set in their shell or settings.json before the first call.
  // Note: passing a literal tilde in env values bypasses shell expansion
  // (see grounding-mcp incident in FULL_TEMPLATE comments), so the
  // wizard does NOT auto-default ORACLE_SCAN_ROOT to ~/code — the
  // operator must supply an absolute path themselves.
  "codebase-oracle": {
    name: "codebase-oracle",
    command: ["codebase-oracle", "mcp"],
    enabled: true,
  },
};

const HEADER = [
  "# ~/.harness/harness.yaml (legacy: ~/.claude/harness.yaml)",
  "#",
  "# Bootstrapped by `harness init --interactive` (Custom profile).",
  "#",
  "# Composed à la carte from your checkbox picks. Re-run the wizard",
  "# or edit by hand to add / remove components.",
  "",
].join("\n");

export function composeCustom(sel: CustomSelection): ComposeResult {
  const warnings: string[] = [];
  const mcpSet = new Set(sel.mcps);

  if (mcpSet.has("codebase-oracle")) {
    warnings.push(
      "MCP codebase-oracle requires ORACLE_SCAN_ROOT (absolute path; tilde is NOT expanded) and OPENAI_API_KEY (or ORACLE_LLM_PROVIDER + the matching provider key) set in your shell or in Claude's settings.json env block before the first call. The wizard does NOT prompt for these.",
    );
  }

  const manifest: Record<string, unknown> = {
    version: 1,
    grounding: {
      session: { auto_start: true, id_format: "gs-{repo}-{rand:8}" },
      evidence_ledger: { path: "~/.evidence-ledger/ledger.db" },
    },
    tools: {
      builtin: {
        known: ["Read", "Edit", "Write", "Bash", "Agent", "Skill", "TaskCreate", "Glob", "Grep"],
      },
    },
    memory: {
      directories: [
        { path: sel.memoryDir ?? "~/.claude/projects/{project}/memory", scope: "project" },
      ],
      retention: { staleness_days: 180, broken_refs: "warn" },
      scopes: { default: "project", allowed: ["project", "user"] },
    },
  };

  // tools.mcp[] only for non-memory-router MCP picks (memory-router
  // routes user-prompts and is structurally a different slot under
  // memory.router; treating it as a tools.mcp[] entry would fail
  // validation).
  const mcpEntries = sel.mcps
    .filter((m): m is Exclude<CustomMcpKey, "memory-router"> => m !== "memory-router")
    .map((k) => MCP_ENTRY[k]);
  if (mcpEntries.length > 0) {
    (manifest.tools as Record<string, unknown>).mcp = mcpEntries;
  }

  if (mcpSet.has("memory-router")) {
    (manifest.memory as Record<string, unknown>).router = {
      command: ["memory-router-user-prompt-submit"],
      min_version: "0.3.0",
      enabled: true,
    };
  }

  if (sel.packs.length > 0) {
    manifest.policy_packs = sel.packs.map((k) => {
      // Single-pack switch today; expand when the pack surface grows.
      if (k === "branch-protection") {
        return {
          name: "branch-protection",
          source: "builtin",
          enabled: true,
          description:
            "Block Write/Edit (claude-code) or apply_patch (codex) on protected branches (master, main, develop) at the first source mutation.",
          config: {
            // Same canonical source as the reseed path (task 68b9ad9c).
            ux: branchProtectionDefaultUx(),
          },
        };
      }
      throw new Error(`composer: unknown pack ${String(k)}`);
    });
  }

  const yaml = `${HEADER}\n${stringify(manifest, { lineWidth: 100 })}`;
  return { yaml, warnings };
}
