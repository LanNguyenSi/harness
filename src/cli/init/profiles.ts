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
//   team: solo + agent-tasks MCP server + the merge-gate policies.
//           Adds the merge gates that require a recorded review for the
//           current session before a PR can land: review:<pr-number>
//           before pull_requests_merge, and (task 2699b476)
//           review:<task-id> before task_merge or a task_finish with
//           autoMerge: true.
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
# loop (use --template team if you want PR review-gating).
#
# INTENTIONAL (operator decision 2026-08-08, task adf037c1): this profile
# does NOT carry the full template's operator_only kill-switch policies
# (deny-kill-switch-bypass / deny-session-env-strip /
# deny-pause-sentinel-forgery), so \`harness doctor\` on a fresh solo (or
# team) install reports all three as template drift and exits non-zero.
# That is the profile-independent security floor by design, not a bug: a
# solo/team operator who genuinely does not want kill-switch protection
# acknowledges it via \`doctor.ignore_template_drift\`. Do NOT "fix" the
# doctor failure by narrowing the drift check to the full profile — that
# would silently remove the floor. (checkTemplatePolicyDrift, pinned by
# the cross-profile test in tests/cli/doctor.test.ts.)
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
      # src/policy-packs/builtin/branch-protection.ts — that function is
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
# Solo profile + agent-tasks MCP + the merge-gate policies. Block
# pull_requests_merge MCP calls unless a ledger entry tagged
# review:<pr-number> exists for the current grounding session, and the
# two task-scoped merge verbs (task_merge, task_finish with
# autoMerge: true) unless a review:<task-id> entry does: the standard
# team workflow where every PR gets a review-subagent pass before it
# can land, on whichever surface it actually lands through.
#
# INTENTIONAL (operator decision 2026-08-08, task adf037c1): like the solo
# profile, this template does NOT carry the full template's operator_only
# kill-switch policies, so \`harness doctor\` on a fresh team install
# reports all three as template drift and exits non-zero. That is the
# profile-independent security floor by design; acknowledge it via
# \`doctor.ignore_template_drift\` if a team deliberately opts out. See the
# SOLO_TEMPLATE header note and checkTemplatePolicyDrift.
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
    #
    # budget_ms: 15000 (task 7bf47554, fix round 2), not the earlier
    # 2000: \`intercept()\` writes this policy's decision to the evidence
    # ledger before returning (src/runtime/intercept.ts,
    # \`options.ledger.record(...)\`), a live grounding-mcp round-trip on
    # the critical path, and review-before-merge additionally queries the
    # ledger for its verdict first. Measured worst case
    # (health.timeout_ms=5000 + a deny-degraded audit-write retry) is
    # ~10.8-13.75s; see the full budget-note comment above
    # \`require-review-evidence\` in src/cli/init/templates.ts for the
    # derivation this mirrors.
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  # The two OTHER agent-tasks verbs that land a PR (task 2699b476).
  # \`task_merge\` merges the PR attached to a task; \`task_finish\` with
  # \`autoMerge: true\` merges as part of finishing. Each needs its own
  # hook entry because a hook's \`match\` is what \`harness apply\`
  # projects into settings.json's tool-name matcher. Same budget_ms
  # derivation as \`require-review-evidence\` above.
  - name: require-review-evidence-task-merge
    event: PreToolUse
    match: "mcp__agent-tasks__task_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  - name: require-review-evidence-task-finish
    event: PreToolUse
    match: "mcp__agent-tasks__task_finish"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

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
    # producers: documents the intended evidence flow (see
    # docs/writing-custom-policies.md, "The trust model"): this is a
    # deliberate process gate — the agent records the review subagent's
    # verdict itself, so against the agent the gate is advisory by design.
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${PR_NUMBER} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the PR number.
    ux:
      cannot: "You cannot merge PR #\${PR_NUMBER} yet."
      required:
        - "a recorded review of PR #\${PR_NUMBER}"
      run:
        - 'harness record review --pr \${PR_NUMBER} "<summary>"'

  # Task-scoped merge surfaces (task 2699b476). Tag shape is
  # \`review:\${TASK_ID}\`: both verbs derive owner/repo/PR number from the
  # task, so \`taskId\` is the only identifier in the tool payload.
  # \`harness record review --pr <pr> --task <id> "<summary>"\` writes the
  # PR, branch, base and task tags in ONE ledger fact, so a single
  # recorded review satisfies every merge gate this profile ships.
  # task_finish is gated ONLY in its auto-merge mode: the plain verb
  # advances the task and merges nothing, so \`input_match\` narrows the
  # trigger to the merging mode alone.
  - name: review-before-task-merge
    description: Block agent-tasks task_merge unless a ledger entry tagged review:<task-id> exists for this session.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__task_merge"
      extract:
        TASK_ID: "toolArgs.taskId"
    requires:
      ledger_tag: "review:\${TASK_ID}"
    hook: require-review-evidence-task-merge
    enforcement: block
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${TASK_ID}: <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the task id.
    ux:
      cannot: "You cannot merge the PR for task \${TASK_ID} yet."
      required:
        - "a recorded review of task \${TASK_ID}"
      run:
        - 'harness record review --pr <pr> --task \${TASK_ID} "<summary>"'

  - name: review-before-task-finish-automerge
    description: 'Block agent-tasks task_finish with autoMerge: true unless a ledger entry tagged review:<task-id> exists for this session.'
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__task_finish"
      input_match:
        toolArgs.autoMerge: true
      extract:
        TASK_ID: "toolArgs.taskId"
    requires:
      ledger_tag: "review:\${TASK_ID}"
    hook: require-review-evidence-task-finish
    enforcement: block
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${TASK_ID}: <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the task id. Same evidence the task_merge gate reads, so one recorded review opens both.
    ux:
      cannot: "You cannot finish task \${TASK_ID} with autoMerge yet."
      required:
        - "a recorded review of task \${TASK_ID}"
      run:
        - 'harness record review --pr <pr> --task \${TASK_ID} "<summary>"'

policy_packs:
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
      # src/policy-packs/builtin/branch-protection.ts — that function is
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
