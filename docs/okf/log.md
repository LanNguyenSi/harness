# Log

<!-- Add new entries at the top, newest first. -->

- 2026-08-06T17:59:39Z, targeted correction (task af7e61d9): the 2026-08-05
  sweep below re-stamped pause-vs-gate-kill-switch's 7 citations but missed
  a semantic drift `okf-kit check` cannot see (source-mtime staleness only,
  not inter-doc contradiction): its `76671e5a` follow-up reference still
  read as an open gap ("still carry the gap... kept separate") after
  76671e5a shipped in v0.44.0, contradicting quote-model-divergence.md and
  index.md, which already had it right. Verified against primary sources,
  not just the sibling doc: CHANGELOG.md's 0.44.0 entry ("closing follow-up
  `76671e5a`") and commit `6d1cf50` (PR #390, `Refs:
  76671e5a-a0dd-4360-8f1f-55b71ceb7308`, tag `v0.44.0` contains it).
  Corrected the one paragraph, added CHANGELOG.md to sources, re-stamped.
  Found during task 9cd546a1's index re-verification, sliced out separately
  since that task was scoped to index.md only.
- 2026-08-05T15:42:36Z, full-bundle re-verification sweep (tasks 3c43de1a
  PR #398 + 3c150880): all 9 docs re-checked claim-by-claim against
  harness 0.44.0 (master 65761ff) after the 0.43.0/0.44.0 policy-engine
  churn. Content corrections in seven: policy-engine-producer-wiring
  (98ad072f/D-021 attribution account, 0.43.0/0.44.0 version history),
  codex-adapter-parity-gaps (10 citations, one CHANGELOG version
  mislabel), quote-model-divergence (76671e5a + aabbad63 shipped in
  0.44.0, fdee7d0f slice 1 documented), understanding-gate-lockout-
  recovery (PR #396 malformedSections surfacing, wrong-file citation
  fixed, 2 sources added), debug-verb-selection (dry-run REPO/BRANCH
  under-prediction since 98ad072f), manifest-validation-scope (3
  citations +4 off), pause-vs-gate-kill-switch (7 citations). Verified
  content-accurate and re-stamped only: evidence-ledger-trust-boundary,
  gate-fail-posture-matrix; review then added the post-merge-gate tag
  to the former and an in-tree D-021 pointer to the latter. Reviewer
  negative control: pre-change clone 35 warnings, post-change 0.
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
