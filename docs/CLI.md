# harness CLI reference

Tracks the verbs available on the `harness` binary as of `v0.30.0`. For policy semantics see [`docs/policy-packs/`](policy-packs/); for the risk gate specifically see [`docs/risk-gate.md`](risk-gate.md).

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
| `harness pack add\|remove\|list <name>` | Manage `policy_packs[]` entries. |
| `harness uninstall` | One-command teardown. Dry-run by default; pass `--apply` to commit. |
| `harness migrate-home` | Move state from `~/.claude/` to `~/.harness/` (introduced in `v0.24.0`, legacy fallback still live). |

## Health, audit, and observability

| Verb | One-liner |
|------|-----------|
| `harness doctor` | Health summary across hooks, packs, MCP registrations, runtime detection, and binary version. |
| `harness list <category>` | Print one category's entries as a flat table or JSON (`policies`, `packs`, `hooks`, `mcp`, `cli`, `skills`). |
| `harness audit [--since 1h] [--policy <name>]` | Replay recorded policy decisions from the evidence-ledger. |
| `harness session-export [sessionId]` | Export the full evidence-ledger for a Claude Code session as JSON, suitable for archival or attaching to a PR. |

## Policy runtime

`harness policy <verb>` is the namespace for policy execution. The most common entry is `intercept`, which Claude Code calls before each tool use.

| Verb | One-liner |
|------|-----------|
| `harness policy intercept` | The runtime evaluator that hooks call on every PreToolUse / PostToolUse. |
| `harness policy explain [policy] [--trace] [--last]` | Print a policy's definition; `--trace` reads the last recorded evaluation; `--last` traces the most recent decision in the ledger. |
| `harness policy explain-action <event.json>` | Reason about a single hook event JSON file and explain which policies would fire. |
| `harness policy explain-policy <policy>` | Resolve and print a single policy by name (after merge + overrides). |
| `harness policy test-risk <event.json>` | Replay an event against the Risk Gate and print the assigned tier. |
| `harness policy resolve-env <event.json>` | Resolve which `environment` block a given event maps to. |
| `harness policy dry-run <prompt>` | Report which hooks fire and which policies match for a synthetic prompt. |

## Hook entrypoints

These are called by Claude Code via `settings.json`; you usually do not run them yourself. They are documented here for operators reading their settings files.

| Verb | Called from |
|------|-------------|
| `harness hook pre-tool-use` | `PreToolUse` matcher. |
| `harness hook post-tool-use` | `PostToolUse` matcher. |
| `harness hook track-active-claim` | `PostToolUse` companion that tracks the active understanding-gate task scope (v2 gate, PR #185). |
| `harness hook branch-protection` | `PreToolUse` branch-guard for the `master`/`main` protection policy. |
| `harness hook codex-pre-tool-use` | Codex variant of `pre-tool-use`; supports `--hook <name>` and a 2s timeout floor (v0.29.0). |
| `harness hook codex-user-prompt-submit` | Codex `UserPromptSubmit` entry. |
| `harness hook codex-stop` | Codex `Stop` entry. |
| `harness session-start preflight` | `SessionStart` companion: emits the per-repo `preflight:` ledger tag the Risk Gate's preflight policy looks for. |
| `harness session-start branch-check` | `SessionStart` companion: emits a one-shot warning if the current branch already has work that should be a fresh task branch (per `feedback-one-branch-per-task`). |

## Operator approvals

`harness approve <kind>` writes the evidence-ledger tags that gate-mode policies look for, and (where applicable) flips persisted artefacts under `harness.generated/`. Operator surface; agents cannot self-approve.

| Verb | One-liner |
|------|-----------|
| `harness approve understanding [--session <id>] [--force]` | Drop the `understanding-approved:<sessionId>` marker so the Understanding Gate releases the session. `--session` is required when multiple sessions share `~/.harness/` (see `feedback-harness-approve-session-flag`). `--force` overrides parser-failed Understanding Reports with an audit suffix (harness PR #253). |
| `harness approve risk [--force] [--i-am-the-operator]` | Write `risk-approved:` to clear the current Risk Gate `require_approval` tier. `--force` only unblocks `deny`-tier (writes `risk-override:`); from `!`-shell calls add `--i-am-the-operator`. |

## Gate kill-switches

| Verb | One-liner |
|------|-----------|
| `harness gate enable\|disable [--group <name>]` | Operator escape hatch: disable or restore hook groups in `~/.claude/settings.json` without rewriting the manifest. |
| `harness pause [--for 5m\|--indefinite] [--reason X]` | Drop a sentinel at `harness.generated/.harness-paused` so PreToolUse / Risk / Understanding hooks short-circuit. Operator-only (`v0.22.0+`). |
| `harness resume` | Remove the pause sentinel and re-engage all gates. |

## Preflight and smoke

| Verb | One-liner |
|------|-----------|
| `harness preflight` | Run the local preflight bundle (`agent-preflight`). The Risk Gate's preflight policy expects the resulting `preflight:<repo>` ledger tag before allowing destructive Bash on that repo. |
| `harness smoke` | End-to-end smoke run for the installed harness (hook plumbing, ledger write, policy evaluation). Useful after a fresh `init --interactive` or a version bump. |

## Notes

- The `add` verb's `--hook <name>` flag and the 2s timeout floor on Codex hook entries were introduced in `v0.29.0`; see [CHANGELOG.md](../CHANGELOG.md).
- The `full` profile pins `@lannguyensi/agent-preflight` and `@lannguyensi/understanding-gate@0.4.0+` as transitive dependencies of the wired packs; mismatched versions surface in `harness doctor`.
- Ledger tag vocabulary used by gate-mode policies: `review:`, `risk-override:`, `risk-approved:`, `understanding-approved:`, `preflight:`. The Risk and Understanding gates both consume their tags scoped to a Claude session id (not the agent-tasks task UUID, see `feedback-agent-grounding-merge-gate-ledger`).
