// Profile templates for `harness init` (task c5287b80, PR split 2/3).
//
// Two opinionated starting manifests that go beyond the bare `minimal`
// template but stay smaller than `full`:
//
//   solo: memory-router + understanding-before-execution policy pack.
//         Single-operator setup that wires the recurring "make me
//         defend my interpretation before I touch anything write-
//         capable" gate without dragging in the agent-tasks loop.
//
//   team: solo + agent-tasks MCP server + review-before-merge policy.
//           Adds the merge gate that requires a ledger entry tagged
//           review:<pr-number> for the current session before the
//           pull_requests_merge MCP verb fires.
//
// Both manifests are validate-clean against the v1 schema. They use the
// same path layouts as the existing FULL template (`~/git/pandora/...`,
// `~/.claude/...`); operators on a different layout should override via
// `~/.claude/machines/<host>.harness.overrides.yaml` (ARCHITECTURE §8).

export const SOLO_TEMPLATE = `# ~/.claude/harness.yaml
#
# Bootstrapped by \`harness init --template solo\`.
#
# Single-operator profile: memory-router for cross-conversation memory
# routing + understanding-before-execution policy pack to force an
# explicit interpretation confirmation before any write-capable tool
# fires. No agent-tasks loop (use --template team if you want PR
# review-gating).
#
# Adapt the paths under \`command:\` to your install layout, or move
# host-specific paths to ~/.claude/machines/<host>.harness.overrides.yaml.

version: 1

grounding:
  session:
    auto_start: true
    id_format: "gs-{repo}-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db
    retention_days: 90

tools:
  builtin:
    known: [Read, Edit, Write, Bash, Agent, Skill, TaskCreate, Glob, Grep]

memory:
  directories:
    - path: ~/.claude/projects/{project}/memory
      scope: project
  router:
    # \`memory-router-user-prompt-submit\` is the published bin from
    # \`@lannguyensi/memory-router\`. \`harness init\` offers to
    # \`npm i -g\` it for you; doctor expects it on PATH.
    command: [memory-router-user-prompt-submit]
    enabled: true
  retention:
    staleness_days: 180
    broken_refs: warn
  scopes:
    default: project
    allowed: [project, user]

policy_packs:
  - name: understanding-before-execution
    source: builtin
    enabled: true
    description: Force agents to expose their task interpretation and wait for explicit human approval before any write-capable tool fires.
    config:
      mode: grill_me
`;

export const TEAM_TEMPLATE = `# ~/.claude/harness.yaml
#
# Bootstrapped by \`harness init --template team\`.
#
# Solo profile + agent-tasks MCP + the review-before-merge policy. Block
# pull_requests_merge MCP calls unless a ledger entry tagged
# review:<pr-number> exists for the current grounding session, the
# standard team workflow where every PR gets a review-subagent pass
# before it can land.
#
# Adapt the paths under \`command:\` to your install layout, or move
# host-specific paths to ~/.claude/machines/<host>.harness.overrides.yaml.

version: 1

grounding:
  session:
    auto_start: true
    id_format: "gs-{repo}-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db
    retention_days: 90

tools:
  mcp:
    - name: agent-tasks
      # Zero-setup entry: \`@agent-tasks/mcp-bridge\` exposes the
      # \`agent-tasks-mcp-bridge\` binary on PATH after
      # \`npm i -g @agent-tasks/mcp-bridge\`. The bridge owns token
      # storage (OS keychain or file fallback) and defaults the base
      # URL to https://agent-tasks.opentriologue.ai, so no env is
      # required here. Override with \`AGENT_TASKS_BASE_URL\` /
      # \`AGENT_TASKS_TOKEN\` if you self-host or want explicit creds.
      command: [agent-tasks-mcp-bridge]
      health:
        verb: projects_list
        timeout_ms: 5000
      enabled: true
    - name: grounding-mcp
      # \`grounding-mcp\` bin is published in \`@lannguyensi/grounding-mcp\`.
      # \`harness init\` offers to \`npm i -g\` it for you. No env is set:
      # the bundled default resolves to \`~/.evidence-ledger/ledger.db\`
      # via os.homedir() at startup. Passing a literal tilde in env
      # bypasses shell expansion and creates rogue cwd-relative DB files
      # (see agent-tasks/42d224a6 incident).
      command: [grounding-mcp]
      health:
        verb: ledger_status
        timeout_ms: 5000
      enabled: true
  builtin:
    known: [Read, Edit, Write, Bash, Agent, Skill, TaskCreate, Glob, Grep]

memory:
  directories:
    - path: ~/.claude/projects/{project}/memory
      scope: project
  router:
    # \`memory-router-user-prompt-submit\` is the published bin from
    # \`@lannguyensi/memory-router\`. \`harness init\` offers to
    # \`npm i -g\` it for you; doctor expects it on PATH.
    command: [memory-router-user-prompt-submit]
    enabled: true
  retention:
    staleness_days: 180
    broken_refs: warn
  scopes:
    default: project
    allowed: [project, user]

hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    # The built-in \`harness policy intercept\` CLI verb is the generic
    # deny-on-missing-evidence hook entrypoint. It reads the tool event
    # JSON on stdin, evaluates all policies whose triggers match, emits
    # Claude Code's deny envelope on block. Using it here removes the
    # need to ship a per-policy shell script under ~/.claude/hooks/ for
    # the team setup; operators with custom logic can swap in their own
    # script path.
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

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

policy_packs:
  - name: understanding-before-execution
    source: builtin
    enabled: true
    description: Force agents to expose their task interpretation and wait for explicit human approval before any write-capable tool fires.
    config:
      mode: grill_me
`;
