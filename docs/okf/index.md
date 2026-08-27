# Knowledge bundle index

Curated OKF knowledge bundle for the harness repo. These docs capture
cross-file semantics, invariants, and recovery procedures that no single
source file or reference doc states on its own. For the underlying feature
references, see `docs/` one level up (ARCHITECTURE, risk-gate,
writing-custom-policies, the policy-pack references, CLI); these docs
deliberately do not duplicate them.

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
  the pack regexes and this repo's own dogfood trigger (task `76671e5a`),
  and a second, independent normalization pass, consulted as a third
  additive matching arm, closed the adjacent command-normalize boundary
  gap (task `aabbad63`).
- [Debug verb selection](debug-verb-selection.md), which harness verb answers
  which "why did my policy (not) fire" question: ledger-replay vs
  live-hypothetical vs static-prediction vs stage-isolation vs end-to-end.
- [Understanding gate, auto-mode signal sources (measured)](understanding-gate-auto-mode-signals.md),
  what signals exist for detecting an agent's own permission/auto-approval
  mode across Claude Code, Codex, and opencode: the measured Claude Code
  hook-payload `permission_mode` field per event and mode, the hook
  process env, the transcript-visibility probe, the resolution of a hook
  `ask` under `-p`, the block-and-retry behaviour of a `-p` child, and a
  trust-class table;
  the rule and decision on which signals may relax the gate live in the
  companion ADR, not here.

## Modules

- [Codex runtime adapter, parity gaps vs Claude Code](codex-adapter-parity-gaps.md),
  what the Codex adapter emits, the enumerated behavioral gaps (the former
  headline gap, no Codex PostToolUse hook, is closed by task `a1348c89`;
  current top gap is the un-translated permission-profile/sandbox stanza,
  gap 4), and the Codex wire-format contract.

## Invariants

- [Evidence-ledger trust boundary](evidence-ledger-trust-boundary.md), the
  agent-writable ledger is audit-only for builtin enforcement gates; only
  operator- or trusted-process-authored filesystem markers open them.
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

- [Understanding-gate lockout recovery](understanding-gate-lockout-recovery.md),
  the operator procedure to unblock a locked session, the 6-tier session-id
  resolution, and the expiry semantics that re-arm the gate.
- [Kill switches, pause vs gate disable](pause-vs-gate-kill-switch.md), the two
  distinct kill-switch mechanisms, when to use which, restore paths, and trust
  caveats.
