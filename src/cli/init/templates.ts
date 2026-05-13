export const MINIMAL_TEMPLATE = `# ~/.claude/harness.yaml
#
# Bootstrapped by \`harness init --template minimal\`.
#
# This is the empty-but-valid manifest. Run \`harness validate\` to confirm it
# parses, then add entries under the five top-level keys:
#
#   grounding:  evidence-ledger + claim-gate config (see docs/ARCHITECTURE.md §2)
#   tools:      mcp / cli / skills / builtin inventory   (§3)
#   memory:     directories, retention, scopes           (§4)
#   hooks:      event-bound shell commands               (§5)
#   policies:   named rules that bind hooks to triggers  (§6)
#
# Phase 2 verbs to add entries safely: \`harness add mcp <name> ...\`,
# \`harness add cli\`, \`harness add hook\`, \`harness add skill\`.
# Per-machine overrides live at ~/.claude/machines/<discriminator>.harness.overrides.yaml
# (ARCHITECTURE.md §8) for paths that vary per host.
#
# Docs: https://github.com/LanNguyenSi/harness

version: 1
`;

export const FULL_TEMPLATE = `# ~/.claude/harness.yaml
#
# Bootstrapped by \`harness init --template full\`. The reference manifest:
# all 5 example policies wired through the generic \`harness policy intercept\`
# engine, so no external shell scripts under ~/.claude/hooks/ are required.
#
# What you still need on PATH (the wizard offers to \`npm i -g\` these on
# init): agent-tasks-mcp-bridge, grounding-mcp, memory-router-*,
# understanding-gate-claude-*. Optional add-on: a local codebase-oracle
# MCP server (see comment under tools.mcp below).

version: 1

grounding:
  session:
    auto_start: true
    id_format: "gs-{repo}-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db
    retention_days: 90
  policies_source: ~/.claude/harness.d/policies/claim-gate.yaml

tools:
  mcp:
    # codebase-oracle (the Pandora RAG MCP server) is intentionally NOT
    # in this default. The npm name \`codebase-oracle\` is already taken
    # by an unrelated CLI, and the Pandora variant is not yet published
    # under a non-colliding scope. Operators who run from a local
    # checkout can add it back with (note: \`harness add\` splits the
    # command on commas, not whitespace):
    #   harness add mcp codebase-oracle \\
    #     --command 'npx,tsx,~/git/pandora/codebase-oracle/src/mcp-server.ts'
    - name: agent-tasks
      # Zero-setup entry: \`@agent-tasks/mcp-bridge\` exposes the
      # \`agent-tasks-mcp-bridge\` binary on PATH. The bridge owns token
      # storage and defaults to the hosted backend; override with
      # \`AGENT_TASKS_BASE_URL\` / \`AGENT_TASKS_TOKEN\` for self-hosted.
      command: [agent-tasks-mcp-bridge]
      health:
        verb: projects_list
        timeout_ms: 5000
      enabled: true
    - name: grounding-mcp
      # Published bin from \`@lannguyensi/grounding-mcp\`.
      command: [grounding-mcp]
      env:
        EVIDENCE_LEDGER_DB: ~/.evidence-ledger/ledger.db
      health:
        verb: ledger_status
        timeout_ms: 5000
      enabled: true

  cli:
    - name: gh
      binary: gh
      required: true

  skills:
    enabled:
      - simplify
      - init
      - review
      - security-review
    source_dirs:
      - ~/.claude/skills

  builtin:
    known: [Read, Edit, Write, Bash, Agent, Skill, TaskCreate, Glob, Grep]

memory:
  directories:
    - path: ~/.claude/projects/{project}/memory
      scope: project
  router:
    # Published bin from \`@lannguyensi/memory-router\`.
    command: [memory-router-user-prompt-submit]
    enabled: true
  retention:
    staleness_days: 180
    broken_refs: warn
  scopes:
    default: project
    allowed: [project, user]

# All PreToolUse hooks share the generic \`harness policy intercept\` CLI
# entrypoint. The engine reads the tool event on stdin, evaluates whichever
# policy below has a matching trigger (\`match\` + optional \`bash_match\`),
# and emits Claude Code's deny envelope when the required ledger tag is
# absent. No external shell scripts are required.
#
# Operators who want a SessionStart producer that writes \`preflight:\${REPO}\`
# (so the \`preflight-before-investigation\` policy unblocks) need an
# agent-preflight-style runner; the bundled \`harness session-start preflight\`
# builtin is on the roadmap (agent-tasks follow-up). Until then, supply your
# own \`~/.claude/hooks/git-preflight.sh\` and add an entry here.
hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  - name: require-dogfood-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: "^(npm publish|git tag v.*)"
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  - name: require-preflight-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: "^git (status|log|diff|branch)"
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

  - name: require-review-subagent-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_create"
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  - name: require-preflight-push-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: "^git push"
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

policies:
  - name: review-before-merge
    description: Block PR merges unless a ledger entry tagged review:<pr-number> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
    hook: require-review-evidence
    enforcement: block

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a recent dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "^(npm publish|git tag v.*)"
    requires:
      ledger_tag: "dogfood:\${SESSION_ID}"
      within: 24h
    hook: require-dogfood-evidence
    enforcement: block

  - name: preflight-before-investigation
    description: Block investigative git reads (status/log/diff/branch) when agent-preflight has not run recently with ready:true for the current repo.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "^git (status|log|diff|branch)"
    requires:
      ledger_tag: "preflight:\${REPO}"
      within: 1h
    hook: require-preflight-evidence
    enforcement: block

  - name: review-subagent-before-pr-create
    description: Block agent-tasks PR creation unless a review-subagent ledger entry tagged for this task already exists. Forces the rigorous review BEFORE the PR opens, not after.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_create"
      extract:
        TASK_ID: "toolArgs.taskId"
    requires:
      ledger_tag: "review-subagent:\${TASK_ID}"
    hook: require-review-subagent-evidence
    enforcement: block

  - name: preflight-before-push
    description: Block git push unless a fresh preflight ledger entry exists for the current branch. Catches the stale-checkout class of incident at the last reversible step.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: "^git push"
    requires:
      ledger_tag: "preflight:\${BRANCH}"
      within: 10m
    hook: require-preflight-push-evidence
    enforcement: block

# Full inherits the Solo/Team understanding-gate stack: the Stop hook
# persists each Understanding Report and the PreToolUse pre-tool-use
# blocker refuses Edit/Write/Bash until the report is approved. Drop
# this block if you want the reference policies above without the
# baseline gate.
policy_packs:
  - name: understanding-before-execution
    source: builtin
    enabled: true
    description: Force agents to expose their task interpretation and wait for explicit human approval before any write-capable tool fires.
    config:
      mode: grill_me
`;

import { SOLO_TEMPLATE, TEAM_TEMPLATE } from "./profiles.js";

export type TemplateName = "minimal" | "full" | "solo" | "team";

export function getTemplate(name: TemplateName): string {
  switch (name) {
    case "full":
      return FULL_TEMPLATE;
    case "solo":
      return SOLO_TEMPLATE;
    case "team":
      return TEAM_TEMPLATE;
    case "minimal":
      return MINIMAL_TEMPLATE;
  }
}
