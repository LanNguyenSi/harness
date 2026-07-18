# Log

<!-- Add new entries at the top, newest first. -->

- 2026-07-18T05:00:00Z, scoped re-verification (task init-mcp-wiring-claude-code/T-004):
  `okf-kit check` flagged 2 files stale (source mtime after doc timestamp).
  `debug-verb-selection.md` — flagged for `src/cli/doctor/index.ts`, which
  changed under the same run (T-003, additive `claudeMcp` field, no
  existing-section behavior change). Diffed against the doc's `doctor`
  section; content held except for the new "Claude Code MCP Registration"
  check, now documented; re-stamped. The other 15 sources are unchanged
  since the 2026-07-16 sweep and were not re-audited beyond that diff.
  `policy-engine-producer-wiring.md` — flagged for `src/policies/ledger-client.ts`,
  which this task's changes never touched (pre-existing/unrelated drift);
  left un-stamped, out of scope for this task, noted as an open follow-up.
- 2026-07-16T02:26:27Z, re-verification sweep (task 93c004a6): all 8 docs re-checked
  against their current sources after the 2026-07-13/15 code churn
  (HMAC marker signing, operator_only policies, pack reseed, Codex
  parity, recovery-commit exemption, doctor exit codes). Content
  corrections in all 8 docs, including a real doc bug: the
  validate-strict paragraph in pause-vs-gate-kill-switch described the
  pre-2cc73f55 state and contradicted its own preceding paragraph.

- 2026-07-16T00:17:17Z, CI now watches staleness: warn-only
  `okf-kit check` on every PR (.github/workflows/okf-staleness.yml).
- 2026-07-09T02:50:30.125962Z, initial 8 docs authored and verified against
  sources at master f3c1727 (harness 0.39.0): gate-fail-posture-matrix,
  evidence-ledger-trust-boundary, policy-engine-producer-wiring,
  manifest-validation-scope, understanding-gate-lockout-recovery,
  pause-vs-gate-kill-switch, codex-adapter-parity-gaps, debug-verb-selection.
- 2026-07-09T02:50:15.112Z, bundle scaffolded by `okf-kit init`.
