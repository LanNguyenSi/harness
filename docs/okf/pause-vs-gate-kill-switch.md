---
type: runbook
title: Kill switches — pause vs gate disable
description: harness has two distinct operator kill switches — `harness pause` (sentinel file, silences ALL hooks temporarily, operator-only enforced in code) vs `harness gate disable` (surgically removes matching hook groups from settings.json with a reversible snapshot); when to use which, exact flags, restore paths, and trust caveats.
tags: [runbook, pause, gate-disable, kill-switch, operator]
timestamp: 2026-07-09T02:50:30.125962Z
sources:
  - src/runtime/pause-sentinel.ts
  - src/cli/pause/index.ts
  - src/cli/gate/disable.ts
  - src/cli/gate/enable.ts
  - src/cli/gate/snapshot.ts
  - src/cli/index.ts
  - src/io/generated-dir.ts
  - docs/for-humans.md
---

# Kill switches: `harness pause` vs `harness gate disable`

harness has TWO separate kill-switch mechanisms. Do not conflate them: `pause` is a temporary, all-or-nothing, auto-expiring mute of every hook; `gate disable` is a surgical, persistent removal of specific hook groups from Claude Code's `settings.json`. They operate on different state (sentinel file vs settings.json), have different guardrails, and different restore paths.

## Decision table

| Situation | Use |
|---|---|
| Lockout recovery, debug A/B test, incident hotfix, short window | `harness pause --for <duration>` (all hooks dormant, auto-resumes) |
| One specific hard-blocking hook must go, e.g. the understanding-before-execution PreToolUse gate blocks every Bash call INCLUDING its own recovery command `harness approve understanding` (the motivating case, task 8fcddb26, comment at `src/cli/index.ts:2206-2211`) | `harness gate disable --matcher <substring>` (removes only matching hook groups, reversible snapshot) |
| Permanently turn a policy off | NEITHER. Edit `policies[].enabled` in the manifest (or `policy_packs[].enabled: false`) — persistent, diff-able, source-controlled. Stated in the `harness pause` command help (`src/cli/index.ts:2555-2556`) and `docs/for-humans.md:343-352` |
| "Move fast on a prototype branch" | A branch-aware policy with a `when:` clause, not a session-wide pause (`docs/for-humans.md:348-349`) |

## Mechanism 1: `harness pause` / `harness resume` (sentinel)

**What it is.** One JSON file at `<generatedDir>/.harness-paused` (`SENTINEL_BASENAME` in `src/runtime/pause-sentinel.ts:26`). `generatedDir` is `harness.generated/` next to the manifest in use, or `<homeDir>/harness.generated` with an override (`src/io/generated-dir.ts`). While the sentinel exists and is unexpired, EVERY PreToolUse/PostToolUse hook calls `maybeAnnouncePause()` (`src/runtime/pause-sentinel.ts:153`), emits one stderr line (`harness <hook>: PAUSED since Xm ago (reason: ...); auto-resumes in Ym. Run \`harness resume\` to re-enable.`) and short-circuits to allow without evaluating gate logic. On the first hook fire AFTER expiry the sentinel is silently deleted (auto-resume) and gating resumes.

**Commands** (registered in `src/cli/index.ts:2550-2648`):
- `harness pause --for <duration>` — e.g. `5m`, `1h`, `PT30S`; default 15 minutes (`DEFAULT_PAUSE_SECONDS = 15 * 60`, `src/cli/pause/index.ts:36`).
- `harness pause --indefinite` — refuses unless the separate verbose flag `--i-am-the-operator-and-accept-no-auto-resume` is also passed; the flag's verbosity is deliberate friction (`src/cli/pause/index.ts:260-272`).
- `--reason <text>` — recorded in the sentinel and announced on each hook fire.
- `harness resume` — deletes the sentinel. Idempotent: against an un-paused install it exits 0 with a notice and skips the ledger write (`src/cli/pause/index.ts:361-368`).
- Re-running `pause` while already paused overwrites the sentinel with the new expiry and flags `note: harness was already paused` in output.

**Operator-only, CODE-CHECKED but NOT CODE-ENFORCED: verified live (task cf1fde6d).** Both `pause` and `resume` refuse (exit EX_USAGE) when any of `$CLAUDE_CODE_SESSION_ID` (canonical, what Claude Code exports), legacy `$CLAUDE_SESSION_ID`, or `$CODEX_SESSION_ID` is set (`refuseIfAgentShell`, `src/cli/pause/index.ts:172-224`), and refuse non-TTY stdin unless `--i-am-the-operator` is passed (`refuseIfNonTTY`, `src/cli/pause/index.ts:226-243`). Do NOT run it from inside Claude Code with the `! ` prefix: that shell INHERITS this session's env AND its non-TTY stdin, so it trips both checks exactly like an agent Bash call would, reproduced live: `! harness pause --for 6h` refuses on the agent-shell check; `! env -u CLAUDE_CODE_SESSION_ID harness pause --for 6h` then refuses on the non-TTY check. There is no in-session shell shape that satisfies both checks; the operator must use a terminal genuinely outside the agent session. Because of this, an agent can bypass both checks with one ordinary Bash-tool call and no `! ` involved: `env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CODEX_SESSION_ID harness pause --for 1h --i-am-the-operator`. The actual enforcement point that runs BEFORE the agent's Bash executes is the PreToolUse deny-policy layer described below, not this CLI check.

**Enforcement layer.** `harness init --template full` ships three default `block` policies (`src/cli/init/templates.ts`, mirrored in `docs/examples/full-manifest.yaml`) that deny, from the agent's Bash tool: `deny-kill-switch-bypass` (`harness pause` / `harness resume` / `harness gate disable` / `harness gate enable` themselves), `deny-session-env-strip` (the `env -u CLAUDE_CODE_SESSION_ID` / `unset CLAUDE_SESSION_ID` / etc. wrappers that defeat `refuseIfAgentShell`), and `deny-pause-sentinel-forgery` (direct writes to `.harness-paused` via `>`, `tee`, or `cp`; reads are unaffected). All three intentionally declare no `producers:`: there is no legitimate way to satisfy them from inside the session, only from a terminal genuinely outside it (see `docs/writing-custom-policies.md` tripwire 4); `harness validate` warns "declares no producers" on each, which is correct and intentional. Known gap: a bash_match regex cannot see through a heredoc, `python -c`, a base64-decoded payload, a script file the agent creates and then executes, or a symlink swap; closing that class needs signing the sentinel (HMAC) or a filesystem-level write guard, neither implemented.

**Audit trail.** Pause/resume write `harness-paused:<pausedAt>` / `harness-resumed:<pausedAt>` facts to the evidence ledger via grounding-mcp, under the synthetic session bucket `default` (`OPERATOR_LEDGER_SESSION`, `src/cli/pause/index.ts:48`) since no agent session id exists in an operator shell. `harness audit --since 24h` surfaces them. Ledger failure does not block the pause; it is reported as `ledger: ⚠ skipped`.

**Trust caveat.** The sentinel is plain JSON with NO signature (`docs/for-humans.md:363-375`). Neither the CLI checks nor the PreToolUse deny-policy layer above is a true boundary against an agent that already has Write access under `harness.generated/` (see "Known gap" above). Defence: deny agent writes to `harness.generated/` (blanket deny is simplest; the agent surface normally never needs to write there). Fail-open note: a malformed sentinel is treated as absent (never escalates to a block), but a forged `expiresAt` that is not a non-empty string or null is rejected as malformed rather than silently read as indefinite (`normalizeSentinel`, `src/runtime/pause-sentinel.ts:72-92`).

## Mechanism 2: `harness gate disable` / `harness gate enable` (settings.json surgery)

**What it is.** Reads `~/.claude/settings.json` (override: `--settings <path>`; default resolved via `os.homedir()` + `.claude/settings.json`, `src/cli/gate/disable.ts:31,82-88`), removes hook groups whose `matcher` field substring-matches `--matcher <pattern>` — LITERAL substring, not regex, so operators can paste the exact matcher from the gate's deny message (`matcherMatches`, `src/cli/gate/disable.ts:184-193`). Before mutating it: (1) backs up the original to `<settings.json>.bak.<ISO>` , (2) writes a snapshot of the removed groups to `<settings-dir>/harness.gate-disable.<ISO>.json` (ISO stamps use `-` for `:`, `src/cli/gate/snapshot.ts:65-77`), then (3) atomically rewrites settings.json. Ordering is deliberate: backup before any mutation, snapshot before the live rewrite (`src/cli/gate/disable.ts:234-265`). Refuses to operate on non-JSON or non-object settings files rather than "fixing" them.

**Dry-run.** With NO `--matcher`, `harness gate disable` is a pure listing: it prints every candidate hook group (`event[index] matcher=... : commands`) and exits without writing anything (`src/cli/gate/disable.ts:201-203`). A `--matcher` that matches nothing errors and points you at the no-args listing.

**Restore.** `harness gate enable` (`src/cli/gate/enable.ts`) picks the NEWEST `harness.gate-disable.*.json` snapshot next to settings.json (mtime-sorted, `listSnapshots` in `src/cli/gate/snapshot.ts:85-107`) and splices the removed groups back at their original indices. Two safety behaviors:
- **Hash-mismatch refusal** (`src/cli/gate/enable.ts:166-173`): if the on-disk settings.json sha256 differs from the snapshot's recorded `settingsAfterSha256`, you edited the file since the disable; enable refuses so it does not overwrite your edits. Inspect the diff against the recorded `settingsBackupPath`, then pass `--force` to restore anyway.
- **Idempotent**: if the current sha equals `settingsBeforeSha256` (already restored), it exits 0 without writing (`src/cli/gate/enable.ts:160-163`).

**Guardrail asymmetry — verified.** Unlike `pause`, `gate disable`/`gate enable` have NO agent-session env-var or TTY refusal in code, and this task (cf1fde6d) did not add one (see "Out of scope" in the task record); adding a code-level check to these verbs is a separate, not-yet-done change. `GateDisableOptions` is only `settingsPath | homeDir | matcher | now` (`src/cli/gate/disable.ts:33-51`); `GateEnableOptions` is only `settingsPath | homeDir | force`. Its operator-only nature is by intent and documentation ("operator escape hatch"), not enforced in the CLI. What DID change: `harness gate disable` / `harness gate enable` are now among the commands the `deny-kill-switch-bypass` PreToolUse policy denies from the agent's Bash tool (see "Enforcement layer" above), so an agent with Bash access under a `full`-template install is blocked at the hook layer even though the CLI itself still has no check. If your policy set does not gate Bash (or the operator installed a manifest without that policy), the CLI has nothing stopping `harness gate disable`, and the reversible snapshot plus `.bak` file are the recovery record either way.

## Quick recovery recipes

- Locked out of every Bash call by a PreToolUse gate, recovery command itself blocked: from your OWN shell, `harness gate disable` (list), find the offending group's matcher, `harness gate disable --matcher <substring>`, fix the underlying state, `harness gate enable`.
- Debugging whether harness causes a behavior: `harness pause --for 15m --reason "A/B test"`, reproduce, `harness resume` (or let it auto-expire).
- Check pause state: stat `<generatedDir>/.harness-paused`, or just run any hooked tool and read the stderr notice; audit history via `harness audit --since 24h` (session bucket `default`).
