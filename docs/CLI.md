# harness CLI reference

Tracks the verbs available on the `harness` binary as of `v0.36.0`; changes that ship on master after that tag are listed under Notes. For policy semantics see [`docs/policy-packs/`](policy-packs/); for the risk gate specifically see [`docs/risk-gate.md`](risk-gate.md).

The CLI is grouped by purpose below. Run any verb with `--help` for flags and examples.

## Manifest and config

| Verb | One-liner |
|------|-----------|
| `harness init [--template solo\|team\|full] [--interactive] [--probe]` | Bootstrap a starter `harness.yaml`. `--interactive` walks the wire-up Q&A and writes `harness.lock` + `harness.generated/`. `--probe` emits a JSON snapshot of detected runtimes and exits. |
| `harness apply` | Render the manifest into the config files the agent runtime actually reads (`~/.claude/settings.json`, `harness.generated/*`). |
| `harness describe` | Print the effective merged manifest (inherited packs + local overrides). |
| `harness validate` | Lint the manifest and referenced assets without writing anything. |
| `harness diff` | Show what `apply` would change against the currently rendered config. |
| `harness adopt <file>` | Take an existing config file under management. |
| `harness add mcp\|cli\|skill\|hook <name> [opts]` | Insert a new managed entry into `harness.yaml`. Subcommands cover the four entry kinds. |
| `harness remove <type> <name>` | Inverse of `add`. |
| `harness export` | Dump the active manifest to stdout (e.g. for sharing or PRs). |
| `harness pack add <name>` / `harness pack remove <name>` / `harness pack list` | Manage `policy_packs[]` entries (`list` takes no name). The same `pack` namespace also carries the runtime hook entrypoints under `harness pack hook ...` (see below); there is no separate top-level `harness hook` runtime namespace. |
| `harness uninstall` | One-command teardown across the state root (`~/.harness/`, legacy `~/.claude/`) and `~/.claude/settings.json`. Dry-run by default; pass `--apply` to commit. |
| `harness gc [--retention-days <n>] [--apply]` | Retention-based cleanup: ages out terminal understanding-gate reports, parse-error logs, and approval markers older than the window (default 30d). Pending reports are never touched. Dry-run by default. |
| `harness migrate-home` | Move state from `~/.claude/` to `~/.harness/` (introduced in `v0.24.0`, legacy fallback still live). Dry-run by default; pass `--apply` to commit. |

## Health, audit, and observability

| Verb | One-liner |
|------|-----------|
| `harness doctor [--rm-rogue-ledgers] [--yes]` | Health summary across hooks, packs, MCP registrations, runtime detection, and binary version. A bare run is read-only; `--rm-rogue-ledgers` opts into deleting each rogue evidence-ledger directory it finds (prompts per hit; add `--yes` to skip the prompts). Exits `1` when the report's `errorCount` is above zero (in both prose and `--json` mode) so CI/scripts can gate on doctor health; warnings alone (`warningCount`) still exit `0`. |
| `harness list <category>` | Print one category's entries as a flat table or JSON. Valid categories: `mcp`, `cli`, `skills`, `memories`, `hooks`, `policies`, `workflows`. |
| `harness audit [--since 1h] [--policy <name>]` | Replay recorded policy decisions from the evidence-ledger. |
| `harness session-export [sessionId]` | Export the full evidence-ledger for a Claude Code session as JSON, suitable for archival or attaching to a PR. |

## Policy runtime

`harness policy intercept` is the runtime evaluator that Claude Code calls on every tool event. The other policy-debug verbs are top-level (not nested under `policy`).

| Verb | One-liner |
|------|-----------|
| `harness policy intercept` | The runtime evaluator that hooks call on every PreToolUse / PostToolUse. Supports `--hook <name>` (v0.29.0) to scope evaluation to a single hook generator. |
| `harness explain [policy] [--trace] [--last]` | Print a policy's definition; `--trace` reads the last recorded evaluation; `--last` traces the most recent decision in the ledger. |
| `harness explain-action <event.json>` | Reason about a single hook event JSON file and explain which policies would fire (Risk Gate debug verb, Phase 7). |
| `harness explain-policy <policy>` | Resolve and print a single policy by name (after merge + overrides) and whether it would apply to a tool event. |
| `harness test-risk <event.json>` | Replay an event against the Risk Gate and print the assigned tier. |
| `harness resolve-env <event.json>` | Resolve which `environment` block a given event maps to. |
| `harness dry-run <prompt>` | Statically predict which hooks fire, which policies match, and which memories route for a prompt. |

## Hook entrypoints

These are called by Claude Code via `settings.json`; you usually do not run them yourself. They are documented here for operators reading their settings files. All runtime hook entrypoints live under the `harness pack hook ...` namespace (the table previously showed a `harness hook ...` spelling that does not exist; `harness add hook <name>` is the unrelated manifest mutation).

| Verb | Called from |
|------|-------------|
| `harness pack hook pre-tool-use` | `PreToolUse` matcher. |
| `harness pack hook post-tool-use` | `PostToolUse` matcher. |
| `harness pack hook track-active-claim` | `PostToolUse` companion that tracks the active understanding-gate task scope (v2 gate, PR #185). |
| `harness pack hook stay-in-scope` | `PostToolUse` soft reminder (non-blocking): flags agent-tasks task payloads that look like review-derived follow-ups. Disable via `STAY_IN_SCOPE_DISABLED=1`; log path via `STAY_IN_SCOPE_LOG`. |
| `harness pack hook branch-protection` | `PreToolUse` branch-guard for the `master`/`main` protection policy. Denies protected-branch edits unless a fresh `branch:non-protected` tag (5m window) or the operator-only override marker from `harness approve branch-protection` is present (v0.33.0). |
| `harness pack hook solution-acceptance` | `PreToolUse` completion-gate (v0.32.0, opt-in pack): denies task-finishing tools (agent-tasks completion verbs, `git push`, `gh pr merge`) unless a ready solution-acceptance verdict exists at the current git HEAD for the active-claim task (or, without a claim, the `SOLUTION_VERDICT_ID` env id). Fail-closed. See [`docs/policy-packs/solution-acceptance.md`](policy-packs/solution-acceptance.md). |
| `harness pack hook solution-acceptance-writeguard` | `PreToolUse` anti-forgery companion (v0.32.0): denies agent writes into the solution-verdict dir; the producer (`grounding-mcp`) is the only legitimate writer. |
| `harness pack hook runtime-reality` | `PreToolUse` drift gate (v0.31.0, opt-in): before destructive runtime commands, probes live process state and denies on critical drift against the expectations file. Fail-open on probe errors. See [`docs/runtime-reality-hook.md`](runtime-reality-hook.md). |
| `harness pack hook codex-pre-tool-use` | Codex variant of `pre-tool-use`. The generator that emits its `settings.json` entry pins a 2s timeout floor as of v0.29.0. |
| `harness pack hook codex-user-prompt-submit` | Codex `UserPromptSubmit` entry. |
| `harness pack hook codex-stop` | Codex `Stop` entry. |
| `harness session-start preflight` | `SessionStart` companion: emits the per-repo `preflight:` ledger tag the Risk Gate's preflight policy looks for. Also exposed as the top-level alias `harness preflight`. |
| `harness session-start branch-check` | `SessionStart` companion: emits a one-shot warning if the current branch already has work that should be a fresh task branch (per `feedback-one-branch-per-task`). |

## Operator approvals

`harness approve <kind>` writes the canonical operator-only marker the corresponding gate consults (under `harness.generated/.approvals/` for the understanding and branch-protection gates), and (where applicable) flips persisted artefacts such as the Understanding Report. It also records a best-effort audit-only evidence-ledger tag; the ledger row is agent-writable and no longer opens these gates. Operator surface; agents cannot self-approve.

| Verb | One-liner |
|------|-----------|
| `harness approve understanding [--session <id>] [--force]` | Write the canonical operator-only marker under `harness.generated/.approvals/<sessionId>` (and flip the persisted Understanding Report to approved) so the Understanding Gate releases the session; the `understanding-approved:` ledger row is a best-effort audit echo only. `--session` is required when multiple sessions share `~/.harness/` (see `feedback-harness-approve-session-flag`). `--force` overrides parser-failed Understanding Reports with an audit suffix (harness PR #253). Since `v0.34.0` the sessionId-less report fallback rejects candidates older than 15 minutes and prints createdAt + age when it adopts one. |
| `harness approve risk [--force <reason>] [--i-am-the-operator]` | Write `risk-approved:` to clear the current Risk Gate `require_approval` tier. `--force <reason>` only unblocks `deny`-tier (writes `risk-override:`) and requires a non-empty reason; from `!`-shell calls add `--i-am-the-operator`. |
| `harness approve branch-protection [--session <id>] [--reason <text>] [--approved-by <actor>]` | Bless a deliberate protected-branch edit for one session (v0.33.0). Writes the canonical operator-only marker under `harness.generated/.approvals/` that the branch-protection blocker consults; the `branch-protection-ack` ledger row is a best-effort audit echo only (the ledger is agent-writable and no longer opens the gate). |

## Gate kill-switches

| Verb | One-liner |
|------|-----------|
| `harness gate disable [--matcher <pattern>] [--settings <path>]` | Remove hook groups from `~/.claude/settings.json` whose matcher substring-matches the pattern. With no `--matcher`, lists candidates without writing. Snapshots removed groups + backs up the file for `gate enable`. |
| `harness gate enable [--settings <path>] [--force]` | Restore the most recent snapshot written by `gate disable`. |
| `harness pause [--for 5m\|--indefinite] [--reason X] [--i-am-the-operator]` | Drop a sentinel at `harness.generated/.harness-paused` so PreToolUse / Risk / Understanding hooks short-circuit. Operator-only (`v0.22.0+`). `--indefinite` requires the companion `--i-am-the-operator-and-accept-no-auto-resume`. |
| `harness resume` | Remove the pause sentinel and re-engage all gates. |

## Preflight and smoke

| Verb | One-liner |
|------|-----------|
| `harness preflight` | Run the local preflight bundle (`agent-preflight`). The Risk Gate's preflight policy expects the resulting `preflight:<repo>` ledger tag before allowing destructive Bash on that repo. |
| `harness smoke` | End-to-end smoke run for the installed harness (hook plumbing, ledger write, policy evaluation). Useful after a fresh `init --interactive` or a version bump. |

## Notes

- `harness doctor` now exits non-zero (`1`) whenever the report has `errorCount > 0`, in both prose and `--json` output; previously it always exited `0` regardless of errors, so CI/scripts had no way to gate on doctor health (task a07b379a). Warnings-only reports (`warningCount > 0`, `errorCount === 0`) are unaffected and still exit `0`; this pass intentionally does not add a `--strict` flag to promote warnings to errors. Non-interactive `harness init` is unrelated and unchanged: it keeps its existing loud-stderr-but-exit-0 contract.
- Since `v0.36.0`: `harness doctor --rm-rogue-ledgers` (with `--yes` to skip the per-hit prompt) opts into deleting rogue evidence-ledger directories that doctor reports, and the read-only Bash classifier re-admits `sort`, `tree`, and `file` behind precise write-flag guards (for example `sort -o` is still treated as write-producing).
- Since `v0.35.0`: `harness apply` fails loud (refuses) when the manifest declares `policies:` without `grounding-mcp` wired under `tools.mcp` (previously it applied and the policies silently degraded to warn-mode at runtime); wire `grounding-mcp` or drop the policies.
- Since `v0.34.0`: `apply --yes` (skip the `--overwrite-drift` confirmation) and non-TTY guards on the `apply`/`adopt` confirmation prompts (they refuse instead of hanging; piped `echo yes |` confirmations no longer work, use `--yes`).
- `harness policy intercept --hook <name>` and the 2s timeout floor pinned by the Codex-hook generator both shipped in `v0.29.0`; see [CHANGELOG.md](../CHANGELOG.md).
- The `full` profile pins `@lannguyensi/agent-preflight` and `@lannguyensi/understanding-gate@0.4.0+` as transitive dependencies of the wired packs; mismatched versions surface in `harness doctor`.
- Ledger tag vocabulary used by gate-mode policies: `review:`, `risk-override:`, `risk-approved:`, `understanding-approved:`, `preflight:`. Only the Risk Gate's `requires.ledger_tag` actually consults a ledger tag to unblock (scoped to a Claude session id, not the agent-tasks task UUID, see `feedback-agent-grounding-merge-gate-ledger`); the Understanding and branch-protection gates read the operator-only marker under `harness.generated/.approvals/` instead; their `understanding-approved:` / `branch-protection-ack:` ledger rows are audit-only and no longer sufficient to open the gate (see `docs/writing-custom-policies.md` tripwire 4 and `CLI.md` on branch-protection above).
