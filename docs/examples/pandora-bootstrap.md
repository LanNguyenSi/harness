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
harness init --template minimal --config ~/.harness/harness.yaml
harness adopt ~/.claude/settings.json --yes
# → adopted 3 hooks: memory-router-user-prompt-submit, understanding-gate-claude-hook, memory-router-pre-tool-use
```

## Manifest extensions

Two things the bare `adopt` does not yet handle:

1. The merge-gate hook (`harness policy intercept`) and the `review-before-merge` policy.
2. Declaring `grounding-mcp` so the policy engine has a ledger to query. Without this declaration, `harness validate` warns:

   > policies declared but grounding-mcp not wired: every policy will fire in degraded warn-mode at runtime

The final manifest at `~/.harness/harness.yaml`:

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
```

Stdout against a fresh target (the apply is idempotent, so re-applying after this prints `no changes`):

```
applied 0 file(s):
merged into ~/.claude/settings.json: replaced 1 owned key (hooks), added 1 (mcpServers), preserved 6 other keys
harness.lock written to ~/.harness/harness.lock

wired into ~/.claude/settings.json
verify: claude -p "say hi" --settings ~/.claude/settings.json --output-format stream-json --include-hook-events
```

`permissions`, `enabledPlugins`, `effortLevel`, `skipDangerousModePermissionPrompt`, `bypassPermissions`, and `env` were preserved verbatim. `hooks` was rewritten wholesale, `mcpServers` was added. Two further files were written next to the manifest as the rendered baseline, useful for `harness diff --since-apply` later:

- `~/.harness/harness.generated/settings.json`
- `~/.harness/harness.generated/MEMORY.md`

When subsequent applies change which MCP servers are declared, harness prints a `restart hint: mcp servers changed; /mcp reconnect required` line to stderr. The first apply on a clean target does not emit that hint.

## Dogfood probe

Three deterministic intercepts via stdin, against the same `grounding-mcp` instance Claude Code uses:

```bash
# Probe A: PR 99, no ledger entry yet → must deny
echo '{"hook_event_name":"PreToolUse","session_id":"default","tool_name":"mcp__agent-tasks__pull_requests_merge","tool_input":{"prNumber":99}}' \
  | harness policy intercept
# → {"decision":"block","reason":"review-before-merge: no matching ledger entry for tag `review:99`","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}

# Add a ledger entry for PR 99
# (via mcp__grounding-mcp__ledger_add, sessionId="default", content includes "review:99")

# Probe B: PR 99, ledger entry present → must allow
echo '{"hook_event_name":"PreToolUse","session_id":"default","tool_name":"mcp__agent-tasks__pull_requests_merge","tool_input":{"prNumber":99}}' \
  | harness policy intercept
# → (empty stdout, exit 0)

# Probe C: PR 100, no ledger entry for 100 → must still deny (cross-PR isolation)
echo '{"hook_event_name":"PreToolUse","session_id":"default","tool_name":"mcp__agent-tasks__pull_requests_merge","tool_input":{"prNumber":100}}' \
  | harness policy intercept
# → {"decision":"block","reason":"review-before-merge: no matching ledger entry for tag `review:100`","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
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
- **settings.json's `mcpServers` block is inert; the live registry is `~/.claude.json`.** Earlier `harness apply` wrote `mcpServers.grounding-mcp` into user-level `~/.claude/settings.json` — but Claude Code never reads that key for user-scope MCP registration, so a project-level entry for the same binary under a different name (e.g. `agent-grounding`) in `~/.claude.json` was never "redundant but functional" alongside it; the settings.json copy simply did nothing. Since task `init-mcp-wiring-claude-code`, `harness init --interactive` registers `tools.mcp[]` servers directly into `~/.claude.json`'s user-scope registry via `claude mcp add-json --scope user` (requires the `claude` CLI on `$PATH`) and migrates the dead settings.json block away once that registration succeeds. **Migrating an existing install:** re-run `harness init --interactive` (or check `harness doctor`'s "Claude Code MCP Registration" section, which flags both a missing live registration and a leftover dead settings.json block) to pick up the fix on a manifest set up before it shipped.
- **Settings-edit window.** Hooks load on session start. After `harness apply`, an in-flight Claude Code session will not see the new merge-gate hook until restart. End-to-end real-merge dogfood needs a fresh session.
- **memory.router warning.** `harness doctor` still warns `no memory router declared` because this manifest only fills `memory.directories`. Cosmetic; doesn't affect policy execution.

## Rollback

```bash
# Dry-run first: print every harness-owned artefact under ~/.claude/,
# including any harness-owned MCP server names currently registered with
# the claude CLI (~/.claude.json — the live registry, not the dead
# settings.json mcpServers block; see the gotcha above).
harness uninstall

# Tear down: removes the manifest, lock, harness.generated/, harness-owned
# hook groups and mcpServers entries from settings.json, AND deregisters
# harness-owned MCP servers from the claude CLI's user-scope registry via
# `claude mcp remove --scope user <name>` — restoring the pre-install state
# symmetrically on both sides (dead settings.json block + live registry).
# Writes a reversible settings.json backup + snapshot next to settings.json
# (the registry deregistration itself is a `claude mcp remove` call, not a
# file harness owns, so it isn't part of that backup/snapshot).
harness uninstall --apply

# If the `claude` CLI isn't on PATH, uninstall does not hard-fail: it warns
# and prints copy-pasteable commands instead, e.g.:
#   claude mcp remove --scope user grounding-mcp
# Run these yourself once the CLI is available.

# Alternative: if you kept the pre-install backup from the install step,
# atomically restore it instead of selective removal (this still
# deregisters harness-owned MCP servers from the live registry as above).
harness uninstall --restore-from ~/.claude/settings.json.pre-harness-2026-05-11

# Finally, drop the CLI itself (harness uninstall does not touch npm):
npm uninstall -g @lannguyensi/harness
```
