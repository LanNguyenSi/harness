# Phase 5 #1a: headless `claude -p` smoke (2026-05-03)

Closes the deferred (a) variant of Phase 5 #1. The synthetic-stdin smoke
(`run-smoke.sh` -> `transcript-baseline-2026-05-01/`) proved the runtime
pipeline + grounding-mcp + sqlite ledger end-to-end. This run adds the
remaining piece: a real headless `claude -p` session whose hook driver
is Claude Code's own runtime, with the apply'd settings.json wired in
via `--settings`.

## Recipe used

```sh
mkdir -p /tmp/harness-claude-p-smoke && cd $_
git clone https://github.com/LanNguyenSi/harness scratch-repo
cd scratch-repo
npm install && npm run build
node dist/cli/main.js apply --config dogfood/phase5/harness.yaml

mkdir -p /tmp/harness-claude-p-smoke/transcript-v2
SID=$(uuidgen)
claude -p "say hi" \
  --session-id "$SID" \
  --settings dogfood/phase5/harness.generated/settings.json \
  --output-format stream-json \
  --include-hook-events \
  --verbose \
  --permission-mode bypassPermissions \
  > /tmp/harness-claude-p-smoke/transcript-v2/stream.jsonl
```

Captured artefacts in this directory:

- `stream.jsonl`: the Claude Code stream-json output.
- `applied-settings.json`: a copy of the `harness apply`-generated
  `settings.json` that was loaded via `--settings`.

Run outside the parent Claude Code session per the task's safety
guidance.

## What this proves

- `claude --settings <path>` loads the apply'd settings file cleanly:
  exit 0, empty stderr, terminal `result.is_error: false`,
  `terminal_reason: "completed"`, `permission_denials: []`.
- The Claude Code hook driver (version `2.1.126`) fires
  `UserPromptSubmit` hooks: two `hook_started` events, two matching
  `hook_response` events with `exit_code: 0` and
  `outcome: "success"`. These come from the user's global config, not
  from the apply'd settings (the manifest does not register a
  UserPromptSubmit hook), and confirm Claude Code's hook lifecycle is
  reachable from a fully headless `-p` session.
- `--session-id` propagates: every event in the stream carries the
  same `session_id`.
- `--output-format stream-json --include-hook-events` captures the
  full lifecycle (system events, hook events, assistant message,
  rate-limit event, terminal `result`).
- `--permission-mode bypassPermissions` is honoured (echoed in the
  `init` event).

## Honest caveats

Two observable gaps remain in this transcript that the synthetic-stdin
baseline already covers:

1. **The PreToolUse policy hook does not fire here.** The manifest's
   only hook matches `mcp__agent-tasks__pull_requests_merge`. The
   `say hi` prompt makes no tool call, so the matcher never trips.
   `applied-settings.json` in this directory shows the hook IS
   registered after `apply` + `--settings`; firing it requires a
   prompt that provokes the matched tool call, which is the synthetic
   baseline's job.
2. **`grounding-mcp` is not in `init.mcp_servers`.** `harness apply`
   today writes only the `hooks` block to settings.json (see
   `src/cli/apply/apply.ts`); the manifest's `tools.mcp` block is not
   translated into a Claude Code `mcpServers` section. So loading the
   apply'd settings into a Claude Code session does not by itself
   register the manifest's MCP servers. The synthetic-stdin smoke
   spawns `grounding-mcp` directly from the runtime under test, which
   is the path that matters for the policy intercept anyway.

Together with the synthetic baseline, this gives complementary
coverage: the baseline exercises the hook + grounding-mcp + ledger
path end-to-end with a real tool event, this run exercises Claude
Code's own hook driver + settings loading with a real model + real
session lifecycle.

## Diff vs synthetic-stdin baseline

| Concern | Synthetic baseline | claude -p stream |
| ------- | ------------------ | ---------------- |
| `harness policy intercept` invoked end-to-end | yes (driver pipes events directly) | no (no tool call provoked) |
| Real grounding-mcp + ledger I/O | yes | no |
| Apply'd settings.json loaded via `--settings` | n/a | yes |
| Claude Code hook lifecycle | no | yes |
| Hook exit-code -> `outcome` mapping | no | yes |
| `--include-hook-events` event shape | no | yes |
| Real model + `result` event | no | yes |

## Notes for future smokes

To exercise the apply'd PreToolUse hook end-to-end through Claude
Code, the prompt needs to provoke a call to a tool whose name matches
the registered matcher. Either widen the manifest matcher to a
built-in (e.g. `Bash`) for a smoke variant, or extend the manifest
itself to register `agent-tasks` MCP and use a prompt that asks for a
PR merge. Both are scope for a future iteration; the current smoke
proves the wiring + hook driver, the baseline proves the runtime
pipeline.

## References

- Parent task: `67517c67-0a13-4c88-a2e3-c1eea3416b34`
- Synthetic-stdin baseline: `../transcript-baseline-2026-05-01/`
- Claude Code version observed: `2.1.126`
- Apply target source-of-truth: `src/cli/apply/apply.ts:133-135`
