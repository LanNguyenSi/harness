# Genuine operator UserPromptSubmit fixture: Codex 0.156.1

This is the redacted operator envelope from an isolated Codex 0.156.1 live
measurement on 2026-09-23. It used `codex --no-daemon -a never --strict-config
exec --ignore-user-config --ephemeral --json --skip-git-repo-check -C
<redacted-cwd> -s read-only` with hooks and multi-agent enabled; plugins and
apps disabled. The raw run-local completion record binds the adapter source
SHA-256 `6edd07ca891334f4d347868da9814f3f8adc23696541dc2f2fc7c926e1f8ff6e`
and built adapter SHA-256
`846aa63ab6c35f6b18006a5f96193ca473298315e9c2c4128f556eca6061f34e`.

Redaction map: `session_id` -> `<redacted-session-id>`, `turn_id` ->
`<redacted-turn-id>`, and `cwd` -> `<redacted-cwd>`. `transcript_path` was
genuinely `null`, so it remains `null`. The event name, model, permission mode,
and exact synthetic measurement prompt are retained because they are genuine
fields from the operator envelope. The label `permission_mode:
"bypassPermissions"` derives from `approval_policy = "never"` in Codex's
hook-runtime compatibility mapping; the independent sandbox flag was
`-s read-only`, so the label does not establish a sandbox-bypass claim.

The recorded lifecycle was UserPromptSubmit (one), SubagentStart (one),
SubagentStop (one), Stop (one). The adapter emitted 875 stdout bytes, empty
stderr, and exit 0 for the operator event. No UserPromptSubmit event occurred
between the child SubagentStop and parent Stop, while the child and parent
reported a matching token. Completion IAC is inferred from the recorded
lifecycle and response together with pinned completion and wait semantics; the
spawn prompt is sealed, so token independence is not observable. Raw machine
paths, IDs, hook payloads, and event timeline remain task-local evidence and
are intentionally not committed.
The provenance command is a normalized summary; the task-local reproducible
procedure and complete invocation are the evidence for replay, not this
summary alone.
