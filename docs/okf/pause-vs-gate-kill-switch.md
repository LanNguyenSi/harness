---
type: runbook
title: Kill switches — pause vs gate disable
description: harness has two distinct operator kill switches, `harness pause` (sentinel file, makes the `harness pack hook runtime-reality` hook dormant temporarily, operator-only checked in the CLI; branch-protection never yields to it) versus `harness gate disable` (surgically removes matching hook groups from settings.json with a reversible snapshot); when to use which, exact flags, restore paths, and trust caveats.
tags: [runbook, pause, gate-disable, kill-switch, operator]
timestamp: 2026-10-16T08:19:35Z
sources:
  - src/runtime/pause-sentinel.ts
  - src/cli/pause/index.ts
  - src/cli/pause-check.ts
  - src/cli/gate/disable.ts
  - src/cli/gate/enable.ts
  - src/cli/gate/snapshot.ts
  - src/cli/register-gate-gc-group.ts
  - src/cli/register-operator-lifecycle.ts
  - src/io/generated-dir.ts
  - src/schema/policy-packs.ts
  - src/cli/init/index.ts
  - src/cli/pack/hook-bootstrap.ts
  - src/cli/pack/hook-runtime-reality.ts
  - src/cli/pack/hook-branch-protection.ts
  - src/policy-packs/builtin/branch-protection.ts
  - docs/policy-packs/branch-protection.md
  - docs/for-humans.md
  - docs/CLI.md
---

# Kill switches: `harness pause` vs `harness gate disable`

harness has TWO separate kill-switch mechanisms. Do not conflate them: `pause` is a temporary, auto-expiring mute of the runtime-reality hook; `gate disable` is a surgical, persistent removal of specific hook groups from Claude Code's `settings.json`. They operate on different state (sentinel file vs settings.json), have different guardrails, and different restore paths. The one shipped gate `pause` does not mute is branch-protection, so `gate disable` (Claude Code) or `enabled: false` on the pack (Codex) is the switch for it.

`harness pause` used to mute the `harness policy intercept` hook too; the policy engine was removed in 1.0.0, and with it the three `operator_only` deny policies (`deny-kill-switch-bypass`, `deny-session-env-strip`, `deny-pause-sentinel-forgery`) that shipped in the `full` template to guard both kill switches from the agent's Bash tool. What remains is the CLI checks described below, and they are a speed bump, not a boundary (`docs/for-humans.md:294#"The CLI check is all there is"`).

## Decision table

| Situation | Use |
|---|---|
| Lockout recovery, debug A/B test, incident hotfix, short window | `harness pause --for <duration>` (the `harness pack hook runtime-reality` hook goes dormant, auto-resumes) |
| A deliberate edit on a protected branch (a hotfix on `master`), or one specific hard-blocking hook group that must go and that `pause` does not mute (branch-protection is the shipped one) | `harness gate disable --matcher <substring>` (removes only matching hook groups, reversible snapshot); on Codex set `enabled: false` on the pack and re-run `harness apply --runtime codex --install` (`docs/policy-packs/branch-protection.md:231#"Disable the gate (operator only)"`) |
| Permanently turn a shipped gate off | NEITHER. For the hooks a policy pack adds, set `policy_packs[].enabled: false` and re-apply (`src/schema/policy-packs.ts:24#"enabled: z.boolean().default(true),"`); for a hand-written hook, remove its entry from `hooks:` in the manifest. Persistent, diff-able, source-controlled |

## Mechanism 1: `harness pause` / `harness resume` (sentinel)

**What it is.** One JSON file at `<generatedDir>/.harness-paused` (`SENTINEL_BASENAME` in `src/runtime/pause-sentinel.ts:38#"SENTINEL_BASENAME"`). `generatedDir` is `harness.generated/` next to the manifest in use, or `<homeDir>/harness.generated` with an override (`src/io/generated-dir.ts:32-38#"path.dirname(opts.manifestPath)"`). While the sentinel exists and is unexpired, `harness pack hook runtime-reality` checks it before any gate logic runs (`src/cli/pack/hook-runtime-reality.ts:234#"checkHookPause("`), emits one stderr line (`harness <hook>: PAUSED since Xm ago (reason: ...); auto-resumes in Ym. Run \`harness resume\` to re-enable.`, `src/runtime/pause-sentinel.ts:190-191#"PAUSED since"`) and short-circuits to allow. Pack hooks go through `checkHookPause` (`src/cli/pack/hook-bootstrap.ts:83#"checkHookPause"`), which wraps `checkPauseFromLoader` (`src/cli/pause-check.ts:38#"checkPauseFromLoader"`) and `maybeAnnouncePause` (`src/runtime/pause-sentinel.ts:174#"maybeAnnouncePause"`). On the first hook fire AFTER expiry the sentinel is silently deleted (auto-resume) and gating resumes. Branch-protection is not a pause consumer at all (next paragraph), so a pause never mutes it.

**Branch-protection does not yield to a pause.** It is the only builtin policy pack and its hook never reads the sentinel; the comment on its stdin-timeout refusal says so (`src/cli/pack/hook-branch-protection.ts:340-342#"this gate does not yield to a pause"`), and the pack doc states "The operator pause (`harness pause`) does not switch this gate off" (`docs/policy-packs/branch-protection.md:244#"does not switch this gate off"`). The `pause` command help says the same (`src/cli/register-operator-lifecycle.ts:37-38#"branch-protection hook does not yield to a pause"`). `docs/for-humans.md:272#"Branch-protection does not yield to a pause"` and the `harness pause` row in `docs/CLI.md` give the accurate scope.

**Commands** (registered in `src/cli/register-operator-lifecycle.ts:35-97#"stdout("` (`pause`) and `src/cli/register-operator-lifecycle.ts:101-133#"stdout("` (`resume`)):
- `harness pause --for <duration>` - e.g. `5m`, `1h`, `PT30S`; default 15 minutes (`DEFAULT_PAUSE_SECONDS = 15 * 60`, `src/cli/pause/index.ts:36#"DEFAULT_PAUSE_SECONDS"`).
- `harness pause --indefinite` - refuses unless the separate verbose flag `--i-am-the-operator-and-accept-no-auto-resume` is also passed; the flag's verbosity is deliberate friction (`src/cli/pause/index.ts:269-279#"EX_USAGE"`).
- `--reason <text>` - recorded in the sentinel and announced on each hook fire.
- `harness resume` - deletes the sentinel. Idempotent: against an un-paused install it exits 0 with a notice and skips the ledger write (`src/cli/pause/index.ts:370-375#"no active pause"`).
- Re-running `pause` while already paused overwrites the sentinel with the new expiry and prints `note: harness was already paused` (`src/cli/register-operator-lifecycle.ts:78-79#"already paused"`).

**Operator-only, CODE-CHECKED but NOT CODE-ENFORCED.** Both `pause` and `resume` refuse (exit EX_USAGE) when any of `$CLAUDE_CODE_SESSION_ID` (canonical, what Claude Code exports), legacy `$CLAUDE_SESSION_ID`, or `$CODEX_SESSION_ID` is set (`refuseIfAgentShell`, `src/cli/pause/index.ts:172-221#"EX_USAGE"`), and refuse non-TTY stdin unless `--i-am-the-operator` is passed (`refuseIfNonTTY`, `src/cli/pause/index.ts:226-241#"EX_USAGE"`). Do NOT run it from inside Claude Code with the `! ` prefix: that shell INHERITS this session's env AND its non-TTY stdin, so it trips both checks exactly like an agent Bash call would (`docs/for-humans.md:282-288#"verified live"`). There is no in-session shell shape that satisfies both checks; the operator must use a terminal genuinely outside the agent session. Because the check is env-var based, an agent can bypass it with one ordinary Bash-tool call and no `! ` involved: `env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CODEX_SESSION_ID harness pause --for 1h --i-am-the-operator`. Until 1.0.0 that bypass was itself denied at the PreToolUse layer by the `deny-kill-switch-bypass` / `deny-session-env-strip` policies; the policy engine was removed in 1.0.0 and nothing was added to replace it, so today the CLI checks stop only the honest mistakes. Same for `harness gate disable`: no harness layer stands between an agent Bash call and that verb (see Guardrail asymmetry below).

**Audit trail.** Pause/resume write `harness-paused:<pausedAt>` / `harness-resumed:<pausedAt>` facts to the evidence ledger via grounding-mcp, under the synthetic session bucket `default` (`OPERATOR_LEDGER_SESSION`, `src/cli/pause/index.ts:48#"OPERATOR_LEDGER_SESSION"`) since no agent session id exists in an operator shell. `harness audit` replays only the pre-1.0.0 `policy_decision` rows, so these facts are read back through grounding-mcp's ledger query, not through `harness audit`. Ledger failure does not block the pause; it is reported as `ledger: ⚠ skipped` (`src/cli/register-operator-lifecycle.ts:91-93#"skipped"`).

**Trust caveat.** The sentinel is plain JSON with NO signature (`docs/for-humans.md:327-328#"no signature"`). The CLI checks are not a boundary against an agent that strips the environment before calling the verb, and they never see a direct filesystem write to the sentinel path from a non-Bash tool at all. Defence in depth is the agent surface itself: the agent normally never needs to write under `harness.generated/`. Fail-open note: a malformed sentinel is treated as absent (never escalates to a block), and so is one that cannot be read as a regular file (a FIFO, a device or a directory at the path, or a file over 1 MiB): `readSentinel` reads it through one bounded, non-blocking descriptor read (`src/runtime/pause-sentinel.ts:60-69#"readTextFileBoundedOrThrow(sentinelPath"`), so planting one neither hangs the hook past its budget nor counts as a pause that switches the gates off. A forged `expiresAt` that is not a non-empty string or null is rejected as malformed rather than silently read as indefinite (`normalizeSentinel`, `src/runtime/pause-sentinel.ts:90-105#"expiresAt must be a non-empty ISO string or null"`). Signing the sentinel (HMAC) would close the forgery class properly but is not implemented.

## Mechanism 2: `harness gate disable` / `harness gate enable` (settings.json surgery)

**What it is.** Reads `~/.claude/settings.json` (override: `--settings <path>`; default resolved via `os.homedir()` + `.claude/settings.json`, `src/cli/gate/disable.ts:31#"DEFAULT_SETTINGS_REL"` and `src/cli/gate/disable.ts:82-86#"os.homedir()"`), removes hook groups whose `matcher` field substring-matches `--matcher <pattern>` - LITERAL substring, not regex, so operators can paste the exact matcher from `settings.json` or the gate's deny message (`matcherMatches`, `src/cli/gate/disable.ts:184-192#"m.includes(pattern)"`). Before mutating it: (1) backs up the original to `<settings.json>.bak.<ISO>`, (2) writes a snapshot of the removed groups to `<settings-dir>/harness.gate-disable.<ISO>.json` (ISO stamps use `-` for `:`, `src/cli/gate/snapshot.ts:65-76#"bak."`), then (3) atomically rewrites settings.json. Ordering is deliberate: backup before any mutation, snapshot before the live rewrite (`src/cli/gate/disable.ts:230-265#"atomicWriteFile(settingsPath, newSettings);"`). Refuses to operate on non-JSON or non-object settings files rather than "fixing" them (`src/cli/gate/disable.ts:110-115#"restore from a backup"`).

**Dry-run.** With NO `--matcher`, `harness gate disable` is a pure listing: it prints every candidate hook group (`event[index] matcher=... : commands`) and exits without writing anything (`src/cli/gate/disable.ts:197-202#"return { mode"`). A `--matcher` that matches nothing errors and points you at the no-args listing (`src/cli/gate/disable.ts:222-224#"no args"`).

**Restore.** `harness gate enable` (`src/cli/gate/enable.ts`) picks the NEWEST `harness.gate-disable.*.json` snapshot next to settings.json (mtime-sorted, `listSnapshots` in `src/cli/gate/snapshot.ts:85-105#"candidates.sort"`) and splices the removed groups back at their original indices. Two safety behaviors:
- **Hash-mismatch refusal** (`src/cli/gate/enable.ts:166-171#"pass --force to restore anyway"`): if the on-disk settings.json sha256 differs from the snapshot's recorded `settingsAfterSha256`, you edited the file since the disable; enable refuses so it does not overwrite your edits. Inspect the diff against the recorded `settingsBackupPath`, then pass `--force` to restore anyway.
- **Idempotent**: if the current sha equals `settingsBeforeSha256` (already restored), it exits 0 without writing (`src/cli/gate/enable.ts:160-163#"already-restored"`).

**Guardrail asymmetry.** Unlike `pause`, `gate disable`/`gate enable` have NO agent-session env-var or TTY refusal in code. `GateDisableOptions` is only `settingsPath | homeDir | matcher | now` (`src/cli/gate/disable.ts:33-50#"now?: Date"`); `GateEnableOptions` is only `settingsPath | homeDir | force`. Its operator-only nature is by intent and documentation ("operator escape hatch", `src/cli/register-gate-gc-group.ts:11#"operator escape hatch for hard-blocking hooks"`), not enforced in the CLI. Until 1.0.0 the `deny-kill-switch-bypass` PreToolUse policy was what stood between an agent's Bash tool and these verbs; that policy layer was removed in 1.0.0 and nothing replaced it, so an agent with Bash access can run `harness gate disable` today. The reversible snapshot plus `.bak` file are the recovery record either way. `gate disable` edits the Claude Code settings only; it does not touch Codex.

## Quick recovery recipes

- Debugging whether harness causes a behavior: `harness pause --for 15m --reason "A/B test"`, reproduce, `harness resume` (or let it auto-expire). Pause mutes the runtime-reality hook only; for anything else use the recipe below.
- Edit or write refused on a protected branch (branch-protection; its hook matches only `Write|Edit` on Claude Code and `apply_patch` on Codex, `src/policy-packs/builtin/branch-protection.ts:70-71#"PRE_TOOL_USE_MATCH_CODEX"`, and does not yield to a pause). Claude Code: `harness gate disable` (list), `harness gate disable --matcher 'Write|Edit'` (quoted: an unquoted `|` is a shell pipe), do the edit, then `harness gate enable`. Codex: set `enabled: false` on the pack and run `harness apply --runtime codex --install`, do the edit, then revert both.
- A custom hook group blocks and you need it off for one call: `harness gate disable` (list), find the group's matcher, `harness gate disable --matcher <substring>`, fix the underlying state, then `harness gate enable`.
- Check pause state: stat `<generatedDir>/.harness-paused`, or just run a runtime-reality-hooked tool and read the stderr notice. The pause / resume history lives in the ledger under session bucket `default` (read it through grounding-mcp; `harness audit` only replays pre-1.0.0 `policy_decision` rows).
