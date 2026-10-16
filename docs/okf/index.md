# Knowledge bundle index

Curated OKF knowledge bundle for the harness repo. These docs capture
cross-file semantics, invariants, and recovery procedures that no single
source file or reference doc states on its own. For the underlying feature
references, see `docs/` one level up (ARCHITECTURE,
the policy-pack references, CLI); these docs
deliberately do not duplicate them.

## Maintenance

Run `okf-kit check docs/okf` (add `--require-anchors` to also check
that every in-repo line citation carries an anchor) after changing a
source file that a doc lists under `sources:`. The check is manual: no
CI job or test runs it. Re-read the claims of a doc that reports a stale
source, fix what drifted, and re-stamp its `timestamp`. A `path:N[-M]`
citation into a source file carries an anchor
(`path:N[-M]#"text on the cited end line"`); `log.md` is exempt as
history. Do not list `CHANGELOG.md` under a doc's `sources:`, since every
CHANGELOG edit anywhere in the repo would re-stale the doc; cite a
release inline with a `CHANGELOG.md:#0.24.0`-style heading-section
citation instead.

## Modules

- [Codex runtime adapter](codex-adapter-parity-gaps.md), what the Codex
  adapter emits and records, the installer's ownership boundaries for
  `~/.codex/config.toml`, the remaining differences from the Claude Code
  target, and the Codex wire format of the hooks that remain.

## Invariants

- [Evidence-ledger trust boundary](evidence-ledger-trust-boundary.md), the
  agent-writable ledger never opens the one shipped enforcement gate
  (branch-protection asks git, not the ledger); what the ledger is still
  for since the policy engine was removed in 1.0.0.
- [Managed mutations validate the whole manifest](manifest-validation-scope.md),
  add/remove schema-validate the entire proposed harness.yaml; add's asset
  gate baseline-diffs so only newly-introduced asset errors block.

## Runbooks

- [Kill switch: harness gate disable/enable](gate-kill-switch.md), the shipped
  operator off switch (`harness gate disable` / `gate enable` remove hook
  groups from settings.json on Claude Code and, with `--runtime codex`,
  neutralise hook units of the harness-managed block of
  `~/.codex/config.toml` in place), when to use it, restore paths, hooks
  without a matcher, and the recovery recipes; `harness pause` / `resume`
  were removed in 1.0.0 and the gate is their replacement.
