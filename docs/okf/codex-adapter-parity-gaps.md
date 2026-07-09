---
type: module
title: Codex runtime adapter — parity gaps vs Claude Code
description: What harness's Codex runtime adapter is, the enumerated behavioral gaps vs the Claude Code first-class target (headline; no Codex PostToolUse hook, so approval_lifecycle.expire_on_tool_match never fires in Codex), and the Codex wire-format contract.
tags: [codex, runtime-adapter, parity, hooks]
timestamp: 2026-07-09T02:50:30.125962Z
sources:
  - src/policy-packs/builtin/understanding-before-execution.ts
  - src/policy-packs/builtin/understanding-before-execution-runtime.ts
  - src/policy-packs/builtin/branch-protection.ts
  - src/policy-packs/builtin/solution-acceptance.ts
  - src/cli/pack/hook-codex-pre-tool-use.ts
  - src/cli/pack/hook-codex-stop.ts
  - src/cli/pack/hook-codex-user-prompt-submit.ts
  - src/cli/apply/apply.ts
  - src/cli/apply/generate-codex-config.ts
  - src/cli/apply/install-codex-config.ts
  - src/cli/doctor/codex.ts
  - src/cli/policy/intercept.ts
  - src/runtime/tool-name-aliases.ts
  - src/runtime/session-id.ts
  - docs/policy-packs/understanding-before-execution.md
  - docs/CLI.md
  - docs/risk-gate.md
  - CHANGELOG.md
---

# Codex runtime adapter — parity gaps vs Claude Code

## What the adapter is

`harness apply --runtime codex` (Phase 6 #6) selects the Codex adapter instead of the default `claude-code`. It does NOT write `settings.json`; it emits `harness.generated/codex/config.toml` (`CODEX_CONFIG_BASENAME = "codex/config.toml"`, `src/cli/apply/apply.ts`) containing only harness-managed hook stanzas — `[[hooks.UserPromptSubmit]]`, `[[hooks.Stop]]`, `[[hooks.PreToolUse]]`, each with `hooks = [{ type = "command", command = "...", timeout = N }]` (`src/cli/apply/generate-codex-config.ts`, `emitHook`/`emitCommandHook`). With `--install`, only the marked harness-managed block inside `~/.codex/config.toml` is replaced; operator model/auth/sandbox config is never owned by harness (generator header, lines 48–69). `MEMORY.md` and pack `instructions.md` ship runtime-agnostic and unchanged (`apply.ts` ~line 378). The Codex hook entrypoints are harness CLI subcommands, not npm bins, because `@lannguyensi/understanding-gate` ships no Codex bins: `harness pack hook codex-user-prompt-submit` / `codex-stop` / `codex-pre-tool-use` (`understanding-before-execution.ts` lines 94–111; `docs/CLI.md` hook-entrypoints table rows 62–64). `harness doctor --target codex` checks the binary on `$PATH`, the generated TOML's banner, command resolvability per hook group, and reports-dir writability (`src/cli/doctor/codex.ts`; docs pack file "Doctor wiring").

Cross-runtime approval state is shared by design: both runtimes persist reports into the same `.understanding-gate/reports/` directory and use the same marker/approve flow, so `harness approve understanding` works identically after a Codex block (`understanding-before-execution.ts` lines 102–107).

## Current parity gaps (each verified in source)

1. **HEADLINE — the pack wires no Codex PostToolUse hook, so `approval_lifecycle.expire_on_tool_match` boundaries never fire in Codex sessions.** The `runtime === "codex"` branch of `buildHooks` in `src/policy-packs/builtin/understanding-before-execution.ts` (lines 325–356) returns exactly three hooks (UserPromptSubmit, Stop, PreToolUse); the Claude branch (lines 372–469) additionally emits the `PostToolUse` marker-expiry hook (`harness pack hook post-tool-use`, fires on `task_finish`/`task_abandon`/`pull_requests_merge`/`tasks_transition` by default). Consequence: in a Codex session an approval marker survives task-completion boundaries and only dies via `approval_lifecycle.max_age` TTL or manual `rm`. This is the buried residual of the CHANGELOG `[0.39.0]` task e7c2ec3c fix ("Known residual: the pack wires no Codex PostToolUse hook, so `expire_on_tool_match` boundaries still do not fire in Codex sessions"). An upstream tracking task exists in agent-tasks for this (a1348c89, "Codex has no PostToolUse hook: approval_lifecycle expire_on_tool_match/expire_on_bash_match never fire in Codex sessions").

2. **What e7c2ec3c DID fix (so you don't re-fix it): TTL and task-scoped markers now reach Codex.** Before 0.39.0 the Codex blocker called the bare session-marker check, so `approval_lifecycle.max_age` and `harness approve understanding --task` markers applied only to Claude Code. Both hooks now share `checkOperatorApprovalMarkers` (`understanding-before-execution-runtime.ts` ~line 859; consumed at `hook-codex-pre-tool-use.ts` lines 253–280), task-scoped marker first, session marker second, same TTL, plus a task-scope trace line on stderr. Pinned by five parity tests per CHANGELOG 0.39.0.

3. **No Codex active-claim tracker or stay-in-scope reminder.** The Claude branch emits the `track-active-claim` PostToolUse hook (writes `harness.generated/active-claim` on `task_start`, lets `harness approve understanding` auto-resolve `--task`) and the `stay-in-scope` PostToolUse reminder; the Codex branch emits neither (`understanding-before-execution.ts` lines 432–468 vs 325–356). A Codex session honors an existing task-scoped marker (gap 2) but can never produce the active-claim file itself.

4. **Pack permission profiles are not translated to a Codex sandbox stanza.** `policy_packs[].config.permission_profile` projects into Claude Code's `settings.json` `permissions` block; the Codex generator does not consume it and `apply --runtime codex` emits a counting warning instead ("--runtime codex does not yet wire permissions into Codex's sandbox shape (filed as a Phase 6 #6 follow-up)", `apply.ts` lines 382–398; generator header comment lines 26–28; docs pack file "Out of scope for v1"). For v1 the hooks alone are the enforcement on Codex.

5. **`--target` and `--runtime codex` are mutually exclusive.** `apply.ts` lines 604–613: `--target` wires the generated Claude-Code settings.json to a destination path; the codex branch produces no settings.json, so the combination throws `HarnessExitError("--target is incompatible with --runtime codex (target wires Claude Code's settings.json)", EX_NOINPUT)`. The two runtimes are mutually exclusive per apply invocation; covering one manifest under both requires two invocations into separate generated trees (docs pack file, "Adapter notes / Codex").

6. **solution-acceptance completion-gate loses its MCP choke points on Codex.** `completionMatch` in `src/policy-packs/builtin/solution-acceptance.ts` (lines 100–104) returns just `"Bash"` for codex because "Codex has no agent-tasks MCP surface here, so it gets the Bash arm only (documented limitation)"; Claude gets `Bash|mcp__agent-tasks__<verb>|...`. The write-guard match is also narrower: `apply_patch|Bash` vs Claude's `Edit|Write|MultiEdit|NotebookEdit|Bash` (lines 90–91).

7. **branch-protection blocker maps to `apply_patch` only on Codex** (`src/policy-packs/builtin/branch-protection.ts` lines 71–72: `PRE_TOOL_USE_MATCH_CLAUDE = "Write|Edit"`, `PRE_TOOL_USE_MATCH_CODEX = "apply_patch"`). Structural mapping rather than a hole, but note asymmetry with the understanding gate, whose Codex match also covers shell tools (`apply_patch|Bash|shell|exec_command|functions.exec_command`, `understanding-before-execution.ts` lines 76–77).

8. **Risk Gate cross-runtime support is officially deferred, with partial de-facto Codex accommodation.** `docs/risk-gate.md` (lines 439–442) declares cross-runtime support (OpenCode, Codex) deferred: "Phase 7 targets the Claude Code `PreToolUse` surface". Yet `src/cli/policy/intercept.ts` already carries Codex-specific plumbing: `isCodexShellTool` + `resolvePolicyCwd` resolve the policy cwd from Codex's sandbox `--command-cwd` argv (read from `/proc/1/cmdline` when the event has no cwd, lines 70–86 and 177–218), and the Codex generator appends `--hook <name>` to `harness policy intercept` commands so each spawned process self-identifies — deliberately NOT injected on the Claude side, where the generator dedupes by `(command, timeout)` and the flag would N-multiply audit writes (intercept.ts lines 75–86). The generator also pins a 2s timeout floor for `policy intercept` hooks, 1s otherwise (`codexTimeoutSeconds`, generate-codex-config.ts lines 129–132; noted in `docs/CLI.md` line 99, shipped v0.29.0).

9. **No `min_version` floor on Codex hooks.** Claude's UserPromptSubmit/Stop hooks carry `min_version: "0.4.0"` + `version_command: ["understanding-gate", "--version"]` against the npm bins; the Codex hooks are harness-internal subcommands and carry no floor (`understanding-before-execution.ts` lines 357–371 vs 326–355).

10. **The Codex injector template is a harness-owned sibling, not the package template.** `buildInstructionBlock` in `hook-codex-user-prompt-submit.ts` (lines 46–72) ships a self-contained instruction block that is "identical across modes for v1"; Claude Code gets the richer per-mode template owned by `@lannguyensi/understanding-gate`. Same artefact names, coarser mode behavior.

11. **`path_match` / `bash_match` are not projected into the Codex TOML** — the generator warns per hook ("script-side filter only", generate-codex-config.ts lines 192–203). Explicitly NOT a parity gap: the Claude Code projection in generate-settings.ts treats them identically as script-enforced documentation; the Codex warning just makes the silent drop visible.

## Wire-format differences (Codex vs Claude Code)

- **Event envelope (stdin, all Codex hooks):** `{ session_id?, tool_name?, raw_input?, event? }`. One tolerated synonym: `tool` for `tool_name`. `id` is deliberately NOT aliased to `session_id` — "`id` in most event-bus shapes is the event/message id, not the session id" (`hook-codex-pre-tool-use.ts` lines 78–89). Session-id fallback env chain when the field is absent: `$CODEX_SESSION_ID` → `$CLAUDE_CODE_SESSION_ID` → `$CLAUDE_SESSION_ID` (lines 198–203); the shared resolver lists `$CODEX_SESSION_ID` as step 4 with source `"env-codex"` (`src/runtime/session-id.ts` lines 178, 234, 265–268).
- **Block contract (PreToolUse):** exit 2 (`EXIT_BLOCK`) + reason on stderr; allow is exit 0 with a stderr diagnostic. There is no JSON-decision envelope: "the JSON-decision shape Claude Code reads is not part of Codex's hook contract today" (`hook-codex-pre-tool-use.ts` lines 13–16, 326–327). Claude Code hooks communicate decisions via structured stdout JSON.
- **Fail direction:** identical to Claude — malformed JSON, missing manifest, undeclared/disabled pack, or unresolvable session id all resolve to ALLOW with a loud stderr diagnostic (fail-open on infrastructure error; the gate itself fails closed on an unclassifiable `raw_input` for the read-only exemption).
- **Shell-command extraction:** `raw_input.command` / `raw_input.cmd` via the shared `extractShellCommand`; a conflicting `command` vs `cmd` pair returns null → falls through to block (`extractCodexShellCommand`, lines 110–124). Bare-string `raw_input` is accepted as the command. Read-only single-`|` pipelines are exempted in both runtimes (`isReadOnlyBashPipeline`).
- **Injector contract (UserPromptSubmit):** plain-text instruction block on stdout (no JSON wrapper), which Codex prepends to `additional_instructions`; stdin envelope `{ session_id?, prompt? }` (`hook-codex-user-prompt-submit.ts` lines 11–19).
- **Stop contract:** stdin envelope `{ session_id?, last_assistant_message?, messages? }`; `last_assistant_message` preferred, else last `role === "assistant"` row of `messages[]`; persists `.understanding-gate/reports/<iso>-codex-<sessionhash>.json` with `approvalStatus: "pending"`; every error path is exit 0 + stderr (Stop must never block the response path) (`hook-codex-stop.ts` lines 1–28, 89–101).
- **Config artefact:** TOML instead of JSON. Table keys are protocol event names (`[[hooks.PreToolUse]]`, Codex 0.131.0 schema; legacy lower-snake names were the first adapter's shape — `eventKey`, generate-codex-config.ts lines 108–127). `timeout` is in SECONDS: `max(floor, ceil(budget_ms/1000))`, floor 2 for `harness policy intercept`, else 1. Hook `match` patterns are alias-expanded at emit time: any simple token that is a shell alias expands to the full set `Bash|shell|exec_command|functions.exec_command`, and `mcp__server__tool` tokens expand hyphen/underscore server-name variants plus the `mcp__server__.tool` dotted form (`expandCodexHookMatchPattern` / `expandToolNameAliases`, `src/runtime/tool-name-aliases.ts` lines 1–68). Output is stable-sorted (event, then command) for byte-equivalent no-op re-applies; the first line `# Generated by harness apply --runtime codex.` is the pinned detection header (`CODEX_GENERATED_HEADER_LINE`).
- **Per-hook self-identification:** Codex `policy intercept` commands carry `--hook <name>` (names restricted to `^[A-Za-z0-9._:-]+$`; exotic names silently skip the flag, generate-codex-config.ts lines 137–147); Claude Code commands never carry it (dedupe rationale, intercept.ts lines 75–86).
