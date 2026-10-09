export const MINIMAL_TEMPLATE = `# ~/.harness/harness.yaml (legacy: ~/.claude/harness.yaml)
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
# Per-machine overrides live at ~/.harness/machines/<discriminator>.harness.overrides.yaml
# (ARCHITECTURE.md §8) for paths that vary per host.
#
# Docs: https://github.com/LanNguyenSi/harness

version: 1
`;

export const FULL_TEMPLATE = `# ~/.harness/harness.yaml (legacy: ~/.claude/harness.yaml)
#
# Bootstrapped by \`harness init --template full\`. The reference manifest:
# every example policy from docs/examples/full-manifest.yaml wired through
# the generic \`harness policy intercept\` engine, so no external shell
# scripts under ~/.claude/hooks/ are required.
#
# Canonical source for the policy + policy_packs sections is
# docs/examples/full-manifest.yaml. A parity vitest
# (tests/cli/init-full-template-parity.test.ts) fails the build if the
# two diverge on policy names or load-bearing fields.
#
# What you still need on PATH (the wizard offers to \`npm i -g\` these on
# init): agent-tasks-mcp-bridge, grounding-mcp, memory-router-*.

version: 1

grounding:
  session:
    auto_start: true
    id_format: "gs-{repo}-{rand:8}"
  evidence_ledger:
    path: ~/.evidence-ledger/ledger.db

tools:
  mcp:
    # codebase-oracle (the Pandora RAG MCP server) is intentionally NOT
    # in the Full default. It is published as
    # \`@lannguyensi/codebase-oracle\` and works fine standalone, but it
    # is an opinionated workflow add-on (multi-repo semantic search)
    # rather than infrastructure harness itself assumes. Operators who
    # want it wire it explicitly:
    #   npm i -g @lannguyensi/codebase-oracle
    #   harness add mcp codebase-oracle --command codebase-oracle,mcp
    # Set ORACLE_SCAN_ROOT (absolute path; tilde is not expanded by the
    # MCP env block) and OPENAI_API_KEY (or switch providers via
    # ORACLE_LLM_PROVIDER) before the first call.
    - name: agent-tasks
      # Zero-setup entry: \`@agent-tasks/mcp-bridge\` exposes the
      # \`agent-tasks-mcp-bridge\` binary on PATH. The bridge owns token
      # storage and defaults to the hosted backend; override with
      # \`AGENT_TASKS_BASE_URL\` / \`AGENT_TASKS_TOKEN\` for self-hosted.
      # \`min_version\` floor: 0.6.0 added the \`--version\` short-circuit
      # the doctor probe needs (PR agent-tasks/240, release-cut PR 241).
      # Bump the floor whenever a fix you depend on lands; loose floors
      # are fine, the point is the drift signal not pinning a specific cut.
      command: [agent-tasks-mcp-bridge]
      min_version: "0.6.0"
      health:
        verb: projects_list
        timeout_ms: 5000
      enabled: true
    - name: grounding-mcp
      # Published bin from \`@lannguyensi/grounding-mcp\`. No env is set:
      # the bundled default resolves to \`~/.evidence-ledger/ledger.db\`
      # via os.homedir() at startup. Passing a literal tilde in env
      # bypasses shell expansion and creates rogue cwd-relative DB files
      # (see agent-tasks/42d224a6 incident). \`min_version\` floor: 0.2.0
      # added the \`--version\` short-circuit the doctor probe needs (PR
      # agent-grounding/76, release-cut PR 77).
      command: [grounding-mcp]
      min_version: "0.2.0"
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
    # \`min_version\` floor: 0.3.0 added the \`--version\` short-circuit
    # the doctor probe needs (PR agent-memory/40, release-cut PR 41).
    command: [memory-router-user-prompt-submit]
    min_version: "0.3.0"
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
hooks:
  # Budget note (task 7bf47554, follow-up to the ms/seconds unit fix
  # f2d2a29): every \`harness policy intercept\` hook below down through
  # \`risk-gate\` carries \`budget_ms: 15000\`, i.e. a Claude Code outer
  # kill-timeout of \`ceil(15000/1000) = 15\` seconds (generate-settings.ts's
  # \`hookTimeoutSeconds\`). This is deliberately UNIFORM across all thirteen
  # of them, for two independent reasons:
  #
  # 1. FAIL-CLOSED MARGIN. \`harness policy intercept\` evaluates its FULL
  #    \`policies:\` list against the incoming event (src/runtime/intercept.ts,
  #    \`intercept()\`), not just the one named policy this hook happens to
  #    also register. Every policy in that evaluation loop that reaches a
  #    verdict has its decision written to the evidence ledger via
  #    \`options.ledger.record()\` BEFORE \`intercept()\` returns and stdout is
  #    flushed (intercept.ts ~L1362-1377) — this includes \`operator_only\`
  #    policies (the three kill-switch denies below), whose VERDICT needs no
  #    ledger read but whose AUDIT WRITE is still a live grounding-mcp
  #    round-trip on the critical path. A \`requires:\`-based policy (the
  #    require-*-evidence / risk-gate policies) additionally QUERIES the
  #    ledger for its verdict (intercept.ts's \`evaluateOnePolicy\`,
  #    ~L752-777) and, on a \`deny-degraded\` outcome, may retry the audit
  #    write once more on a fresh session (\`realLedgerClient\`,
  #    src/cli/policy/intercept.ts ~L276-306). Measured worst case with the
  #    grounding-mcp health.timeout_ms=5000 default: query (~5s) + one
  #    fresh-session deny-degraded retry (initialize + ledger_add, each
  #    bounded by \`auditRetryTimeoutMs(5000)\` ~=1.25s) is ~10.8-13.75s. If
  #    Claude Code's outer timeout fires FIRST, it kills the subprocess
  #    before the deny JSON reaches stdout — a hook that Claude Code cannot
  #    read in time is treated as ALLOW, silently turning a computed,
  #    fail-closed \`deny\`/\`deny-degraded\` verdict into an unintended
  #    fail-open one. 15000ms clears the measured worst case with margin,
  #    for BOTH the evidence-requiring policies (their own query+retry) AND
  #    the pure pattern-deny policies (bounded lower, ~1x
  #    health.timeout_ms=~5s via the mandatory record() alone, but still
  #    above the pre-fix 1-2s floor).
  # 2. DEDUP-SAFETY. \`generate-settings.ts\`'s \`buildGroups\` collapses
  #    multiple manifest hooks that share the same \`match\` (settings.json's
  #    tool-name matcher — \`bash_match\` is NOT projected there) AND the same
  #    \`(command, timeout)\` fingerprint into ONE settings.json hook entry,
  #    specifically so Claude Code spawns \`harness policy intercept\` ONCE
  #    per matching tool call instead of once per manifest hook name (the
  #    comment on \`buildGroups\` names this explicitly: avoiding "redundant
  #    Node bootstraps and ledger queries per tool call"). All nine
  #    \`match: "Bash"\` hooks below share one settings.json matcher group;
  #    giving them a NON-uniform budget_ms would make their computed
  #    \`timeout\` values diverge, split that one group into several entries,
  #    and reintroduce exactly the redundant-invocation cost the dedup
  #    exists to avoid — on top of leaving whichever entry keeps a low
  #    timeout still exposed to the fail-open risk above. Keeping all
  #    thirteen at the identical 15000ms budget_ms preserves the existing
  #    one-invocation-per-matcher-group collapse (previously they all
  #    collapsed onto the shared 2s floor; now they collapse onto 15s).
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  # Tool-agnostic parallel of require-review-evidence for operators on the
  # gh-cli workflow (\`gh pr merge\`) instead of agent-tasks MCP. Same generic
  # \`harness policy intercept\` entrypoint; the matching review-before-merge-bash
  # policy below picks up the trigger. A PolicyTrigger can only AND-match one
  # surface (MCP tool-name OR Bash command), so two parallel definitions are
  # the minimum-scope way to cover both PR surfaces without bumping the schema.
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  # The two OTHER agent-tasks verbs that land a PR (task 2699b476).
  # \`pull_requests_merge\` is not the only merge surface the MCP server
  # exposes: \`task_merge\` merges the PR attached to a task, and
  # \`task_finish\` with \`autoMerge: true\` merges as part of finishing
  # (both of its auto-merge modes, the soloMode work claim and the review
  # claim + approve). Each needs its OWN hook entry because a hook's
  # \`match\` is what \`harness apply\` projects into settings.json's
  # tool-name matcher, and a matcher for \`pull_requests_merge\` never
  # spawns \`harness policy intercept\` for either of these. Same
  # 15000ms budget_ms as every other blocking intercept hook, for the
  # same two reasons the note above gives.
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

  - name: require-dogfood-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  - name: require-review-subagent-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_create"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  # Bash-surface parallel of require-review-subagent-evidence for operators
  # who open PRs with \`gh pr create\` instead of agent-tasks MCP. The matching
  # review-subagent-before-pr-create-bash policy below tags by branch
  # (\`review-subagent:\${BRANCH}\`) because no task UUID is in \`gh pr create\`
  # arguments; the working branch is the closest stable handle for "the
  # PR-in-progress" at this point in the cycle.
  - name: require-review-subagent-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr create\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000

  # deny-kill-switch-bash / deny-session-env-strip-bash / deny-sentinel-write-bash
  # (task cf1fde6d): \`harness pause\` / \`harness resume\` refuse to run inside an
  # agent shell in CODE, but that CLI check is a speed bump, not a boundary: a
  # Claude Code \`! \`-prefixed shell inherits this session's env AND its non-TTY
  # stdin, so it is indistinguishable from an agent Bash call and trips the same
  # check the agent would trip (verified live; see
  # docs/okf/pause-vs-gate-kill-switch.md). The actual enforcement point that
  # runs BEFORE the agent's Bash executes is this PreToolUse deny-policy layer.
  # These three hooks/policies below deny, from Bash: the kill-switch verbs
  # themselves, the env-stripping wrappers that would otherwise defeat
  # \`refuseIfAgentShell\`, and direct writes to the unsigned pause sentinel file.
  - name: deny-kill-switch-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S*\\s+)*(?:npx\\s+|\\S*/)?harness\\s+(["\\x27]?)(?:pause|resume|gate\\s+(["\\x27]?)(?:disable|enable)\\4)\\3(?![\\w-])'
    command: harness policy intercept
    blocking: hard
    # 15000, not a smaller pattern-only budget: see the budget note above
    # require-review-evidence. This policy's own verdict (operator_only)
    # needs no ledger read, but intercept()'s audit-record call for that
    # verdict is still a live grounding-mcp round-trip on the critical
    # path, AND this hook shares its settings.json matcher group with the
    # evidence-requiring Bash hooks above (dedup-safety).
    budget_ms: 15000

  - name: deny-session-env-strip-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S*\\s+)*(env\\b[^;\\n|&]*-u\\s*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|env\\b[^;\\n|&]*--unset(?:=|\\s+)(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|unset\\s+(\\S+\\s+)*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)=(?=\\s))'
    command: harness policy intercept
    blocking: hard
    # 15000: same rationale as deny-kill-switch-bash immediately above.
    budget_ms: 15000

  # Known gap, deliberately not faked as coverage: this only catches the
  # obvious shell shapes (\`> .harness-paused\`, \`tee .harness-paused\`,
  # \`cp ... .harness-paused\`). A regex over the raw command string cannot
  # see through a heredoc, \`sh -c '...'\`, \`bash -lc\`, \`eval\`,
  # \`python -c\`, base64-decoded payloads, an fs.write call inside a script
  # file the agent creates and then executes, a symlink swap, or the
  # sentinel-write equivalents of \`cp\`/\`>\` done via \`mv\`, \`ln\`,
  # \`install\`, or \`dd\`. These are NOT covered on purpose (regex whack-a-
  # mole against every file-write-capable tool does not meaningfully close
  # this class); closing it for real needs either signing the sentinel
  # (HMAC) or a filesystem-level write guard, neither of which is in scope
  # here; both are noted as follow-ups.
  - name: deny-sentinel-write-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S*\\s+)*(tee|cp)\\b[^;\\n|&]*\\.harness-paused\\b|>{1,2}\\s*\\S*\\.harness-paused\\b'
    command: harness policy intercept
    blocking: hard
    # 15000: same rationale as deny-kill-switch-bash above.
    budget_ms: 15000

  # risk-gate (Phase 7 #6): the Risk Gate enforcement hook. The
  # gate-prod-destructive policies below reference it. Same generic
  # \`harness policy intercept\` entrypoint as every other policy hook;
  # the interceptor builds the Action Envelope, classifies risk against
  # \`risk.classifiers[]\`, resolves the environment against
  # \`environments.resolvers[]\`, and evaluates the policies' \`when:\`.
  - name: risk-gate
    event: PreToolUse
    match: "Bash"
    command: harness policy intercept
    blocking: hard
    # 15000: same rationale as the budget note above require-review-evidence.
    budget_ms: 15000

  # Optional: runtime-reality drift gate (NOT enabled by default).
  # Blocks destructive runtime commands (compose down/restart, systemctl,
  # kill/pkill, ./deploy-*) when the live process state has drifted from what
  # your expectations file says should be running. Left COMMENTED on purpose:
  # the hook is host-coupled and, without RUNTIME_REALITY_KEYWORD + an
  # expectations file + RUNTIME_REALITY_PROBE_CMD, degrades silently to allow,
  # a no-op that looks like protection. To arm it, uncomment the entry and
  # fill in the three env values. The expectations-file format and how to
  # install the probe are documented in docs/runtime-reality-hook.md.
  #
  # - name: runtime-reality
  #   event: PreToolUse
  #   command: >-
  #     RUNTIME_REALITY_KEYWORD=<your-stack>
  #     RUNTIME_REALITY_EXPECTATIONS_DIR=$HOME/.runtime-reality/expectations
  #     RUNTIME_REALITY_PROBE_CMD="node $HOME/.runtime-reality/probes/runtime-reality-docker-probe.mjs"
  #     harness pack hook runtime-reality
  #   blocking: hard
  #   description: Block destructive runtime commands on critical process drift

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
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${PR_NUMBER} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the PR number. The content should be self-contained enough for an auditor to read without re-opening the chat.
    ux:
      cannot: "You cannot merge PR #\${PR_NUMBER} yet."
      required:
        - "a recorded review of PR #\${PR_NUMBER}"
      run:
        - 'harness record review --pr \${PR_NUMBER} "<summary>"'

  # Bash-surface parallel of review-before-merge for operators on the gh-cli
  # workflow. Two scope notes:
  #   1. Tag shape: \`review:\${BRANCH}\` instead of \`review:\${PR_NUMBER}\`. The
  #      \`gh pr merge\` invocation can target the PR by number, by URL, or by
  #      the current branch (default), and PR_NUMBER is not extractable from
  #      \`tool_input.command\` with today's JSONPath-only extract DSL. BRANCH
  #      is the stable identifier the producer can record at review time.
  #   2. This sits ALONGSIDE review-before-merge — not as a replacement. An
  #      operator using both surfaces (e.g. agent-tasks MCP for most repos
  #      + gh-cli for a quick hotfix) will have both gates active, each with
  #      its own tag shape, which is semantically honest.
  - name: review-before-merge-bash
    description: Block \`gh pr merge\` unless a ledger entry tagged review:<branch> exists for this session.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    requires:
      ledger_tag: "review:\${BRANCH}"
    hook: require-review-evidence-bash
    enforcement: block
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${BRANCH} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the branch diff, capture its verdict, then persist a ledger entry tagged with the branch name. Mirror of the review-before-merge producer for the gh-cli surface.
    ux:
      cannot: "You cannot merge the PR for branch \${BRANCH} via \`gh pr merge\` yet."
      required:
        - "a recorded review of the PR for branch \${BRANCH}"
      run:
        - 'harness record review --pr <pr> "<summary>"'

  # The two agent-tasks verbs that ALSO land a PR (task 2699b476, closing
  # the residual 99f47307 Slice 1 named twice in the CHANGELOG). Same
  # shape as review-before-merge, three scope notes:
  #   1. Tag shape: \`review:\${TASK_ID}\` rather than \`review:\${PR_NUMBER}\`.
  #      Both verbs are task-scoped: they derive owner/repo/PR number from
  #      the task, so \`taskId\` is the only identifier in the tool payload.
  #      \`harness record review --pr <pr> --task <id> "<summary>"\` writes
  #      the PR, branch, base AND task tags in ONE ledger fact, so a single
  #      recorded review satisfies all four merge gates at once.
  #   2. task_finish is gated ONLY in its auto-merge mode. The verb is
  #      polymorphic: a plain \`task_finish\` advances the task and merges
  #      nothing, while \`autoMerge: true\` merges the PR (both modes do,
  #      the soloMode work claim and the review claim + approve). Gating
  #      the whole verb would block the ordinary finish call for no reason;
  #      \`input_match\` narrows the trigger to the merging mode alone.
  #      A missing \`autoMerge\` never matches, so an omitted argument
  #      leaves the gate out of the way rather than arming it.
  #   3. These sit ALONGSIDE review-before-merge / -bash, same rationale
  #      as the bash variant above: an operator may use any of the four
  #      merge surfaces, and each carries its own tag shape.
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
        description: Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the task id. Mirror of the review-before-merge producer for the task-scoped merge surface.
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

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a recent dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)'
    requires:
      ledger_tag: "dogfood:\${SESSION_ID}"
      within: 24h
    hook: require-dogfood-evidence
    enforcement: block
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"dogfood:\${SESSION_ID} — <end-to-end smoke summary against the live system>", source:"manual smoke test"}'
        description: Before tagging or publishing, run the release path end-to-end against the live system (not just unit tests) and persist the result as a session-tagged ledger entry. Document what you exercised (install, CLI happy path, MCP handshake, etc.) so a future auditor can tell whether the smoke covered the change.
    ux:
      cannot: "You cannot publish a release yet."
      required:
        - "an end-to-end dogfood run in this session"
      run:
        - 'harness record dogfood "<was wurde real ausprobiert>"'

  - name: two-reviewers-required
    description: At least two distinct reviewer ledger entries must exist for the PR.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:\${PR_NUMBER}"
      count:
        min: 2
    hook: require-review-evidence
    enforcement: warn
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${PR_NUMBER} — <verdict + key findings + nits>", source:"Agent(general-purpose) review (reviewer 2)"}'
        description: Same shape as review-before-merge but TWO DISTINCT reviewer entries must exist before the gate is satisfied (count.min 2). Distinguish reviewers by source so the count is honest. Warn-level enforcement, so the agent CAN merge with one reviewer but should consider spawning a second for load-bearing changes.

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
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review-subagent:\${TASK_ID} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: After running a review subagent against the staged diff, persist its verdict + load-bearing findings as a ledger entry tagged with the task UUID. The content should be self-contained enough to audit later without re-reading the chat.
    ux:
      cannot: "You cannot open a pull request for task \${TASK_ID} yet."
      required:
        - "a completed review-subagent pass on this task"
      run:
        - 'harness record review-subagent --task \${TASK_ID} --verdict <verdict>'

  # Bash-surface parallel of review-subagent-before-pr-create. Tag shape is
  # \`review-subagent:\${BRANCH}\` because TASK_ID is an agent-tasks-only
  # concept; for the gh-cli workflow the working branch is the closest stable
  # handle for "the PR-in-progress" at this point. Same rationale as
  # review-before-merge-bash: sits alongside the MCP variant, not as a
  # replacement.
  - name: review-subagent-before-pr-create-bash
    description: Block \`gh pr create\` unless a review-subagent ledger entry tagged review-subagent:<branch> exists for this session. Forces the rigorous review BEFORE the PR opens.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr create\\b'
    requires:
      ledger_tag: "review-subagent:\${BRANCH}"
    hook: require-review-subagent-evidence-bash
    enforcement: block
    producers:
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review-subagent:\${BRANCH} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: After running a review subagent against the staged diff for the working branch, persist its verdict + load-bearing findings as a ledger entry tagged with the branch name. Mirror of the review-subagent-before-pr-create producer for the gh-cli surface.
    ux:
      cannot: "You cannot open a pull request for branch \${BRANCH} via \`gh pr create\` yet."
      required:
        - "a completed review-subagent pass on branch \${BRANCH}"
      run:
        - 'harness record review-subagent --task <task-id> --verdict <verdict>'

  # Phase 7 Risk Gate — the canonical built-in worked example. These two
  # policies, with the dangerous-shell classifier and production-signals
  # resolver below, are the Risk Gate's default stance: a destructive
  # shell action whose target environment resolves to production is
  # gated before the runtime fires it. Both fire ONLY when the
  # environment resolves to production (a main / release branch, a
  # prod-looking DATABASE_URL, or a prod kube context); on an ordinary
  # feature branch the environment is unknown and neither fires. Ordered
  # deny-first so a critical action (which also matches the high
  # threshold) gets the hard-deny envelope. See docs/risk-gate.md.
  - name: gate-prod-destructive
    description: Deny critical-severity destructive shell actions against a production target.
    trigger:
      event: PreToolUse
      match: "Bash"
    when:
      risk.severity_at_least: critical
      environment.name: production
    requires:
      ledger_tag: "risk-override:\${SESSION_ID}"
    hook: risk-gate
    enforcement: block
    # Operator-in-the-loop gate: the override tag is written by the
    # operator verb (ask semantics), not by the agent. See
    # writing-custom-policies.md, tripwire 4 (the trust model).
    producers:
      - kind: ask
        command: harness approve risk --force <reason>
        description: Deliberate operator override for a critical production mutation; run from the operator shell.
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"risk-override:\${SESSION_ID} — operator-authorized <reason>", source:"operator"}'
        description: Recovery path if the approve verb is unavailable; only meaningful when the OPERATOR authorizes the content.
    ux:
      cannot: "You cannot run this critical destructive action against production."
      required:
        - "a deliberate operator override: a critical production mutation has no benign reading"
      run:
        - "Choose a non-destructive alternative, or ask the OPERATOR to run the command themselves, outside the agent."
        - "Operator override (deliberate): the OPERATOR runs \`harness approve risk --force <reason>\` from their own shell (\`! \` prefix in Claude Code, with --i-am-the-operator to acknowledge a non-TTY invocation)."
  - name: gate-prod-destructive-approval
    description: Require operator approval for high-severity destructive shell actions against a production target.
    trigger:
      event: PreToolUse
      match: "Bash"
    when:
      risk.severity_at_least: high
      environment.name: production
    requires:
      ledger_tag: "risk-approved:\${SESSION_ID}"
    hook: risk-gate
    enforcement: require_approval
    producers:
      - kind: ask
        command: harness approve risk
        description: Operator approves this Risk Gate decision from their own shell.
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"risk-approved:\${SESSION_ID} — operator-authorized", source:"operator"}'
        description: Recovery path if the approve verb is unavailable; only meaningful when the OPERATOR authorizes the content.
    ux:
      cannot: "You cannot run this destructive production action yet."
      required:
        - "operator approval of this Risk Gate decision"
      run:
        - "harness approve risk"

  # gate-dev-unsafe-deletion (task d03af8f6): the two policies above fire
  # ONLY when the environment resolves to production — on an ordinary
  # task branch (environment: unknown) a deletion command runs
  # unconfirmed even when its target is a stray variable or a relative
  # path pointing somewhere unintended. This policy is deliberately
  # environment-INDEPENDENT (no environment.name clause) and gates on the
  # new \`action.deletion_target_unresolvable\` clause instead of
  # \`risk.severity_at_least\`/\`risk.category_in\` specifically because
  # those fail-close to matched=true for ANY unclassified action —
  # unscoped, that would gate every unrelated unclassified Bash call in
  # every environment. \`action.deletion_target_unresolvable\` only fires
  # for a recognized deletion verb (\`rm -r*\`/\`-f*\`, \`find ... -delete\`,
  # \`git clean -f*\`) whose target(s) cannot be statically proven inside
  # \`risk.safe_deletion_roots\` (below). See docs/risk-gate.md.
  #
  # This policy consults its OWN ledger tag
  # (\`risk-approved:deletion:\${SESSION_ID}\`), never the tag
  # \`gate-prod-destructive-approval\` above consults — a routine dev-
  # context deletion approval must not also clear the production
  # approval gate. \`harness approve risk --scope deletion\` writes this
  # tag; the bare \`harness approve risk\` (no \`--scope\`) keeps writing
  # only the production tag. See CHANGELOG.md task d03af8f6 for the
  # measured incident this fixed.
  - name: gate-dev-unsafe-deletion
    description: Require approval for a deletion-verb command whose target cannot be statically proven safe, in every environment.
    trigger:
      event: PreToolUse
      match: "Bash"
    when:
      action.deletion_target_unresolvable: true
    requires:
      ledger_tag: "risk-approved:deletion:\${SESSION_ID}"
    hook: risk-gate
    enforcement: require_approval
    producers:
      - kind: ask
        command: harness approve risk --scope deletion
        description: Operator approves this Risk Gate decision from their own shell.
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"risk-approved:deletion:\${SESSION_ID} — operator-authorized", source:"operator"}'
        description: Recovery path if the approve verb is unavailable; only meaningful when the OPERATOR authorizes the content.
    ux:
      cannot: "You cannot run this deletion command yet — its target cannot be statically proven safe."
      required:
        - "operator approval of this Risk Gate decision, OR an absolute target inside a declared risk.safe_deletion_roots entry"
      run:
        - "harness approve risk --scope deletion"
        - "Or point the command at a path under risk.safe_deletion_roots (default: /tmp, /private/tmp) instead of an unresolved variable, relative path, or traversal."

  # deny-kill-switch-bypass / deny-session-env-strip / deny-pause-sentinel-forgery
  # (task cf1fde6d): \`harness pause\`/\`harness resume\` refuse to run inside an
  # agent shell in CODE, but that CLI check (refuseIfAgentShell / refuseIfNonTTY
  # in src/cli/pause/index.ts) is a speed bump, not a boundary: a Claude Code
  # \`! \`-prefixed shell inherits this session's env AND its non-TTY stdin, so
  # it is indistinguishable from an agent Bash call and trips the same checks
  # (verified live; docs/okf/pause-vs-gate-kill-switch.md). This PreToolUse
  # layer is the enforcement point that actually runs BEFORE the agent's Bash
  # executes.
  #
  # UPDATE (task 2cc73f55, closes the gap the HONESTY NOTE below used to
  # document): these three now declare \`operator_only: true\` instead of a
  # requires.ledger_tag. Every requires:-based policy in this engine is, by
  # construction, satisfiable by the SAME agent it gates: nothing stops it
  # from calling mcp__grounding-mcp__ledger_add with content matching the
  # tag for its own session before running the denied command, which used to
  # flip deny to allow (src/runtime/intercept.ts, the satisfied-requires
  # branch). \`operator_only: true\` closes that specific hole: the policy
  # declares NO requires: at all, and intercept() short-circuits to an
  # unconditional deny before the requires pipeline runs — no ledger query,
  # no template substitution, so no ledger write, marker file, or flag can
  # ever flip it to allow. See docs/writing-custom-policies.md tripwire 4 and
  # the "Operator-only unconditional deny" section for the schema contract,
  # and tests/cli/init-full-template-kill-switch-deny.test.ts for a test that
  # forges every ledger-evidence shape available to intercept() and asserts
  # the block holds.
  #
  # RESIDUAL GAP (still open, out of scope for task 2cc73f55): bash_match is
  # still a regex over the raw command string, matched BEFORE evaluation ever
  # reaches operator_only:, so it still cannot see through a heredoc,
  # \`sh -c '...'\`, \`eval\`, a base64-decoded payload, or a script file the
  # agent writes and then executes — an agent that defeats the TRIGGER match
  # never reaches this deny at all. That is a bash_match coverage gap, not a
  # requires-satisfaction gap, and is unrelated to the fix here (see PR #341
  # for the known uncoverable shapes). \`harness validate\` no longer warns
  # "declares no producers" on these three (checkPolicySelfAttestation now
  # recognises operator_only: true as correct-by-construction).
  #
  # UPDATE (task 432db3d3, 2026-07-28, follow-up to ea8becf5): PARTIALLY
  # closed — for THIS policy only. \`src/runtime/command-normalize.ts\` now
  # peels wrapper prefixes (\`env\`, \`nice\`, \`command\`, \`sudo\`, \`doas\`,
  # \`time\`, \`timeout\`, \`stdbuf\`, \`setsid\`, \`exec\`, \`nohup\`, leading
  # VAR=value) and
  # collapses whitespace runs for the closed head-token set
  # \`git\`/\`gh\`/\`npm\`/\`harness\`, so \`env harness pause\`, \`nice harness
  # gate disable\` and the like now reach this deny via the raw-OR-normalised
  # match — measured 2026-07-28 against the real trigger regex through the
  # real hook entry point, pinned in tests/runtime/intercept-cli.test.ts.
  # The OTHER TWO kill switches are NOT covered by that closed set:
  # deny-session-env-strip keys on \`env\`/\`unset\` head tokens, and \`env\`
  # is STRUCTURALLY unreachable for the normaliser (its peeling loop
  # consumes \`env -u <VAR>\` while hunting for a gated command behind it,
  # erasing the very text this trigger keys on); deny-pause-sentinel-forgery
  # keys on \`tee\`/\`cp\`. Both remain wrapper-bypassable (\`nice env -u
  # CLAUDE_CODE_SESSION_ID ...\`, \`nice tee <sentinel>\`), measured
  # 2026-07-28 and pinned as explicit not-covered tests plus a head-token
  # drift guard (tests/runtime/bash-match-head-token-drift.test.ts) that
  # goes red when a future bash_match policy gates a new head token.
  - name: deny-kill-switch-bypass
    description: Deny harness pause, harness resume, harness gate disable, and harness gate enable from the agent's Bash tool. These are operator-only kill switches.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S*\\s+)*(?:npx\\s+|\\S*/)?harness\\s+(["\\x27]?)(?:pause|resume|gate\\s+(["\\x27]?)(?:disable|enable)\\4)\\3(?![\\w-])'
    operator_only: true
    hook: deny-kill-switch-bash
    enforcement: block
    ux:
      cannot: "You cannot run \`harness pause\`, \`harness resume\`, \`harness gate disable\`, or \`harness gate enable\`."
      required:
        - "the OPERATOR to run this from a terminal genuinely outside your agent session, not a \`! \`-prefixed Claude Code shell, which inherits this session's env and stdin and does not count"
      run:
        - "Stop. Explain to the operator what you were trying to do and why, and let THEM decide whether to run that command from their own terminal. This is the only way to unblock this gate: it is an unconditional deny (operator_only: true) that no in-session evidence — a ledger write, a marker file, a flag — can ever satisfy; the only remaining gap is bash_match's regex coverage of exotic shell shapes, not this evaluation (see docs/okf/pause-vs-gate-kill-switch.md)."

  - name: deny-session-env-strip
    description: Deny Bash attempts to strip or unset the agent-session env vars that harness pause/resume check (\$CLAUDE_CODE_SESSION_ID, \$CLAUDE_SESSION_ID, \$CODEX_SESSION_ID). Closes the one-liner that otherwise defeats refuseIfAgentShell.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S*\\s+)*(env\\b[^;\\n|&]*-u\\s*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|env\\b[^;\\n|&]*--unset(?:=|\\s+)(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|unset\\s+(\\S+\\s+)*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)=(?=\\s))'
    operator_only: true
    hook: deny-session-env-strip-bash
    enforcement: block
    ux:
      cannot: "You cannot strip or unset your own agent-session id env vars from Bash."
      required:
        - "no legitimate reason from inside this session: stripping \$CLAUDE_CODE_SESSION_ID / \$CLAUDE_SESSION_ID / \$CODEX_SESSION_ID is recognised as an attempt to defeat the harness pause/resume agent-shell check"
      run:
        - "Stop. If you believe you have a legitimate reason to run a command without one of these env vars set, ask the OPERATOR to do it from their own terminal instead. This gate is an unconditional deny (operator_only: true); see docs/okf/pause-vs-gate-kill-switch.md for the honest trust model and the residual bash_match coverage gap."

  - name: deny-pause-sentinel-forgery
    description: Deny Bash writes (redirect, tee, cp) to the harness pause sentinel file (.harness-paused). The sentinel is unsigned JSON; a forged file silences every gate exactly like a real operator pause. Reads (cat, stat) are unaffected.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S*\\s+)*(tee|cp)\\b[^;\\n|&]*\\.harness-paused\\b|>{1,2}\\s*\\S*\\.harness-paused\\b'
    operator_only: true
    hook: deny-sentinel-write-bash
    enforcement: block
    ux:
      cannot: "You cannot write to the harness pause sentinel file (.harness-paused)."
      required:
        - "the OPERATOR to run \`harness pause\`/\`harness resume\` themselves, from a terminal outside your agent session, never a direct write to the sentinel file"
      run:
        - "Stop. Do not write, redirect, tee, or copy anything to .harness-paused. Ask the OPERATOR to silence the gates themselves, from their own terminal, using the operator-only command named under Required, if the session genuinely needs it. This gate is an unconditional deny (operator_only: true); see docs/okf/pause-vs-gate-kill-switch.md for the honest trust model and the residual bash_match coverage gap."

policy_packs:
  # branch-protection (agent-tasks/2fdc5bbe, default-enabled since v0.17.2):
  # blocks Write/Edit (claude-code) or apply_patch (codex) when git names a
  # protected branch (default: master, main, develop) for the directory the
  # call writes into. It fires at the FIRST source mutation, catching the
  # \"forgot to branch off master\" pattern before any edit lands.
  #
  # The hook asks git (\`git -C <dir> symbolic-ref -q HEAD\`) on every call;
  # the way forward for the agent is a feature branch
  # (\`git checkout -b <feature>\`). Fails closed: a manifest that does not
  # load or a git that cannot answer refuses the call. Outside a repository
  # and on a detached HEAD the call is allowed.
  #
  # Disable by setting \`enabled: false\` or removing this entry if your
  # workflow routinely edits master directly. Override the protected list
  # via \`config.protected_branches\`. Full reference:
  # docs/policy-packs/branch-protection.md.
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

# Phase 7 Risk Gate vocabulary. The dangerous-shell classifier and
# production-signals resolver feed the gate-prod-destructive policies
# above: \`harness policy intercept\` builds the Action Envelope,
# classifies the action against \`risk.classifiers[]\`, resolves the
# target environment against \`environments.resolvers[]\`, and evaluates
# each policy's \`when:\` clauses against the result. Full design and the
# decision model: docs/risk-gate.md.
risk:
  # Fail posture when a policy's evidence cannot be READ (ledger timeout,
  # spawn failure, unresolved template): with \`preserve_enforcement\`
  # (the default) block/require_approval policies fail CLOSED
  # (\`deny-degraded\`) while warn policies stay non-blocking. Set
  # \`fail_open\` to restore the pre-0.45 availability-first behaviour
  # where EVERY degraded evaluation was a non-blocking \`warn-degraded\`.
  # Kept COMMENTED OUT on purpose: the schema is strict, so a manifest
  # carrying this key fails to parse on a pre-0.45 binary, and a manifest
  # load failure is ALLOW at the hook layer — on a mixed-version fleet an
  # emitted default would turn a downgrade into a silent full fail-open
  # (review 2026-08-08). See docs/okf/gate-fail-posture-matrix.md.
  # degraded_fail_posture: preserve_enforcement
  # Safe-deletion-root allowlist for gate-dev-unsafe-deletion's
  # \`action.deletion_target_unresolvable\` clause (task d03af8f6): an
  # absolute deletion target inside one of these roots is allowed; a
  # relative path, an unexpanded \$VAR/~, or a traversal that normalizes
  # outside every root is gated. Shown explicitly even though it matches
  # the schema default (\`/tmp\`, \`/private/tmp\` — the two spellings this
  # harness's own scratchpad convention can use, macOS symlinks /tmp to
  # /private/tmp) so an operator sees the live config surface here rather
  # than having to know the schema default exists. An override REPLACES
  # this list, it does not merge with it. See docs/risk-gate.md.
  safe_deletion_roots:
    - /tmp
    - /private/tmp
  classifiers:
    - name: dangerous-shell
      tool: Bash
      patterns:
        - pattern: 'rm\\s+-rf\\s+(/|/var|/data|/mnt|~)'
          categories: [destructive, data_loss]
          severity: critical
        - pattern: 'DROP\\s+TABLE|TRUNCATE\\s+TABLE|DELETE\\s+FROM'
          categories: [destructive, data_loss]
          severity: high
        # Token-based, flag-tolerant: a flag between \`kubectl\` and
        # \`delete\` (e.g. \`kubectl --context=x delete namespace payments\`)
        # must not defeat the match, without matching \`kubectl
        # get\`/\`describe\` and without exponential-backtracking on a long
        # flag run. \`(?:\\s+-\\S+(?:\\s+(?!delete\\b)(?!-)\\S+)?)*\` consumes
        # zero or more \`-\`/\`--\` flag tokens (each optionally taking one
        # following, non-flag, non-"delete" value token), linear in
        # command length. See docs/risk-gate.md for the full rationale
        # and the earlier quadratic-alternation form this replaced.
        - pattern: 'kubectl(?:\\s+-\\S+(?:\\s+(?!delete\\b)(?!-)\\S+)?)*\\s+delete\\s+(namespace|deployment|statefulset|pvc)'
          categories: [destructive, infrastructure_change]
          severity: high
        # Same flag-tolerance treatment for terraform's own \`-chdir=DIR\`
        # global flag, which sits between the tool name and the
        # subcommand (\`terraform -chdir=infra destroy\`).
        - pattern: 'terraform(?:\\s+-\\S+(?:\\s+(?!destroy\\b)(?!-)\\S+)?)*\\s+destroy'
          categories: [destructive, infrastructure_change]
          severity: critical
        # Task 2929c5b7: unclassified commands no longer trivially
        # satisfy risk.severity_at_least: critical (see when-eval.ts and
        # docs/risk-gate.md's "Unclassified actions and the fail-close
        # rule") — kept in lockstep with docs/examples/full-manifest.yaml
        # by tests/cli/init-full-template-parity.test.ts.
        #
        # These patterns are the OPERATOR-EDITABLE MIRROR of the built-in
        # destructive floor (src/runtime/destructive-shell-floor.ts),
        # not the only line of defence: the floor ships in the binary and
        # already classifies these heads for an EXISTING manifest that
        # never adopts the patterns below. Edit, narrow, or raise these
        # freely: an operator pattern composes with the floor under
        # highest-severity-wins, so it can only add. The floor is
        # argv-aware where a regex cannot be (path-qualified and wrapped
        # spellings: /bin/dd, sudo dd, sh -c "dd ...", git -C <dir> push
        # -f), so a few spellings are caught by the floor alone; the
        # parity test in tests/runtime/destructive-shell-floor.test.ts
        # pins that everything caught HERE is also caught THERE, at the
        # same severity or higher.
        - pattern: '\\bdd\\s[^\\n]*\\bof='
          categories: [destructive, data_loss]
          severity: critical
        - pattern: '\\btruncate\\b[^\\n]*(\\s-[a-zA-Z]*s|--size)'
          categories: [destructive, data_loss]
          severity: critical
        - pattern: '\\bshred\\b'
          categories: [destructive, data_loss, irreversible_action]
          severity: critical
        - pattern: '\\bmkfs(\\.\\w+)?\\b'
          categories: [destructive, data_loss, infrastructure_change]
          severity: critical
        - pattern: '\\bfind\\b[^\\n]*-delete\\b'
          categories: [destructive, data_loss]
          severity: critical
        - pattern: '\\bfind\\b[^\\n]*-exec(dir)?\\s+rm\\b'
          categories: [destructive, data_loss]
          severity: critical
        - pattern: '\\bgit\\s+reset\\b[^\\n]*--hard\\b'
          categories: [destructive, data_loss]
          severity: high
        - pattern: '\\bgit\\s+push\\b[^\\n]*(--force(-with-lease)?\\b|\\s-f\\b)'
          categories: [destructive, production_mutation, deployment_change]
          severity: high
        - pattern: '\\bgit\\s+clean\\b[^\\n]*(--force\\b|\\s-[a-zA-Z]*f[a-zA-Z]*\\b)'
          categories: [destructive, data_loss]
          severity: high
        - pattern: '\\bgit\\s+checkout\\s+--\\s+\\.'
          categories: [destructive, data_loss]
          severity: high
        - pattern: '\\bgit\\s+restore\\s+\\.(\\s|$)'
          categories: [destructive, data_loss]
          severity: high
        - pattern: '\\b(chmod|chown)\\b[^\\n]*(\\s-[a-zA-Z]*R|--recursive\\b)'
          categories: [mass_update]
          severity: high
        - pattern: '\\bcurl\\b[^\\n]*(-X\\s*|--request[\\s=])(?![Gg][Ee][Tt]\\b)(?![Hh][Ee][Aa][Dd]\\b)[A-Za-z]'
          categories: [production_mutation, network_exfiltration]
          severity: high
        - pattern: '\\bcurl\\b[^\\n]*(\\s-[a-zA-Z]*[dFT]|--data\\b|--json\\b|--form(-string)?\\b|--upload-file\\b)'
          categories: [production_mutation, network_exfiltration]
          severity: high
        - pattern: '\\bcurl\\b[^\\n]*(\\s-[a-zA-Z]*[oODcK]|--output(-dir)?\\b|--remote-name\\b|--remote-header-name\\b|--dump-header\\b|--cookie-jar\\b|--config\\b|--create-dirs\\b|--etag-save\\b|--trace(-ascii)?\\b|--stderr\\b|(\\s-[a-zA-Z]*w\\b|--write-out\\b)[^\\n]*%output)'
          categories: [destructive, data_loss]
          severity: high
        - pattern: '\\bsed\\b[^\\n]*(\\s-[a-zA-Z]*i[a-zA-Z]*\\b|--in-place\\b)'
          categories: [destructive, data_loss]
          severity: high

environments:
  resolvers:
    - name: production-signals
      environment: production
      signals:
        branch_patterns: [main, "release/*"]
        env_var_patterns:
          - var: DATABASE_URL
            patterns: [prod, production]
        kube_context_patterns: [".*prod.*"]
        kube_namespace_patterns: [prod, production]
`;

import { parse as parseYaml } from "yaml";
import { parseManifest } from "../../schema/index.js";
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

/**
 * The NAMES of `operator_only` (kill-switch / security) policies the
 * current full template ships (task adf037c1). Parsed from FULL_TEMPLATE
 * itself — the single source of truth, kept honest by
 * tests/cli/init-full-template-parity.test.ts — so this set can never
 * drift from what `harness init --template full` actually writes; adding a
 * new operator_only policy to the template automatically extends it.
 *
 * Scope is deliberately operator_only-only (operator decision 2026-08-08):
 * these are the profile-independent security floor (the kill-switch
 * defenses) whose silent absence from an aged manifest is the incident
 * this drift check exists to surface. Non-operator_only full-template
 * policies are intentionally NOT enumerated here — flagging a solo/team
 * install for lacking full-only convenience policies it never had would be
 * noise. Memoized: the parse is pure and FULL_TEMPLATE is a build constant.
 */
let shippedOperatorOnlyCache: readonly string[] | undefined;
export function shippedOperatorOnlyPolicyNames(): readonly string[] {
  if (shippedOperatorOnlyCache === undefined) {
    const manifest = parseManifest(parseYaml(FULL_TEMPLATE));
    shippedOperatorOnlyCache = manifest.policies
      .filter((p) => p.operator_only === true)
      .map((p) => p.name);
  }
  return shippedOperatorOnlyCache;
}

/**
 * One shipped `bash_match` trigger's leading boundary-alternation group
 * (task 037cfb7c). Every FULL_TEMPLATE `bash_match` regex opens with a
 * parenthesized alternation of the shell-token boundaries it treats as
 * "start of a new command", e.g. `^|\n|;|\||&|\(` since v0.43.0 (task
 * d834a065, which narrowed the old `&&`-only boundary to `&` so a
 * backgrounded `sleep 0 & gh pr merge 1` is not missed). `level`
 * distinguishes a hook-level `hooks[].bash_match` trigger from a
 * policy-level `policies[].trigger.bash_match` trigger; the same name
 * can exist on both levels for logically-paired entries with no
 * collision (see the require- / review-...-bash hook/policy pairs in
 * the template).
 */
export interface BashMatchBoundaryEntry {
  level: "hook" | "policy";
  name: string;
  /** The alternation's inner content, e.g. `^|\n|;|\||&|\(` (no outer parens). */
  boundary: string;
}

// Matches the leading `(...)` group of a bash_match regex source string.
// Every shipped bash_match opens with the boundary-alternation group and
// none of its branches contain a literal `)` (parens inside are always
// escaped as `\(`), so a non-greedy scan to the first `)` is exact for
// every entry in FULL_TEMPLATE.
const BOUNDARY_GROUP_RE = /^\(([^)]*)\)/;

/**
 * Extracts the leading boundary-alternation group from a `bash_match`
 * regex source string (e.g. `"(^|\\n|;|\\||&|\\()..."` -> `"^|\\n|;|\\||&|\\("`).
 * Returns `undefined` when the string does not open with a parenthesized
 * group; defensive only, every shipped template entry does.
 *
 * Known limitation: the scan is not escape-aware, so an escaped closing
 * paren (`\\)`) inside the group would truncate the match early at that
 * `)` character instead of continuing past it. No shipped FULL_TEMPLATE
 * boundary contains one today; a future boundary that needs a literal
 * `)` inside the alternation would need this scan widened first.
 */
export function extractBashMatchBoundary(bashMatch: string): string | undefined {
  return BOUNDARY_GROUP_RE.exec(bashMatch)?.[1];
}

/**
 * Every FULL_TEMPLATE `hooks[]` / `policies[].trigger` entry that
 * declares a `bash_match`, paired with its boundary-alternation group
 * (task 037cfb7c). Parsed from FULL_TEMPLATE itself, the same
 * single-source-of-truth pattern as `shippedOperatorOnlyPolicyNames`
 * immediately above, so this list can never drift from what
 * `harness init --template full` actually writes; unlike
 * `shippedOperatorOnlyPolicyNames`, this one is pinned by its own
 * fixed-point test in tests/cli/doctor-trigger-boundary-drift.test.ts
 * (entry count and the literal shipped boundary), not by
 * tests/cli/init-full-template-parity.test.ts, which does not reference
 * it. Memoized: the parse is pure and FULL_TEMPLATE is a build constant.
 */
let shippedBashMatchBoundariesCache: readonly BashMatchBoundaryEntry[] | undefined;
export function shippedBashMatchBoundaries(): readonly BashMatchBoundaryEntry[] {
  if (shippedBashMatchBoundariesCache === undefined) {
    const manifest = parseManifest(parseYaml(FULL_TEMPLATE));
    const entries: BashMatchBoundaryEntry[] = [];
    for (const hook of manifest.hooks) {
      if (!hook.bash_match) continue;
      const boundary = extractBashMatchBoundary(hook.bash_match);
      if (boundary !== undefined) entries.push({ level: "hook", name: hook.name, boundary });
    }
    for (const policy of manifest.policies) {
      const bashMatch = policy.trigger.bash_match;
      if (!bashMatch) continue;
      const boundary = extractBashMatchBoundary(bashMatch);
      if (boundary !== undefined) entries.push({ level: "policy", name: policy.name, boundary });
    }
    shippedBashMatchBoundariesCache = entries;
  }
  return shippedBashMatchBoundariesCache;
}
