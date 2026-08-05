---
type: overview
title: Gate fail-posture matrix
description: Which harness enforcement gates fail OPEN vs fail CLOSED when their evidence source (grounding-mcp ledger, approval markers, verdict files, probes) is unreachable or errors, with the exact code paths and override knobs.
tags: [gates, fail-open, fail-closed, enforcement]
timestamp: 2026-08-05T15:21:47Z
sources:
  - docs/risk-gate.md
  - docs/policy-packs/branch-protection.md
  - docs/policy-packs/solution-acceptance.md
  - docs/policy-packs/understanding-before-execution.md
  - docs/runtime-reality-hook.md
  - src/runtime/intercept.ts
  - src/runtime/command-normalize.ts
  - src/cli/policy/intercept.ts
  - src/cli/pack/hook-pre-tool-use.ts
  - src/cli/pack/hook-branch-protection.ts
  - src/cli/pack/hook-solution-acceptance.ts
  - src/cli/pack/hook-runtime-reality.ts
  - CHANGELOG.md
---

# Gate fail-posture matrix

Every harness enforcement gate has a deliberate posture for the moment its evidence source cannot answer. The split is intentional and documented per gate: gates whose whole purpose is preventing a specific irreversible incident fail CLOSED (branch-protection, solution-acceptance); gates that add advisory or approval friction fail OPEN so a bug or a missing dependency never bricks the session (policy engine / risk gate, understanding gate, runtime-reality). One universal fail-open overrides all of them: the operator pause sentinel (`harness pause`) makes every hook below allow without evaluating (`checkHookPause` branches in each hook; e.g. `src/cli/pack/hook-branch-protection.ts` "harness paused; branch-protection allowing without evaluating").

| Gate | Runtime entry | Evidence source | Posture on source failure | Degraded outcome |
|---|---|---|---|---|
| Policy engine / Risk Gate | `harness policy intercept` → `intercept()` in `src/runtime/intercept.ts` | grounding-mcp evidence ledger | fail **OPEN** | `warn-degraded` outcome; never blocks |
| `bash_match` normalised-form matching (both passes) | `harness policy intercept` → `normalizeCommand` / `normalizeCommandAmpAware` in `src/runtime/command-normalize.ts` | command length vs `MAX_NORMALIZE_LENGTH` (100,000 chars) | fail **OPEN** above the bound | normalised-form matching skipped for BOTH the primary and the ampersand-aware second pass (task `aabbad63`) — they share the identical bound on the identical input command, so one stderr line covers both; raw match only. Previously silent, no stderr line, no audit row (G4 fix, review round 2, 2026-07-27) |
| Per-policy target attribution bound (`${REPO}`/`${BRANCH}`/`at_head`) | `harness policy intercept` → `resolveAttributedContexts` in `src/runtime/intercept.ts` | segment-derived repository targets (a filesystem `.git`-shape check, no evidence source of its own) | fail **CLOSED** above 4 distinct targets (`MAX_ATTRIBUTED_CONTEXTS`) | one synthetic decision naming the ambiguity, mapped through the policy's OWN `enforcement:` (`block` denies, `warn` warns, `require_approval` requires approval — never a hardcoded outcome); ZERO ledger queries for that policy |
| understanding-before-execution | `harness pack hook pre-tool-use` (`src/cli/pack/hook-pre-tool-use.ts`) | approval marker + persisted JSON report; ledger is audit-only | fail **OPEN** on load/parse/ledger/report-scan errors | allow, exit 0, stderr diagnostic |
| branch-protection | `harness pack hook branch-protection` (`src/cli/pack/hook-branch-protection.ts`) | `branch:non-protected:<branch>` ledger tag (5-min window) + override marker | fail **CLOSED** on any load/parse/ledger error | block envelope |
| solution-acceptance | `harness pack hook solution-acceptance` (`src/cli/pack/hook-solution-acceptance.ts`) | HEAD-pinned verdict marker file written by grounding-mcp `solution_evaluate` | fail **CLOSED** (scoped to completion actions) | deny the completion verb |
| runtime-reality | `harness pack hook runtime-reality` (`src/cli/pack/hook-runtime-reality.ts`) | `RUNTIME_REALITY_PROBE_CMD` output vs expectations file | fail **OPEN** on every load/probe error | allow + stderr warning; flip with `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` |

## Policy engine / Risk Gate: fail open as `warn-degraded`

The generic PreToolUse policy pipeline (`evaluateOnePolicy` in `src/runtime/intercept.ts`) maps every could-not-decide condition to the `PolicyOutcome` value `"warn-degraded"`, which `isBlockingDecision` never treats as blocking (only `deny` with `enforcement: block` and `require_approval` abort). The degraded paths are enumerable in the source: unresolved template variables in `requires.ledger_tag`, a thrown or `kind: "degraded"` ledger query, an invalid `requires.within` duration, and a thrown `evaluateRequires`. When grounding-mcp is not declared in the manifest at all, the CLI wrapper substitutes `degradedLedgerClient("grounding-mcp not declared in manifest")` (`src/cli/policy/intercept.ts`), so every query degrades. `docs/risk-gate.md` ("Degraded mode") states the contract for `require_approval`/`deny` policies explicitly: with the ledger unreachable the decision degrades to a non-blocking `warn-degraded`, the tool call proceeds, and the un-evaluated policy is recorded; an operator who needs fail-closed must keep grounding-mcp healthy (`harness doctor` surfaces an unreachable ledger). Two hardening notes ride this contract: since v0.39.0 (CHANGELOG, task a2589fa3) one pooled grounding-mcp session per intercept invocation replaces two subprocess spawns per policy, closing the load-induced fail-open where the 30s hook budget timed out and Claude Code's conventional hook-timeout-is-allow silently disabled enforcement; and an audit-write failure (`ledger.record()` throw) is surfaced to stderr but never blocks — the decision is still applied (`intercept()` catch block, task 6b8e53cc).

## understanding-before-execution: fail open, but the ledger was never the decision input

The header contract in `src/cli/pack/hook-pre-tool-use.ts` (lines 17–22): "any error in load / parse / ledger / report scan resolves to ALLOW (exit 0, silent). The Understanding Gate is opt-in; turning a bug in this code into a session-wide tool block would be hostile." Concretely allowing: malformed stdin JSON, manifest load failure, pack not declared or `enabled: false`, and an unresolvable session id — each with a stderr diagnostic. Important nuance: a degraded grounding-mcp does NOT open this gate, because since the marker-canonical redesign the ledger probe is audit-only ("The result intentionally does NOT influence the allow/block decision", `checkLedger` call site). The decision rests on two operator-authored filesystem sources — the approval marker `harness.generated/.approvals/<sessionId>` (`checkOperatorApprovalMarkers`) and the persisted report under `.understanding-gate/reports/` (`checkPersistedReport`) — so with grounding-mcp down an unapproved session still blocks and an approved one still passes. Inside the gate two sub-decisions fail CLOSED: an unclassifiable Bash command falls through to block (`isReadOnlyBashPipeline` miss), and a malformed sessionId in the marker path check fails closed (`src/policy-packs/builtin/understanding-before-execution-runtime.ts`, "a malformed sessionId must fail CLOSED"); symlinked and forged/unsigned markers are refused (`checkApprovalMarker`, harness/f9485cc7). One narrow allow-on-uncertainty carve-out (task 6e888423): when the marker is specifically `expired` (a real prior approval existed and aged past `approval_lifecycle.max_age`, as opposed to never approved or cleared by a task boundary) AND the Bash command is a bare, unchained `git commit` (`isRecoveryGitCommit`), the blocker allows it through so already-approved work can be committed without re-triggering a full Understanding Report cycle; every other Bash shape and all Edit/Write stay hard-gated.

## branch-protection: fail closed, the explicit inverse

`docs/policy-packs/branch-protection.md` ("Failure mode", lines 47–55): the blocker fails **closed**; any error in load / parse / ledger query forces a block, "the inverse of `understanding-before-execution`'s fail-open contract", because a bug that silently allowed Writes through would defeat the pack's entire purpose (preventing edit-on-master). The source enforces this at each step (`src/cli/pack/hook-branch-protection.ts`): empty or malformed stdin resolves to BLOCK ("we'd rather block a Write we couldn't classify"), a manifest load failure blocks with reason `manifest load failed (...); refusing on failsafe`, and a degraded ledger (`grounding-mcp not declared in manifest`, query error) leaves the satisfying `branch:non-protected` tag unfound, which blocks. The only allow-on-uncertainty carve-outs are deliberate: a pack not declared or `enabled: false` allows (the hook was wired without `harness apply`), and a detached HEAD / non-git cwd allows at the blocker (blocking every Write in non-git workspaces would be hostile; `preflight-before-push` catches the push). Escape: the operator-only marker `harness.generated/.approvals/branch-protection-<sessionId>` via `harness approve branch-protection`; a self-written `branch-protection-ack:` ledger tag no longer opens the gate (audit finding #39).

## solution-acceptance: fail closed, scoped to completion actions

Header contract in `src/cli/pack/hook-solution-acceptance.ts` (lines 19–22): any error in load / parse / HEAD-resolution / verdict-read resolves to BLOCK ("branch-protection's fail-closed posture, not understanding-gate's fail-open"). `docs/policy-packs/solution-acceptance.md` (lines 56–60) enumerates the deny set: missing verdict, not-ready verdict, HEAD drift (`ready && head === current HEAD` is the whole decision), unresolvable HEAD, and no-claim/no-id; a malformed `SOLUTION_VERDICT_ID` env value also fails closed, and a sessionId fallback is intentionally absent. The blast radius is bounded: on manifest load failure the hook blocks only when the tool is a completion action per the DEFAULT verb set (`task_finish`, `task_submit_pr`, `task_merge`, `pull_requests_merge`, Bash `git push` / `gh pr merge`); non-completion tools still allow ("manifest load failed (...) but <tool> is not a completion action; allowing"). The pack is a pure consumer that reads the verdict marker file directly and has no runtime dependency on grounding-mcp, so "grounding-mcp unreachable" here means the producer can never write a verdict: the gate becomes a permanent deny that looks protective. Both deadlock misconfigurations (grounding-mcp absent from `tools.mcp` = hard error; relative `SOLUTION_VERDICT_DIR` = warning) are surfaced by `harness validate` and `harness doctor` via `checkSolutionAcceptanceProducer` (`src/cli/validate/checks.ts`, per the pack doc).

## runtime-reality: fail open, with an opt-in fail-closed knob

`docs/runtime-reality-hook.md` (line 14): "Every load or probe error degrades to allow: a misconfigured probe never tarpits the session. The only deny path is a probe that actually produced state showing critical drift." The source (`src/cli/pack/hook-runtime-reality.ts`) mirrors this: stdin read failure, hook construction failure, unset `RUNTIME_REALITY_KEYWORD` (no baseline), and unset `RUNTIME_REALITY_PROBE_CMD` (nothing to compare) all resolve via `allowResult(...)`; a thrown/hung probe (10s subprocess timeout) is treated as "probe failed" under the same fail-open policy. Operators can invert per tier (env toggles documented in `docs/runtime-reality-hook.md`'s reference table; the escalation logic lives in the external `@lannguyensi/runtime-reality-checker` package, not in the hook file): `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` denies on probe failure, `RUNTIME_REALITY_WARN_AS_BLOCK=1` escalates warnings, `RUNTIME_REALITY_CRITICAL_AS_WARN=1` degrades critical drift to allow, `RUNTIME_REALITY_DISABLE=1` short-circuits entirely. This fail-open default is why `harness init --template full` ships the hook entry commented out: an active entry without the three env values "would degrade to a silent allow (a no-op that looks like protection)".

## `bash_match` normalised-form matching: fail open above a size bound, now loud

Above `MAX_NORMALIZE_LENGTH` (100,000 characters), `normalizeCommand` (`src/runtime/command-normalize.ts`) skips normalisation entirely and returns the command unchanged — a defensive bound so command SIZE alone can never drive `harness policy intercept` past a hook's own timeout budget (`require-preflight-evidence` declares `budget_ms: 1000`). The RAW command is still tested by `policyMatchesEvent` regardless (raw-OR-normalised construction), so this only loses the ADDITIONAL normalised-form coverage — wrapper-peeled or git-global-option-collapsed spellings a `bash_match` regex would otherwise also have matched — never the baseline raw match. Until review round 2 (G4 finding, 2026-07-27) this skip was completely silent: no stderr line, no audit row, discoverable only by reading the source. `NormalizedCommand` now carries a `truncated: boolean` field, and `runInterceptCli` (`src/cli/policy/intercept.ts`) writes exactly one stderr line reporting the skip whenever it is `true`, keeping the normaliser module itself pure and I/O-free while making the fail-open loud at the one place that already owns a stderr stream for the event. The ampersand-aware SECOND pass added by task `aabbad63` (`normalizeCommandAmpAware`, same file) carries the IDENTICAL fail-open posture over the IDENTICAL bound — it is only ever invoked with the same Bash command `normalizeCommand` was, so its own `truncated` flag can never disagree with the primary pass's for the one production caller (`runInterceptCli`), and the one stderr line above already reports the skip for both passes at once; there is no separate stderr line naming the amp pass's own skip, nor does one need to exist while the two passes share both the bound and the input.

## Per-policy target attribution: additive fallback, never a new fail-open

(task `98ad072f`) Any policy whose `requires.ledger_tag` references
`${REPO}`/`${BRANCH}` or sets `at_head: true` is evaluated once per
DISTINCT repository a trigger-satisfying command segment names (its own
`-C`/`env -C`/`--git-dir`, or a target inherited from a genuinely
persisting `cd`) — the session's own cwd context is ALWAYS also
evaluated, never dropped (`resolveAttributedContexts`; the "always add, never replace" rule
D-021 and its four-review-pass history are restated in-tree at
`src/runtime/command-normalize.ts:507-576` — the original decision
record under `.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/` is
local run state and not shipped with the repo). This section covers only the FALLBACK side of that resolution,
since it is the part that changes this matrix's own fail-posture story:

- **A composition the module cannot resolve to a single, unambiguous
  target (`--work-tree` alone, more than one repo-relocating option, a
  relative target after a preceding `cd`, a `~`/quoted/substitution
  value) falls back to the cwd context ALONE — never fail-open, never a
  new gap.** This is identical to the cwd-only resolution every such
  policy had before this task; the fallback is a PRECISION concern (does
  the demand correctly name the touched repo), not a safety one, because
  the cwd demand is never dropped regardless of how the fallback
  resolves.
- **More than `MAX_ATTRIBUTED_CONTEXTS` (4) distinct targets for one
  policy on one event fails CLOSED** — see the new table row above. This
  is the one place per-policy attribution ADDS a fail-closed posture the
  plain per-event resolution never needed (an event with only ever one
  context to evaluate could not exceed a bound on the count of contexts).
- **What is unchanged:** every OTHER fail-posture row in this matrix
  (ledger degradation → `warn-degraded`, audit-write failure →
  stderr-only, `MAX_NORMALIZE_LENGTH` truncation → loud fail-open)
  applies IDENTICALLY to each attributed context independently —
  attribution introduces no new evidence source and no new degraded-mode
  path, it only multiplies how many times the existing per-policy
  evaluation in `evaluateOnePolicy` runs for one event.

## Cross-cutting rules

Two invariants hold across all gates. First, audit degradation never blocks: `LedgerClient.record` implementations "MUST be best-effort" (`src/runtime/intercept.ts` interface doc), and a record throw is written to stderr while the gate decision stands. Second, fail-open is always loud: every allow-on-error path in every hook emits a stderr diagnostic, because "a silently-allowing gate manufactures false confidence, which is the worst direction for a governance hook to fail in" (`src/cli/pack/hook-pre-tool-use.ts`). The one asymmetric fail-closed inside an otherwise fail-open surface is the risk gate's `when:` classifier: an unclassified action matches classification-severity clauses via the "unknown is not safe" rule (`whenUnclassifiedFallback` in `src/runtime/intercept.ts`), so an unknown command can be denied even while ledger degradation on the same event would have been fail-open.
