# Knowledge bundle index

Curated OKF knowledge bundle for the harness repo. These docs capture
cross-file semantics, invariants, and recovery procedures that no single
source file or reference doc states on its own. For the underlying feature
references, see `docs/` one level up (ARCHITECTURE,
writing-custom-policies, the policy-pack references, CLI); these docs
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

## Overview

- [Gate fail-posture matrix](gate-fail-posture-matrix.md), which enforcement
  gates fail open vs fail closed when their evidence source is unreachable,
  with the exact code paths and override knobs.
- [Shell quote models, measured divergence against bash](quote-model-divergence.md),
  what the three independent shell-word models actually extract, measured
  against real bash; headline: the trigger boundary alphabet knew `&&` but
  not single `&`, which defeated every bash_match gate including an
  operator-only deny, closed at template level in v0.43.0 (task
  `d834a065`); an existing `full` install picks it up only after re-running
  `harness init --template full --force`. In v0.44.0 the same fix reached
  the pack regexes (those packs are since removed) and this repo's own
  dogfood trigger (task `76671e5a`),
  and a second, independent normalization pass, consulted as a third
  additive matching arm, closed the adjacent command-normalize boundary
  gap (task `aabbad63`).
- [Debug verb selection](debug-verb-selection.md), which harness verb answers
  which "why did my policy (not) fire" question: ledger-replay vs
  static-prediction vs end-to-end.

## Modules

- [Codex runtime adapter](codex-adapter-parity-gaps.md), what the Codex
  adapter emits and records, the installer's ownership boundaries for
  `~/.codex/config.toml`, the remaining differences from the Claude Code
  target, and the Codex wire format of the hooks that remain.

## Invariants

- [Evidence-ledger trust boundary](evidence-ledger-trust-boundary.md), the
  agent-writable ledger never opens a builtin enforcement gate
  (branch-protection asks git, `operator_only` policies read no evidence);
  `requires.ledger_tag` policies are process gates by design.
- [Policy engine needs its producers wired](policy-engine-producer-wiring.md),
  a policy is only ever POSITIVELY satisfied if grounding-mcp is wired under
  tools.mcp[]; an unwired producer denies block/require_approval tiers
  (deny-degraded, task f1aea826); version-sensitive (0.35.0 apply refusal,
  0.39.0 pooled ledger session, 0.43.0/0.44.0 raw-or-normalised bash_match
  matching plus per-repository `${REPO}`/`${BRANCH}`/`at_head` attribution,
  universal-additive).
- [Managed mutations validate the whole manifest](manifest-validation-scope.md),
  add/remove schema-validate the entire proposed harness.yaml; add's asset
  gate baseline-diffs so only newly-introduced asset errors block.

## Runbooks

- [Kill switches, pause vs gate disable](pause-vs-gate-kill-switch.md), the two
  distinct kill-switch mechanisms (`harness pause` mutes the policy-intercept
  and runtime-reality hooks, never branch-protection; `harness gate disable`
  edits settings.json), when to use which, restore paths, the `operator_only`
  deny policies that guard both, and trust caveats.
