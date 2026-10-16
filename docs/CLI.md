# harness CLI reference

Tracks the verbs available on the `harness` binary in the current release. Notes carry version-specific detail. For policy semantics see [`docs/policy-packs/`](policy-packs/).

The CLI is grouped by purpose below. Run any verb with `--help` for flags and examples.

## Manifest and config

| Verb | One-liner |
|------|-----------|
| `harness init [--template minimal\|solo\|team\|full] [--interactive] [--probe]` | Bootstrap a starter `harness.yaml` (default template: `minimal`). `--interactive` walks the wire-up Q&A and writes `harness.lock` + `harness.generated/`. `--probe` emits a JSON snapshot of detected runtimes and exits. |
| `harness apply [--runtime claude-code\|codex\|opencode] [--target <path>] [--merge\|--force]` | Render the manifest into the config files the agent runtime actually reads. Without `--runtime`, apply reuses the runtime the last apply recorded in `harness.generated/.last-apply` and says so (`runtime: codex (from last apply; pass --runtime to change)`); an explicit `--runtime` that differs is honoured and both `--dry-run` and the apply name the switch (`runtime: codex -> claude-code`). A `.last-apply` from an older release, which has no runtime field, is read through its files map (only `codex/config.toml` means codex, and so on; when both `settings.json` and `codex/config.toml` are present, the recorded policy-pack `instructions.md` entries decide if every one names the same runtime in its `## Runtime` section; only the packs the record's own manifest snapshot lists count, when it has a readable one) and the output says the runtime was inferred; when that is ambiguous, or with no `.last-apply` at all, the default is `claude-code` (for an older record the output says so and names the runtimes the record holds files for, e.g. `generated files for claude-code and codex; pass --runtime codex to keep codex`), which writes `harness.generated/settings.json` (Claude Code reads it only through `--target`); `--runtime codex` emits `harness.generated/codex/config.toml` (`--install` merges it into `~/.codex/config.toml`); `--runtime opencode` emits `harness.generated/opencode/opencode.json` (MCP servers only, not auto-installed). `--target <path>` (claude-code only: without `--runtime` it implies `claude-code` and the output names it; rejected with an explicit `--runtime codex` or `--runtime opencode`) additionally writes settings.json to `<path>`, `--merge` 3-way-merges it, `--force` overwrites it. |
| `harness describe` | Print the effective merged manifest (inherited packs + local overrides). |
| `harness validate` | Lint the manifest and referenced assets without writing anything; do not execute manifest version commands. `tools.cli[].min_version` warns to run `harness doctor` (`--strict` promotes the warning to an error). |
| `harness diff` | Show what `apply` would change against the currently rendered config. |
| `harness adopt <file>` | Take an existing config file under management. |
| `harness add mcp\|cli\|skill\|hook <name> [opts]` | Insert a new managed entry into `harness.yaml`. Subcommands cover the four entry kinds. |
| `harness remove <type> <name>` | Inverse of `add`. |
| `harness export` | Dump the operator-declared manifest to stdout (e.g. for sharing or PRs). Manifest posture warnings (removed keys, removed hook fields, removed packs, removed commands) go to stderr, one `warning:` line each; stdout carries only the manifest. |
| `harness pack add <name>` / `harness pack remove <name>` / `harness pack list` / `harness pack reseed <name> [--dry-run]` | Manage `policy_packs[]` entries (`list` takes no name; its columns are `name`, `source`, `enabled` and `description`, and `--json` emits the same keys). `remove --force` also deletes the pack's generated files and prunes their entries from `harness.generated/.last-apply`, keeping the record's other fields, including the runtime it records, so the next plain `harness apply` still reuses that runtime. `reseed` pulls the shipped builtin template's `config.ux` for `<name>` into the manifest, preserving every other key (for example `protected_branches`); this is the supported way to pick up a deny-message wording fix on an already-installed manifest. A manifest that still names the removed `understanding-before-execution` pack loads with a warning and the entry is ignored (`remove --force` still deletes the entry and its generated files). The same `pack` namespace also carries the runtime hook entrypoints under `harness pack hook ...` (see below); there is no separate top-level `harness hook` runtime namespace. |
| `harness uninstall` | One-command teardown across the state root (`~/.harness/`, legacy `~/.claude/`) and `~/.claude/settings.json`. Dry-run by default; pass `--apply` to commit. |
| `harness migrate-home` | Move state from `~/.claude/` to `~/.harness/` (introduced in `v0.24.0`, legacy fallback still live). Dry-run by default; pass `--apply` to commit. |

## Manifest reference

The manifest (`harness.yaml`) accepts these top-level keys besides the required `version: 1` (`src/schema/index.ts`). Any other top-level key fails the load, unless it is a removed key (below).

| Key | Holds |
|---|---|
| `grounding` | `session.*` (reserved, no consumer yet) and `evidence_ledger.path`, which `harness apply` projects as `EVIDENCE_LEDGER_DB` onto the `grounding-mcp` entry |
| `tools` | `mcp[]`, `cli[]`, `skills` and `builtin`: the tool inventory `harness doctor` checks and `harness apply` wires |
| `memory` | `directories[]`, `router`, `retention` and `scopes`: memory directories indexed into `MEMORY.md` |
| `hooks` | runtime hook entries (`event`, `command`, `match`, `blocking`, `budget_ms`, ...) that `harness apply` writes into the runtime config |
| `policy_packs` | builtin packs such as `branch-protection`; see [`policy-packs/`](policy-packs/) |
| `audit` | `redact[]`: regex or env-var rules that `harness session-export` applies to its output |

### Override layers

The loader merges these files in order, later layers winning (`src/cli/loader.ts`, `src/overrides/machines.ts`). Every path except the base is under the state root (`~/.harness/`, or `$HARNESS_HOME`):

1. the base manifest: `harness.yaml` in the state root, or the file `--config` names;
2. `machines/default.harness.overrides.yaml`;
3. `machines/<os>.harness.overrides.yaml`, where `<os>` is `linux`, `darwin`, `wsl2` or `win32`;
4. `machines/<hostname>.harness.overrides.yaml`, with the hostname lowercased;
5. `projects/<name>/harness.overrides.yaml`, when `--project <name>` is given.

`--config` moves only the base manifest; the override layers still load from the state root. A layer file that holds no YAML document (empty, or comments only) is skipped with a warning and the manifest loads as if it were absent; a layer whose root is a scalar or a list fails the load with an error naming the file, since an override layer must be a mapping.

### Removed keys, packs and commands

A key, pack or command that a release removed does not fail the load (`src/schema/removed-keys.ts`):

- a removed manifest key (for example `grounding.policies_source` or `risk`, and since 1.0.0 `policies:`, `workflows:`, `review_templates:` and `doctor:`) is stripped with a warning (an empty value is stripped without one);
- a removed per-hook field (`bash_match`, `path_match`, removed in 1.0.0) is stripped from the hook, which is kept, with one warning per hook;
- a removed pack name in `policy_packs[]` is ignored with a warning;
- a hook or a pack config site that still calls a removed CLI command (for example `harness policy intercept` or `harness record`, both removed in 1.0.0) is reported with a warning.

`harness validate`, `harness doctor`, `harness apply` and `harness export` print these warnings, and `harness validate --strict` fails on them. A key that was never valid is not on the removed list and still fails the load.

## Health, audit, and observability

| Verb | One-liner |
|------|-----------|
| `harness doctor [--target codex\|opencode] [--rm-rogue-ledgers] [--yes]` | Health summary across hooks, packs, MCP registrations, runtime detection, and binary version. A bare run is read-only; `--rm-rogue-ledgers` opts into deleting each rogue evidence-ledger directory it finds (prompts per hit; add `--yes` to skip the prompts). Exits `1` when the report's `errorCount` is above zero (in both prose and `--json` mode) so CI/scripts can gate on doctor health; warnings alone (`warningCount`) still exit `0`. `--target codex` / `--target opencode` verifies that runtime's adapter wiring after `apply --runtime <same>` (config artefact presence/banner +, for opencode, every projected MCP server's command resolving on PATH). A declared `policy_packs[].min_version` is reported as a warning, because a builtin pack has no probe to enforce it. Declared-but-not-live packs are checked against the runtime a plain `harness apply` would select (recorded in `.last-apply`, inferred from its files, else `claude-code`, through apply's own `selectRuntime`), never against `--target`, and the report names it (`Pack expansion runtime: codex (recorded by the last apply)`; `packExpansionRuntime` in `--json`; a malformed `.last-apply` falls back to the default and adds a warning naming the file). |
| `harness list <category>` | Print one category's entries as a flat table or JSON. Valid categories: `mcp`, `cli`, `skills`, `memories`, `hooks` (`policies` and `workflows` were removed in 1.0.0; naming one is a usage error that says so). `memories` rows carry a `project_rejected` field only when `--project` was supplied and rejected by `isValidProjectName` (see the SINK GUARD note below); `harness list` itself prints no warning for it, unlike `harness doctor`. |
| `harness audit [--since 1h] [--policy <name>] [--outcome <outcome>] [--session <id>] [--json]` | Replay recorded policy decisions from the evidence-ledger: the `policy_decision:` rows written by pre-1.0.0 releases (the policy engine that wrote them is removed, so nothing adds new ones). `--json` also carries the resolved `sessionId`. |
| `harness session-export [sessionId]` | Export the full evidence-ledger for a Claude Code session as JSON, suitable for archival or attaching to a PR. |

## Policy runtime (removed in 1.0.0)

The policy engine is removed. `harness policy intercept`, `harness explain` and `harness dry-run` were the runtime evaluator and its debug verbs; all three are gone, and a manifest hook that still calls one loads with a warning and fails at runtime with "unknown command" (see Removed keys, packs and commands above).

## Hook entrypoints

These are called by Claude Code via `settings.json`; you usually do not run them yourself. They are documented here for operators reading their settings files. All runtime hook entrypoints live under the `harness pack hook ...` namespace (the table previously showed a `harness hook ...` spelling that does not exist; `harness add hook <name>` is the unrelated manifest mutation).

| Verb | Called from |
|------|-------------|
| `harness pack hook branch-protection [--runtime claude-code\|codex]` | `PreToolUse` branch-guard for the protected branches (task `a4d8adc5`): asks git (`git -C <dir> symbolic-ref -q HEAD`) for the branch of every directory the call writes into and refuses when git names a protected branch (compared case-insensitively) or cannot answer; outside every repository and on a detached HEAD it allows. Claude Code gets a JSON deny envelope on stdout (exit 0); `--runtime codex` exits 2 with the reason on stderr. See [`docs/policy-packs/branch-protection.md`](policy-packs/branch-protection.md). |
| `harness pack hook runtime-reality` | `PreToolUse` drift gate (v0.31.0, opt-in): before destructive runtime commands, probes live process state and denies on critical drift against the expectations file. Fail-open on probe errors. See [`docs/runtime-reality-hook.md`](runtime-reality-hook.md). |

## Operator approvals

`harness approve` no longer exists; there is no CLI approval verb.

Removed in task `a4d8adc5`: `harness approve branch-protection` and `harness session-start branch-check`. Removed in task `f3f15290`: the entire `harness session-start` command group (`preflight`, `toolchain-parity`, `stale-base-check`) and the top-level `harness preflight` alias. Removed in task `39c112e0`: the entire `harness approve` command group; its last kind went with the Risk Gate. The branch-protection gate asks git for the branch on every call and keeps no ledger tag or override marker; to edit a protected branch deliberately, switch the gate off from an operator shell (`harness gate disable`, below).

## Gate kill-switches

| Verb | One-liner |
|------|-----------|
| `harness gate disable [--matcher <pattern>] [--runtime claude\|codex] [--settings <path>] [--config <path>]` | Remove hook groups from `~/.claude/settings.json` whose matcher substring-matches the pattern; with `--runtime codex`, neutralise the matching hook units of the harness-managed block of `~/.codex/config.toml` in place (`hooks = []`, so other hooks keep their position and trust; `--config` overrides the path). With no `--matcher`, lists candidates without writing. Snapshots what it changed + backs up the file for `gate enable`; at most one snapshot per file stays live. A second disable joins it only when the file is exactly the state that snapshot left; a snapshot with nothing left to restore is retired by the disable, and in any other state the disable refuses and names the way out (`gate enable --force`, then the disable again). |
| `harness gate enable [--runtime claude\|codex] [--settings <path>] [--config <path>] [--force]` | Restore the one live snapshot `gate disable` keeps for that file and retire it (renamed `*.restored.json`); a Claude snapshot is never applied to the Codex config, or the reverse. A second disable merges into the snapshot, so one enable restores everything. On Claude a removed group counts as back only when the file holds an unchanged copy of it; a group with the same event and matcher but other content may be another hook, so enable refuses while there is one (and prints both) unless `--force` takes it as back, and `--force` otherwise puts back every group still missing and keeps every other edit. Enable looks only beside the given path; a snapshot that names another settings file in the same directory (an alias such as `settings.local.json`, or a link under another name) is foreign: enable exits non-zero and prints the `--settings` it needs. On Codex a snapshot restores byte for byte when the config is unchanged since the disable (an edited config refuses without `--force`, unless skipping the units already back rebuilds the pre-disable bytes); one a later install or a hand edit superseded is renamed `*.superseded.json` (the install renames it itself), and enable exits non-zero naming any unit that stays disabled. Details and recovery recipes: [`docs/okf/gate-kill-switch.md`](okf/gate-kill-switch.md). |

## Environment variables

Variables the `harness` binary reads. For the `RUNTIME_REALITY_*` variables of the runtime-reality hook see [`runtime-reality-hook.md`](runtime-reality-hook.md).

| Variable | Read by | Effect |
|---|---|---|
| `HARNESS_HOME` | every verb that resolves the state root | Pins the state root, ahead of `~/.harness/` and the legacy `~/.claude/`. |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID` | `harness audit`, `harness session-export` | Session id fallback, in this order, when `--session` carries none. `audit` then falls back to the newest Claude Code transcript. |
| `CLAUDE_CONFIG_DIR` | `harness init --interactive`, `harness doctor`, `harness adopt`, `harness uninstall` | Moves the Claude Code user-scope MCP registry these verbs read from `~/.claude.json` to `$CLAUDE_CONFIG_DIR/.claude.json`. |

`harness` itself does not read `EVIDENCE_LEDGER_DB` or `SOLUTION_VERDICT_SIGNING_KEY`: `harness apply` projects only `EVIDENCE_LEDGER_DB` onto the `grounding-mcp` server entry, which reads it. It no longer projects `SOLUTION_VERDICT_SIGNING_KEY` (task 21a2c508): grounding-mcp falls back to `<harness-home>/harness.generated/.approval-signing.key` when the variable is unset, and an operator-declared `env.SOLUTION_VERDICT_SIGNING_KEY` on the manifest entry still passes through.

## Notes

- `harness doctor` now exits non-zero (`1`) whenever the report has `errorCount > 0`, in both prose and `--json` output; previously it always exited `0` regardless of errors, so CI/scripts had no way to gate on doctor health (task a07b379a). Warnings-only reports (`warningCount > 0`, `errorCount === 0`) are unaffected and still exit `0`; this pass intentionally does not add a `--strict` flag to promote warnings to errors. Non-interactive `harness init` is unrelated and unchanged: it keeps its existing loud-stderr-but-exit-0 contract.
- Since `v0.36.0`: `harness doctor --rm-rogue-ledgers` (with `--yes` to skip the per-hit prompt) opts into deleting rogue evidence-ledger directories that doctor reports.
- Since `v0.34.0`: `apply --yes` (skip the `--overwrite-drift` confirmation) and non-TTY guards on the `apply`/`adopt` confirmation prompts (they refuse instead of hanging; piped `echo yes |` confirmations no longer work, use `--yes`).
- The `review:` ledger tag vocabulary belonged to the gate-mode policies removed in 1.0.0 (with the `harness record` verbs that wrote the tags). The branch-protection gate consults no ledger tag at all; it asks git.

### `--project` name validation

Every command that takes `--project <name>` (and every caller that builds `LoaderOptions.project` by hand) feeds the name into path joins and `{project}` substitutions. This note covers how that name is screened.

**SINK GUARD (task `1c4eb3ea`; task `e904f25a`):** `isValidProjectName` (`src/io/project-name.ts`, moved from `src/runtime/git-context.ts`, task `b5e6ccb0`, which now re-exports it) screens a project name at the SOURCE, on two independent grounds: the shapes that escape a path segment (the empty string, `.`, `..`, a forward slash, a backslash) and, since task `e904f25a`, any control character (C0 `U+0000` to `U+001F`, which includes NUL, LF, CR and ESC; DEL `U+007F`; C1 `U+0080` to `U+009F`, NEL included). It is exported for reuse at each of `{project}`'s four interpolation sinks; three are guarded, one remains open. Leaving that one open is accepted rather than a live escape: it is reached ONLY through an explicit `--project <name>` flag an operator passes by hand, never through a cwd-derived name (`deriveProjectName` validates its own return value before any sink sees it). That sink calls the validator nowhere, so it inherits NEITHER screen; the control-character rule stated below is a property of the guarded paths, not of the whole codebase.

- `resolvePaths`' `path.join` sink (`src/cli/loader.ts`) — guarded since task `1c4eb3ea` (defense in depth: `deriveProjectName` already validates its own return value before this sink is reached from anywhere else); an invalid name resolves `projectLayer: null`, same as "no layer on disk".
- `substituteProject` (`src/probes/memory.ts`) — guarded since task `e904f25a`; an invalid name degrades to the "no project supplied" branch, so `{project}` survives substitution and reports `unresolved: true` instead of escaping the intended directory. Substitution runs AFTER `expandHome` and uses a literal `split`/`join` (never `replace`+regex), so `$'`/`` $` `` insert literally and `~` never re-anchors a relative pattern to the home directory.
- `generate-memory-index.ts`'s own `{project}` substitution — unguarded; that file is reserved for a separate slice (see [CHANGELOG.md](../CHANGELOG.md) for the reservation), so guarding it is left to that slice rather than worked around here. Reached only through an explicit `--project`, never through a cwd-derived name.
- `buildLockEntries` (`src/io/harness-lock.ts`): guarded since task `b5e6ccb0`; an invalid name skips the templated directory's lock entry the same way an absent `opts.projectName` already did, so the raw value never lands in `harness.lock` and can never resurface in `harness diff --since-apply`'s drift list on a later run that passes no `--project` at all.

A rejected `--project` value (one that fails `isValidProjectName`) is reported distinctly from the ordinary "no project supplied" case: `harness doctor` renders it as its own warn line, gated on at least one memory directory actually carrying the `{project}` placeholder (`MemoryReport.projectRejected`, `src/probes/memory.ts`), while `harness list memories` carries the same value only as a conditionally present `project_rejected` row field (present only when rejected, absent otherwise, since `renderText` derives its columns from the first row) and prints no warning of its own; only `harness doctor` warns. Two complementary rules, not an enumeration of rendering sites, keep a crafted `--project` value out of `harness doctor`'s and `harness list memories`' rendered output. First, an ACCEPTED name cannot carry a control character at all, because `isValidProjectName` refuses one at the source (see SINK GUARD above); that also covers the surfaces that render the SUBSTITUTED directory path rather than the name itself, doctor's `memory directory missing` line and `list memories`' `path` row field, which no per-site escaper of the name would have reached. Second, a REJECTED name is by definition unvalidated and is still echoed back so the operator can see WHICH value was refused, so every such echo goes through `sanitizeProjectForDisplay` (`src/io/project-name.ts`, moved from `src/runtime/git-context.ts`, task `b5e6ccb0`, which now re-exports it), which strips the same control characters: doctor's rejection warning, its per-directory note, its header `project:` clause (which renders the raw `--project` whether it was accepted or rejected), and `list memories`' `project_rejected` field (and with it the text table derived from it). Report DATA keeps the raw value (`DoctorReport.project`, `MemoryReport.projectRejected`), carried over `--json` by JSON's own escaping rather than by a raw control byte. A cwd-derived name containing a control character is rejected exactly the way a `..` basename already was: `deriveProjectName` returns `null`, no project override layer resolves for that repository, and the base/machine value applies, with no error and no warning. Pinned by `tests/runtime/git-context.test.ts` (the validator's control-character screen and the display stripper) and by `tests/cli/doctor.test.ts` and `tests/cli/list.test.ts` (a control-bearing `--project` with NO path separator: rejected, echoed sanitized, no forged line or row, the substituted path still carrying the literal placeholder, `--json` parseable).
