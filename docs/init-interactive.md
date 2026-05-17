# `harness init --interactive`

Guided wizard that detects the operator's environment, picks a profile, and writes a starting `harness.yaml`. Composes the read-only detection from PR 1 (`--probe`) with the `solo` / `team` profile templates from PR 2.

The wizard is one of three ways to bootstrap a manifest:

| Mode | When to use |
|---|---|
| `harness init --template minimal\|solo\|team\|full` | Non-interactive, automation-friendly. CI scripts, fresh-VM provisioning, anything that needs a known starting state. |
| `harness init --probe` | Read-only environment dump as JSON. Debug what the harness sees before committing to a manifest. |
| `harness init --interactive` | First-time setup on a developer machine. Wizard walks you through the choices. |

## Wizard flow

1. **Environment probe.** The wizard runs the same detection as `--probe` and prints a summary to stderr (existing Claude Code / Codex config homes, existing manifest, MCP servers already wired in `~/.claude/settings.json`, harness binary version). The probe never blocks the flow, it just reports.

2. **Overwrite guard.** If `~/.claude/harness.yaml` already exists, the wizard asks before overwriting. Default is `false`, so a stray return key never blows away a hand-edited manifest. Decline and the wizard exits with no write.

3. **Profile selection.** Four choices, with different external-account assumptions:

   - **Solo** (no external accounts): `memory-router` + the `understanding-before-execution` policy pack. Single-operator baseline. Works against any PR workflow because it does not wire any PR-merge gate.
   - **Team** (requires an agent-tasks account, hosted or self-hosted): Solo + the `agent-tasks` MCP server + `grounding-mcp` + the `review-before-merge` policy. The merge gate matches the `mcp__agent-tasks__pull_requests_merge` tool only; gh-CLI workflows (`gh pr merge`) stay unguarded today.
   - **Full** (requires agent-tasks + `@lannguyensi/agent-preflight` + `gh` on PATH): Team + the reference policies (`dogfood-before-release`, `preflight-before-*`, `review-subagent-before-pr-create`). All hooks run through the bundled `harness policy intercept` engine.
   - **Custom (advanced)**: à-la-carte composer (see [Custom flow](#custom-flow) below). Pick discrete packs / MCPs / policies; the wizard composes a validate-clean manifest from your selection.

4. **Agent-tasks warning (Team / Full).** If you pick `team` or `full` but the probe did not find an `agent-tasks` entry in `settings.json`, the wizard asks whether to proceed. The manifest will still be written, the hook will still fire, but two preconditions need to land before the gate is enforceable: (a) `agent-tasks-mcp-bridge` on PATH and wired into Claude's settings.json, (b) a token in the OS keychain or `AGENT_TASKS_TOKEN` env. Default is `true` because the common case is "I am setting up everything from scratch and agent-tasks is about to land alongside this manifest". After the manifest write the wizard prints a reminder line with the `agent-tasks-mcp-bridge login` recovery path.

5. **Agent-tasks auth probe (Team / Full / Custom-with-bridge).** After a successful `npm i -g` of the missing packages, the wizard runs `agent-tasks-mcp-bridge status` against the freshly installed binary. Three observed outcomes:
   - **Token present, validates against the backend**: prints `✓ agent-tasks token validated against the backend.` and continues.
   - **Token present, validation fails** (backend unreachable, expired token, wrong base URL): prints an informational warning naming the bridge's reason and continues. The wizard does not block on this because the recovery path (`agent-tasks-mcp-bridge status` once your endpoint is reachable) is not actionable from inside the wizard.
   - **No token stored**: opens a three-option dialog: (a) run `agent-tasks-mcp-bridge login` interactively now (recommended; the bridge prompts for a token with TTY masking and stores it via the OS keychain), (b) skip and run login manually later, (c) abort the wizard with a pointer to the hosted signup URL and the re-run command. After a successful login the wizard re-probes to confirm.

6. **Memory directory.** Free-text input. Default is `~/.claude/projects/{project}/memory` (the `{project}` token is expanded per-session by the memory router). Press return to accept.

7. **Write confirmation.** Last chance to bail.

8. **Validate.** After the write, the wizard runs `harness validate` and reports the error / warning counts and the per-diagnostic details. A non-zero error count makes the wizard exit `1` so CI scripts notice; the manifest stays on disk for inspection.

9. **Runtime wire-now multiselect.** A checkbox prompt offers `claude-code` and `codex` (and a disabled `opencode` slot pending [task `f34eb233`](https://github.com/LanNguyenSi/harness/issues)). Whichever runtimes the probe found configured are pre-checked, so the common single-runtime case is one Enter press. For each ticked runtime:
   - `claude-code` → `harness apply --target ~/.claude/settings.json --merge` is run; the merge summary, `wired into …`, and `verify: …` lines print to stderr.
   - `codex` → `harness apply --runtime codex` writes `harness.generated/codex/config.toml`; the operator gets the path and the merge instruction (`copy or include those [[hooks.*]] entries into ~/.codex/config.toml`). The wizard never edits `~/.codex/config.toml` directly because `apply --target` is incompatible with `--runtime codex`.
   - Unchecking everything skips wiring entirely; both manual fallback commands print so the operator can wire later by hand.
   - Selecting both runtimes runs the two applies sequentially. `harness.lock` then reflects the **last-applied** runtime; a follow-up `harness apply --runtime <name>` per runtime refreshes its drift baseline. The wizard surfaces this caveat to stderr.

   Since v0.17.4, the `claude-code` wire-now branch passes `overwriteDrift: true` (auto-confirmed) to `apply`. This is the deliberate "start from scratch" intent of `init --interactive`: any pre-existing `~/.claude/harness.generated/settings.json` that drifted out of the last-apply snapshot is overwritten by the freshly-rendered settings rather than refused with `outcome: "drift-refuse"`. Ad-hoc `harness apply` (outside the wizard) keeps the strict drift safeguard unchanged. If `targetWritten` still ends up false for any other reason, the wizard now prints a clear stderr message and a `recoveryHint` instead of leaving the operator with a "wired into …" line that never landed.

## Custom flow

Custom is for power users who want a manifest narrower or wider than the named profiles. The wizard branches into three checkbox prompts:

1. **Policy packs** — pre-checked: none (settings.json carries no pack signal today). Surface: `understanding-before-execution`.
2. **MCP servers** — pre-checked from `detect()`: any MCP name found in `settings.json mcpServers` is ticked. Surface: `agent-tasks`, `grounding-mcp`, `memory-router` (wired under `memory.router`, not `tools.mcp[]`; the composer puts it in the right slot), and `codebase-oracle` (requires `ORACLE_SCAN_ROOT` + `OPENAI_API_KEY` env vars that the wizard does NOT prompt for; an advisory prints when ticked).
3. **Reference policies** — pre-checked: none. Surface mirrors `--template full`: `review-before-merge`, `preflight-before-investigation`, `review-subagent-before-pr-create`, `preflight-before-push`, `dogfood-before-release`, `two-reviewers-required` (warn-level companion to review-before-merge with `count.min: 2`). Each policy carries its hook entry automatically; shared hook names (e.g. `require-review-evidence` for both `review-before-merge` and `two-reviewers-required`) are deduplicated.

Acceptance:

- **Empty selection** across all three prompts aborts the wizard with no write.
- **A Custom selection** rejoins the shared tail (dependency check → memory dir → confirm → write → validate → wire-now multiselect), so write semantics are identical to the named profiles.
- **Producer-coupling advisories** print to stderr when a selected policy has no producer for its ledger tag (e.g. `dogfood-before-release` selected without `grounding-mcp` would block every `npm publish`). These are warnings, not blockers; `harness validate` still passes.

## Ctrl-C semantics

Pressing Ctrl-C at any prompt surfaces an `ExitPromptError` from `@inquirer/prompts`. The wizard catches it, prints `Aborted: Ctrl-C received during prompt; no manifest written.` to stderr, and exits with code 0. No partial write ever lands on disk.

## Acceptance test

```bash
# Fresh ~/.claude/ → solo manifest → validate clean
rm -rf ~/.claude/harness.yaml
harness init --interactive  # answer: Solo, accept default memory dir, write
harness validate            # expect: no validation findings
```

## Limitations (will land later)

- **Custom-profile per-field editing.** Whole packs / MCPs / policies are pickable; field-level edits (e.g. tweaking `within:` windows, swapping a `match:` regex) still require hand-editing the YAML.
- **`opencode` runtime pack.** Blocked on agent-tasks `f34eb233` (runtime adapter prerequisite); will surface as a disabled checkbox like the wire-now multiselect already does for the wiring step.
- **Opencode runtime.** v1 covers Claude Code and Codex; the wizard surfaces `opencode` as a disabled checkbox until the runtime adapter task `f34eb233` lands.
- **Cross-runtime apply lock state.** `harness apply` is single-runtime per invocation, so when the wizard wires both Claude Code and Codex in one run it calls `apply` twice; `harness.lock` reflects the last-applied runtime's artefacts. Drift detection on the first runtime's outputs is unreliable until you re-run `harness apply --runtime <name>` for that runtime. Tracked for a future single-call multi-runtime apply.
