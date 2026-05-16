# Policy Pack: `branch-protection`

Block `Write`/`Edit` (claude-code) or `apply_patch` (codex) when the
agent is about to mutate source on a protected branch. The gate fires
at the **first** source mutation, complementing
`preflight-before-push` (which fires at the last reversible step).

Motivating incident: a session that branches AFTER it has already
edited master leaves an uncommitted diff on master that a second
session only notices on the next `git checkout master`. Recovery
requires stash + branch + commit-rewrite, strictly worse than
branching upfront.

## Status

Opt-in. Not wired by any init template. Enable with:

```bash
harness pack add branch-protection
harness apply
```

## How it works

The pack contributes two hooks to `settings.json`:

1. **SessionStart producer** (`harness session-start branch-check`,
   `blocking: false`): reads the cwd's `.git/HEAD`. When the branch is
   NOT in the protected list, writes a `branch:non-protected:<branch>`
   fact to the evidence ledger for the current session.

2. **PreToolUse blocker** (`harness pack hook branch-protection`,
   `blocking: hard`) on `Write|Edit` (claude-code) or `apply_patch`
   (codex): consults the ledger and emits a deny envelope unless
   EITHER
   - a `branch:non-protected` tag exists from within the last
     5 minutes, OR
   - a `branch-protection-ack:<reason>` override tag exists (any age).

The 5-minute freshness window lets a single branch-check satisfy a
whole edit batch without re-running for every Write. Longer than that
and a branch switch in the middle of a session would silently keep the
gate open against the new HEAD.

## Failure mode

The blocker fails **closed**. Any error in load / parse / ledger query
forces a block envelope with the recovery hint:

> branch-protection: refusing Write on protected branch "master".
> ledger degraded (mcp connect refused); refusing on failsafe
> To proceed, cut a feature branch and re-run the producer:
>   git checkout -b <feature-slug>
>   harness session-start branch-check

This is the inverse of `understanding-before-execution`'s fail-open
contract. The whole job of this pack is preventing edit-on-master
incidents; a bug that silently allowed Writes through would defeat
the purpose.

## Configuration

```yaml
policy_packs:
  - name: branch-protection
    config:
      # Override the default ["master", "main", "develop"] list.
      protected_branches:
        - main
        - release/prod
        - production
```

A malformed `protected_branches` value (not an array, empty, all
non-string entries) falls back to the default list with a warning
surfaced at `harness apply` time.

## Escape hatches

### Refresh after branching

When the agent cuts a new branch mid-session, the producer is
re-runnable from the operator's `!` shell. The Understanding Gate's
allowlist accepts bare `harness ...` invocations, so this works even
under the Understanding Gate:

```bash
! harness session-start branch-check
```

The next `Write` / `Edit` will succeed within the 5-minute window.

### Explicit override

When you have a deliberate reason to edit a protected branch (version
bumps, CI workflow patches, hotfixes), write the override tag via
`mcp__agent-grounding__ledger_add`:

```text
mcp__agent-grounding__ledger_add(
  sessionId="<your session id>",
  type="fact",
  content="branch-protection-ack:CI hotfix for broken workflow",
  source="manual"
)
```

The override survives the session and bypasses this gate for as long
as the ledger row exists. The `:<reason>` suffix is free-form so a
later audit can read WHY the override fired.

## Detached HEAD

A detached HEAD is treated as **protected** by the producer (it
declines to write the tag) and as **safe** by the blocker (it allows,
since git detached-HEAD edits don't auto-push to a protected ref —
the downstream `preflight-before-push` gate still catches the
push). This asymmetry is intentional: the producer is conservative;
the blocker is pragmatic (alternative would block every Write in
non-git workspaces).

## Out of scope (v1)

- Locking down `git` itself (would create false-positive churn on
  read-only commands like `git status`).
- Auto-branching on Write attempt (silent autocorrect is wrong; the
  agent should be the one who notices and branches).
- Allowlist of paths that are safe to edit on master (CHANGELOG.md,
  package.json version bumps). Open for v2 if operators report
  friction.

## Test fixtures

- `tests/policy-packs/branch-protection-runtime.test.ts`, helpers
- `tests/policy-packs/branch-protection-expand.test.ts`, pack expansion
- `tests/cli/session-start/branch-check.test.ts`, producer
- `tests/cli/pack-hook-branch-protection.test.ts`, blocker
