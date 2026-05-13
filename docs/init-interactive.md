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

3. **Profile selection.** Three choices:

   - **Solo**: `memory-router` + the `understanding-before-execution` policy pack. Single-operator baseline.
   - **Team**: Solo + the `agent-tasks` MCP server + `grounding-mcp` + the `review-before-merge` policy. Wires the merge gate that blocks PR-merge MCP calls without a ledger entry tagged `review:<pr-number>`.
   - **Custom (advanced)**: Bails out with a hint to run `harness init --template full` and hand-edit the resulting manifest. The wizard does not yet build manifests à la carte; that is a follow-up.

4. **Agent-tasks warning (Team only).** If you pick `team` but the probe did not find an `agent-tasks` entry in `settings.json`, the wizard asks whether to proceed. The manifest will still be written, the hook will still fire, but agent-tasks needs to be wired by `harness apply` or by hand before the gate is actually enforceable. Default is `true` because the most common case is "I am setting up everything from scratch and agent-tasks is about to land alongside this manifest".

5. **Memory directory.** Free-text input. Default is `~/.claude/projects/{project}/memory` (the `{project}` token is expanded per-session by the memory router). Press return to accept.

6. **Write confirmation.** Last chance to bail.

7. **Validate.** After the write, the wizard runs `harness validate` and reports the error / warning counts and the per-diagnostic details. A non-zero error count makes the wizard exit `1` so CI scripts notice; the manifest stays on disk for inspection.

8. **Next steps.** The wizard prints the suggested `harness apply --runtime claude-code` follow-up but does NOT run it. Auto-apply would risk silently mutating `settings.json` after a partial confirmation; the operator should review the new manifest first.

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

- **Custom profile.** Today the Custom choice just hands you off to `--template full`. A future PR can expose the checkbox flow described in task `c5287b80` (per-pack / per-MCP / per-hook selection).
- **Opencode runtime.** v1 covers Claude Code and Codex. Opencode adapter is a separate prerequisite task (`f34eb233`).
- **Auto-apply.** The wizard prints the `harness apply` command but does not invoke it; manifests are written, runtime wiring stays explicit.
- **Multi-runtime selection.** v1 writes a manifest that works for both Claude Code and Codex without asking. A future revision can offer a runtime checkbox if there is demand.
