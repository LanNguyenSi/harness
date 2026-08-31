# Log

<!-- Add new entries at the top, newest first. -->

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
  re-stamped here; the other three that would also match
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
  `understanding-gate-lockout-recovery.md` (`hook-pre-tool-use.ts:771`
  anchor, `hook-codex-pre-tool-use.ts:358` closing-brace start line) and
  on `pause-vs-gate-kill-switch.md` (`docs/for-humans.md:394-395` blank
  start line) is unrelated to this task's changes and left as-is, same as
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
  `hook-pre-tool-use.ts:771#"writePendingApproval(...)"` anchor already
  missed its target there, and `pause-vs-gate-kill-switch.md`'s
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
