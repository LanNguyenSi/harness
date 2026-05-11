# Pandora session bootstrap

A real-world example of wiring harness v0.8.0 into an existing Claude Code session that already had memory-router + understanding-gate installed as hand-edited hooks. Done on 2026-05-11 against the `/home/lan/git/pandora` working tree.

The goal was the README's load-bearing claim:

> a `mcp__agent-tasks__pull_requests_merge` call against a session without a `review:${PR_NUMBER}` ledger entry refuses

Before harness, that gate did not exist. After this bootstrap, it does, dogfooded end-to-end against the live `grounding-mcp` evidence ledger.

## Starting state

- Claude Code session with hand-edited `~/.claude/settings.json`:
  - `UserPromptSubmit` hooks: `memory-router-user-prompt-submit`, `understanding-gate-claude-hook`
  - `PreToolUse` hook on `Bash`: `memory-router-pre-tool-use`
  - No PR-merge gate.
- `agent-grounding` MCP registered project-level in `~/.claude.json` with command `grounding-mcp` (linked to the local `agent-memory` workspace).
- No `harness` CLI installed yet; no manifest anywhere.

## Bootstrap steps

```bash
# 1. Backup the existing settings.json
cp ~/.claude/settings.json ~/.claude/settings.json.pre-harness-2026-05-11

# 2. Install the CLI
npm i -g @lannguyensi/harness

# 3. Bootstrap a minimal manifest, then adopt the existing hooks
harness init --template minimal --config ~/.claude/harness.yaml
harness adopt ~/.claude/settings.json --yes
# → adopted 3 hooks: memory-router-user-prompt-submit, understanding-gate-claude-hook, memory-router-pre-tool-use
```

## Manifest extensions

Two things the bare `adopt` does not yet handle:

1. The merge-gate hook (`harness policy intercept`) and the `review-before-merge` policy.
2. Declaring `grounding-mcp` so the policy engine has a ledger to query. Without this declaration, `harness validate` warns:

   > policies declared but grounding-mcp not wired: every policy will fire in degraded warn-mode at runtime

The final manifest at `~/.claude/harness.yaml`:

```yaml
version: 1

memory:
  directories:
    - path: /home/lan/.claude/projects/-home-lan-git-pandora/memory
      scope: project

tools:
  mcp:
    - name: grounding-mcp
      command: [grounding-mcp]
      enabled: true
      health:
        verb: ledger_summary
        timeout_ms: 5000

  builtin:
    known: [Read, Edit, Write, Bash, Agent, Skill, TaskCreate, Glob, Grep]

hooks:
  - name: memory-router-user-prompt-submit
    event: UserPromptSubmit
    command: memory-router-user-prompt-submit
    blocking: false

  - name: understanding-gate-claude-hook
    event: UserPromptSubmit
    command: understanding-gate-claude-hook
    blocking: false

  - name: memory-router-pre-tool-use
    event: PreToolUse
    command: memory-router-pre-tool-use
    blocking: false
    match: Bash

  - name: harness-policy-intercept
    event: PreToolUse
    command: harness policy intercept
    blocking: hard
    budget_ms: 5000
    match: "mcp__agent-tasks__pull_requests_merge"

policies:
  - name: review-before-merge
    description: |
      Block mcp__agent-tasks__pull_requests_merge unless the current session
      has logged a `review:${PR_NUMBER}` evidence-ledger entry.
    trigger:
      event: PreToolUse
      match: "mcp__agent-tasks__pull_requests_merge"
      extract:
        PR_NUMBER: "toolArgs.prNumber"
    requires:
      ledger_tag: "review:${PR_NUMBER}"
    hook: harness-policy-intercept
    enforcement: block
```

`harness validate` then reports `no validation findings`. `harness doctor --shallow` shows the four hooks, one MCP, one policy.

## Apply

```bash
harness apply --target ~/.claude/settings.json --merge
# → applied 0 file(s):
#   merged into ~/.claude/settings.json: replaced 1 owned key (hooks), preserved 6 other keys
#   harness.lock written to ~/.claude/harness.lock
#   restart hint: mcp servers changed; /mcp reconnect required
```

`permissions`, `enabledPlugins`, `effortLevel`, `skipDangerousModePermissionPrompt`, `bypassPermissions`, and `env` were preserved verbatim. Only `hooks` was rewritten, and `mcpServers` added.

## Dogfood probe

Three deterministic intercepts via stdin, against the same `grounding-mcp` instance Claude Code uses:

```bash
# Probe A: PR 99, no ledger entry yet → must deny
echo '{"hook_event_name":"PreToolUse","session_id":"default","tool_name":"mcp__agent-tasks__pull_requests_merge","tool_input":{"prNumber":99}}' \
  | harness policy intercept
# → {"decision":"deny","reason":"review-before-merge: no matching ledger entry for tag `review:99`"}

# Add a ledger entry for PR 99
# (via mcp__agent-grounding__ledger_add — sessionId="default", content includes "review:99")

# Probe B: PR 99, ledger entry present → must allow
echo '...prNumber":99}}' | harness policy intercept
# → (empty stdout, exit 0)

# Probe C: PR 100, no ledger entry for 100 → must still deny (cross-PR isolation)
echo '...prNumber":100}}' | harness policy intercept
# → {"decision":"deny","reason":"review-before-merge: no matching ledger entry for tag `review:100`"}
```

`harness audit --since 5m` confirmed the three rows landed correctly:

```
timestamp            policy               outcome  reason
-------------------  -------------------  -------  ---------------------------------------------
2026-05-11 19:38:22  review-before-merge  deny     no matching ledger entry for tag `review:99`
2026-05-11 19:39:16  review-before-merge  allow    1 matching ledger entry for tag `review:99`
2026-05-11 19:39:22  review-before-merge  deny     no matching ledger entry for tag `review:100`
```

## Gotchas worth knowing

- **Session-id resolution.** `harness policy intercept` reads the session id from (1) the hook event's `session_id` field, (2) `$CLAUDE_SESSION_ID` env, (3) literal `"default"`. Probe stdin must include `session_id` or the runtime falls back to `"default"`, which may or may not match where you wrote the ledger entry.
- **mcpServers double-registration.** `harness apply` writes `mcpServers.grounding-mcp` into user-level `~/.claude/settings.json`. If your `~/.claude.json` already registers the same binary project-level under a different name (e.g. `agent-grounding`), both run side by side. Functional but redundant. A clean fix is to delete the project-level entry and let harness own the registration end to end, once you trust the manifest path.
- **Settings-edit window.** Hooks load on session start. After `harness apply`, an in-flight Claude Code session will not see the new merge-gate hook until restart. End-to-end real-merge dogfood needs a fresh session.
- **memory.router warning.** `harness doctor` still warns `no memory router declared` because this manifest only fills `memory.directories`. Cosmetic; doesn't affect policy execution.

## Rollback

```bash
cp ~/.claude/settings.json.pre-harness-2026-05-11 ~/.claude/settings.json
rm ~/.claude/harness.yaml ~/.claude/harness.lock
rm -rf ~/.claude/harness.generated
```
