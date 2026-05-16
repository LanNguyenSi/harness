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

3. **Profile selection.** Four choices:

   - **Solo**: `memory-router` + the `understanding-before-execution` policy pack. Single-operator baseline.
   - **Team**: Solo + the `agent-tasks` MCP server + `grounding-mcp` + the `review-before-merge` policy. Wires the merge gate that blocks PR-merge MCP calls without a ledger entry tagged `review:<pr-number>`.
   - **Full**: Team + the reference policies (`dogfood-before-release`, `preflight-before-*`, `review-subagent-before-pr-create`). All hooks run through the bundled `harness policy intercept` engine.
   - **Custom (advanced)**: à-la-carte composer (see [Custom flow](#custom-flow) below). Pick discrete packs / MCPs / policies; the wizard composes a validate-clean manifest from your selection.

4. **Agent-tasks warning (Team only).** If you pick `team` but the probe did not find an `agent-tasks` entry in `settings.json`, the wizard asks whether to proceed. The manifest will still be written, the hook will still fire, but agent-tasks needs to be wired by `harness apply` or by hand before the gate is actually enforceable. Default is `true` because the most common case is "I am setting up everything from scratch and agent-tasks is about to land alongside this manifest".

5. **Memory directory.** Free-text input. Default is `~/.claude/projects/{project}/memory` (the `{project}` token is expanded per-session by the memory router). Press return to accept.

6. **Write confirmation.** Last chance to bail.

7. **Validate.** After the write, the wizard runs `harness validate` and reports the error / warning counts and the per-diagnostic details. A non-zero error count makes the wizard exit `1` so CI scripts notice; the manifest stays on disk for inspection.

8. **Runtime wire-now multiselect.** A checkbox prompt offers `claude-code` and `codex` (and a disabled `opencode` slot pending [task `f34eb233`](https://github.com/LanNguyenSi/harness/issues)). Whichever runtimes the probe found configured are pre-checked, so the common single-runtime case is one Enter press. For each ticked runtime:
   - `claude-code` → `harness apply --target ~/.claude/settings.json --merge` is run; the merge summary, `wired into …`, and `verify: …` lines print to stderr.
   - `codex` → `harness apply --runtime codex` writes `harness.generated/codex/config.toml`; the operator gets the path and the merge instruction (`copy or include those [[hooks.*]] entries into ~/.codex/config.toml`). The wizard never edits `~/.codex/config.toml` directly because `apply --target` is incompatible with `--runtime codex`.
   - Unchecking everything skips wiring entirely; both manual fallback commands print so the operator can wire later by hand.
   - Selecting both runtimes runs the two applies sequentially. `harness.lock` then reflects the **last-applied** runtime; a follow-up `harness apply --runtime <name>` per runtime refreshes its drift baseline. The wizard surfaces this caveat to stderr.

## Custom flow

Custom is for power users who want a manifest narrower or wider than the named profiles. The wizard branches into three checkbox prompts:

1. **Policy packs** — pre-checked: none (settings.json carries no pack signal today). v1 surface: `understanding-before-execution`.
2. **MCP servers** — pre-checked from `detect()`: any MCP name found in `settings.json mcpServers` is ticked. v1 surface: `agent-tasks`, `grounding-mcp`, `memory-router` (note: `memory-router` lives under `memory.router`, not `tools.mcp[]`; the composer puts it in the right slot).
3. **Reference policies** — pre-checked: none. v1 surface: `review-before-merge`, `preflight-before-investigation`, `review-subagent-before-pr-create`. Each policy carries its hook entry automatically.

Acceptance:

- **Empty selection** across all three prompts aborts the wizard with no write.
- **A Custom selection** rejoins the shared tail (dependency check → memory dir → confirm → write → validate → wire-now multiselect), so write semantics are identical to the named profiles.
- **Producer-coupling advisories** print to stderr when a selected policy has no producer for its ledger tag (e.g. `review-before-merge` selected without `agent-tasks`). These are warnings, not blockers; `harness validate` still passes.

The v1 surface is intentionally a subset of `--template full`. Remaining packs (none today), MCPs (`codebase-oracle`), and policies (`dogfood-before-release`, `preflight-before-push`, `two-reviewers-required`) are tracked as follow-up; the composer is structured so adding them is a single-entry diff in `src/cli/init/composer.ts`.

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

- **Custom-profile surface coverage.** The v1 Custom composer ships a deliberate subset: 1 pack, 3 MCPs, 3 reference policies. Expanding the catalogue to cover the rest of `--template full` (and `codebase-oracle`, the `opencode` runtime pack) is a follow-up task.
- **Opencode runtime.** v1 covers Claude Code and Codex; the wizard surfaces `opencode` as a disabled checkbox until the runtime adapter task `f34eb233` lands.
- **Cross-runtime apply lock state.** `harness apply` is single-runtime per invocation, so when the wizard wires both Claude Code and Codex in one run it calls `apply` twice; `harness.lock` reflects the last-applied runtime's artefacts. Drift detection on the first runtime's outputs is unreliable until you re-run `harness apply --runtime <name>` for that runtime. Tracked for a future single-call multi-runtime apply.
