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
   - the operator-only override marker exists at
     `harness.generated/.approvals/branch-protection-<sessionId>`
     (written by `harness approve branch-protection`).

The 5-minute freshness window lets a single branch-check satisfy a
whole edit batch without re-running for every Write. Longer than that
and a branch switch in the middle of a session would silently keep the
gate open against the new HEAD.

## Failure mode

The blocker fails **closed**. Any error in load / parse / ledger query
forces a block. Engine-vocabulary BLOCK reason (`branch-protection: refusing Write on protected branch "master"`, ledger health, freshness window, session id) lands on stderr for operator audit. The agent surface follows the `config.ux` shape below (v0.17.3+); operators who haven't set `ux:` see the legacy envelope verbatim.

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
      # Agent-facing block message (v0.17.3+; default shipped by every init template).
      ux:
        cannot: "You cannot edit files on protected branch ${BRANCH} yet."
        required:
          - "a checkout of a non-protected branch (current `${BRANCH}` is protected)"
        run:
          - "git checkout -b feat/<your-task>"
          - "harness session-start branch-check"
```

A malformed `protected_branches` value (not an array, empty, all
non-string entries) falls back to the default list with a warning
surfaced at `harness apply` time.

### Config schema

Since task `d78fb3c7`, the pack's `config:` block is validated by `harness validate` and `harness doctor` against a strict zod schema. Typo'd keys (`protected_brnches`) now fail at lint time. The accepted keys are:

| Key | Type | Notes |
|---|---|---|
| `protected_branches` | array of non-empty strings | optional; default `["master", "main", "develop"]` |
| `ux` | `PolicyUxSchema` (`cannot` + `required[]` + `run[]`) | optional; agent-facing remediation render, see below |

Any other top-level key is rejected as a typo.

### Pack-level `min_version` (task `bd154095`)

`policy_packs[].min_version` is an optional floor on the canonical package-side bin. The `branch-protection` blocker is harness itself, not a separate binary; this pack therefore has no version probe registered, and declaring `min_version` on it surfaces a `no version probe registered` warning at `harness doctor` time so the operator's expectation is visible. Leave the field unset on this pack.

### `config.ux` (v0.17.3+)

The blocker reads `config.ux` and renders the plain-language `{ cannot, required, run }` shape via `renderAgentFacing` (`src/runtime/agent-facing.ts`) on every block. `${BRANCH}` substitutes from the resolved git context, so on a Write attempt against master the agent sees:

```
You cannot edit files on protected branch master yet.

Required:
- a checkout of a non-protected branch (current `master` is protected)

Run:
  git checkout -b feat/<your-task>
  harness session-start branch-check
```

The engine-vocabulary BLOCK reason (naming the protected list, freshness window, ledger health, session id) still lands on stderr. Both runtime blockers, claude-code and codex, share the same renderer.

Verbatim three-section form, the agent / operator surface split, and the full builtin set are documented in [`docs/for-agents.md`](../for-agents.md#agent-facing-block-messages-ux-block). The branch-protection blocker itself resolves `${BRANCH}`, `${TOOL_NAME}`, and `${SESSION_ID}`; other builtins (`${REPO}`, `${CWD}`) are not provided by this pack's hook.

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

### Explicit override (operator only)

When you have a deliberate reason to edit a protected branch (version
bumps, CI workflow patches, hotfixes), run, from an un-hooked operator
shell (in Claude Code: prefix with `! `):

```text
harness approve branch-protection --session <your session id> --reason "CI hotfix for broken workflow"
```

This writes the canonical approval marker at
`harness.generated/.approvals/branch-protection-<sessionId>`, which the
blocker consults. Only a process the operator launched can write under
`harness.generated/` (Edit / Write / Bash are all gated, and no
configured MCP server exposes a filesystem write), so the marker is the
trusted override signal.

> **Security (audit finding #39).** A `branch-protection-ack:<reason>`
> ledger tag is NO LONGER a sufficient override on its own. The agent has
> direct `mcp__agent-grounding__ledger_add` access, so it could self-write
> that tag and bless its own protected-branch edit. The approve verb still
> records the ledger tag for audit (`--reason` becomes its `:<reason>`
> suffix), but only the marker file opens the gate.

## Detached HEAD

A detached HEAD is treated as **protected** by the producer (it
declines to write the tag) and as **safe** by the blocker (it allows,
since git detached-HEAD edits don't auto-push to a protected ref;
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
