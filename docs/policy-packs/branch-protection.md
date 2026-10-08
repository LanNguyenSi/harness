# Policy Pack: `branch-protection`

Block `Write`/`Edit` (claude-code) or `apply_patch` (codex) when the tool
call writes into a repository whose checked-out branch is protected. The
gate fires at the **first** source mutation, complementing
`preflight-before-push` (which fires at the last reversible step).

Motivating incident: a session that branches AFTER it has already
edited master leaves an uncommitted diff on master that a second
session only notices on the next `git checkout master`. Recovery
requires stash + branch + commit-rewrite, strictly worse than
branching upfront.

## Status

Default-enabled in `harness init --template full` since v0.17.2. Opt-in for the solo, team, and minimal templates; enable there with:

```bash
harness pack add branch-protection
harness apply
```

## How it works

The pack contributes one hook: a **PreToolUse blocker**
(`harness pack hook branch-protection`, `blocking: hard`, budget 5000 ms)
on `Write|Edit` (claude-code) or `apply_patch` (codex, as
`harness pack hook branch-protection --runtime codex`).

On every call the blocker asks git for the branch (task `a4d8adc5`); it
never reads git's files itself, and it keeps no ledger tag, session
state or override marker.

1. **Directories.** For `Write`, `Edit`, `MultiEdit` and `NotebookEdit`
   it takes the nearest existing directory of the target path (a `Write`
   may create the directories in between). For a Codex `apply_patch` it
   takes the nearest existing directory of every path named by a
   `*** Add File:`, `*** Update File:`, `*** Delete File:` or
   `*** Move to:` header, relative to the event cwd. For any other tool,
   or a patch without a header, it takes the event cwd. Each distinct
   directory is checked.
2. **Presence walk.** From the directory up to the filesystem root it
   looks (with `lstat`, nothing is read) for an entry named `.git`. When
   there is none, the directory is outside every repository and git is
   not run.
3. **git.** Otherwise it runs `git -C <dir> symbolic-ref -q HEAD`
   directly (no shell), with stdin closed, each output stream capped at
   4 KiB, every `GIT_*` variable removed from git's environment
   (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` set;
   `HOME` kept, so your global git configuration applies as it does to
   your own git), and a 2000 ms bound per call after which git is killed.
   All directories of one tool call together are bounded at 3000 ms,
   counted from the moment the hook starts (the stdin read included), well
   below the hook budget: a hook the runtime kills at its budget would be
   read as an allow.

## The three outcomes

| git says | The tool call | What to do |
|---|---|---|
| `refs/heads/<name>` and `<name>` is protected (compared case-insensitively, so `Master` counts as `master`) | **refused** | Branch off: `git checkout -b <feature>`, then retry. |
| anything it cannot answer: an error exit, a signal, no answer within the bound, git missing from `PATH`, output past the cap, or an exit-0 answer that is not `refs/heads/<name>` (a `HEAD` naming a tag, for example) | **refused**, with one fixed sentence naming git's first stderr line | Fix the repository (run `git -C <dir> symbolic-ref -q HEAD` yourself to see what git says), or disable the gate from an operator shell (below). |
| nothing, because there is no `.git` entry above the directory (outside every repository) | **allowed** | Nothing. |

A detached HEAD (git exits 1 with no output) is allowed as well: an edit
there does not land on a protected branch by itself, and pushes are
outside this gate's scope.

A planted layout git does not accept (a broken `HEAD` in a nested
`.git`, for example) either stops git with an error (refused) or makes
git resolve the enclosing repository, which is then judged on its own
branch, exactly as your own git would.

## Failure mode

The blocker fails **closed**: a manifest that does not load, an event on
stdin that is not a JSON object, a stdin that never closes within 3000 ms
and every git error refuse the call. The stderr diagnostic
(`harness pack hook branch-protection: BLOCK: ...`) names the directory
and what git said, for operator audit.

This is the inverse of `understanding-before-execution`'s fail-open
contract. The whole job of this pack is preventing edit-on-master
incidents; a bug that silently allowed Writes through would defeat
the purpose.

A manifest that still carries a key or a pack a newer release removed
does not count as one that fails to load: removed entries are stripped
with a warning (`harness validate`, `harness doctor`) and the gate keeps
working. Only a key that was never valid fails the load.

## Block contract per runtime

| Runtime | Refusal | Allow |
|---|---|---|
| claude-code | one JSON line on stdout, `{"decision":"block","reason":...,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":...}}`, exit 0 | nothing on stdout, exit 0 |
| codex (`--runtime codex`) | the reason on stderr, exit 2, nothing on stdout | nothing on stdout, exit 0 |

An unknown `--runtime` value refuses with exit 2, which both runtimes read
as a block. The agent-facing text names `git checkout -b` as the way
forward and nothing else.

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
```

A malformed `protected_branches` value (not an array, empty, all
non-string entries) falls back to the default list with a warning
surfaced at `harness apply` time.

### Config schema

Since task `d78fb3c7`, the pack's `config:` block is validated by `harness validate` and `harness doctor` against a strict zod schema. Typo'd keys (`protected_brnches`) now fail at lint time. The accepted keys are:

| Key | Type | Notes |
|---|---|---|
| `protected_branches` | array of non-empty strings | optional; default `["master", "main", "develop"]`; compared case-insensitively |
| `ux` | `PolicyUxSchema` (`cannot` + `required[]` + `run[]`) | optional; agent-facing remediation render, see below |

Any other top-level key is rejected as a typo.

### Pack-level `min_version` (task `bd154095`)

`policy_packs[].min_version` is an optional floor on the canonical package-side bin. The `branch-protection` blocker is harness itself, not a separate binary; this pack therefore has no version probe registered, and declaring `min_version` on it surfaces a `no version probe registered` warning at `harness doctor` time so the operator's expectation is visible. Leave the field unset on this pack.

### `config.ux` (v0.17.3+)

On a protected branch the blocker renders `config.ux` in the plain-language `{ cannot, required, run }` shape via `renderAgentFacing` (`src/runtime/agent-facing.ts`). `${BRANCH}` substitutes the branch git named, so on a Write attempt against master the agent sees:

```
You cannot edit files on protected branch master yet.

Required:
- a checkout of a non-protected branch (current `master` is protected)

Run:
  git checkout -b feat/<your-task>
```

Without `ux:` the agent sees the default text (`branch-protection: refusing Write on protected branch "master" ...`, the `git checkout -b <feature>` line and the protected list). A refusal because git could not answer always uses its fixed sentence, whatever `ux:` says. The branch-protection blocker resolves `${BRANCH}`, `${TOOL_NAME}`, and `${SESSION_ID}` (the event's session id, empty when absent); other builtins (`${REPO}`, `${CWD}`) are not provided by this pack's hook. Verbatim three-section form and the agent / operator surface split are documented in [`docs/for-agents.md`](../for-agents.md#agent-facing-block-messages-ux-block).

A wording fix to this text only reaches manifests generated by a fresh `harness init` after the fix ships; an already-installed manifest's `config.ux` stays on the old wording until refreshed. `harness doctor` warns on divergence and `harness pack reseed branch-protection [--dry-run]` pulls the current shipped wording in, leaving every other key on the pack entry (e.g. `config.protected_branches`) untouched. A manifest whose `ux.run` still lists the removed `harness session-start branch-check` line is such a divergence: reseed drops it.

## Escape hatches

### Branch off (the agent)

```bash
git checkout -b <feature>
```

The next call is judged against the new branch; there is nothing to
refresh.

### Disable the gate (operator only)

When you have a deliberate reason to edit a protected branch (version
bumps, CI workflow patches, hotfixes), switch the gate off from an
un-hooked operator shell, not from the agent's session:

- Claude Code: `harness gate disable` (run it without `--matcher` first
  to list the hook groups, then with the matcher of this pack's group);
  `harness gate enable` restores them.
- Codex: set `enabled: false` on this pack and re-run
  `harness apply --runtime codex --install`; `harness gate disable`
  edits the Claude Code settings only.

The operator pause (`harness pause`) does not switch this gate off.

### Removed in task `a4d8adc5`

`harness session-start branch-check` (the SessionStart producer and its
`branch:non-protected:<branch>` ledger tag) and
`harness approve branch-protection` (the override marker under
`harness.generated/.approvals/`) are gone, together with the 5-minute
freshness window and the session-id requirement. Re-run `harness apply`
(and `harness apply --runtime codex --install`) after upgrading so the
settings stop calling the removed producer.

## Out of scope (v1)

- Locking down `git` itself (would create false-positive churn on
  read-only commands like `git status`).
- Auto-branching on Write attempt (silent autocorrect is wrong; the
  agent should be the one who notices and branches).
- Allowlist of paths that are safe to edit on master (CHANGELOG.md,
  package.json version bumps). Open for v2 if operators report
  friction.
- A bare repository's own directory: it has no `.git` entry, so the
  presence walk counts it as outside every repository.

## Test fixtures

- `tests/cli/pack-hook-branch-protection.test.ts`, the blocker against real git, the injected git runner and the per-runtime contract
- `tests/runtime/git-branch.test.ts`, the branch reader
- `tests/runtime/git-branch-differential.test.ts`, the gate against git run plainly over the repository layouts
- `tests/cli/hook-git-context-fifo.test.ts`, a git file that never answers, through the built CLI
- `tests/cli/manifest-posture.test.ts`, removed manifest keys warn and are ignored
- `tests/policy-packs/branch-protection-runtime.test.ts`, helpers
- `tests/policy-packs/branch-protection-expand.test.ts`, pack expansion
