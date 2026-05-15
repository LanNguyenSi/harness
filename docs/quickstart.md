# Quickstart

From nothing to a Claude Code session gated by a policy you declared, in
about five minutes. This is the bare command path. For the *why* behind
each step, read [`for-humans.md`](for-humans.md).

## 1. Install

```bash
npm i -g @lannguyensi/harness   # Node 20 or newer
```

## 2. Generate a manifest

```bash
harness init --template team --config ~/.claude/harness.yaml
```

The `team` template ships a `review-before-merge` policy: no PR merge
without a logged review. (`--template solo` drops the agent-tasks
wiring; `harness init --interactive` walks you through the choices
instead.)

## 3. Check it

```bash
harness validate --config ~/.claude/harness.yaml
```

Expect `no validation findings`.

## 4. Preview the gate before wiring anything

```bash
harness dry-run "merge PR 42" \
  --tool mcp__agent-tasks__pull_requests_merge \
  --tool-args '{"prNumber":42}' \
  --config ~/.claude/harness.yaml
```

```
Policies that match:
  - name: review-before-merge
    ledgerQuery: review:42
    requires:
      ledger_tag: review:${PR_NUMBER}
    enforcement: block
    triggerEvent: PreToolUse
# ... (dry-run also lists the hooks that would fire and the memories that would route)
```

That is the policy that will block the merge at runtime. No files
touched yet.

## 5. Wire it into Claude Code

```bash
harness apply --target ~/.claude/settings.json --merge
```

`--merge` replaces only the harness-owned keys (`hooks`, `mcpServers`)
and preserves everything else in your `settings.json`. Restart Claude
Code so it reloads the file.

Prefer to see the generated files first? Run `harness apply` with no
`--target`: it writes them to `harness.generated/` next to the manifest,
records a `harness.lock`, and touches nothing else.

## Done

Once Claude Code has restarted (step 5), the gate is live. In that
session, `mcp__agent-tasks__pull_requests_merge` is blocked until a
`review:<pr-number>` entry exists in the evidence ledger. To inspect
decisions:

```bash
harness explain review-before-merge --trace   # why did this fire?
harness audit --since 1h                       # what fired recently?
```

## Next

- Change the rule or add your own: [`for-humans.md`](for-humans.md),
  "First hour: a real policy".
- Every manifest field, in one file:
  [`examples/full-manifest.yaml`](examples/full-manifest.yaml). This is
  a schema-coverage reference, not a runnable config: `validate` will
  flag the install-specific hook paths it references. The file's
  header explains what to expect.
- What an agent needs to know about the gates:
  [`for-agents.md`](for-agents.md).
