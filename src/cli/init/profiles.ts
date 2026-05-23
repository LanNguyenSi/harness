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
// `~/.harness/machines/<host>.harness.overrides.yaml` (ARCHITECTURE §8).

export const SOLO_TEMPLATE = `# ~/.harness/harness.yaml (legacy: ~/.claude/harness.yaml)
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
# host-specific paths to ~/.harness/machines/<host>.harness.overrides.yaml.

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
      # ux (agent-tasks/60bc93e5): replaces the legacy engine-vocabulary
      # deny envelope with the plain-language { cannot, required, run }
      # shape. Engine details still land in stderr for operator audit;
      # the agent only sees this.
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)"
          - "Run \`harness approve understanding\` and approve the prompt"
      # approval_lifecycle (agent-tasks/d8ee60ca + harness/f54e0ecb,
      # v0.18.0+): expire the approval marker on task-completion
      # boundaries. Solo wires no agent-tasks MCP, so
      # \`expire_on_tool_match\` would be dead weight; we list Bash
      # boundaries instead (PR merges via gh-cli, pushes to the
      # protected branch). Operators on other CLIs override this list
      # with their own regexes. \`max_age\` is the safety net for
      # sessions that never hit a listed command. Opt out entirely
      # with \`approval_lifecycle: { mode: session }\`.
      approval_lifecycle:
        expire_on_bash_match:
          - '^gh pr (merge|close)\\b'
          - '^git push origin (master|main)\\b'
        max_age: 1h
`;

export const TEAM_TEMPLATE = `# ~/.harness/harness.yaml (legacy: ~/.claude/harness.yaml)
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
# host-specific paths to ~/.harness/machines/<host>.harness.overrides.yaml.

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
    ux:
      cannot: "You cannot merge PR #\${PR_NUMBER} yet."
      required:
        - "a recorded review of PR #\${PR_NUMBER}"
      run:
        - 'mcp__agent-grounding__ledger_add { sessionId: "\${SESSION_ID}", type: "fact", content: "review:\${PR_NUMBER} — <verdict + key findings + nits>" }'

policy_packs:
  - name: understanding-before-execution
    source: builtin
    enabled: true
    description: Force agents to expose their task interpretation and wait for explicit human approval before any write-capable tool fires.
    config:
      mode: grill_me
      # ux (agent-tasks/60bc93e5): same shape as Solo's pack ux.
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)"
          - "Run \`harness approve understanding\` and approve the prompt"
      # approval_lifecycle (agent-tasks/d8ee60ca + harness/f54e0ecb,
      # v0.18.0+): expire the approval marker on task-completion
      # boundaries. Team wires agent-tasks, so the MCP task verbs are
      # the primary boundary; the Bash list catches operators who use
      # gh-cli in parallel (hybrid workflow). \`max_age\` is the safety
      # net. Opt out entirely with
      # \`approval_lifecycle: { mode: session }\`.
      approval_lifecycle:
        expire_on_tool_match:
          - mcp__agent-tasks__task_finish
          - mcp__agent-tasks__task_abandon
          - mcp__agent-tasks__pull_requests_merge
          - mcp__agent-tasks__tasks_transition
        expire_on_bash_match:
          - '^gh pr (merge|close)\\b'
          - '^git push origin (master|main)\\b'
        max_age: 4h
`;
