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
    # Floor at agent-preflight 0.1.1, the release that distinguishes
    # "tool not installed" (e.g. an npm script invoking eslint that is
    # not in devDependencies) from real lint/test/typecheck failures.
    # Stale 0.1.0 installs silently emit false-positive blockers that
    # keep the preflight-before-* policies closed forever. version_command
    # points at the source-of-truth preflight binary, not at the
    # \`harness session-start preflight\` wrapper.
    min_version: "0.1.1"
    version_command: ["preflight", "--version"]

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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${PR_NUMBER} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the PR diff, capture its verdict, then persist a ledger entry tagged with the PR number. The content should be self-contained enough for an auditor to read without re-opening the chat.
    ux:
      cannot: "You cannot merge PR #\${PR_NUMBER} yet."
      required:
        - "a recorded review of PR #\${PR_NUMBER}"
      run:
        - 'mcp__agent-grounding__ledger_add { sessionId: "\${SESSION_ID}", type: "fact", content: "review:\${PR_NUMBER} — <verdict + key findings + nits>" }'

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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review:\${BRANCH} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: Spawn a review subagent against the branch diff, capture its verdict, then persist a ledger entry tagged with the branch name. Mirror of the review-before-merge producer for the gh-cli surface.
    ux:
      cannot: "You cannot merge the PR for branch \${BRANCH} via \`gh pr merge\` yet."
      required:
        - "a recorded review of the PR for branch \${BRANCH}"
      run:
        - 'mcp__agent-grounding__ledger_add { sessionId: "\${SESSION_ID}", type: "fact", content: "review:\${BRANCH} — <verdict + key findings + nits>" }'

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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"dogfood:\${SESSION_ID} — <end-to-end smoke summary against the live system>", source:"manual smoke test"}'
        description: Before tagging or publishing, run the release path end-to-end against the live system (not just unit tests) and persist the result as a session-tagged ledger entry. Document what you exercised (install, CLI happy path, MCP handshake, etc.) so a future auditor can tell whether the smoke covered the change.
    ux:
      cannot: "You cannot publish a release yet."
      required:
        - "an end-to-end dogfood run in this session"
      run:
        - 'mcp__agent-grounding__ledger_add { sessionId: "\${SESSION_ID}", type: "fact", content: "dogfood:\${SESSION_ID} — <end-to-end smoke summary>" }'

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
        verb: mcp__agent-grounding__ledger_add
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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"preflight:\${REPO}", source:"manual"}'
        description: Direct ledger write. Use when the Bash hook is locked down (e.g. understanding-gate active) or when the standard producer is unavailable.
    ux:
      cannot: "You cannot investigate this repository yet."
      required:
        - "verified repository preflight"
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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review-subagent:\${TASK_ID} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: After running a review subagent against the staged diff, persist its verdict + load-bearing findings as a ledger entry tagged with the task UUID. The content should be self-contained enough to audit later without re-reading the chat.
    ux:
      cannot: "You cannot open a pull request for task \${TASK_ID} yet."
      required:
        - "a completed review-subagent pass on this task"
      run:
        - 'mcp__agent-grounding__ledger_add { sessionId: "\${SESSION_ID}", type: "fact", content: "review-subagent:\${TASK_ID} — <verdict + key findings + nits>" }'

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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"review-subagent:\${BRANCH} — <verdict + key findings + nits>", source:"Agent(general-purpose) review"}'
        description: After running a review subagent against the staged diff for the working branch, persist its verdict + load-bearing findings as a ledger entry tagged with the branch name. Mirror of the review-subagent-before-pr-create producer for the gh-cli surface.
    ux:
      cannot: "You cannot open a pull request for branch \${BRANCH} via \`gh pr create\` yet."
      required:
        - "a completed review-subagent pass on branch \${BRANCH}"
      run:
        - 'mcp__agent-grounding__ledger_add { sessionId: "\${SESSION_ID}", type: "fact", content: "review-subagent:\${BRANCH} — <verdict + key findings + nits>" }'

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
        verb: mcp__agent-grounding__ledger_add
        example: '{sessionId:"\${SESSION_ID}", type:"fact", content:"preflight:\${BRANCH} head:<full-sha> — <summary of what is on the branch + smoke results>", source:"manual"}'
        description: Direct ledger write. Include head:<full-sha> if you want the entry to count under at_head; the branch is the WIP review surface and the content should summarise what is staged + the smoke evidence so a reviewer can audit later without re-reading the chat.
    ux:
      cannot: "You cannot push branch \${BRANCH} yet."
      required:
        - "a preflight for \${BRANCH} at the current HEAD (any age) OR any preflight within the last 10 minutes. Re-run \`harness preflight\` if you committed since the last preflight AND it has been more than 10 minutes."
      run:
        - "harness preflight"

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
      ux:
        cannot: "You cannot use write-capable tools yet."
        required:
          - "an approved Understanding Report for this session"
        run:
          - "Write an Understanding Report covering: Current Understanding, Intended Outcome, Derived Todos, Acceptance Criteria, Assumptions, Open Questions, Out Of Scope, Risks, Verification Plan"
          - "Run \`harness approve understanding\` and approve the prompt"
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
  # or a \`branch-protection-ack:<reason>\` override the operator writes
  # via mcp__agent-grounding__ledger_add for deliberate protected-branch
  # edits (version bumps, CI workflow patches, hotfixes).
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
      ux:
        cannot: "You cannot edit files on protected branch \${BRANCH} yet."
        required:
          - "a checkout of a non-protected branch (current \`\${BRANCH}\` is protected)"
        run:
          - "git checkout -b feat/<your-task>"
          - "harness session-start branch-check"
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
