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
# init): agent-tasks-mcp-bridge, grounding-mcp, memory-router-*,
# understanding-gate-claude-*.

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
#
# The \`git-preflight\` SessionStart hook is the producer side of the
# \`preflight-before-*\` policies: \`harness session-start preflight\` runs
# agent-preflight against the session cwd and, on a ready:true result,
# records \`preflight:\${REPO}\` to the evidence ledger. It needs the
# \`preflight\` binary on PATH (\`npm i -g @lannguyensi/agent-preflight\`); when
# that is absent the hook logs to stderr and exits 0, so the session is
# never broken — the preflight gates just stay closed until a tag is
# produced some other way.
hooks:
  - name: git-preflight
    event: SessionStart
    command: harness session-start preflight
    blocking: false
    # 70s budget gives the wrapped preflight (default 60s) headroom plus
    # ledger-write time. Was 30s through v0.17.4, but a healthy preflight
    # on a medium-size repo takes ~28s and the old 25s wrapper ceiling
    # blew through it. Bumped together with DEFAULT_PREFLIGHT_TIMEOUT_MS
    # (agent-tasks/7265599e).
    budget_ms: 70000
    # Floor at agent-preflight 0.2.0, the release that makes secret
    # detection git-aware and diff-scoped: a gitignored+untracked .env,
    # a .md doc, a non-git dir, or a secret in a tracked file the branch
    # never touched is a non-blocking warn, not a hard fail. Pre-0.2.0
    # installs hard-fail preflight on the normal correct state (a
    # gitignored .env holding real credentials), so this SessionStart
    # producer never writes a preflight: tag and the preflight-before-*
    # policies stay closed forever on any repo with a local .env. (0.1.1
    # had already fixed the wrapper-script "tool not installed" false
    # positive.) version_command points at the source-of-truth preflight
    # binary, not at the \`harness session-start preflight\` wrapper.
    min_version: "0.2.0"
    version_command: ["preflight", "--version"]

  # toolchain-parity (PATH-shim incident 2026-07-22 follow-up): writes THIS
  # machine's toolchain snapshot (node version, npm globals, OW-Kit
  # version, MCP server names) to \`toolchain_parity.machine_state_dir\`
  # and advisorily compares it against every peer machine's snapshot
  # already there, warning on drift (version mismatches, missing
  # packages, node/OW-Kit drift, MCP-name differences). Purely advisory —
  # no policy consumes the \`toolchain-parity:\` ledger fact this writes,
  # it exists for \`harness audit\`/operator visibility only. DISABLED by
  # default (no \`toolchain_parity:\` block above): opt in with
  # \`toolchain_parity: { enabled: true }\` (machine_state_dir/profile/
  # workspace_root all have sane defaults — see docs/CLI.md). No external
  # binary to floor-check (node/npm are assumed present already), so
  # unlike git-preflight this hook carries no min_version/version_command.
  - name: toolchain-parity
    event: SessionStart
    command: harness session-start toolchain-parity
    blocking: false
    # node --version + npm ls -g run in parallel (bounded ~2s/~4s each);
    # plus two near-instant file reads and a ledger write. 10s leaves
    # comfortable headroom over the normal-case sub-5s wall time without
    # approaching git-preflight's 70s (which wraps a full external test
    # suite, a fundamentally heavier operation this hook never performs).
    budget_ms: 10000

  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  # Tool-agnostic parallel of require-review-evidence for operators on the
  # gh-cli workflow (\`gh pr merge\`) instead of agent-tasks MCP. Same generic
  # \`harness policy intercept\` entrypoint; the matching review-before-merge-bash
  # policy below picks up the trigger. A PolicyTrigger can only AND-match one
  # surface (MCP tool-name OR Bash command), so two parallel definitions are
  # the minimum-scope way to cover both PR surfaces without bumping the schema.
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  - name: require-dogfood-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)'
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  - name: require-preflight-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

  - name: require-review-subagent-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_create"
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  # Bash-surface parallel of require-review-subagent-evidence for operators
  # who open PRs with \`gh pr create\` instead of agent-tasks MCP. The matching
  # review-subagent-before-pr-create-bash policy below tags by branch
  # (\`review-subagent:\${BRANCH}\`) because no task UUID is in \`gh pr create\`
  # arguments; the working branch is the closest stable handle for "the
  # PR-in-progress" at this point in the cycle.
  - name: require-review-subagent-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr create\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 2000

  - name: require-preflight-push-evidence
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

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
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S*\\s+)*(?:npx\\s+|\\S*/)?harness\\s+(["\\x27]?)(?:pause|resume|gate\\s+(["\\x27]?)(?:disable|enable)\\4)\\3(?![\\w-])'
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

  - name: deny-session-env-strip-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S*\\s+)*(env\\b[^;\\n|&]*-u\\s*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|env\\b[^;\\n|&]*--unset(?:=|\\s+)(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|unset\\s+(\\S+\\s+)*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)=(?=\\s))'
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

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
    bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S*\\s+)*(tee|cp)\\b[^;\\n|&]*\\.harness-paused\\b|>{1,2}\\s*\\S*\\.harness-paused\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 1000

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
    budget_ms: 2000

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
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
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

  - name: dogfood-before-release
    description: Block npm publish / git tag v* without a recent dogfood ledger entry.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)'
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

  - name: preflight-before-investigation
    description: Block investigative git reads (status/log/diff/branch) when agent-preflight has not run recently with ready:true for the current repo.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b'
    requires:
      ledger_tag: "preflight:\${REPO}"
      within: 1h
    hook: require-preflight-evidence
    enforcement: block
    producers:
      - kind: bash
        command: harness session-start preflight
        description: Runs agent-preflight against the current cwd; on ready:true, records preflight:\${REPO} to the ledger. Standard producer.
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"preflight:\${REPO}", source:"manual"}'
        description: Direct ledger write. Use when the Bash hook is locked down (e.g. understanding-gate active) or when the standard producer is unavailable.
    ux:
      cannot: "You cannot investigate this repository yet."
      required:
        - "verified repository preflight"
        - "an approved Understanding Report, if the Understanding Gate is still active (it blocks \`harness preflight\` itself)"
      run:
        - "harness preflight"

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
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr create\\b'
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

  - name: preflight-before-push
    description: Block git push unless a fresh preflight ledger entry exists for the current branch. Catches the stale-checkout class of incident at the last reversible step.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b'
    requires:
      ledger_tag: "preflight:\${BRANCH}"
      within: 10m
      # at_head:true lets a preflight at the current HEAD satisfy the
      # gate at any age (the standard producer writes head:<sha> into
      # the tag content). The 10m window remains the freshness ceiling
      # for the head-mismatch case (operator switched branch, preflight
      # predates HEAD shift, runtime couldn't resolve a sha).
      at_head: true
    hook: require-preflight-push-evidence
    enforcement: block
    producers:
      - kind: bash
        command: harness session-start preflight
        description: Runs agent-preflight against the current cwd; on ready:true, records preflight:\${BRANCH} ready:true confidence:<n> head:<sha> to the ledger. Standard producer.
      - kind: mcp
        verb: mcp__grounding-mcp__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"preflight:\${BRANCH} head:<full-sha> — <summary of what is on the branch + smoke results>", source:"manual"}'
        description: Direct ledger write. Include head:<full-sha> if you want the entry to count under at_head; the branch is the WIP review surface and the content should summarise what is staged + the smoke evidence so a reviewer can audit later without re-reading the chat.
    ux:
      cannot: "You cannot push branch \${BRANCH} yet."
      required:
        - "a preflight for \${BRANCH} at the current HEAD (any age) OR any preflight within the last 10 minutes. Re-run \`harness preflight\` if you committed since the last preflight AND it has been more than 10 minutes."
        - "if solution-acceptance is enabled, a ready HEAD-pinned verdict at the SAME commit too (run \`solution_evaluate\`). \`git push\` trips both gates, so commit first if the tree is dirty, then satisfy both at one HEAD."
        - "an approved Understanding Report, if the Understanding Gate is still active (it blocks \`harness preflight\` itself)"
      run:
        - "harness preflight"

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
        - "Session-wide kill switch: the OPERATOR runs \`harness pause --for <duration>\` instead, from a terminal outside this agent session (every gate silences until the sentinel expires or \`harness resume\` runs); you cannot run \`harness pause\`/\`harness resume\` yourself, that is denied at the Bash-tool level."
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
  # \`time\`, \`timeout\`, \`stdbuf\`, \`setsid\`, leading VAR=value) and
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
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S*\\s+)*(?:npx\\s+|\\S*/)?harness\\s+(["\\x27]?)(?:pause|resume|gate\\s+(["\\x27]?)(?:disable|enable)\\4)\\3(?![\\w-])'
    operator_only: true
    hook: deny-kill-switch-bash
    enforcement: block
    ux:
      cannot: "You cannot run \`harness pause\`, \`harness resume\`, \`harness gate disable\`, or \`harness gate enable\`."
      required:
        - "the OPERATOR to run this from a terminal genuinely outside your agent session, not a \`! \`-prefixed Claude Code shell, which inherits this session's env and stdin and does not count"
      run:
        - "Stop. Explain to the operator what you were trying to do and why, and let THEM decide whether to pause/resume/toggle a gate from their own terminal. This is the only way to unblock this gate: it is an unconditional deny (operator_only: true) that no in-session evidence — a ledger write, a marker file, a flag — can ever satisfy; the only remaining gap is bash_match's regex coverage of exotic shell shapes, not this evaluation (see docs/okf/pause-vs-gate-kill-switch.md)."

  - name: deny-session-env-strip
    description: Deny Bash attempts to strip or unset the agent-session env vars that harness pause/resume check (\$CLAUDE_CODE_SESSION_ID, \$CLAUDE_SESSION_ID, \$CODEX_SESSION_ID). Closes the one-liner that otherwise defeats refuseIfAgentShell.
    trigger:
      event: PreToolUse
      match: "Bash"
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S*\\s+)*(env\\b[^;\\n|&]*-u\\s*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|env\\b[^;\\n|&]*--unset(?:=|\\s+)(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|unset\\s+(\\S+\\s+)*(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)\\b|(CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CODEX_SESSION_ID)=(?=\\s))'
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
      bash_match: '(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S*\\s+)*(tee|cp)\\b[^;\\n|&]*\\.harness-paused\\b|>{1,2}\\s*\\S*\\.harness-paused\\b'
    operator_only: true
    hook: deny-sentinel-write-bash
    enforcement: block
    ux:
      cannot: "You cannot write to the harness pause sentinel file (.harness-paused)."
      required:
        - "the OPERATOR to run \`harness pause\`/\`harness resume\` themselves, from a terminal outside your agent session, never a direct write to the sentinel file"
      run:
        - "Stop. Do not write, redirect, tee, or copy anything to .harness-paused. Ask the OPERATOR to run harness pause / harness resume themselves if the session genuinely needs gates silenced. This gate is an unconditional deny (operator_only: true); see docs/okf/pause-vs-gate-kill-switch.md for the honest trust model and the residual bash_match coverage gap."

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
      # Producers (agent-tasks/25bced52): rendered into the gate's deny
      # envelope by the same engine as policy producers. Constraint at
      # this layer: at-least-one \`ask\`. Post-v0.14.0 the gate signal
      # is a filesystem marker and the mcp ledger_add path no longer
      # satisfies the gate; the canonical unblock surface is the
      # operator-approval prompt.
      #
      # KEEP IN SYNC (task 68b9ad9c): this text must match
      # defaultProducers() in
      # src/policy-packs/builtin/understanding-before-execution.ts —
      # that function is what \`harness pack reseed\` and \`harness doctor\`'s
      # divergence warning treat as "the shipped template". A wording fix
      # landed here without updating defaultProducers() would make reseed
      # silently pull operators BACK to the stale wording. Pinned by
      # tests/cli/init-templates-ux-parity.test.ts.
      producers:
        - kind: ask
          command: harness approve understanding
          description: "Bare command, no pipes or chaining. The hook recognises it via isEscapeCommand and emits permissionDecision:ask; the operator's go on that prompt IS the gate approval. Golden path."
        - kind: bash
          command: harness approve understanding
          description: Same command from any un-hooked terminal (operator only, not reachable from inside the gated session). Writes the canonical marker at harness.generated/.approvals/\${SESSION_ID}.
      # ux (agent-tasks/e48e3b45): replaces the legacy engine-vocabulary
      # deny envelope with the plain-language { cannot, required, run }
      # shape. Engine details (the BLOCK reason naming session id /
      # marker / report state) still land in stderr for operator audit;
      # the agent only sees this.
      #
      # KEEP IN SYNC (task 68b9ad9c): see the producers: comment above —
      # same rationale applies here, against defaultUx("grill_me") in the
      # same builtin module.
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan, Prior Art (state what you searched for an existing solution and what you found, with an explicit adopt-or-build judgment)"
          - "Run \`harness approve understanding\` with the report attached as a quoted heredoc (harness approve understanding <<'UNDERSTANDING_REPORT' ...report... UNDERSTANDING_REPORT) so it is persisted for audit, then approve the prompt; the heredoc is the only extra shell shape the gate allows (no pipes, chaining, or other redirection)"
      # approval_lifecycle (agent-tasks/d8ee60ca + harness/f54e0ecb,
      # v0.18.0+): expire the approval marker on task-completion
      # boundaries so a multi-task session re-prompts for an
      # Understanding Report between tasks. Without this the legacy
      # "one approval per session" contract lets a stale interpretation
      # drive the next task's edits.
      #
      # Full ships both boundary kinds: the agent-tasks MCP verbs for
      # operators on that workflow, plus a Bash regex list for hybrid
      # operators who also use gh-cli for PR mechanics. \`max_age\` is
      # the safety net. Operators who prefer the legacy per-session
      # behaviour opt out with \`approval_lifecycle: { mode: session }\`.
      # Operators on other task systems override the matchers.
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

  # branch-protection (agent-tasks/2fdc5bbe, default-enabled since v0.17.2):
  # blocks Write/Edit (claude-code) or apply_patch (codex) on protected
  # branches (default: master, main, develop). Complements
  # preflight-before-push, which fires at the LAST reversible step;
  # branch-protection fires at the FIRST source mutation, catching the
  # \"forgot to branch off master\" pattern earlier in the cycle.
  #
  # Two satisfying signals: a fresh \`branch:non-protected:<branch>\` tag
  # from the SessionStart producer (\`harness session-start branch-check\`),
  # or the operator-only override marker written by
  # \`harness approve branch-protection --session <id>\` for deliberate
  # protected-branch edits (version bumps, CI workflow patches, hotfixes).
  # A branch-protection-ack ledger tag is no longer a sufficient override
  # on its own (it is agent-writable); the marker file is the trusted signal.
  #
  # Fails closed (any load / parse / ledger error refuses). Disable by
  # setting \`enabled: false\` or removing this entry if your workflow
  # routinely edits master directly. Override the protected list via
  # \`config.protected_branches\`. Full reference:
  # docs/policy-packs/branch-protection.md.
  - name: branch-protection
    source: builtin
    enabled: true
    description: Block Write/Edit on protected branches (master, main, develop) at the first source mutation.
    config:
      # ux (agent-tasks/9806d4f8): replaces the legacy
      # "branch-protection: refusing ..." envelope with the
      # plain-language { cannot, required, run } shape. Engine details
      # (the BLOCK reason naming session id / freshness window) stay
      # on stderr for operator audit.
      #
      # KEEP IN SYNC (task 68b9ad9c): this text must match defaultUx() in
      # src/policy-packs/builtin/branch-protection.ts — see the identical
      # note on the understanding-before-execution pack above for why.
      # Pinned by tests/cli/init-templates-ux-parity.test.ts.
      ux:
        cannot: "You cannot edit files on protected branch \${BRANCH} yet."
        required:
          - "a checkout of a non-protected branch (current \`\${BRANCH}\` is protected)"
        run:
          - "git checkout -b feat/<your-task>"
          - "harness session-start branch-check"

  # solution-acceptance (harness cc43c7a4): Verifier-gated Done. Gates the
  # task-finishing tools (agent-tasks completion verbs + git push / gh pr
  # merge) on a ready, HEAD-pinned verdict that the grounding-mcp producer
  # (solution_evaluate) derives from a real preflight run, plus an
  # anti-forgery write-guard on the verdict marker. DISABLED by default: it
  # is a hard completion-gate and needs grounding-mcp (>= 0.3.2) under
  # tools.mcp plus the preflight binary on PATH. Flip enabled: true once the
  # producer is wired and you want completion earned, not claimed. The pack
  # emits its own instructions.md on apply; harness validate warns if you
  # enable it without the producer.
  - name: solution-acceptance
    source: builtin
    enabled: false
    description: Gate task completion on a ready, HEAD-pinned solution-acceptance verdict earned from a real preflight run.

  # post-merge-gate (harness T-001, post-merge-gate): catches "kept working
  # on a branch after it was already merged" — a PostToolUse producer
  # records a merged-tip fact on a successful \`gh pr merge\`; a PreToolUse
  # blocker denies curated history-mutating commands (git commit/add/push/
  # merge/rebase/cherry-pick/revert/reset/stash pop|apply, gh pr create/
  # merge) while the current branch tip still exactly matches that
  # recorded tip. An escape allowlist (git switch/checkout/pull/fetch,
  # git branch -d/-D, git stash list/show, any \`harness ...\` command) is
  # checked first, unconditionally, before any manifest or ledger access —
  # the recovery path this gate itself recommends can never be starved.
  # Fails OPEN (unlike branch-protection) when the ledger is unreachable.
  # DISABLED by default: a fresh gate, opt in once you've reviewed the
  # curated command list for your workflow. Full reference:
  # docs/policy-packs/post-merge-gate.md.
  - name: post-merge-gate
    source: builtin
    enabled: false
    description: Deny curated history-mutating git/gh commands on a branch whose current tip was already merged.
    config:
      # ux: replaces the legacy "post-merge-gate: refusing ..." envelope
      # with the plain-language { cannot, required, run } shape.
      #
      # KEEP IN SYNC: this text must match defaultUx() in
      # src/policy-packs/builtin/post-merge-gate.ts — see the identical
      # note on the branch-protection pack above for why. Pinned by
      # tests/cli/init-templates-ux-parity.test.ts.
      ux:
        cannot: "You cannot run \${TOOL_NAME} on branch \${BRANCH} yet — its current tip was already merged."
        required:
          - "a branch tip that is not sitting at an already-merged commit (switch off \`\${BRANCH}\`, or move its tip with a new commit)"
        run:
          - "git switch \${DEFAULT_BRANCH}"
          - "git pull --ff-only"
          - "git branch -d \${BRANCH}  # optional cleanup"

# Phase 7 Risk Gate vocabulary. The dangerous-shell classifier and
# production-signals resolver feed the gate-prod-destructive policies
# above: \`harness policy intercept\` builds the Action Envelope,
# classifies the action against \`risk.classifiers[]\`, resolves the
# target environment against \`environments.resolvers[]\`, and evaluates
# each policy's \`when:\` clauses against the result. Full design and the
# decision model: docs/risk-gate.md.
risk:
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
        - pattern: 'kubectl\\s+delete\\s+(namespace|deployment|statefulset|pvc)'
          categories: [destructive, infrastructure_change]
          severity: high
        - pattern: 'terraform\\s+destroy'
          categories: [destructive, infrastructure_change]
          severity: critical

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
