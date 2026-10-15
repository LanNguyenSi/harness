// Profile templates for `harness init` (task c5287b80, PR split 2/3).
//
// Two opinionated starting manifests that go beyond the bare `minimal`
// template but stay smaller than `full`:
//
//   solo: memory-router + branch-protection policy pack.
//         Single-operator setup that refuses Write/Edit on a protected
//         branch (master, main, develop) without dragging in the
//         agent-tasks loop.
//
//   team: solo + the agent-tasks MCP server (and grounding-mcp).
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
# routing + branch-protection policy pack that refuses Write/Edit while
# git names a protected branch (master, main, develop). No agent-tasks
# MCP server (use --template team if you want it).
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
  # branch-protection: blocks Write/Edit (claude-code) or apply_patch (codex)
  # when git names a protected branch (default: master, main, develop) for the
  # directory the call writes into. Fails closed: a manifest that does not
  # load or a git that cannot answer refuses the call. Outside a repository
  # and on a detached HEAD the call is allowed.
  # Disable with \`enabled: false\`; override the protected list via
  # \`config.protected_branches\`. Reference: docs/policy-packs/branch-protection.md.
  - name: branch-protection
    source: builtin
    enabled: true
    description: Block Write/Edit on protected branches (master, main, develop) at the first source mutation.
    config:
      # ux (agent-tasks/9806d4f8): replaces the default
      # "branch-protection: refusing ..." text with the plain-language
      # { cannot, required, run } shape. Engine details (the directory
      # git was asked about) stay on stderr for operator audit.
      #
      # KEEP IN SYNC (task 68b9ad9c): this text must match defaultUx() in
      # src/policy-packs/builtin/branch-protection.ts: that function is
      # what \`harness pack reseed\` and \`harness doctor\`'s divergence
      # warning treat as \"the shipped template\". Pinned by
      # tests/cli/init-templates-ux-parity.test.ts.
      ux:
        cannot: "You cannot edit files on protected branch \${BRANCH} yet."
        required:
          - "a checkout of a non-protected branch (current \`\${BRANCH}\` is protected)"
        run:
          - "git checkout -b feat/<your-task>"
`;

export const TEAM_TEMPLATE = `# ~/.harness/harness.yaml (legacy: ~/.claude/harness.yaml)
#
# Bootstrapped by \`harness init --template team\`.
#
# Solo profile + the agent-tasks MCP server and grounding-mcp.
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

policy_packs:
  # branch-protection: blocks Write/Edit (claude-code) or apply_patch (codex)
  # when git names a protected branch (default: master, main, develop) for the
  # directory the call writes into. Fails closed: a manifest that does not
  # load or a git that cannot answer refuses the call. Outside a repository
  # and on a detached HEAD the call is allowed.
  # Disable with \`enabled: false\`; override the protected list via
  # \`config.protected_branches\`. Reference: docs/policy-packs/branch-protection.md.
  - name: branch-protection
    source: builtin
    enabled: true
    description: Block Write/Edit on protected branches (master, main, develop) at the first source mutation.
    config:
      # ux (agent-tasks/9806d4f8): replaces the default
      # "branch-protection: refusing ..." text with the plain-language
      # { cannot, required, run } shape. Engine details (the directory
      # git was asked about) stay on stderr for operator audit.
      #
      # KEEP IN SYNC (task 68b9ad9c): this text must match defaultUx() in
      # src/policy-packs/builtin/branch-protection.ts: that function is
      # what \`harness pack reseed\` and \`harness doctor\`'s divergence
      # warning treat as \"the shipped template\". Pinned by
      # tests/cli/init-templates-ux-parity.test.ts.
      ux:
        cannot: "You cannot edit files on protected branch \${BRANCH} yet."
        required:
          - "a checkout of a non-protected branch (current \`\${BRANCH}\` is protected)"
        run:
          - "git checkout -b feat/<your-task>"
`;
