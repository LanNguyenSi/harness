# Policy Pack: `post-merge-gate`

Deny curated history-mutating `git` / `gh` commands on a branch whose
current tip was already merged via `gh pr merge`. The gate fires at the
first history-mutating command AFTER a real merge, catching the "kept
working on a merged branch" pattern: a session merges a PR, then keeps
committing / pushing / rebasing on the same checkout without switching
back to the default branch — silently building on top of an already-
integrated commit.

## Status

Opt-in. Shipped by the `full` init template with `enabled: false` (a
fresh gate; review the curated command list below before turning it on).
Enable with:

```bash
harness pack add post-merge-gate
harness apply
```

## How it works

The pack contributes two hooks to `settings.json`:

1. **PostToolUse producer** (`harness pack hook post-merge-gate-record`,
   `blocking: false`) on `Bash`: fires only when the just-run command
   matched `gh pr merge` AND the merge is CONFIRMED by one of two
   contracts (dual-contract, payload-reality follow-up):
   - **Contract A** — `tool_output.exit_code` reads as the plain number
     `0`. This is the shape documented at
     [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks),
     and it is left completely unchanged: any install that DOES send it
     still works exactly as before.
   - **Contract B** — `tool_response` is present with
     `interrupted === false` AND its `stdout`+`stderr` contain `gh pr
     merge`'s own past-tense success sentence — `Squashed and merged
     pull request <fullname?>#<n>`, `Rebased and merged pull request
     <fullname?>#<n>`, or `Merged pull request <fullname?>#<n>` (all
     three merge methods covered; case-sensitive, exact phrasing,
     `\b`-bounded on both ends). **Source, verified against the
     installed `gh` binary (v2.94.0, `pkg/cmd/pr/merge/merge.go` lines
     369-376)**: the line is built as `infof("%s %s pull request %s#%d
     (%s)", icon, action, ghrepo.FullName(baseRepo), pr.Number,
     pr.Title)` — the repo fullname sits between "pull request" and the
     bare PR number, GLUED to `#` with **no space** (real example:
     `✓ Squashed and merged pull request owner/repo#65 (Some title)`),
     and `infof` writes to `gh`'s **STDERR** channel, which is why this
     contract checks the concatenated `stdout`+`stderr`, never stdout
     alone. The matcher's `[^\s#]*` between "pull request" and `#`
     accepts both that real `owner/repo#<n>` shape and a bare `#<n>`
     (no fullname — not `gh`'s actual current wording, but tolerated
     defensively at no extra matching-surface cost). **Why this
     exists**: live verification against a real Claude Code **2.1.218**
     native install (a `claude -p --settings` dump-hook capture, 19/19
     fired PostToolUse events) found NO `tool_output` field at all — the
     field is `tool_response`, shaped `{ stdout, stderr, interrupted,
     isImage, noOutputExpected }`, with no exit-code equivalent. A
     verbatim capture of that real payload lives at
     [`tests/fixtures/post-merge-gate/real-posttooluse-payload-2.1.218.json`](../../tests/fixtures/post-merge-gate/real-posttooluse-payload-2.1.218.json).
     The `tool_output.exit_code` shape (Contract A) evidently describes
     a different — newer, or differently-shimmed — Claude Code contract
     than 2.1.218's, not a documentation error; Contract B is what makes
     the producer fire AT ALL on that install.

   **Ordering (binding)**: Contract A wins whenever it resolves to ANY
   definite verdict, success OR failure — a well-formed non-zero
   `exit_code` short-circuits WITHOUT consulting Contract B (so a
   coincidental gh success phrase sitting in a sibling `tool_response`
   field, the hypothetical "both present" shape, can never override an
   authoritative Contract-A failure). Contract B is tried only when
   Contract A's `exit_code` is entirely unresolvable.

   On a confirmed match, records
   `post-merge-gate:merged:<repo>:<branch>:<sha>` (plus PR number and
   timestamp, audit-only) to the evidence ledger via the Trusted-Writer
   path (`resolveManifestLedgerWriter` / `addLedgerFact`) — never an
   agent-issued `ledger_add`. `<sha>` is the LOCAL branch tip observed
   right after the merge: `gh pr merge` merges the PR on the remote side
   and does not itself move the local branch pointer, so this is exactly
   the commit that got merged. `<n>` prefers extraction from the `gh pr
   merge` command itself, falling back to the number captured out of the
   Contract-B success sentence when the command carries none (e.g. bare
   `gh pr merge` run from the checked-out branch).

2. **PreToolUse blocker** (`harness pack hook post-merge-gate`,
   `blocking: hard`) on `Bash`, in this order:
   1. **Escape allowlist**, checked FIRST, unconditionally, before any
      manifest load or ledger query (see "Escape hatches" below).
   2. **Curated mutation match** (see "Deny scope" below); commands
      outside the list pass through untouched.
   3. **Ledger check**: denies only when the current branch tip exactly
      equals a recorded merged-tip fact for this repo+branch.

## Tip-match semantics (no ancestry, no expiry)

The gate compares the current branch tip against the recorded tip by
**exact sha equality**, not ancestry. This is deliberate and squash-safe:

- A new local commit moves the tip → the fact no longer matches → the
  gate falls silent. Making a new commit IS the signal that this is
  legitimate continued work, not stale post-merge state.
- A recycled branch name (same name, different history) has a different
  tip → never a false positive.
- No freshness window / expiry is needed: the match key already encodes
  "this specific commit was merged", which never goes stale on its own.

## Deny scope (v1, curated)

The blocker matches only these commands (not "every Bash call" —
mirrors `branch-protection`'s documented v1 scope-cut):

- `git commit`, `git add`, `git push`, `git merge`, `git rebase`,
  `git cherry-pick`, `git revert`, `git reset`, `git stash pop`,
  `git stash apply`
- `gh pr create`, `gh pr merge`

Read-only git (`status`/`log`/`diff`/`branch`) and unrelated shell are
never touched.

## Escape hatches

Checked **first**, unconditionally — before any manifest load or ledger
query, so the recovery path this gate itself recommends can never be
starved by an unrelated failure:

- `git switch`, `git checkout`
- `git pull`, `git fetch`
- `git branch -d`, `git branch -D`
- `git stash list`, `git stash show`
- any `harness ...` invocation (any spelling: `npx harness ...`,
  `/usr/local/bin/harness ...`, `./node_modules/.bin/harness ...`)

The deny message's own recommended recovery is:

```bash
git switch <default-branch>
git pull --ff-only
git branch -d <branch>   # optional cleanup
```

## Failure mode

The blocker fails **OPEN** — the inverse of `branch-protection`'s
fail-closed posture. A manifest-load failure or a degraded evidence
ledger both ALLOW (with a stderr warning). Without the ledger, "merged"
and "not merged" are indistinguishable, and fail-closed here would block
ordinary git history work on every branch whenever grounding-mcp
hiccups. This pack is advisory-strength against a hostile agent, the
same honesty as the other `requires.ledger_tag`-style gates — see
[`docs/okf/evidence-ledger-trust-boundary.md`](../okf/evidence-ledger-trust-boundary.md).

## Configuration

```yaml
policy_packs:
  - name: post-merge-gate
    config:
      # Agent-facing block message (default shipped by the full init template).
      ux:
        cannot: "You cannot run ${TOOL_NAME} on branch ${BRANCH} yet — its current tip was already merged."
        required:
          - "a branch tip that is not sitting at an already-merged commit (switch off `${BRANCH}`, or move its tip with a new commit)"
        run:
          - "git switch ${DEFAULT_BRANCH}"
          - "git pull --ff-only"
          - "git branch -d ${BRANCH}  # optional cleanup"
```

`ux` is the only operator-tunable key in v1 — the curated mutation list
and the escape allowlist are fixed. `${DEFAULT_BRANCH}` is always
populated by the blocker (best-effort `origin/HEAD` resolution, falling
back to the literal placeholder `<default-branch>` when it cannot
resolve a remote default), never left as an unresolved template
variable.

### Pack-level `min_version`

Both the producer and the blocker are harness itself, not a separate
binary; this pack has no version probe registered. Declaring
`min_version` on it surfaces a `no version probe registered` warning at
`harness doctor` time.

## Edge cases (no deny)

- **Detached HEAD** / **outside a git work tree**: the blocker cannot
  resolve a branch name or tip; allows.
- **Repo without a remote**: has no effect on the deny decision itself
  (which only compares tips); only the default-branch NAME in the deny
  message degrades to the `<default-branch>` placeholder.
- **New commits after the merge**: the tip no longer matches the
  recorded fact; allows (see "Tip-match semantics" above).
- **Recycled branch name**: a different tip never matches; allows.
- **Read-only commands** (`git status`/`log`/`diff`/`branch`): outside
  the curated deny scope; allows.

## Known gaps (documented, not attempted in v1)

- **MCP merge path**: `mcp__agent-tasks__pull_requests_merge` is NOT a
  producer trigger. Only the `gh pr merge` Bash surface is watched.
- **Regex-vs-shell-eval residual**: same class of gap as every other
  `bash_match`-style matcher in this codebase (heredoc / `sh -c` /
  `eval` indirection defeats the trigger match before either hook ever
  runs).
- **Curated scope, not every Bash command**: destructive non-git
  mutation on a just-merged branch is out of v1 scope.
- **Chained-escape bypass**: escape-first matches against the WHOLE
  command string, not per-clause, so a curated mutation chained with an
  escape verb (e.g. `git commit -am x && git switch main`) is fully
  ALLOWED — the escape wins for the entire compound command. Same
  accepted class as the regex-vs-shell-eval residual above (`eval`,
  heredoc, `sh -c`); the alternative (per-clause splitting) would need a
  real shell parser.
- **Inverted trust-boundary residual**: a merged fact written by any
  means other than the producer (e.g. directly via
  `mcp__grounding-mcp__ledger_add`) that happens to exactly match the
  CURRENT `repo:branch:sha` triple denies curated mutations on that
  branch — recoverable via any escape command or by making a new commit
  (which moves the tip and the fact no longer matches). A fact for a
  different `repo:branch:sha` triple is inert; this is
  availability-only (a spurious deny, always escapable), never a
  privilege the agent gains — consistent with
  [`docs/okf/evidence-ledger-trust-boundary.md`](../okf/evidence-ledger-trust-boundary.md).
- **Contract B is coupled to `gh`'s current wording**: the success-text
  matcher matches `gh`'s OWN past-tense success sentence, verbatim, as
  verified against the installed `gh` v2.94.0 source
  (`pkg/cmd/pr/merge/merge.go` lines 369-376). A future `gh` release that
  rephrases that sentence — or changes the `%s#%d` glued-fullname
  formatting — makes Contract B silently, FAIL-SAFELY inert on installs
  that never send `tool_output.exit_code` (Contract A stays available
  wherever it's actually sent) — never a false "merged" record, but the
  blocker also never fires for that merge. Not attempted to close here
  (would need a `gh` wire-format contract, e.g. `--json`, out of this
  pack's Bash-text matching design). **Verification path** after
  upgrading `gh`: merge a throwaway PR and check for a fresh
  `post-merge-gate:merged` fact in the evidence ledger.
- **No Codex adapter**: both hooks assume the Claude Code Bash tool
  surface (mirrors `solution-acceptance`, which ships with no Codex
  variant either).

## Test fixtures

- `tests/policy-packs/post-merge-gate-runtime.test.ts`, helpers
  (including the dual-contract `resolveMergeConfirmation` decision table)
- `tests/policy-packs/post-merge-gate-expand.test.ts`, pack expansion
- `tests/cli/pack-hook-post-merge-gate-record.test.ts`, producer
  (Contract A, Contract B success/negative cases, both-present ordering)
- `tests/cli/pack-hook-post-merge-gate.test.ts`, blocker (including the
  escape self-lock table and the squash-merge end-to-end fixture)
- `tests/fixtures/post-merge-gate/real-posttooluse-payload-2.1.218.json`
  — a verbatim capture of a real Claude Code 2.1.218 PostToolUse Bash
  payload (drift guard for the `tool_response` shape Contract B reads)
