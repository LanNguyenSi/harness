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
- [Debug verb selection](debug-verb-selection.md), which harness verb answers
  which "why did my policy (not) fire" question: ledger-replay vs
  live-hypothetical vs static-prediction vs stage-isolation vs end-to-end.

## Modules

- [Codex runtime adapter, parity gaps vs Claude Code](codex-adapter-parity-gaps.md),
  what the Codex adapter emits, the enumerated behavioral gaps (headline: no
  Codex PostToolUse hook, so expire_on_tool_match never fires there), and the
  Codex wire-format contract.

## Invariants

- [Evidence-ledger trust boundary](evidence-ledger-trust-boundary.md), the
  agent-writable ledger is audit-only for builtin enforcement gates; only
  operator- or trusted-process-authored filesystem markers open them.
- [Policy engine needs its producers wired](policy-engine-producer-wiring.md),
  a policy only ever blocks if grounding-mcp is wired under tools.mcp[];
  version-sensitive (0.35.0 apply refusal, 0.39.0 pooled ledger session).
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
