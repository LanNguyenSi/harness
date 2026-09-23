# Genuine operator UserPromptSubmit fixture: Codex 0.150.1

This redacted fixture is derived from the interactive TUI operator capture at
`dogfood/ug-auto-mode-signals/payloads/codex-tui-default.UserPromptSubmit.json`.
That capture was recorded on Codex CLI 0.150.1 on 2026-08-27; its introducing
commit is `0c16d462acd0d2320ab6b9b9e380e15001354d09`.

Redactions replace `session_id`, `turn_id`, `transcript_path`, and `cwd` with
typed placeholders. The event name, model, permission mode, and operator
prompt remain so the adapter test exercises a genuine operator envelope.

This fixture is not a notification capture. A current-version operator fixture
and notification timeline are maintained as task T-001 live evidence.
