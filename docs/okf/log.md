# Log

<!-- Add new entries at the top, newest first. -->

- 2026-09-02T05:44:14Z, task `204efc56` round 3 (further review fixes
  for the `report_missing` delegation refusal reason: CHANGELOG wording
  corrected to the shipped existence-probe/single-read shape, the
  resolvable-vs-dangling-symlink comments corrected in three places, the
  existence probe moved into a new `probeRegularFilePresence` export in
  `src/io/read-regular-file.ts` alongside the shared reader, the
  `report_missing` detail/type-doc wording narrowed to what stat
  actually proves, a `hook-pre-tool-use.ts` comment split into its two
  distinct unreachable-branch reasons, and four missing tests added):
  `okf-kit check` flagged 6 docs stale for `src/cli/pack/hook-pre-tool-use.ts`
  and/or `CHANGELOG.md` after this round's edits: `codex-adapter-parity-gaps.md`,
  `gate-fail-posture-matrix.md` (both sources), `pause-vs-gate-kill-switch.md`,
  `policy-engine-producer-wiring.md` (both `CHANGELOG.md` only),
  `understanding-gate-auto-mode-signals.md`,
  `understanding-gate-lockout-recovery.md`. None of these 6 docs mention
  `report_missing`, `report_path_mismatch`, `report_content_mismatch`,
  `probeRegularFilePresence`, or cite a span of `hook-pre-tool-use.ts`
  inside this round's edited region (lines ~940-978): `grep` across all 6
  for those terms found only `understanding-gate-lockout-recovery.md`'s
  pre-existing citation at `hook-pre-tool-use.ts:788#"writePendingApproval(generatedDir, sessionId);"`,
  well before the edited region, still resolving. `evidence-ledger-trust-boundary.md`
  was NOT flagged stale this round: it was itself edited (new
  `probeRegularFilePresence` paragraph, `delegation-markers.ts` added to
  `sources:`) as part of this same round's changes, ahead of `okf-kit
  check`, so its shared-reader invariant was re-verified against the
  actual code (both exports now live in `src/io/read-regular-file.ts`,
  confirmed by reading the file) rather than re-stamped blind. Timestamp-only
  re-stamp on the 6 flagged docs; no content changed on them. `okf-kit
  check --json docs/okf` on the committed tree shows 0 errors, 0
  warnings after the re-stamp.
- 2026-09-02T05:17:40Z, task `204efc56` round 2 (review fixes for the
  `report_missing` delegation refusal reason): `okf-kit check` flagged 5
  docs stale for `src/cli/pack/hook-pre-tool-use.ts` and/or
  `docs/policy-packs/understanding-before-execution.md` after this
  round's edits: `codex-adapter-parity-gaps.md`,
  `evidence-ledger-trust-boundary.md`, `gate-fail-posture-matrix.md`,
  `understanding-gate-auto-mode-signals.md`,
  `understanding-gate-lockout-recovery.md`. This round's changes to
  `hook-pre-tool-use.ts` restructured `verifyDelegation`'s report check
  (existence probe before the path hash, single read moved after) and
  qualified one comment (review finding 6); the doc change enumerated
  the three fallback-shape reasons in a paragraph that previously named
  none. Checked: none of these 5 docs mention `report_missing`,
  `report_path_mismatch`, `report_content_mismatch`, or the `--report
  <path>` paragraph at all (`grep` across all 5 for those terms: no
  hits), and the one line-numbered citation into `hook-pre-tool-use.ts`
  among them, in `understanding-gate-lockout-recovery.md` (anchored on
  `writePendingApproval(generatedDir, sessionId);` at line 788), sits
  before every edit this round touched and still resolves. Timestamp-only
  re-stamp on all 5; no content changed. `okf-kit check --json docs/okf`
  on the committed tree shows 0 errors, 0 warnings after the re-stamp.
  among them (`understanding-gate-lockout-recovery.md`'s
  `hook-pre-tool-use.ts:788#"writePendingApproval(generatedDir,
  sessionId);"`) sits before every edit this round touched and still
  resolves at line 788. Timestamp-only re-stamp on all 5; no content
  changed. `okf-kit check --json docs/okf` on the committed tree shows 0
  errors, 0 warnings after the re-stamp.
- 2026-09-02T05:04:08Z, task `44ee799a` fleet pin sweep: the okf-staleness
  workflow pin moved from okf-kit@0.6.0 to 0.9.0 for parity with the other
  bundle repos. Measured on the committed tree before and after: `okf-kit
  check --json docs/okf` reports 0 errors, 0 warnings, 0 notices at 0.6.0,
  0.8.0 and 0.9.0, so no doc needed a re-point or a re-stamp.

- 2026-09-02T04:54:26Z, task `204efc56` (`report_missing` delegation
  refusal reason, follow-up to `49d1ee41`): `okf-kit check` flagged 7
  docs stale for `src/cli/pack/hook-pre-tool-use.ts` and/or
  `CHANGELOG.md` after this task's edits: `codex-adapter-parity-gaps.md`,
  `evidence-ledger-trust-boundary.md`, `gate-fail-posture-matrix.md`,
  `pause-vs-gate-kill-switch.md`, `policy-engine-producer-wiring.md`,
  `understanding-gate-auto-mode-signals.md`,
  `understanding-gate-lockout-recovery.md`. The task's only change to
  `hook-pre-tool-use.ts` was a comment reword (naming the new
  `report_missing` reason alongside the two existing report reasons in
  the stderr comment, no behavior change), and the CHANGELOG addition
  describes only the new reason itself; neither touches any claim or
  cited span in these 7 docs (the one line-numbered citation among them,
  `understanding-gate-lockout-recovery.md`'s
  `hook-pre-tool-use.ts:788#"writePendingApproval(generatedDir, sessionId);"`,
  sits well before the edited comment and still resolves). Timestamp-only
  re-stamp on all 7; no content changed. `okf-kit check --json docs/okf`
  on the committed tree shows 0 errors, 0 warnings after the re-stamp.
- 2026-09-01T09:15:00Z, task `2929c5b7` review round 4 (decision D-013:
  the `curl` read-only floor is REMOVED, not extended; `curl` stays
  unclassified and approval-gated, and only its write-capable spellings
  are raised by `destructive-shell-floor.ts`). Three docs re-pointed and
  content-corrected, five re-verified and timestamp-only:
  - `quote-model-divergence.md`: its two round-3 citations of
    `src/runtime/intercept.ts` were off by three lines (they pointed at
    lines 535-620); the real shift is +33, so the correct span is
    `src/runtime/intercept.ts:538-623`, verified byte-identical against
    lines 505-590 of the same file at `72ba45a`. Its prose named
    `isReadOnlyCurlCommand` as a shipped floor and is rewritten for D-013.
  - `policy-engine-producer-wiring.md`: the same off-by-three re-point to
    `src/runtime/intercept.ts:538-623`, same verification. Every other
    citation in the file (`src/cli/policy/intercept.ts:125-127`,
    `src/cli/validate/checks.ts:306-337`, `src/schema/tools.ts:20`,
    `src/policies/ledger-client.ts:499`,
    `src/cli/policy/intercept.ts:387`) re-opened and confirmed unchanged.
  - `gate-fail-posture-matrix.md`: its citation of the same file moved
    from lines 1129-1157 to `src/runtime/intercept.ts:1132-1160`,
    verified against lines 1099-1127 at `72ba45a`.
  - `debug-verb-selection.md`: its `test-risk` paragraph listed a
    `curl` read-only floor among the built-ins. Corrected to name the
    absence and point at the risk-gate.md section. Its two
    `docs/risk-gate.md` line citations (129-132, 144-145) re-checked and
    still accurate: this round's insertions all start at line 319.
  - `codex-adapter-parity-gaps.md`, `evidence-ledger-trust-boundary.md`,
    `pause-vs-gate-kill-switch.md`,
    `understanding-gate-auto-mode-signals.md`: re-read the passages that
    depend on `docs/risk-gate.md`, `CHANGELOG.md`,
    `src/cli/init/templates.ts` and `src/runtime/read-only-bash.ts`. None
    describes the removed floor or the added classifier pattern
    (`understanding-gate-auto-mode-signals.md` lists `read-only-bash.ts`
    as a source but makes no claim about it in prose), so these carry the
    timestamp bump only.

- 2026-09-01T08:26:00Z, task `49d1ee41` (delegation launcher-report
  channel; three implementation rounds plus a master merge; this
  branch: `CHANGELOG.md`, `docs/CLI.md`,
  `docs/decisions/2026-08-27-ug-auto-mode-approval.md`,
  `docs/policy-packs/understanding-before-execution.md`,
  `src/cli/delegate/index.ts`, `src/cli/index.ts`,
  `src/cli/pack/hook-pre-tool-use.ts`,
  `src/policy-packs/builtin/understanding-before-execution/delegation-markers.ts`,
  `src/policy-packs/builtin/understanding-before-execution/index.ts`,
  `tests/cli/delegate.test.ts`,
  `tests/cli/pack-hook-pre-tool-use-delegate.test.ts`,
  `tests/policy-packs/ube-export-surface.test.ts`): round 1 (`be1ae89`)
  wired the child hook to consume a `harness delegate --report`-staged
  launcher report through the conventional
  `.delegation-reports/<child-sid>.md` path; round 2 (`df66f11`) bound
  the persisted report to the delegation's content hash, added
  stage-time `parseReport` validation, and made the missing-file reason
  deterministic, closing a verify-then-persist race by having the hook
  persist exactly the bytes `verifyDelegation` proved (`reportContent`)
  instead of re-reading the file; a follow-up (`ece9985`) dropped em
  dashes introduced in round-2 prose. Round 3 (`402d0bb`) fixed the
  stage-time gap-fill mode to mirror the hook's own
  `toPackageMode(resolveMode(declaredPack).mode)` resolution instead of
  a hardcoded `fast_confirm` literal (every shipped init template sets
  `mode: grill_me`, so a short-form report used to pass staging and
  only fail at the hook after the adoption ledger had already recorded
  it spent), narrowed the pack doc's STAGE-time claim to what holds,
  corrected a "burns the child session id" overclaim (the ledger is
  keyed by content hash; a fresh report re-arms the sid, per the
  existing (r2) test), restated the CHANGELOG's third mutation probe to
  name what actually discriminates, and added two hook tests: (w4)
  pins the single-read persist path via a call-through `vi.mock` of
  `readRegularFileRejectingSymlink`, (w5) covers the
  previously-uncovered report-bound parse-failure-at-mint branch. Each
  round re-stamped the seven bundle docs whose `sources:` list the
  touched files (`f08a06a` after round 1, `7b47bd9` after round 2,
  `65f7d76` after the em-dash cleanup); merging master (`10b5217`)
  pulled in an unrelated ADR expansion that shifted four of this ADR's
  own citations, re-anchored in `733b9f8`
  (`hook-pre-tool-use.ts:866->882` and `:1087->1198`,
  `delegate/index.ts:256->276` and `:285->305`); round 3's own edit
  shifted two of those same `delegate/index.ts` anchors again
  (`:276->277`, `:305->306`), re-anchored in the round-3 commit
  itself. `npx -y okf-kit@0.8.0 check docs/okf` after the round-3 fix
  commit (`402d0bb`) flagged the same seven bundle docs STALE
  (`docs/policy-packs/understanding-before-execution.md` and
  `CHANGELOG.md` both changed); re-verified each against the current
  tree (none describes the stage-time mode bug or the mutation-probe
  wording, no content change needed) and re-stamped all seven in this
  second, timestamp-only commit. Verdict after the re-stamp: `okf-kit:
  clean, no findings`.

- 2026-09-01T07:21:52Z, task `be9faf70` (two review rounds; this branch:
  `docs/decisions/2026-08-27-ug-auto-mode-approval.md`,
  `docs/okf/codex-adapter-parity-gaps.md`,
  `docs/policy-packs/understanding-before-execution.md`, `docs/CLI.md`,
  `src/cli/index.ts`, `src/cli/delegate/index.ts`, `CHANGELOG.md`,
  `tests/cli/delegate.test.ts`): decided gap 14 (`claude -p` delegation
  stays Claude Code only on the consuming side) as a "Platform scope"
  amendment with a reopen criterion; round 2 corrected the issuing side
  after review found `harness delegate` resolves a parent from
  `$CODEX_SESSION_ID` and `checkApprovalMarker` applies no harness
  filter, so a Codex session can still issue a delegation for a Claude
  child today; named the two keys a Codex child would need; pinned the
  `--help` boundary sentence with a test. The `src/cli/index.ts` help
  edit shifted three `pause-vs-gate-kill-switch.md` citations (+2),
  re-pointed; six bundle docs whose `sources:` list the touched files
  were re-verified (no content change) and re-stamped twice (once per
  round), then once more after merging master, which carried the
  `a4ceb6be` re-stamps of the same docs. `npx -y okf-kit@0.8.0 check
  docs/okf` after the last commit: clean, no findings.

- 2026-09-01T06:56:42Z, review-round-2 fixes on task `a4ceb6be` (this
  round: `docs/decisions/2026-08-27-ug-auto-mode-approval.md`,
  `src/cli/doctor/bypass-without-auto-approve.ts`,
  `src/policy-packs/builtin/understanding-before-execution/permission-mode-observations.ts`,
  `docs/policy-packs/understanding-before-execution.md`,
  `CHANGELOG.md`): reworded the ADR's "second, unconditional minting
  path for the marker-signing key" clause and its four echoes (the two
  module headers, the policy-pack doc, and `CHANGELOG.md`'s `[Unreleased]`
  entry) to "second, unconditional signing surface" (`markerId`
  namespacing already stops a signed observation from minting an
  approval marker), added one sentence to the ADR's Reasoning paragraph
  on the narrow write-primitive-without-key-read class marker signing
  closes, appended a transcript-corroboration candidate to the ADR's
  reopen criterion, and substituted the ADR's `bypass-without-auto-approve.ts:20`
  comment citation for a code citation at its `doctor/index.ts` call
  site. Also closed a `CHANGELOG.md` self-contradiction (the task
  `8f637efd` F2 bullet's trailing "possible follow-up" sentence, written
  before the sibling `[Unreleased]` entry above it settled the question
  the other way) and pinned the doctor message's caveat clause with a
  new assertion in `tests/cli/doctor-bypass-without-auto-approve.test.ts`.
  The commit above changed `docs/policy-packs/understanding-before-execution.md`,
  `CHANGELOG.md`, and `permission-mode-observations.ts` again, so
  `npx -y okf-kit@0.8.0 check docs/okf` flagged the same seven bundle
  docs listed below STALE a second time; re-verified each against the
  current tree (still no content change needed, same as round 1) and
  re-stamped all seven in a second, timestamp-only commit. Verdict after
  the re-stamp: `okf-kit: clean, no findings`.

- 2026-09-01T06:42:59Z, re-stamp for commit `e66399f1` (task `a4ceb6be`,
  round 1): the prior commit changed `CHANGELOG.md`,
  `docs/policy-packs/understanding-before-execution.md`, and
  `src/policy-packs/builtin/understanding-before-execution/permission-mode-observations.ts`
  for the unsigned-observation ADR paragraph, and each of the seven docs
  below cites at least one of those three files in its `sources:` list,
  so `okf-kit check` flagged all seven STALE. Re-verified each against
  the current tree: none describes the signing decision itself, so every
  one was timestamp-only.
  - `codex-adapter-parity-gaps.md` (cites `understanding-before-execution.md`, `CHANGELOG.md`)
  - `evidence-ledger-trust-boundary.md` (cites `permission-mode-observations.ts`, `CHANGELOG.md`)
  - `gate-fail-posture-matrix.md` (cites `CHANGELOG.md`)
  - `pause-vs-gate-kill-switch.md` (cites `CHANGELOG.md`)
  - `policy-engine-producer-wiring.md` (cites `CHANGELOG.md`)
  - `understanding-gate-auto-mode-signals.md` (cites `permission-mode-observations.ts`, `CHANGELOG.md`)
  - `understanding-gate-lockout-recovery.md` (cites `CHANGELOG.md`)

- 2026-08-31T19:55:00Z, verification-round fixes (agent-tasks `2699b476`):
  the three remaining bare `src/cli/validate/checks.ts` range citations
  (two in `manifest-validation-scope.md`, one in
  `policy-engine-producer-wiring.md`) now carry function-signature
  anchors. Without an anchor, okf-kit bounds-checks a range but cannot
  see a range that drifted onto adjacent code; with the anchor, a shift
  that moves the signature out of the range is reported
  (anchor-not-found-in-range; probed for real this round). A pure
  WIDENING that keeps the anchor inside the range still passes: okf-kit
  checks anchor presence in-range, not position. Three em dashes in this
  branch's newly authored prose replaced.

- 2026-08-31T17:26:14Z, fix-round after the merge commits (task
  `2699b476`): the merge commit (touching CHANGELOG.md, additive only)
  and the follow-up commit (a comment-only edit to
  `src/runtime/intercept.ts`) newly staled six docs whose `sources:`
  list either file: `codex-adapter-parity-gaps.md`,
  `evidence-ledger-trust-boundary.md`, `gate-fail-posture-matrix.md`,
  `pause-vs-gate-kill-switch.md`, `policy-engine-producer-wiring.md`,
  `quote-model-divergence.md`. None of their CHANGELOG-citing passages
  describe the `[Unreleased]` section this task touches (all cite
  released versions), so those are timestamp-only. The
  `src/runtime/intercept.ts` citations needed real re-pointing, not just
  a re-stamp, because this task's round 1 already grew
  `policyMatchesEvent` (the `input_match` block) before this merge
  round started: `policy-engine-producer-wiring.md` and
  `quote-model-divergence.md` (2x) cited `503-568` for the whole
  function; actual is `505-590` (start +2 from two new imports earlier
  in the file, end pushed to 590 by the `input_match` arm this task
  added inside the function). `gate-fail-posture-matrix.md` cited
  `1034-1062` for `resolveAttributedContexts`'s own D-021 doc comment;
  actual is `1099-1127` (net +65: the `input_match` block inside
  `policyMatchesEvent` plus the new `inputMatchMismatchesEvent`
  function, both upstream of this citation). `policy-engine-producer-wiring.md`
  also had a stale `checkSolutionAcceptanceProducer` citation
  (:304-335 → :306-337) missed by the earlier `manifest-validation-scope.md`
  pass since it lives in a different doc. Two conflict-resolution
  mistakes from the merge itself, caught by re-running the checkers
  rather than trusting the resolution: (1) `pause-vs-gate-kill-switch.md`'s
  decision-table row citing `docs/for-humans.md:391-393`/:394-395 ,
  wrong on BOTH branches (that file is untouched by anyone since before
  this task started), fixed to master's already-correct
  :395-397#"  diff-able, source-controlled."/:398-399; (2) `log.md`'s
  own 09:42:00Z historical entry, where the "keep HEAD" conflict
  resolution wrongly preserved a live citation token (the
  writePendingApproval anchor into hook-pre-tool-use.ts, around line
  771) that the `ad66c43f` sweep had already lifted into prose on
  master, re-lifted here, attributed to the sweep instead of this task.
  Verdict: `npx -y okf-kit@0.8.0 check --json docs/okf` and the `@0.6.0`
  pin both report `{errors:0, warnings:0, notices:0}` on the working
  tree, re-confirmed against the committed tree after this fix-round's
  commit.

- 2026-08-31T17:20:31Z, final merge round on task `2699b476`: merged
  `origin/master` (the `ad66c43f` sweep, PR #483, and the `6f719bb4` ADR
  citation-anchoring task, PR #482) into this branch. CHANGELOG.md and
  `log.md` conflicts resolved by keeping both sides' entries (log.md
  newest-first by timestamp); `evidence-ledger-trust-boundary.md` and
  `pause-vs-gate-kill-switch.md` conflicted only on `timestamp:` (no
  content diverged on either side once the round-2 hardening's own edit
  is accounted for), kept this branch's content and re-verified its
  three `src/cli/index.ts` citations in `pause-vs-gate-kill-switch.md`
  (`2912-2916`, `3284-3289`, `3282-3381`) still resolve on the merged
  tree (that file is untouched by both the sweep and the ADR task).
  `debug-verb-selection.md` (unowned once the sweep merged) now
  documents the `input_match` parity arm: named the shared evaluator
  `firstInputMatchMismatch` (`src/io/extract.ts`), used by both
  `policyMatchesEvent` (`src/runtime/intercept.ts`) and dry-run's
  `policyMatchesTool` (`src/cli/dry-run.ts`), and that the
  mixed-envelope arming (`inputMatchMismatchesEvent`, round 2) is
  intercept-only because dry-run's `--input` is always a single object;
  added both files to `sources:`. The bridging comments in
  `src/runtime/intercept.ts` and `src/cli/dry-run.ts` that round 2 left
  saying the doc did NOT yet cover `input_match` now point at the doc
  plainly. `manifest-validation-scope.md`'s ten
  `src/cli/validate/checks.ts` citations, stale since round 2 inserted
  `checkTaskVerbGateWiring` (~57 net lines) after `checkWorkflowGateWiring`
  and two new imports (+2 lines) above `checkMcp`: `checkMcp` (:119-136
  → :121-138, and the single-line :119 → :121), `checkCli`
  (:138-189 → :140-191), `checkSkills` (:191-214 → :193-216),
  `checkHooks` (:216-248 → :218-250), `checkPolicyPacks` /
  `checkPolicyPackConfigsAsDiagnostics` (:1258-1287 → :1316-1345),
  `checkSolutionAcceptanceProducer` (:304-335 → :306-337),
  `checkWorkflowGateWiring` (:364-407 → :366-412, the function itself
  grew by 5 lines calling the new check),
  `checkUnderstandingBeforeExecutionAutoApproveMeasured` (:1331-1364 →
  :1389-1422) and its `listedAutoApproveHarnesses` helper (:1309-1329
  → :1367-1387), and `runAssetChecks` itself (:1366-1392 →
  :1424-1450); every re-point verified against the current file (each
  function's declaration and closing brace read directly), not derived
  from the line-count arithmetic alone. All other citations in this doc
  (`src/cli/add/index.ts`, `src/cli/remove/index.ts`, `src/schema/*`,
  `src/io/validate-before-write.ts`, `src/cli/add/mutate.ts`) are
  untouched by this task and were left as-is.

- 2026-08-31T19:20:00Z, merge round after the ad66c43f sweep landed
  (agent-tasks `6f719bb4`): merged master into this branch (both branches
  append log entries; both sides kept, newest first). This branch's
  `[Unreleased]` CHANGELOG entry postdates the sweep's fresh stamps on
  `codex-adapter-parity-gaps.md`, `gate-fail-posture-matrix.md` and
  `policy-engine-producer-wiring.md` (all list `CHANGELOG.md` in
  `sources:`), so re-read their CHANGELOG-citing passages against the
  added entry (a guard/anchoring bullet; none of the three cites the
  Unreleased section) and re-stamped all three timestamp-only.

- 2026-08-31T18:50:00Z, ADR citation anchoring, round 3 fixes (agent-tasks
  `6f719bb4`, review round 1, HIGH finding): the round below fixed every
  BACKTICK citation but left twelve BARE, non-backtick `lines N-M` / `line
  N` prose references untouched in
  `docs/decisions/2026-08-27-ug-auto-mode-approval.md` (eleven in the
  decision-order table and the "Approving an Understanding Report"
  citation, plus one found by this round's own sweep in an acceptance
  criterion), all stale at HEAD. Re-pointed all twelve to the same
  backtick-anchored form against the current tree. Strengthened the guard
  with a within-cited-range anchor-uniqueness check (the anchor text must
  occur exactly once across the whole `[N, M]` range, not just on line
  `M`), which catches a citation silently widened at its start; no
  existing citation violated it. The guard still cannot see a bare,
  non-backtick line reference at all (grammar unchanged by design; a
  probe that re-introduced one confirmed the guard stays green), so the
  sweep table in the task report, not the guard, is what closes this
  class going forward. This round also edited `CHANGELOG.md`'s
  `[Unreleased]` Added bullet (scoped it to what the guard enforces),
  which re-staled `evidence-ledger-trust-boundary.md` and
  `pause-vs-gate-kill-switch.md` (both list `CHANGELOG.md` in
  `sources:`); re-read both docs' CHANGELOG-citing passages (unrelated
  historical entries, `63fefe3a`/`1432e053` and the shared-marker-reader
  extraction, both untouched by this edit) and re-stamped both
  timestamp-only, same as the round below did for the same reason.

- 2026-08-31T17:05:39Z, re-stamp for the review round-1 hardening on the
  task-scoped merge gate (task `2699b476`, round 2): the mixed-envelope
  `input_match` arm and the `checkWorkflowGateWiring` missing-task-hooks
  warning. Changed sources this commit: `src/io/extract.ts` (comment
  only), `src/schema/extract.ts` (comment only), `src/schema/policies.ts`
  (comment only), `src/runtime/intercept.ts`, `src/cli/dry-run.ts`,
  `src/cli/validate/checks.ts`, `src/cli/init/profiles.ts` (mutation
  probe only, restored byte-exact, no net diff), `src/cli/record/index.ts`
  (JSDoc relocation only, no content change), `CHANGELOG.md`. Two
  non-sweep docs name one of these in `sources:` and are re-stamped
  here: `pause-vs-gate-kill-switch.md` (names `src/runtime/intercept.ts`
  / `src/cli/validate/checks.ts` / `src/schema/policies.ts`) and
  `evidence-ledger-trust-boundary.md` (names `CHANGELOG.md`; the round-2
  bullet only documents the hardening above and does not touch any
  ledger-tag or producer this doc describes). Their cited claims
  (`evaluateOnePolicy`'s `operator_only` short-circuit,
  `checkPolicySelfAttestation`'s recognition of `operator_only: true`,
  the "0 warnings/errors under `validate --strict`" measurement, and the
  `readRegularFileRejectingSymlink` extraction history) are about
  different code paths than this round's changes
  (`inputMatchMismatchesEvent`, the new `checkTaskVerbGateWiring`
  warning) and are unaffected; FULL_TEMPLATE still carries all four
  evidence hooks, so the new warning never fires for it, leaving the
  "0 warnings/errors" claim true. `understanding-gate-lockout-recovery.md`
  names none of this round's changed sources and was not touched.
  `manifest-validation-scope.md` is SWEEP-OWNED (task `ad66c43f`) and was
  deliberately left alone per the same scope call the round-1 entry
  below records, but its own `src/cli/validate/checks.ts` line-range
  citations were NOT re-pointed by this commit even though inserting
  `checkTaskVerbGateWiring` (~40 lines) shifted everything below it:
  `okf-kit check` newly reports 4 `citations-resolve` warnings on that
  file this commit did not exist to cause a fix for (2 continuation
  ranges and one single-line citation now resolve to a closing brace or
  a blank line). Left for the sweep task per the orchestrator's scope
  call; flagged here and in this task's report so the sweep re-points
  against this commit's line numbers rather than bd87f46's.

- 2026-08-31T16:19:19Z, re-stamp for the task-scoped merge gate (task
  `2699b476`, `trigger.input_match`). Changed sources this commit:
  `src/io/extract.ts`, `src/schema/extract.ts`, `src/schema/policies.ts`,
  `src/policies/index.ts`, `src/runtime/intercept.ts`,
  `src/runtime/workflow-policies.ts`, `src/cli/dry-run.ts`,
  `src/cli/init/templates.ts`, `src/cli/init/profiles.ts`,
  `src/cli/record/index.ts`, `src/cli/index.ts`,
  `docs/examples/full-manifest.yaml` (+ its golden),
  `docs/for-agents.md`, `docs/writing-custom-policies.md`,
  `docs/CLI.md`, `CHANGELOG.md`. Cross-checked each against every doc's
  `sources:` list. Three docs name at least one of them and are
  re-stamped here; the other six that would also match
  (`codex-adapter-parity-gaps.md`, `debug-verb-selection.md`,
  `gate-fail-posture-matrix.md`, `policy-engine-producer-wiring.md`,
  `quote-model-divergence.md`, `manifest-validation-scope.md`) are the
  long-stale set a parallel task is sweeping and were deliberately NOT
  touched here, per the orchestrator's scope call for this task;
  `understanding-gate-auto-mode-signals.md` names none of the changed
  files at all.

  What was re-verified, per doc:
  `evidence-ledger-trust-boundary.md` names `src/cli/init/templates.ts`,
  `docs/writing-custom-policies.md`, `docs/CLI.md`, `CHANGELOG.md`. Its
  invariant (no agent-writable ledger tag opens a BUILTIN enforcement
  gate; custom `requires.ledger_tag` policies are process gates by
  design) is unchanged by this task: the two new template policies are
  ordinary `requires.ledger_tag` gates on the agent-writable ledger,
  exactly the class the doc's "Ledger tags that remain load-bearing"
  paragraph already covers. That paragraph gained the new
  `review:${TASK_ID}` entry with its producer, so the enumeration stays
  complete; nothing else in the doc restates a claim this task altered.
  Two earlier entries in this log quoted those same already-drifted
  ranges in citation form (a full path-plus-range citation into
  `src/cli/index.ts` followed by a bare continuation range),
  which okf-kit resolves as live continuation citations; this commit's
  line shift turned one of them into a closing-brace start line. They
  are historical records of what the doc cited THEN, so they are lifted
  out of citation form rather than re-pointed, which would falsify the
  record.

  `pause-vs-gate-kill-switch.md` names `src/cli/index.ts`,
  `src/schema/policies.ts`, `src/runtime/intercept.ts`,
  `src/cli/init/templates.ts`, `CHANGELOG.md`. Its subject is the pause
  sentinel, `gate disable`/`enable`, and the three `operator_only`
  kill-switch policies; this task touched none of those (it added an
  optional trigger field, two non-`operator_only` policies, and two
  hooks). Its three `src/cli/index.ts` citations DID need attention:
  they pointed at ranges that had already drifted on `origin/master`
  (the cited `2726-2731` landed inside `record dogfood`'s action block,
  and `3086-3094` / `3086-3185` inside the `uninstall` command help),
  and this commit's `+8` lines in `record review` would have shifted
  them further. All three are re-pointed at their real current
  locations, two of them anchored: the `gate disable` motivation
  comment, the `harness pause` description line naming
  `policies[].enabled`, and the pause/resume registration block.
  `understanding-gate-lockout-recovery.md` names `src/cli/index.ts`.
  Its only citation into that file is the `harness approve
  understanding` flag list, which sits well above this commit's edits,
  so it neither drifted nor changed meaning; its
  `expire_on_tool_match` paragraph mentions
  `mcp__agent-tasks__task_finish` as a marker-EXPIRY trigger in the
  understanding pack, an unrelated mechanism from the merge gate this
  task adds on the same verb. No content edit, timestamp bumped.

  Verdict: 3 docs re-stamped, 1 with a content edit
  (`evidence-ledger-trust-boundary.md`), 1 with citation re-points
  (`pause-vs-gate-kill-switch.md`). Pre-existing citations-resolve
  findings on `understanding-gate-lockout-recovery.md`
  (`hook-pre-tool-use.ts` anchor, `hook-codex-pre-tool-use.ts`
  closing-brace start line) and on `pause-vs-gate-kill-switch.md`
  (`docs/for-humans.md` blank start line) are unrelated to this task's
  files and left as-is, same as the two preceding entries record.
- 2026-08-31T16:16:29Z, ADR citation anchoring sweep (agent-tasks `6f719bb4`):
  every backtick source citation in
  `docs/decisions/2026-08-27-ug-auto-mode-approval.md` and
  `docs/decisions/2026-05-16-ug-drift-guard-version-pin.md`
  was re-pointed to a repo-relative path with an anchor
  (`` `path:N-M#"text on line M"` ``) verified against the current tree by a
  new guard, `tests/decisions-citations-resolve.test.ts`. Most citations had
  drifted: several basename-only forms (`markers.ts`, `hook-pre-tool-use.ts`,
  `understanding-before-execution.md`) needed the full repo-relative path,
  and many line ranges into `src/cli/pack/hook-pre-tool-use.ts` and
  `src/cli/approve/understanding.ts` had shifted well past the eleven lines
  the terrain note flagged, because slice 1 and slice 3 of the ADR's own
  design (auto-approve, delegation) have since been implemented in those two
  files (`src/cli/pack/auto-approve-path.ts` is a new module carrying most of
  the slice-1 logic). No described code had actually vanished; every
  BACKTICK citation resolved to an existing, still-accurate location once
  re-pointed (the eleven-plus-one BARE, non-backtick line references this
  sweep left untouched were caught in review and re-pointed in a round 3
  follow-up; see the next entry). Checked `docs/okf/*.md` frontmatter
  `sources:` for the ADR path and for
  `CHANGELOG.md` (this task added an `[Unreleased]` CHANGELOG entry):
  `evidence-ledger-trust-boundary.md` and `pause-vs-gate-kill-switch.md`
  list `CHANGELOG.md`; re-read their CHANGELOG-citing passages (unrelated
  historical entries, still accurate) and re-stamped both timestamp-only.
  `codex-adapter-parity-gaps.md`, `gate-fail-posture-matrix.md`, and
  `policy-engine-producer-wiring.md` also list `CHANGELOG.md` but are three
  of the six docs the parallel sweep (agent-tasks `ad66c43f`) owns, so left
  untouched. No doc lists the ADR path itself in frontmatter `sources:`
  except `log.md`, which is excluded by convention.
- 2026-08-31T15:57:58Z, genuine re-verify and re-stamp sweep (agent-tasks
  `ad66c43f`): ran `npx okf-kit@0.8.0 check --json docs/okf` on the
  worktree HEAD (master `50b60f5`) as the before-baseline and matched it
  against the orchestrator's own master measurement: sources-fresh warned
  on `quote-model-divergence.md`, `codex-adapter-parity-gaps.md`,
  `debug-verb-selection.md`, `gate-fail-posture-matrix.md`,
  `policy-engine-producer-wiring.md`, and `manifest-validation-scope.md`;
  citations-resolve warned on `log.md` (three findings), on
  `understanding-gate-lockout-recovery.md` (two findings), and on
  `pause-vs-gate-kill-switch.md` (one finding). For each of the six
  sources-fresh docs, read every source its `sources:` list names that
  had a newer commit than the doc's own `timestamp:`, opened the current
  file at HEAD, and compared claim by claim against what the doc said.
  Corrections made, per doc:
  - `quote-model-divergence.md`: task `cf3dff51` (PR #412/#419) closed
    the quoted-shell-boundary bash_match bypass the doc's "Fail-open-
    Klassen" table and "Ebenfalls Fail-open" paragraph still described
    as live; both are now marked closed, the "Einordnung je Klasse"
    table row and the Empfehlung-2 narrative updated to say two of the
    three originally-bundled tasks (`cf3dff51`, `2dfdf472`) are closed
    and only `b093911d` remains open, and the `command-normalize.ts` /
    `bash-prefix-parse.ts` table citations into `src/runtime/intercept.ts`
    and `src/cli/policy/intercept.ts` re-pointed to their current
    location (the raw/normalised/amp-aware/quote-aware four-arm
    `policyMatchesEvent`, and the `bashPrefix` consultation block that
    moved after task `a7eb1a71`'s kubectl-signal wiring).
  - `manifest-validation-scope.md`: task `57058364` Slice 2 inserted a
    new `checkUnderstandingBeforeExecutionAutoApproveMeasured` function
    ahead of `runAssetChecks` in `src/cli/validate/checks.ts`, shifting
    every function after it; every line citation in the "What the asset
    gate actually checks" list and the "harness add mcp x" walkthrough
    was re-verified against the current file and re-pointed, and a new
    bullet documents the added check as a fourth way an unrelated-
    looking path can appear in a fresh add's asset error.
  - `policy-engine-producer-wiring.md`: two changes shipped in 0.45.0
    that the doc's body already narrated inline (the tier-aware
    deny-degraded posture, task `f1aea826`) but its own "Version history
    that matters" section stopped at 0.44.0 and called it current; added
    a 0.45.0 bullet, corrected the "current" claim (`package.json` is at
    0.53.0 now), and added a new paragraph documenting the FOURTH
    `bash_match` matching arm (`normalizeCommandQuoteAware`, task
    `cf3dff51`) the trigger-matching narrative had stopped at three.
  - `codex-adapter-parity-gaps.md`: re-verified gaps 1-13 against their
    cited sources; added gap 14, a genuinely new gap found during this
    pass, `claude -p` delegation (slice 3, agent-tasks `37ad0b05`) has
    no Codex-side wiring at all in `hook-codex-pre-tool-use.ts`; and
    added a short note that task `8f637efd` now ships `auto_approve`
    active by default in the FULL/SOLO/TEAM templates, which does not
    change gap 13's fail-closed mechanics.
  - `gate-fail-posture-matrix.md`: same `8f637efd` active-by-default note
    added next to the auto-approval paragraph; the
    `hook-pre-tool-use.ts` header-contract line citation was off by one
    line after intervening edits and was corrected.
  - `debug-verb-selection.md`: the dry-run and audit sections already
    matched current source (the four-arm parity claim and the audit
    approvals section were already correct); only the `smoke` verb's
    `EX_UNAVAILABLE` citation had drifted to an unrelated line and was
    re-pointed to the `ensureClaudeAvailable` function that now carries
    it.

  Separately, fixed the three citations-resolve findings without
  re-verifying their docs' whole `sources:` list (their sources were not
  on the sources-fresh list above): in
  `understanding-gate-lockout-recovery.md` the `writePendingApproval`
  anchor into `hook-pre-tool-use.ts` moved one line down and the
  `hook-codex-pre-tool-use.ts` closing-brace citation was pointing at
  the wrong function entirely; both are now anchored on the actual
  `writePendingApproval(generatedDir, sessionId);` call site in each
  file. In `pause-vs-gate-kill-switch.md` the `docs/for-humans.md`
  blank-start-line citation is now re-pointed past the blank line to the
  bullet's own last line, and the same doc's two citations named by the
  orchestrator as mis-pointing without a warning (`src/cli/index.ts`
  pause/gate-command ranges, plus the `policies[].enabled` help-text
  citation and the `gate disable` motivating-case comment citation) are
  re-verified against the current `pause`/`resume`/`gate` command
  registrations and re-pointed; two attempted full anchored citations
  (`#"..."`) whose anchor text itself contained backtick characters
  broke the outer markdown code span and were reported by okf-kit as
  notices, corrected by dropping to plain range citations instead. In
  `log.md` itself, every historical entry's `path:N-M`-shaped citation
  token (the pre-existing drift notes about these same three docs,
  above) was rewritten to prose naming the file and an approximate line,
  since a log entry describing citation drift should not itself carry a
  citation token okf-kit tries to resolve.

  After committing, re-ran the same command against the committed tree
  and separately the exact invocation `.github/workflows/okf-staleness.yml`
  uses; both report zero warnings for `sources-fresh` and
  `citations-resolve`. Set difference against the before-baseline: every
  sources-fresh and citations-resolve finding listed above is gone; no
  new finding of either rule appeared.

  Correction (round 2, review finding, HIGH): "read every source ... and
  compared claim by claim" above overclaimed. It read every source file
  the sources-fresh docs named, but did not separately verify the prose
  line references embedded in running text outside a backtick citation
  token, the shorthand shape okf-kit's citations-resolve rule cannot
  parse because it carries no path, so a wrong one there passes the
  mechanical check silently. A follow-up pass read every such prose line
  reference across all nine docs this task touched against HEAD and
  re-pointed the ones that had drifted or were wrong from the start,
  including references in docs `okf-kit check` already reported clean.
  Also restored an accurate status for the still-open command-normalize
  peeling gap in `quote-model-divergence.md` (a wrong cross-reference had
  claimed a different fix addressed it) and corrected the same doc's
  `&`-boundary-closure attribution to name both the template-level and
  the engine-level fix, with the caveat that an already-materialized
  manifest does not pick up the template-level one on its own.

- 2026-08-30T10:20:00Z, re-stamp on commit-time recheck (task `8f637efd`,
  review round 3, findings F1-F5): after the round-3 fixes commit
  (`bbf6f7f`), ran `npx okf-kit@0.8.0 check docs/okf` and computed
  newly-stale docs against the round-2 re-stamp baseline (the state this
  branch merged from `origin/master`). Four docs came back STALE, each
  because a source this task's commit touched appears in that doc's
  `sources:` list: `evidence-ledger-trust-boundary.md`
  (`docs/policy-packs/understanding-before-execution.md`, `CHANGELOG.md`),
  `pause-vs-gate-kill-switch.md` (`src/cli/index.ts`, `CHANGELOG.md`),
  `understanding-gate-auto-mode-signals.md`
  (`permission-mode-observations.ts`,
  `docs/policy-packs/understanding-before-execution.md`), and
  `understanding-gate-lockout-recovery.md` (`src/cli/index.ts`,
  `docs/policy-packs/understanding-before-execution.md`). Checked each
  doc's actual claims against what round 3 changed: the `src/cli/index.ts`
  edit (F5) is a single in-place string edit inside the `pack upgrade`
  `--description` help text at line 1224-1227 (no line added or removed),
  nowhere near either doc's cited ranges (`1584-1599`, `2726-2731`,
  `3086-3185`, `3088-3094`); the `permission-mode-observations.ts` edits
  (F1: `rejectMalformedSessionId` on write, `sanitizeForDisplay` on read;
  F2: corrected module-header trust framing) changed HOW the sessionId is
  validated/sanitized, not WHAT is written or that it is consumed only by
  `harness doctor`'s advisory finding, which is the only claim
  `understanding-gate-auto-mode-signals.md` makes about this file; and the
  `docs/policy-packs/understanding-before-execution.md` edits (F5's
  heading-only task-id drop, F2's "hook-written, not agent-writable" ->
  unsigned/advisory wording correction) touch no claim any of the four
  docs actually restates or contradicts (`evidence-ledger-trust-boundary.md`
  and `understanding-gate-lockout-recovery.md` list the doc only as a
  background source, with no line citation into it; neither of the other
  two make a signed/unsigned claim about the permission-mode observation
  either way). No doc's substantive claims describe content round 3
  altered, so all four `timestamp:` fields are bumped with no content
  edit. The pre-existing citation-resolve drift on
  `understanding-gate-lockout-recovery.md` (the writePendingApproval
  anchor into hook-pre-tool-use.ts around line 771 as the file stood
  then, and the closing-brace start line hook-codex-pre-tool-use.ts was
  cited at around line 358 as it stood then) and on
  `pause-vs-gate-kill-switch.md` (the blank start line docs/for-humans.md
  was cited around lines 394-395 as it stood then) is unrelated to this
  task's changes and left as-is, same as
  the round-2 entry below already found for the same two docs. The
  remaining STALE findings from this run (`codex-adapter-parity-gaps.md`,
  `debug-verb-selection.md`, `gate-fail-posture-matrix.md`,
  `manifest-validation-scope.md`, `policy-engine-producer-wiring.md`,
  `quote-model-divergence.md`) are the identical pre-existing set the
  round-2 entry below already accepted (confirmed by running the same
  check against the pre-round-3 commit `d64eed6`, which shows the same
  six docs and no others), and are left out of scope here per the
  orchestrator's F6 acceptance for this task.

- 2026-08-30T09:42:00Z, re-stamp on commit-time recheck (task `8f637efd`,
  review round 2, F8 final verification): after the round-2 fixes
  commit, ran `npx okf-kit@0.8.0 check docs/okf` and computed
  newly-stale docs by COMMIT time (not local mtime) against
  `origin/master`. Two docs this branch had already re-stamped in round
  1 came back STALE again, both from round-2 edits to a file their
  `sources:` list names: `understanding-gate-auto-mode-signals.md`
  (`permission-mode-observations.ts`, touched by F1's dedup extraction;
  `src/cli/pack/hook-pre-tool-use.ts`, whose "last touched" commit moved
  to the round-1/master merge commit even though this branch's own diff
  against `origin/master` for that file is unchanged since round 1: a
  merge-commit history-simplification artifact, not new content) and
  `understanding-gate-lockout-recovery.md` (`src/cli/index.ts`, touched
  by F5's `gc` command wiring, well after the line range the doc cites
  from that file; same `hook-pre-tool-use.ts` merge-commit artifact).
  Re-read both docs' claims against every round-2-touched source in
  their list: neither doc's substantive claims (the observation
  mechanism's read/write contract; the `approve` command's flag list)
  describe code this task's changes actually altered, so both
  `timestamp:` fields are bumped with no content edit. Two OTHER STALE
  findings from the same run were checked and left as pre-existing,
  unrelated citation drift, confirmed against the pre-task common
  ancestor `a08efe0`: `understanding-gate-lockout-recovery.md`'s
  writePendingApproval anchor into hook-pre-tool-use.ts, cited at around
  line 771 as the file stood then, already missed its target there
  (lifted out of citation form by the `ad66c43f` sweep so this
  historical note stops resolving against today's file), and
  `pause-vs-gate-kill-switch.md`'s
  `src/cli/index.ts` pause/gate-command ranges (lines 3086-3185 and
  3088-3094 as cited then, lifted out of citation form by task 2699b476
  so this historical note stops resolving against today's file)
  already pointed at the unrelated `uninstall` command's description
  there too (same drift the entry below already named). Several other
  docs under this directory (codex-adapter-parity-gaps.md,
  debug-verb-selection.md, gate-fail-posture-matrix.md,
  policy-engine-producer-wiring.md, quote-model-divergence.md) also came
  back STALE against files this branch touched (docs/CLI.md,
  CHANGELOG.md, `src/cli/index.ts`, `src/cli/doctor/index.ts`,
  `src/cli/init/composer.ts`, `src/cli/init/templates.ts`,
  `docs/examples/full-manifest.yaml`, `docs/policy-packs/understanding-before-execution.md`);
  these are out of this task's scope (none of their sources: lists are
  this task's own primary subject, and re-reading all five in full is a
  larger sweep than one task's fix-round budget covers) and are left
  as-is, flagged here rather than folded into a vague "unrelated"
  mention.
- 2026-08-30T09:32:00Z, targeted correction (task `8f637efd`, review round
  2, F8): the 2026-08-30T08:46:21Z entry below said "several other docs
  under this directory already carried staleness against unrelated prior
  commits before this task started" without naming them. That residue is
  two specific docs, both because THIS task's own `src/cli/init/templates.ts`
  edit (the `auto_approve` snippet insertion, round 1) touched a file
  their `sources:` list: `evidence-ledger-trust-boundary.md` and
  `pause-vs-gate-kill-switch.md`. Re-read both against the templates.ts
  change (additive: one new config key rendered into the pack's
  `config:` mapping) and, for round 2, against `src/cli/init/composer.ts`
  (also a source of `evidence-ledger-trust-boundary.md`; F3 added the
  same `auto_approve` default there) and `src/cli/index.ts` (a source of
  `pause-vs-gate-kill-switch.md`; F5 added the `gc` command's
  permission-mode-observation sweep, +2 net lines before the pause/gate
  command registration): neither doc's claims describe any of the four
  changed regions, so no content edit is needed in either doc; both
  `timestamp:` fields are bumped. Separately, and NOT fixed by this
  correction: `pause-vs-gate-kill-switch.md` cites `src/cli/index.ts`
  lines 3086-3185 and 3088-3094 (as cited then, lifted out of citation
  form by task 2699b476) for the `pause`/`gate` command registrations; both
  ranges already pointed at the unrelated `uninstall` command's
  description before this task touched the file at all (confirmed
  against the pre-round-1 merge commit), so this is genuinely
  pre-existing citation drift from an earlier, unrelated change, out of
  this task's scope; round 2's F5 edit shifts those already-wrong line
  numbers by +2 more but does not newly break a citation that resolved
  correctly before.
- 2026-08-30T08:54:18Z, re-stamped `understanding-gate-lockout-recovery.md`
  after the same round-1-fix edit to `understanding-before-execution.md`'s
  Cleanup paragraph (this doc lists it as a source): re-read its own
  claims about the adoption ledger's role in re-arming a lockout, which
  do not touch the gc sweep's age-gating wording; no content change
  needed.
- 2026-08-30T08:50:54Z, review round 1 fix on task `3ece079d`: the
  orphaned-adoption-ledger branch in `sweepDelegations` (no delegation
  marker at all for a session) now also requires the ledger file's own
  `mtimeMs` to be past the retention cutoff before treating it as a
  candidate, matching the `gc` command's documented "older than the
  retention window" posture (previously it swept a brand-new orphan
  ledger regardless of age). `docs/CLI.md`'s `gc` row and the Cleanup
  paragraph in `understanding-before-execution.md`'s delegation section
  re-worded to state the age gate explicitly; re-stamped
  `understanding-gate-auto-mode-signals.md`'s `sources:` timestamp after
  re-reading its `hook-pre-tool-use.ts` and
  `understanding-before-execution.md` claims against both edits (neither
  touches the permission-mode / escape-branch material that doc cites;
  no content change needed there).
- 2026-08-30T08:24:49Z, `harness gc` grew a `delegation` category (task
  `3ece079d`, follow-up from UG auto-mode slice 3): sweeps expired
  delegation markers (past their own signed `expires` binding by the
  retention window, no signature check needed for a retention decision)
  and orphaned adoption ledgers, never a file gc could not parse. The
  adoption-ledger dirname constant moved out of `hook-pre-tool-use.ts`
  (its only prior writer) into `delegation-markers.ts`, next to the
  delegation-marker dirname, so the new read-only sweep did not need a
  cli-to-cli import; that shifted line numbers in the hook file, which
  stale-anchored one citation in `understanding-gate-lockout-recovery.md`
  pointing at the pending-approval staging call, now re-anchored to the
  moved line. Checked by hand that the surrounding header-contract
  citation in the same file (cited from `gate-fail-posture-matrix.md`)
  sits above every edit and still holds; no citation linter exists yet to
  re-run instead.
- 2026-08-30T08:46:21Z, understanding-gate auto-approval install default
  (task `8f637efd`, D-004, amendment to
  docs/decisions/2026-08-27-ug-auto-mode-approval.md): FULL_TEMPLATE,
  SOLO_TEMPLATE, and TEAM_TEMPLATE now ship an active `auto_approve`
  block; a new `harness pack upgrade understanding-before-execution` verb
  inserts it into an existing manifest; a new `harness doctor` advisory
  fires when `bypassPermissions` was observed for a session and
  `auto_approve` does not cover it. The PreToolUse hook
  (`src/cli/pack/hook-pre-tool-use.ts`) gained one new side-effect write
  (a per-session `permission_mode` observation), at the same point in its
  decision order the existing auto-approval attempt already runs at;
  nothing about the decision order, the fail-open contract, or the marker
  authority changed. Checked every doc under this directory that names
  the touched source paths (the templates, the PreToolUse hook, the
  understanding-before-execution pack module) for a line-number-anchored
  citation into the changed regions: none of the found citations point
  into content this change actually touched. Two pre-existing
  line-number citations into files this change also edits were found
  already stale before this change (confirmed against the pre-change
  commit) and are out of this task's scope; left as-is and flagged
  separately. `understanding-gate-auto-mode-signals.md`'s "What harness
  reads today" section listed exactly one call site consulting
  `permission_mode` in the PreToolUse hook; this change adds a second,
  non-gating read at the same call site, so that bullet now names the
  new observation write and its source file, and the doc's own
  `timestamp:` and `sources:` were updated to match. `npx okf-kit@0.8.0
  check docs/okf` was run against this worktree both before and after
  that edit: zero errors both times, plus a pre-existing set of
  sources-fresh / citations-resolve warnings unrelated to this change
  (several other docs under this directory already carried staleness
  against unrelated prior commits before this task started; those were
  left as-is, since bumping a doc's timestamp while it still carries
  unrelated staleness would overstate its freshness).
- 2026-08-27T17:54:07Z, understanding-gate auto-approval, slice 1 code half
  (agent-tasks `74b4b17d`): the PreToolUse hook gained the opt-in
  `auto_approve` path at the end of its decision order
  (`src/cli/pack/auto-approve-path.ts`). Five docs updated for it rather
  than only re-stamped: `understanding-gate-auto-mode-signals.md` ("What
  harness reads today" now names the one gate site that reads
  `permission_mode`), `evidence-ledger-trust-boundary.md` (the marker has
  a second, opt-in writer; what "operator-only" means now),
  `gate-fail-posture-matrix.md` (the auto path is a fail-closed last
  branch, the infrastructure fail-open contract is untouched),
  `understanding-gate-lockout-recovery.md` (what a persisting lockout
  means under auto mode), `codex-adapter-parity-gaps.md` (new gap 13: the
  auto path is Claude-only until slice 2).
- 2026-08-27T17:32:41Z, interactive and subagent captures for the auto-mode
  signal doc (agent-tasks `74b4b17d`, ADR slice 1 acceptance criteria 8
  and 9 plus the subagent assumption): three probes added to
  `dogfood/ug-auto-mode-signals/` (`interactive-capture.sh`,
  `interactive-ask-probe.sh`, `subagent-capture.sh`, sharing
  `interactive-lib.sh`), each n=2 with redacted fixtures, and three
  matching "Measured" sections in
  `understanding-gate-auto-mode-signals.md`. Results: the interactive
  `PreToolUse` payload carries the same `permission_mode` value as the
  headless one and the hook env's session id agrees with the payload's,
  2/2; a hook `permissionDecision: "ask"` under an interactive
  `bypassPermissions` session surfaces a real operator prompt that does
  not auto-resolve, 2/2 (a denial headlessly, an operator prompt
  interactively, an auto-allow in neither, so the ADR's conditional
  `deny` hardening has no measured case to fire on for this mode); a
  subagent's own tool call reaches the same hook on the parent's session
  id with extra `agent_id` / `agent_type`, and its transcript entries sit
  in a separate agent transcript file rather than as sidechain entries of
  the payload's transcript, 2/2. Five entries left the "Unverified / not
  measured" list; four narrower ones replaced them (pinned-session-id
  launch, interactive mode switching, other subagent types and nesting,
  the onboarding seed the interactive probes need). Re-stamped; the doc's
  numbers live there and in the dogfood README, not in the ADR.

- 2026-08-27T14:06:24Z, understanding-gate auto-mode signal sources
  (agent-tasks `f6be48cf`): new overview doc
  `understanding-gate-auto-mode-signals.md`, backed by a new dogfood
  fixture directory `dogfood/ug-auto-mode-signals/` (24 redacted
  `claude -p` hook-payload captures across 4 permission modes x 6 events,
  a hook-process env probe, a transcript-visibility probe with negative
  controls, a hook-`ask` resolution probe, and a block-and-retry probe
  with an independent re-run).
  Measures what signals exist for detecting an agent's own
  permission/auto-approval mode in Claude Code (doc-only for Codex and
  opencode), and classifies each by trust. The rule and decision on which
  signals may relax the understanding gate live in the companion ADR
  `docs/decisions/2026-08-27-ug-auto-mode-approval.md`, not in this doc.

- 2026-08-17T19:29:55Z, review fix-round doc-repointing (agent-tasks
  348a4d42, structural concentration slice 2): 13 citations across 4 docs
  (evidence-ledger-trust-boundary, codex-adapter-parity-gaps,
  understanding-gate-lockout-recovery, gate-fail-posture-matrix) plus 3
  citations in docs/policy-packs/understanding-before-execution.md still
  named `understanding-before-execution-runtime.ts` as the implementation
  site after that file became a 9-line re-export shim over 7 concern
  siblings under `understanding-before-execution/`. Repointed each
  citation to the sibling that actually defines the cited symbol
  (`checkApprovalMarker`/`writeApprovalMarker` -> `markers.ts`;
  `matchLedgerEntries`/`isPolicyDecisionRow` -> `ledger.ts`;
  `checkOperatorApprovalMarkers` -> `task-markers.ts`, dropping its
  stale `~line 1005` anchor; `matchPostToolUseBoundary` /
  `applyPostToolUseExpiry` / `describePostToolUseExpiry` ->
  `post-tool-use-boundary.ts`); the 3 OKF `sources:` entries pointing at
  the shim were replaced with the sibling paths the doc body actually
  cites. CHANGELOG.md's own historical references to the pre-split
  monolith were deliberately left as-is. Content re-verified only for
  the touched paragraphs (not a full claim-by-claim sweep of these 4
  docs); re-stamped.
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

## 2026-08-30 re-stamp after task 8f637efd review round 4

- `understanding-gate-auto-mode-signals.md`: re-verified against
  `permission-mode-observations.ts` after round 4 exported the display
  sanitiser and applied it to `observedAt` as well; the doc's claims about
  what the hook reads and writes are unchanged, so this is a timestamp-only
  re-stamp. Verdict: `npx -y okf-kit@0.8.0 check docs/okf` shows no
  sources-fresh finding on this doc afterwards.
- `evidence-ledger-trust-boundary.md`, `pause-vs-gate-kill-switch.md`: both
  list `CHANGELOG.md` as a source; round 4 appended one bullet to the task
  `8f637efd` entry there, which neither doc describes. Re-read the
  CHANGELOG-citing passages of both docs, no change needed, timestamp-only
  re-stamp.

  Round-3 note (verification review): the round-2 rewording of the
  manifest-validation-scope "ways to block as new" enumeration had invented
  a fourth route (an add being the auto_approve pack config), impossible
  because no supported add mutation touches manifest.policy_packs; reworded
  to state the demote-to-warning reality with the mutate-union citation.
  Two range attributions tightened (newErrors versus the throw site in
  src/cli/add/index.ts; the risk-gate sentence spans two lines).
