// À la carte manifest composer for `harness init --interactive` Custom
// profile (task 31d2fbb5). The composer turns a discrete checkbox
// selection into a YAML manifest that `harness validate` accepts.
//
// v1 scope (per task scope-cut): a single policy pack
// (understanding-before-execution), three MCPs (agent-tasks,
// grounding-mcp, memory-router — note memory-router lives under
// memory.router, not tools.mcp[]), and three reference policies. The
// remaining packs/MCPs/policies in the FULL template are deliberately
// deferred to a follow-up task so the Custom surface stays
// reviewable in one PR.
//
// Design: build a plain object matching the Manifest schema, then
// serialise via the `yaml` library. The shared `init()` path
// (validateBeforeWrite, file lock, overwrite guard) handles persistence
// so Custom rejoins the same write/validate semantics as
// solo/team/full.

import { stringify } from "yaml";

export type CustomPackKey = "understanding-before-execution";
export type CustomMcpKey = "agent-tasks" | "grounding-mcp" | "memory-router";
export type CustomPolicyKey =
  | "review-before-merge"
  | "preflight-before-investigation"
  | "review-subagent-before-pr-create";

export interface ComposableOption<K extends string> {
  key: K;
  label: string;
  description: string;
}

export const COMPOSABLE_PACKS: ReadonlyArray<ComposableOption<CustomPackKey>> = [
  {
    key: "understanding-before-execution",
    label: "understanding-before-execution",
    description:
      "Force agents to expose their interpretation and wait for approval before any write-capable tool fires.",
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
    description: "Evidence ledger + understanding-gate approval surface.",
  },
  {
    key: "memory-router",
    label: "memory-router  (wired under memory.router, not tools.mcp[])",
    description: "Cross-conversation memory routing via UserPromptSubmit.",
  },
];

export const COMPOSABLE_POLICIES: ReadonlyArray<ComposableOption<CustomPolicyKey>> = [
  {
    key: "review-before-merge",
    label: "review-before-merge",
    description:
      "Block mcp__agent-tasks__pull_requests_merge unless a review:<pr-number> ledger entry exists.",
  },
  {
    key: "preflight-before-investigation",
    label: "preflight-before-investigation",
    description:
      "Block git status/log/diff/branch unless preflight:<repo> ledger entry exists for this repo (within 1h).",
  },
  {
    key: "review-subagent-before-pr-create",
    label: "review-subagent-before-pr-create",
    description:
      "Block mcp__agent-tasks__pull_requests_create unless a review-subagent:<task-id> ledger entry exists.",
  },
];

export interface CustomSelection {
  packs: CustomPackKey[];
  mcps: CustomMcpKey[];
  policies: CustomPolicyKey[];
  /** Optional override for memory.directories[0].path; defaults to the wizard's standard. */
  memoryDir?: string;
}

export interface ComposeResult {
  yaml: string;
  /**
   * Non-fatal advisories: policy selected without its producing MCP,
   * pack selected without its baseline tools, etc. These are surfaced
   * to stderr by the wizard so the operator can adjust without the
   * manifest itself being rejected (`harness validate` stays clean).
   */
  warnings: string[];
}

interface HookSpec {
  name: string;
  event: string;
  match: string;
  bash_match?: string;
  command: string;
  blocking: string;
  budget_ms: number;
}

interface PolicySpec {
  name: string;
  description: string;
  trigger: {
    event: string;
    match: string;
    bash_match?: string;
    extract?: Record<string, string>;
  };
  requires: { ledger_tag: string; within?: string };
  hook: string;
  enforcement: string;
}

const HOOK_FOR_POLICY: Record<CustomPolicyKey, HookSpec> = {
  "review-before-merge": {
    name: "require-review-evidence",
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_merge",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 2000,
  },
  "preflight-before-investigation": {
    name: "require-preflight-evidence",
    event: "PreToolUse",
    match: "Bash",
    bash_match:
      "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 1000,
  },
  "review-subagent-before-pr-create": {
    name: "require-review-subagent-evidence",
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_create",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 2000,
  },
};

const POLICY: Record<CustomPolicyKey, PolicySpec> = {
  "review-before-merge": {
    name: "review-before-merge",
    description:
      "Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.",
    trigger: {
      event: "PreToolUse",
      match: "mcp__agent-tasks__pull_requests_merge",
      extract: { PR_NUMBER: "toolArgs.prNumber" },
    },
    requires: { ledger_tag: "review:${PR_NUMBER}" },
    hook: "require-review-evidence",
    enforcement: "block",
  },
  "preflight-before-investigation": {
    name: "preflight-before-investigation",
    description:
      "Block investigative git reads (status/log/diff/branch) when agent-preflight has not run recently with ready:true for the current repo.",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match:
        "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b",
    },
    requires: { ledger_tag: "preflight:${REPO}", within: "1h" },
    hook: "require-preflight-evidence",
    enforcement: "block",
  },
  "review-subagent-before-pr-create": {
    name: "review-subagent-before-pr-create",
    description:
      "Block agent-tasks PR creation unless a review-subagent ledger entry tagged for this task already exists. Forces the rigorous review BEFORE the PR opens, not after.",
    trigger: {
      event: "PreToolUse",
      match: "mcp__agent-tasks__pull_requests_create",
      extract: { TASK_ID: "toolArgs.taskId" },
    },
    requires: { ledger_tag: "review-subagent:${TASK_ID}" },
    hook: "require-review-subagent-evidence",
    enforcement: "block",
  },
};

interface McpEntry {
  name: string;
  command: string[];
  min_version: string;
  health: { verb: string; timeout_ms: number };
  enabled: boolean;
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
};

const HEADER = [
  "# ~/.claude/harness.yaml",
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
  const packSet = new Set(sel.packs);

  // Producer-consistency advisories: each policy's `requires.ledger_tag`
  // implies some producer must populate that tag. agent-tasks-coupled
  // policies need the agent-tasks MCP wired; preflight-coupled policies
  // need either grounding-mcp (so ledger_add reaches the gate) or a
  // SessionStart preflight hook. The Custom v1 surface does not expose
  // the SessionStart hook yet, so only check the MCP coupling.
  if (sel.policies.includes("review-before-merge") && !mcpSet.has("agent-tasks")) {
    warnings.push(
      "policy review-before-merge fires on agent-tasks MCP verbs; selecting it without the agent-tasks MCP is allowed but the gate has no event to evaluate.",
    );
  }
  if (
    sel.policies.includes("review-subagent-before-pr-create") &&
    !mcpSet.has("agent-tasks")
  ) {
    warnings.push(
      "policy review-subagent-before-pr-create fires on agent-tasks MCP verbs; selecting it without the agent-tasks MCP is allowed but the gate has no event to evaluate.",
    );
  }
  if (
    sel.policies.includes("preflight-before-investigation") &&
    !mcpSet.has("grounding-mcp") &&
    !packSet.has("understanding-before-execution")
  ) {
    warnings.push(
      "policy preflight-before-investigation requires a producer that writes preflight:<repo> tags to the evidence ledger. Without grounding-mcp (ledger_add) or a separate SessionStart preflight hook, the gate stays closed forever.",
    );
  }

  const manifest: Record<string, unknown> = {
    version: 1,
    grounding: {
      session: { auto_start: true, id_format: "gs-{repo}-{rand:8}" },
      evidence_ledger: { path: "~/.evidence-ledger/ledger.db", retention_days: 90 },
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

  if (sel.policies.length > 0) {
    manifest.hooks = sel.policies.map((p) => HOOK_FOR_POLICY[p]);
    manifest.policies = sel.policies.map((p) => POLICY[p]);
  }

  if (sel.packs.length > 0) {
    manifest.policy_packs = sel.packs.map((k) => {
      // Single-pack switch today; expand when the pack surface grows.
      if (k === "understanding-before-execution") {
        return {
          name: "understanding-before-execution",
          source: "builtin",
          enabled: true,
          description:
            "Force agents to expose their task interpretation and wait for explicit human approval before any write-capable tool fires.",
          config: {
            mode: "grill_me",
            producers: [
              {
                kind: "ask",
                command: "harness approve understanding",
                description:
                  "Bare command, no pipes or chaining. The hook recognises it via isEscapeCommand and emits permissionDecision:ask; the operator's go on that prompt IS the gate approval. Golden path.",
              },
              {
                kind: "bash",
                command: "harness approve understanding",
                description:
                  "Same command from any un-hooked terminal (operator only, not reachable from inside the gated session). Writes the canonical marker at harness.generated/.approvals/${SESSION_ID}.",
              },
            ],
          },
        };
      }
      throw new Error(`composer: unknown pack ${String(k)}`);
    });
  }

  const yaml = `${HEADER}\n${stringify(manifest, { lineWidth: 100 })}`;
  return { yaml, warnings };
}
