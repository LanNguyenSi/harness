# Phase 6 #6 dogfood: Codex adapter for the Understanding Gate

Synthetic smoke for the harness-shipped Codex adapter for the
`understanding-before-execution` policy pack.

## Goal

Demonstrate that:

1. `harness apply --runtime codex` emits a Codex config artefact under
   `harness.generated/codex/config.toml` and does NOT write
   `settings.json` (the runtime branches are mutually exclusive in
   v1).
2. The `harness pack hook codex-pre-tool-use` blocker refuses
   `apply_patch` invocations with exit code 2 + a stderr reason until
   an approved Understanding Report exists for the session.
3. After a persisted report flips `approvalStatus` to `approved` (the
   synthetic equivalent of running `harness approve understanding`
   when the ledger source is degraded), the same blocker exits 0 with
   a diagnostic naming `persisted-report` as the approval source.
4. `harness pack hook codex-user-prompt-submit` emits the
   Understanding-Gate instruction template on stdout for Codex to
   prepend to its `additional_instructions`.

## Wire format on stdin

The Codex blocker reads a JSON envelope shaped:

```jsonc
{
  "session_id": "<string>",   // also tolerated: "id"
  "tool_name":  "<string>",   // also tolerated: "tool"
  "raw_input":  {  /* tool args, opaque */  },
  "event":      "<string>"    // optional, identifying the Codex event
}
```

A Codex CLI integration is expected to wrap its native event into this
shape via a thin shim. The format is harness-defined to keep the
adapter portable across Codex versions; the synthetic smoke exercises
the adapter against this format directly without requiring a Codex
binary.

## Why no real Codex binary

`harness apply --runtime codex` writes a config snippet the operator
copies into `~/.codex/config.toml`; the actual integration into
Codex's runtime config is a manual step (analogous to OpenCode v1).
Phase 6 #6 ships the *adapter scripts* and *config generator*; a full
end-to-end Codex-CLI dogfood is a follow-up once the upstream integration
shape stabilises.

## Running the smoke

From the repo root:

```sh
npm run build && bash dogfood/phase6-6/run-smoke.sh
```

The driver writes to `dogfood/phase6-6/transcript/`:

- `run.log`             : full smoke output.
- `block-stderr.txt`    : captured BLOCK reason from step 2.
- `allow-stderr.txt`    : captured ALLOW diagnostic from step 4.
- `inject-stdout.txt`   : injector-emitted instruction template.
- `cwd-<session>/`      : synthetic working directory holding the
                          persisted report under
                          `.understanding-gate/reports/`.

Exit 0 = pass.

## Adjacent: `harness doctor --target codex`

Once the manifest has been applied with `--runtime codex`, the
adapter-health doctor reports OK against this dogfood:

```sh
harness apply --config dogfood/phase6-6/harness.yaml --runtime codex --quiet
harness doctor --config dogfood/phase6-6/harness.yaml --target codex
```

The doctor checks: `harness` on PATH, the codex-* subcommands resolve,
`harness.generated/codex/config.toml` is present and harness-managed,
every contributed hook command resolves, and
`.understanding-gate/reports/` is writable. `--json` emits a structured
`codexTarget` block whose error/warning counts roll into the top-level
totals.

## Out of scope (Phase 6 #6 follow-ups)

- A Codex-specific Stop-equivalent that captures the Understanding
  Report transcript into `.understanding-gate/reports/`. v1 relies on
  `harness approve understanding` writing the ledger tag (or, in the
  smoke, a hand-crafted persisted report).
- A real Codex headless run as a smoke target. Tracked separately
  once the Codex CLI's hook contract is documented + stable.
