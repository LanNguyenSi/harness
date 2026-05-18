// À la carte manifest composer for `harness init --interactive` Custom
// profile (tasks 31d2fbb5 + 5dd3d8a6). The composer turns a discrete
// checkbox selection into a YAML manifest that `harness validate`
// accepts.
//
// Current surface (parity with FULL_TEMPLATE): one policy pack
// (understanding-before-execution), four MCPs (agent-tasks,
// grounding-mcp, memory-router — wired under memory.router, NOT
// tools.mcp[] — and codebase-oracle), and six reference policies
// (review-before-merge, preflight-before-investigation,
// review-subagent-before-pr-create, preflight-before-push,
// dogfood-before-release, two-reviewers-required). The opencode pack
// stays disabled in the wire-now multiselect until its runtime adapter
// (agent-tasks/f34eb233) lands.
//
// Design: build a plain object matching the Manifest schema, then
// serialise via the `yaml` library. The shared `init()` path
// (validateBeforeWrite, file lock, overwrite guard) handles persistence
// so Custom rejoins the same write/validate semantics as
// solo/team/full.

import { stringify } from "yaml";

export type CustomPackKey = "understanding-before-execution" | "branch-protection";
export type CustomMcpKey =
  | "agent-tasks"
  | "grounding-mcp"
  | "memory-router"
  | "codebase-oracle";
export type CustomPolicyKey =
  | "review-before-merge"
  | "preflight-before-investigation"
  | "review-subagent-before-pr-create"
  | "preflight-before-push"
  | "dogfood-before-release"
  | "two-reviewers-required";

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
  {
    key: "branch-protection",
    label: "branch-protection",
    description:
      "Block Write/Edit (claude-code) or apply_patch (codex) on protected branches (master, main, develop) at the first source mutation. Complements preflight-before-push at the LAST step. Two satisfying signals: a SessionStart `branch-check` tag, or an operator-written `branch-protection-ack` override.",
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
  {
    key: "codebase-oracle",
    label: "codebase-oracle  (needs ORACLE_SCAN_ROOT + OPENAI_API_KEY env vars)",
    description:
      "Multi-repo semantic search MCP server. Set ORACLE_SCAN_ROOT to an absolute path (tilde is NOT expanded) and an embedding-provider key before the first call.",
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
  {
    key: "preflight-before-push",
    label: "preflight-before-push",
    description:
      "Block git push unless preflight:<branch> ledger entry exists for the current branch (within 10m).",
  },
  {
    key: "dogfood-before-release",
    label: "dogfood-before-release",
    description:
      "Block npm publish / git tag v* unless a dogfood:<session-id> ledger entry exists in this session (within 24h).",
  },
  {
    key: "two-reviewers-required",
    label: "two-reviewers-required  (warn-level companion to review-before-merge)",
    description:
      "Warn when PR-merge runs without TWO distinct review:<pr-number> ledger entries. Enforcement: warn.",
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
  requires: {
    ledger_tag: string;
    within?: string;
    count?: { min?: number; max?: number; exact?: number };
    at_head?: boolean;
  };
  hook: string;
  enforcement: string;
  ux?: {
    cannot: string;
    required: string[];
    run: string[];
  };
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
  "preflight-before-push": {
    name: "require-preflight-push-evidence",
    event: "PreToolUse",
    match: "Bash",
    bash_match: "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 1000,
  },
  "dogfood-before-release": {
    name: "require-dogfood-evidence",
    event: "PreToolUse",
    match: "Bash",
    bash_match:
      "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)",
    command: "harness policy intercept",
    blocking: "hard",
    budget_ms: 2000,
  },
  // two-reviewers-required shares review-before-merge's hook; the policy
  // intercept engine evaluates both policies under the same trigger and
  // each enforces independently (block vs warn). We still need a hook
  // entry so the policy's `hook:` field round-trips through validate,
  // but it's the same row as require-review-evidence.
  "two-reviewers-required": {
    name: "require-review-evidence",
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_merge",
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
    ux: {
      cannot: "You cannot merge PR #${PR_NUMBER} yet.",
      required: ["a recorded review of PR #${PR_NUMBER}"],
      run: [
        'mcp__agent-grounding__ledger_add { type: "fact", content: "review:${PR_NUMBER} — <verdict + key findings + nits>" }',
      ],
    },
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
    ux: {
      cannot: "You cannot investigate this repository yet.",
      required: ["verified repository preflight"],
      run: ["harness preflight"],
    },
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
    ux: {
      cannot: "You cannot open a pull request for task ${TASK_ID} yet.",
      required: ["a completed review-subagent pass on this task"],
      run: [
        'mcp__agent-grounding__ledger_add { type: "fact", content: "review-subagent:${TASK_ID} — <verdict + key findings + nits>" }',
      ],
    },
  },
  "preflight-before-push": {
    name: "preflight-before-push",
    description:
      "Block git push unless a fresh preflight ledger entry exists for the current branch. Catches the stale-checkout class of incident at the last reversible step.",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
    },
    requires: {
      ledger_tag: "preflight:${BRANCH}",
      within: "10m",
      // at_head:true lets a preflight at the current HEAD satisfy at
      // any age (standard producer writes head:<sha>). The 10m window
      // is the freshness ceiling for the head-mismatch case.
      at_head: true,
    },
    hook: "require-preflight-push-evidence",
    enforcement: "block",
    ux: {
      cannot: "You cannot push branch ${BRANCH} yet.",
      required: [
        "a preflight for ${BRANCH} at the current HEAD (any age) OR any preflight within the last 10 minutes. Re-run `harness preflight` if you committed since the last preflight AND it has been more than 10 minutes.",
      ],
      run: ["harness preflight"],
    },
  },
  "dogfood-before-release": {
    name: "dogfood-before-release",
    description: "Block npm publish / git tag v* without a recent dogfood ledger entry.",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match:
        "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)",
    },
    requires: { ledger_tag: "dogfood:${SESSION_ID}", within: "24h" },
    hook: "require-dogfood-evidence",
    enforcement: "block",
    ux: {
      cannot: "You cannot publish a release yet.",
      required: ["an end-to-end dogfood run in this session"],
      run: [
        'mcp__agent-grounding__ledger_add { type: "fact", content: "dogfood:${SESSION_ID} — <end-to-end smoke summary>" }',
      ],
    },
  },
  "two-reviewers-required": {
    name: "two-reviewers-required",
    description: "At least two distinct reviewer ledger entries must exist for the PR.",
    trigger: {
      event: "PreToolUse",
      match: "mcp__agent-tasks__pull_requests_merge",
      extract: { PR_NUMBER: "toolArgs.prNumber" },
    },
    requires: { ledger_tag: "review:${PR_NUMBER}", count: { min: 2 } },
    hook: "require-review-evidence",
    enforcement: "warn",
    // No `ux:`: this policy is warn-only and never blocks, so the
    // agent never sees its message. The audit ledger still gets the
    // engine-internal trace.
  },
};

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
  if (sel.policies.includes("two-reviewers-required") && !mcpSet.has("agent-tasks")) {
    warnings.push(
      "policy two-reviewers-required fires on agent-tasks MCP verbs; selecting it without the agent-tasks MCP is allowed but the gate has no event to evaluate.",
    );
  }
  // Note: understanding-before-execution does NOT produce preflight tags
  // (it produces the operator-approve marker, a different gate signal).
  // The pack is therefore NOT a substitute for grounding-mcp here; the
  // only Custom-surface producer the wizard can wire is grounding-mcp's
  // ledger_add.
  if (
    sel.policies.includes("preflight-before-investigation") &&
    !mcpSet.has("grounding-mcp")
  ) {
    warnings.push(
      "policy preflight-before-investigation requires a producer that writes preflight:<repo> tags to the evidence ledger. Without grounding-mcp (ledger_add) or a separate SessionStart preflight hook (not in the Custom surface), the gate stays closed forever.",
    );
  }
  if (sel.policies.includes("preflight-before-push") && !mcpSet.has("grounding-mcp")) {
    warnings.push(
      "policy preflight-before-push requires a producer that writes preflight:<branch> tags to the evidence ledger. Without grounding-mcp (ledger_add) or a separate SessionStart preflight hook (not in the Custom surface), the gate stays closed forever.",
    );
  }
  if (sel.policies.includes("dogfood-before-release") && !mcpSet.has("grounding-mcp")) {
    warnings.push(
      "policy dogfood-before-release requires a producer that writes dogfood:<session-id> tags to the evidence ledger. Without grounding-mcp (ledger_add) the gate stays closed forever — every npm publish / git tag v* will be blocked.",
    );
  }
  if (mcpSet.has("codebase-oracle")) {
    warnings.push(
      "MCP codebase-oracle requires ORACLE_SCAN_ROOT (absolute path; tilde is NOT expanded) and OPENAI_API_KEY (or ORACLE_LLM_PROVIDER + the matching provider key) set in your shell or in Claude's settings.json env block before the first call. The wizard does NOT prompt for these.",
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
    // Dedup hooks by name: two-reviewers-required + review-before-merge
    // both reference `require-review-evidence`, but the schema's
    // superRefine rejects duplicate hook names (each hook entry must be
    // unique). Emit each hook at most once; the same row services every
    // referencing policy.
    const seenHookName = new Set<string>();
    const hooks: HookSpec[] = [];
    for (const p of sel.policies) {
      const h = HOOK_FOR_POLICY[p];
      if (seenHookName.has(h.name)) continue;
      seenHookName.add(h.name);
      hooks.push(h);
    }
    manifest.hooks = hooks;
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
            ux: {
              cannot: "You cannot use write-capable tools yet.",
              required: ["an approved Understanding Report for this session"],
              run: [
                "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan",
                "Run `harness approve understanding` and approve the prompt",
              ],
            },
            // agent-tasks/d8ee60ca: expire the approval marker on
            // task-completion boundaries so multi-task sessions
            // re-prompt for an Understanding Report between tasks.
            approval_lifecycle: {
              expire_on_tool_match: [
                "mcp__agent-tasks__task_finish",
                "mcp__agent-tasks__task_abandon",
                "mcp__agent-tasks__pull_requests_merge",
                "mcp__agent-tasks__tasks_transition",
              ],
              max_age: "4h",
            },
          },
        };
      }
      if (k === "branch-protection") {
        return {
          name: "branch-protection",
          source: "builtin",
          enabled: true,
          description:
            "Block Write/Edit (claude-code) or apply_patch (codex) on protected branches (master, main, develop) at the first source mutation.",
          config: {
            ux: {
              cannot: "You cannot edit files on protected branch ${BRANCH} yet.",
              required: [
                "a checkout of a non-protected branch (current `${BRANCH}` is protected)",
              ],
              run: [
                "git checkout -b feat/<your-task>",
                "harness session-start branch-check",
              ],
            },
          },
        };
      }
      throw new Error(`composer: unknown pack ${String(k)}`);
    });
  }

  const yaml = `${HEADER}\n${stringify(manifest, { lineWidth: 100 })}`;
  return { yaml, warnings };
}
