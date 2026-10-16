---
type: runbook
title: "Kill switch: harness gate disable / enable"
description: "harness's shipped operator kill switch: `harness gate disable` / `harness gate enable` edit the live runtime config with a reversible snapshot, `~/.claude/settings.json` for Claude Code (matching hook groups are removed) and, with `--runtime codex`, the harness-managed hook block of `~/.codex/config.toml` (a matching unit is neutralised in place so every other hook keeps its position and its trust); when to use it, exact flags, what is written, how restore works, hooks without a matcher, and the recovery recipes."
tags: [runbook, gate-disable, kill-switch, operator]
timestamp: 2026-10-16T17:45:02Z
sources:
  - src/cli/gate/disable.ts
  - src/cli/gate/enable.ts
  - src/cli/gate/snapshot.ts
  - src/cli/gate/codex-disable.ts
  - src/cli/gate/codex-snapshot.ts
  - src/cli/gate/codex-enable.ts
  - src/cli/register-gate-gc-group.ts
  - src/cli/apply/install-codex-config.ts
  - src/cli/apply/generate-settings.ts
  - src/policy-packs/builtin/branch-protection.ts
  - src/schema/policy-packs.ts
  - src/schema/removed-keys.ts
  - docs/policy-packs/branch-protection.md
  - docs/runtime-reality-hook.md
---

# Kill switch: `harness gate disable` / `harness gate enable`

harness ships ONE operator kill switch: `harness gate disable` takes the hook groups or hook units whose matcher matches a substring out of the live runtime config with a reversible snapshot, and `harness gate enable` puts them back. `harness pause` and `harness resume` were removed in 1.0.0 (task 973163a4), and the gate verbs are their replacement: both are `REMOVED_COMMANDS` entries now, so a hook or `ux.run` line that still calls one is reported by validate, doctor and apply (`src/schema/removed-keys.ts:474-475#"the operator pause is removed"`).

## When to use this

- Lockout recovery: a hard-blocking hook refuses the calls you would use to recover.
- "Is this harness or my code?" debugging: switch one hook off, reproduce, enable it again.
- A deliberate edit on a protected branch (a hotfix on `master`): branch-protection is the shipped gate this is for.
- One specific hook group must be off for a while and you want the file state back afterwards.

To turn a shipped gate off permanently use NEITHER verb: set `policy_packs[].enabled: false` on the pack (`src/schema/policy-packs.ts:24#"enabled: z.boolean().default(true),"`) or remove the hook entry from the manifest, then re-run `harness apply`. Persistent, diff-able, source-controlled.

## Guardrail note

The gate is the "operator escape hatch for hard-blocking hooks" (`src/cli/register-gate-gc-group.ts:39#"operator escape hatch for hard-blocking hooks"`), but nothing enforces that in the CLI: `GateDisableOptions` is only `settingsPath | homeDir | matcher | now` (`src/cli/gate/disable.ts:33-50#"now?: Date"`), with no agent-session env-var or TTY refusal. An agent with Bash access can run the verb; the snapshot plus `.bak` file are the recovery record either way.

## Claude Code: settings.json surgery

Flags: `harness gate disable [--matcher <pattern>] [--settings <path>] [--runtime claude|codex]`, default runtime `claude`; `--config` belongs to `--runtime codex` and is refused here (`src/cli/register-gate-gc-group.ts:25-26#"only applies to --runtime codex; use --settings"`). The verb reads `~/.claude/settings.json` (`DEFAULT_SETTINGS_REL`, `src/cli/gate/disable.ts:31#"DEFAULT_SETTINGS_REL"`) and removes the hook groups whose `matcher` contains the pattern, a literal substring and not a regex (`m.includes(pattern)`, `src/cli/gate/disable.ts:184-192#"m.includes(pattern)"`). With no `--matcher` it is a pure listing of the candidate groups and writes nothing (`src/cli/gate/disable.ts:10-10#"pure listing"`); a `--matcher` that matches nothing errors and points at that listing (`src/cli/gate/disable.ts:222-223#"no hook groups matched"`). A settings file that is not a JSON object refuses the operation rather than being "fixed" (`src/cli/gate/disable.ts:110-115#"restore from a backup"`).

What it writes, in order: a backup of the original to `<settings.json>.bak.<ISO>`, a snapshot of the removed groups to `<settings-dir>/harness.gate-disable.<ISO>.json` (ISO stamps use `-` for `:`, `src/cli/gate/snapshot.ts:65-76#"bak."`), then the atomic rewrite of settings.json; the backup lands before any mutation and the snapshot before the live rewrite, so a crash between the writes never leaves settings.json mutated without its way back (`src/cli/gate/disable.ts:230-265#"atomicWriteFile(settingsPath, newSettings);"`).

Restore: `harness gate enable [--settings <path>] [--force]` picks the NEWEST `harness.gate-disable.*.json` snapshot next to settings.json by mtime (`candidates.sort`, `src/cli/gate/snapshot.ts:87-110#"candidates.sort"`) and splices the groups back at their recorded indices. Two safety behaviors: a file that already matches the pre-disable sha exits 0 without writing (idempotent, `src/cli/gate/enable.ts:160-163#"already-restored"`), and a file whose sha matches neither state (you edited it since the disable) refuses, so the restore cannot overwrite your edits: inspect the diff against the recorded `settingsBackupPath`, then pass `--force` (`src/cli/gate/enable.ts:166-171#"pass --force to restore anyway"`).

## Codex: the harness-managed hook block

Flags: `harness gate disable --runtime codex [--matcher <pattern>] [--config <path>]` and `harness gate enable --runtime codex [--config <path>] [--force]` (task 1f6ec6c9). The default target is `~/.codex/config.toml` (`src/cli/apply/install-codex-config.ts:157-158#"config.toml"`); the verbs edit only the `# BEGIN harness-managed codex hooks` block that `harness apply --runtime codex --install` writes, and text outside the fences is never touched.

Disable does not delete a unit: the comment line, the `[[hooks.<Event>]]` header and the `matcher` line stay and the unit's `hooks = [...]` line becomes `hooks = []` (`CODEX_NEUTRALISED_HOOKS`, `src/cli/gate/codex-snapshot.ts:38#"CODEX_NEUTRALISED_HOOKS"`). Codex keys a user hook's trust and enabled state by the hook's position inside its event's array, and an empty group takes that position without registering a handler, so every other hook of every event keeps its position and its trust (`src/cli/gate/codex-disable.ts:9-10#"keys a user hook's trust and enabled state by its position in the event's"`). The matcher rule is the same literal substring as on Claude. The listing marks a unit an earlier disable already neutralised with `[disabled]`, and disable refuses to neutralise an already-disabled unit twice. A backup `<config>.bak.<ISO>` and a snapshot `harness.gate-disable-codex.<ISO>.json` land beside the config under its own file prefix (`src/cli/gate/codex-snapshot.ts:29#"CODEX_SNAPSHOT_BASENAME_PREFIX"`) with the config's own file mode, before the rewrite. The snapshot carries `version: 3` and `target: "codex"`, so a Claude settings snapshot is never restored into the Codex config and a Codex snapshot is never read as a settings.json one (`src/cli/gate/codex-snapshot.ts:12-13#"can never be restored into TOML"`).

Enable walks the snapshots taken for that config (another config's are skipped and named) by their recorded `createdAt`, newest first, never by file mtime (`src/cli/gate/codex-enable.ts:7#"walks them by their recorded"`): it applies the newest that matches the config byte for byte, then each older one that matches the result byte for byte, so two disables need one enable, and each unit gets its original `hooks = [...]` line back byte-identically. A snapshot it applies, or finds the config already matching, is renamed to `*.restored.json`; one taken before a later `harness apply --runtime codex --install`, or whose units are all enabled again, is renamed to `*.superseded.json`; neither is applied again. The install is dated by the installer's `<config>.harness-backup-*` files beside the config (`src/cli/apply/install-codex-config.ts:2222-2223#".harness-backup-"`), which is the protection against an outdated snapshot putting an outdated hooks line back: delete or move those files and that protection is gone (`src/cli/gate/codex-enable.ts:11-12#"dates that write"`). Enable exits non-zero and names the units while any unit stays disabled or a unit a live snapshot names is missing from the block (`src/cli/register-gate-gc-group.ts:187-190#"are still disabled"`). `--force` applies the newest snapshot to a config edited since: it swaps only that snapshot's hooks lines back into the units it names (found by id), keeps every other edit, handles one snapshot per run, and refuses when a unit is missing, changed, or not disabled (`src/cli/gate/codex-enable.ts:21-22#"a forced restore swaps only the snapshot's hooks lines back"`). A later `harness apply --runtime codex --install` re-renders the whole block and brings disabled units back (`src/cli/gate/codex-disable.ts:20-21#"re-renders the whole block"`).

## Hooks without a matcher

The matcher is a literal substring of the hook group's `matcher`, so a group WITHOUT a matcher cannot be targeted by `gate disable` on either runtime (`src/cli/gate/disable.ts:184-186#"if (m === null) return false;"`, `src/cli/gate/codex-disable.ts:116#"unit.matcher !== null"`). A manifest hook with no `match` projects exactly such a matcher-less group (`src/cli/apply/generate-settings.ts:13-13#"is omitted when the manifest hook has no"`), and the documented runtime-reality hook entry is declared without `match` (`docs/runtime-reality-hook.md:22-28#"harness pack hook runtime-reality"`). Switch such a hook off with its own switch (`RUNTIME_REALITY_DISABLE=1` for runtime-reality, `docs/runtime-reality-hook.md:77#"short-circuit the hook entirely"`), give the entry a `match` and re-run `harness apply`, or remove it from the manifest and re-run `harness apply`.

## Branch-protection

branch-protection is the shipped gate the kill switch was written for: it asks git for the branch on every call and keeps no ledger tag, session state or override marker, and it never yielded to the removed pause. Its hook matches only `Write|Edit` on Claude Code and `apply_patch` on Codex (`src/policy-packs/builtin/branch-protection.ts:70-71#"PRE_TOOL_USE_MATCH_CODEX"`), so reach for the gate when the edit itself is refused.

- Claude Code: `harness gate disable` (list), `harness gate disable --matcher 'Write|Edit'` (quoted: an unquoted `|` is a shell pipe), do the edit, `harness gate enable`.
- Codex: `harness gate disable --runtime codex --matcher apply_patch`, do the edit, `harness gate enable --runtime codex`; see the pack doc (`docs/policy-packs/branch-protection.md:231#"Disable the gate (operator only)"`). On Codex, `enabled: false` on the pack plus `harness apply --runtime codex --install` does the same durably (`docs/policy-packs/branch-protection.md:248-248#"enabled: false"`).

## Recovery recipes

- Edit refused on a protected branch: the branch-protection recipe above, per runtime.
- A custom hook group blocks and you need it off for one call: list, disable by matcher substring, fix the underlying state, enable.
- `gate enable` refuses because the file was edited since the disable: read the diff against the `.bak.<ISO>` file the refusal names, then pass `--force` (Claude restores the snapshot wholesale; Codex swaps only that snapshot's hooks lines, one snapshot per run).
- Codex says a unit stays disabled and the snapshot no longer matches the file byte for byte: the refusal names `--force`; alternatively restore the config from the `<config>.bak.<timestamp>` beside it, or re-render the block with `harness apply --runtime codex --install`.
- Codex says a snapshot's unit is missing from the block: that snapshot stays live and restores nothing; re-run `harness apply --runtime codex --install` or restore the config from the backup beside it.
- A settings file corrupted by hand: restore the newest `.bak.<ISO>` file next to it; on Claude the gate verbs refuse to operate on a file that is not a JSON object rather than overwrite it.
