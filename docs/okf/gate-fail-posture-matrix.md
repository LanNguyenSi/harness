---
type: overview
title: Gate fail-posture matrix
description: Which harness enforcement gates fail OPEN vs fail CLOSED when their evidence source (grounding-mcp ledger, approval markers, verdict files, probes) is unreachable or errors, with the exact code paths and override knobs.
tags: [gates, fail-open, fail-closed, enforcement]
timestamp: 2026-10-07T08:18:20Z
sources:
  - src/cli/pack/auto-approve-path.ts
  - src/io/atomic-write.ts
  - src/cli/pack/hook-codex-pre-tool-use.ts
  - docs/risk-gate.md
  - src/schema/risk.ts
  - docs/policy-packs/branch-protection.md
  - docs/policy-packs/solution-acceptance.md
  - docs/policy-packs/understanding-before-execution.md
  - docs/runtime-reality-hook.md
  - src/runtime/intercept.ts
  - src/runtime/command-normalize.ts
  - src/runtime/shell-command-model.ts
  - src/runtime/shell-model-paths.ts
  - src/cli/policy/intercept.ts
  - src/cli/pack/hook-pre-tool-use.ts
  - src/cli/pack/hook-branch-protection.ts
  - src/cli/pack/hook-solution-acceptance.ts
  - src/runtime/task-providers/agent-tasks.ts
  - src/cli/pack/hook-runtime-reality.ts
  - src/cli/pack/hook-bootstrap.ts
  - src/cli/bounded-stdin.ts
  - src/cli/pack/hook-solution-acceptance-writeguard.ts
  - src/cli/pack/hook-post-merge-gate.ts
  - src/policy-packs/builtin/understanding-before-execution/inflight-records.ts
---

# Gate fail-posture matrix

Every harness enforcement gate has a deliberate posture for the moment its evidence source cannot answer. The split is intentional and documented per gate: gates whose whole purpose is preventing a specific irreversible incident fail CLOSED (branch-protection, solution-acceptance, and — since task f1aea826 — the policy engine's own block/require_approval tier); gates that add advisory or approval friction fail OPEN so a bug or a missing dependency never bricks the session (the policy engine's warn tier, understanding gate, runtime-reality). Inside the policy engine the split runs along `enforcement:` itself, with an explicit manifest opt-out (`risk.degraded_fail_posture: fail_open`) restoring the pre-0.45 availability-first mapping. One universal fail-open overrides all of them: the operator pause sentinel (`harness pause`) makes every hook below allow without evaluating (`checkHookPause` branches in each hook; e.g. `src/cli/pack/hook-branch-protection.ts` "harness paused; branch-protection allowing without evaluating").

| Gate | Runtime entry | Evidence source | Posture on source failure | Degraded outcome |
|---|---|---|---|---|
| Policy engine / Risk Gate | `harness policy intercept` → `intercept()` in `src/runtime/intercept.ts` | grounding-mcp evidence ledger | fail **CLOSED** for `block`/`require_approval`, fail **OPEN** for `warn` (task f1aea826; opt-out `risk.degraded_fail_posture: fail_open` restores fail-open for every tier) | `deny-degraded` blocks with a degraded-specific envelope for `block`/`require_approval`; `warn-degraded` never blocks for `warn` |
| `bash_match` normalised-form matching (both passes) | `harness policy intercept` → `normalizeCommand` / `normalizeCommandAmpAware` in `src/runtime/command-normalize.ts` | command length vs `MAX_NORMALIZE_LENGTH` (100,000 chars) | fail **OPEN** above the bound | normalised-form matching skipped for BOTH the primary and the ampersand-aware second pass (task `aabbad63`) — they share the identical bound on the identical input command, so one stderr line covers both; raw match only. Previously silent, no stderr line, no audit row (G4 fix, review round 2, 2026-07-27) |
| Per-policy target attribution bound (`${REPO}`/`${BRANCH}`/`at_head`) | `harness policy intercept` → `resolveAttributedContexts` in `src/runtime/intercept.ts` | segment-derived repository targets (a filesystem `.git`-shape check, no evidence source of its own) | fail **CLOSED** above 4 distinct targets (`MAX_ATTRIBUTED_CONTEXTS`) | one synthetic decision naming the ambiguity, mapped through the policy's OWN `enforcement:` (`block` denies, `warn` warns, `require_approval` requires approval — never a hardcoded outcome); ZERO ledger queries for that policy |
| Quote-aware shell command model (`${REPO}`/`${BRANCH}`/`at_head` policies) | `harness policy intercept` → `resolveAttributedContexts` in `src/runtime/intercept.ts`, model in `src/runtime/shell-command-model.ts` | the command text (no evidence source of its own) | fail **CLOSED** on an opaque possibility (a target it refuses to read, a glob, an in-command `CDPATH` search, a relative step after an opaque directory, a loop that moves relatively, more than 8 possibilities, a composed path over 4096 characters), on model paths that need more than the per-event filesystem work budget (`MAX_MODEL_PATH_WORK`, `src/runtime/shell-model-paths.ts`), and on a command it cannot lex or longer than `MAX_NORMALIZE_LENGTH` when the text holds a directory-changing word; otherwise it only adds demands to the segment view's, which are computed first (task `7d4abf84`) | the same `opaque-target` decision as the row above's shape: one synthetic decision through the policy's OWN `enforcement:`, ZERO ledger queries |
| Empty `${REPO}`/`${BRANCH}` in a `ledger_tag` | `harness policy intercept` → `evaluateOnePolicy` in `src/runtime/intercept.ts` | none queried: the value resolved for the context (cwd outside every repo, detached HEAD, empty override) | decided per the policy's OWN `enforcement:` (never fail-open to a blank tag) | `deny` / `require_approval` / `warn` with a reason naming `cd <repo>` / `git -C <repo>` or `git switch <branch>`; ZERO ledger queries; NOT `deny-degraded` (task `6c8ebd37`) |
| understanding-before-execution | `harness pack hook pre-tool-use` (`src/cli/pack/hook-pre-tool-use.ts`) | HMAC-signed approval marker (sole authority); persisted JSON report and ledger are audit-only | fail **OPEN** on load/parse/ledger/report-scan errors | allow, exit 0, stderr diagnostic |
| branch-protection | `harness pack hook branch-protection` (`src/cli/pack/hook-branch-protection.ts`) | `branch:non-protected:<branch>` ledger tag (5-min window) + override marker | fail **CLOSED** on any load/parse/ledger error | block envelope |
| solution-acceptance | `harness pack hook solution-acceptance` (`src/cli/pack/hook-solution-acceptance.ts`) | HEAD-pinned verdict marker file written by grounding-mcp `solution_evaluate` | fail **CLOSED** (scoped to completion actions) | deny the completion verb |
| runtime-reality | `harness pack hook runtime-reality` (`src/cli/pack/hook-runtime-reality.ts`) | `RUNTIME_REALITY_PROBE_CMD` output vs expectations file | fail **OPEN** on every load/probe error | allow + stderr warning; flip with `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` |

## Policy engine / Risk Gate: fail posture derived from `enforcement:` (task f1aea826)

The generic PreToolUse policy pipeline (`evaluateOnePolicy` in `src/runtime/intercept.ts`) routes every could-not-decide condition through `degradedOutcome`, which derives the fail posture from the policy's own `enforcement:` tier: `warn` maps to the non-blocking `warn-degraded` (unchanged availability-first behaviour), while `block` and `require_approval` map to the blocking `deny-degraded` — `isBlockingDecision` treats `deny-degraded` as aborting unconditionally, since it is only ever produced for those two tiers. The degraded paths are enumerable in the source and all share the same routing: unresolved template variables in `requires.ledger_tag`, a thrown or `kind: "degraded"` ledger query (including the timeout latch the 2026-08-06 audit measured flipping a `git push` deny to ALLOW at 1-100ms budgets), an invalid `requires.within` duration, a thrown `evaluateRequires`, and the defensive schema-invariant branch. When grounding-mcp is not declared in the manifest at all, the CLI wrapper substitutes `degradedLedgerClient("grounding-mcp not declared in manifest")` (`src/cli/policy/intercept.ts`), so every query degrades — under the new posture a manifest that declares block-tier policies but no grounding-mcp now denies loudly instead of silently no-opping. The `deny-degraded` envelope deliberately bypasses the policy's `ux:` surface and names the degraded cause (bounded and control-stripped, since it embeds subprocess output) plus an operator-facing recovery path, so nobody debugs a phantom missing tag — and it deliberately OMITS the opt-out: that text is fed back to the blocked agent, and a deny that includes its own disable recipe is not a gate. The manifest opt-out `risk.degraded_fail_posture: fail_open` (schema default `preserve_enforcement`, `src/schema/risk.ts`) restores the pre-0.45 mapping for every tier and is named only on operator surfaces: the verbose stderr diagnostic, docs/risk-gate.md, and this matrix. A default-verbosity surface exists too: one stderr hint line per degraded-denied event at DEFAULT verbosity (suppressed under `HARNESS_POLICY_VERBOSE`, where the full diagnostic supersedes it), carrying the decision's own (sanitised) reason and pointing at `harness doctor`, docs/risk-gate.md and the verbose diagnostic — deliberately WITHOUT the opt-out literal, because hook stderr can be surfaced to the model in some harness configurations. Hardening notes that ride this contract: since v0.39.0 (task a2589fa3, `CHANGELOG.md:#0.39.0`) one pooled grounding-mcp session per intercept invocation replaces two subprocess spawns per policy, closing the load-induced fail-open where the hook budget timed out; the pooled session's timeout LATCH previously guaranteed a degraded deny lost its own audit row (every post-timeout call on the session short-circuits), so `realLedgerClient.record` now retries at most once per invocation, RESERVED for `deny-degraded` rows, over a fresh session whose own per-call budget is max(250ms, timeoutMs/4) — worst-case added stall is 2x that per-call budget (initialize + ledger_add), i.e. <=timeoutMs/2 for timeouts >=1s, dominated by the 250ms floor below that; and an audit-write failure that survives the retry is surfaced to stderr but never blocks — the decision is still applied. The OUTER hook-budget layer stays fail-open by harness contract (a hook exceeding `budget_ms` is allow) and is not reachable from this schema; hook budgets must stay comfortably above the ledger timeout for the fail-closed decision to be delivered at all. This is doubly load-bearing on the Claude Code projection, where `apply` emits the budget into settings.json's `timeout` field which is in SECONDS: task 7bf47554 fixed a prior 1:1 ms-into-seconds projection (a 1000x inflation that had accidentally kept the outer timer at thousands of seconds) and, in the same change, raised every blocking ledger-consulting `harness policy intercept` hook across all shipped manifest surfaces (FULL and TEAM templates, the interactive Custom composer, the full-manifest fixture, and the branch-protection / understanding-before-execution / post-merge-gate packs) to `budget_ms: 15000`, a 15s outer timeout that clears the ~13.75s ledger round-trip worst case with margin, so the `deny-degraded` decision lands before Claude Code cancels the hook. `tests/runtime/hook-budget-ledger-margin.test.ts` pins this invariant (a hard 15000ms floor plus the ledger-timeout+retry margin) across every manifest surface; the durable mechanical enforcement is follow-up d20a7e0c (a validate/doctor consistency check). The trade-off is deliberate and f1aea826-consistent: on a down or hanging ledger a gated action now freezes up to ~15s and then denies, rather than allowing. Two wrapper-level fail-opens also sit outside the enumerable degraded family: malformed event JSON and a failed manifest load both resolve to allow-with-stderr in `runInterceptCli`, so the engine's posture is only as fail-closed as manifest integrity.

## understanding-before-execution: fail open, but the ledger was never the decision input

The header contract in `src/cli/pack/hook-pre-tool-use.ts` (lines 17-20): "any error in load / parse / ledger / report scan resolves to ALLOW (exit 0, silent). The Understanding Gate is opt-in; turning a bug in this code into a session-wide tool block would be hostile." Concretely allowing: malformed stdin JSON, manifest load failure, pack not declared or `enabled: false`, and an unresolvable session id, each with a stderr diagnostic. Important nuance: a degraded grounding-mcp does NOT open this gate, because since the marker-canonical redesign the ledger probe is audit-only ("The result intentionally does NOT influence the allow/block decision", `checkLedger` call site). The decision rests on one operator-authored, HMAC-signed filesystem source, the approval marker `harness.generated/.approvals/<sessionId>` or `task-<taskId>` (`checkOperatorApprovalMarkers`); the persisted report under `.understanding-gate/reports/` (`checkPersistedReport`, returning `PersistedReportEvidence` since task 7402301d) only feeds the block diagnostic and never grants approval, so with grounding-mcp down an unapproved session still blocks and an approved one still passes, and an approved-looking report with no valid marker behind it blocks with the distinct `unsigned persisted-report approval rejected` reason. One narrow fail-CLOSED branch sits beside that (task `fa423e9b`): after a marker matched, both hooks (`verifyMatchedMarkerReport`, which applies `verifyApprovedReportHash` to the task marker and falls back to the session marker) refuse a marker that carries a non-null `reportContentHash` when no parseable report file in the reports directory (any session, any `approvalStatus`) has that canonical hash, which includes the case that the approved report was rewritten as unparseable JSON while report files remain, and a file nested too deeply to hash, a file over the 1 MiB size cap (`MAX_HASHED_REPORT_BYTES`) and a `*.json` entry that is not a regular file (a FIFO, a directory, a device) count as report files that match nothing (the read is bounded by type and size, opened non-blocking and typed by `fstat` on the open descriptor, `readReportFileBounded` in `persisted-reports.ts`, so such a file cannot crash, exhaust or stall the hash scan into the runtime's non-blocking-error path; the hash scan's volume of planted entries is bounded by a 32 MiB budget (`MAX_HASH_SCAN_BYTES`, newest report first) in which every `*.json` entry is charged its bytes read or at least 4 KiB (`MIN_SCAN_ENTRY_COST_BYTES`), whatever the read returned, so at most 8192 entries are opened and about 32 MiB read (the last file read may add up to the 1 MiB per-file cap); past it the check denies with the mismatch reason, fail closed, so an approved report behind that much newer report data denies until re-approval writes a newer report, which recovers only when the newer entries are real reports (planted names that sort after the timestamped report names keep denying until removed). The scan lists the directory through the same early-stopping listing as the readers below, so past 8192 `*.json` entries, or 16384 entries of any name, it opens nothing and denies with a reason that names the bound and the remedy, fail closed, even when the approved report is among those entries; the listing no longer does a whole-directory `readdir` and name sort. The other full-directory reads on the hook path (the evidence read that follows a refused marker or runs on the no-marker path, the auto-approval precondition listing, the subagent-delegation lookup and the parse-error log lookup) list the directory entry by entry and stop once more than `MAX_HOOK_LISTING_ENTRIES` (8192) matching entries, or more than 16384 entries of any name, have been seen, and charge every entry they read against the same 32 MiB budget and 4 KiB floor (each reader its own budget, from the descriptor's size before the read); past either bound the reader fails closed (no evidence, the auto-approval declines, no delegation capture, no parse error), never an allow, and the block text names the remedy (remove non-report or stale `*.json` entries from the directory by hand; `harness gc` removes only aged approved or expired reports), so planted entries, many or large, no longer take the hook past the 15 s PreToolUse budget in the cases measured (the CHANGELOG records the measurements and the residuals: the hash scan lists through the same early-stopping listing, the in-flight record check on a Claude Code subagent call looks up its one entry directly instead of listing `.inflight/<session>/`, and the grounding ledger query shares the 15 s budget, the one read left uncharged); the PostToolUse boundary expiry is not on that path and lists without an entry bound; every other read of the reports directory or of `parse-errors/` that a PreToolUse hook makes goes through the same reader, so a planted FIFO, a symlink to one or a file over the cap is skipped there too and cannot stall or kill the hook: the evidence read both hooks reach on the no-marker path and after a refused marker (`listPersistedReportsBoundedWithSkips` with the entry bound), the PostToolUse boundary expiry (`listPersistedReportsBounded`, the same reader without the entry bound; it acts on the newest report that was within the cap, so an oversized newest approved report is left as it is and the next in-cap one is expired), the auto-approval precondition and the subagent-delegation lookup (`listPersistedReportsBoundedWithSkips`; the auto path also declines when the listing had to skip an entry, so an oversized or unreadable newest report never lets it fall back to an older pending one) and the parse-error log lookup (`findLatestParseError`). The operator commands `harness approve understanding` and `harness gc` list the directory through the same bounded reader but do not skip: approve refuses (exit 1, naming each oversized, non-regular, symlinked or unreadable entry as an escaped literal, before any marker, ledger tag or report flip, and `--force` does not override it) and gc reports such an entry as unparseable and leaves it in place. The auto-approval consume step (`rewriteReportApproved`) rewrites the text the precondition read through the bounded reader instead of re-reading the path, and writes through a temp file renamed over the entry; that temp file is created by `atomicWriteFile` in `src/io/atomic-write.ts` under a random 64-bit suffix and opened with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, so a FIFO, symlink or regular file planted at the name it chose makes the write throw `EEXIST` at once (no hang, no write through the link, the planted entry kept) and the consume declines with the report left pending; the boundary expiry skips with a note and the marker writers report the failed write); a null-hash marker or a reports directory with no `*.json` entry at all changes nothing, and the read-only Bash exemption and the escape `ask` stay reachable. Inside the gate two sub-decisions fail CLOSED: an unclassifiable Bash command falls through to block (`isReadOnlyBashPipeline` miss), and a malformed sessionId in the marker path check fails closed (`src/policy-packs/builtin/understanding-before-execution/markers.ts`, "a malformed sessionId must fail CLOSED"); symlinked and forged/unsigned markers are refused (`checkApprovalMarker`, harness/f9485cc7). One narrow allow-on-uncertainty carve-out (task 6e888423): when the marker is specifically `expired` (a real prior approval existed and aged past `approval_lifecycle.max_age`, as opposed to never approved or cleared by a task boundary) AND the Bash command is a bare, unchained `git commit` (`isRecoveryGitCommit`), the blocker allows it through so already-approved work can be committed without re-triggering a full Understanding Report cycle; every other Bash shape and all Edit/Write stay hard-gated. When the marker check misses and the payload names a non-empty `agent_id`, the hook also consults a signed in-flight subagent record before falling through to the auto-approval attempt or the final block (task `496660c5`, `src/policy-packs/builtin/understanding-before-execution/inflight-records.ts`); a match allows the same way a marker match does (the `SubagentStart` hook mints a record only after the same report-hash cross-check passes, so an approval refused at gate read leaves no record behind, task `dac02d5c`), and a forged or tampered record is declined with its own distinct diagnostic and, folded together with a forged operator marker, also suppresses the auto-approval attempt below. Since agent-tasks/74b4b17d one more branch sits between the escape `ask` and the final block: the auto-approval attempt (`src/cli/pack/auto-approve-path.ts`, ADR `docs/decisions/2026-08-27-ug-auto-mode-approval.md`), a schema-opt-in block that `harness init` now renders active by default in the FULL, SOLO, and TEAM templates since task `8f637efd` (an existing install keeps its prior config unless it runs the new `harness pack upgrade understanding-before-execution` verb). It fails CLOSED on every missing input (no `auto_approve` block, the hook's own harness not listed in `auto_approve.harnesses` (default: Claude Code only), `permission_mode` absent or not in `when`, a forged marker already detected at step 3, session-consistency failure (Claude Code: payload/hook-env session-id disagreement; Codex: a `transcript_path` that does not name an existing regular file carrying the payload session id), absent signing key, no strict-session `pending` report or one that fails the approve CLI's own validation, nests too deeply to hash its content or exceeds the 1 MiB size cap) and never allows by itself: on success it consumes the report, writes the signed session marker and re-runs the same marker check, whose match is the only allow. The infrastructure fail-open contract above is untouched; the auto path is reached only after those checks have passed.

## branch-protection: fail closed, the explicit inverse

`docs/policy-packs/branch-protection.md` ("Failure mode", lines 47–55): the blocker fails **closed**; any error in load / parse / ledger query forces a block, "the inverse of `understanding-before-execution`'s fail-open contract", because a bug that silently allowed Writes through would defeat the pack's entire purpose (preventing edit-on-master). The source enforces this at each step (`src/cli/pack/hook-branch-protection.ts`): empty or malformed stdin resolves to BLOCK ("we'd rather block a Write we couldn't classify"), a manifest load failure blocks with reason `manifest load failed (...); refusing on failsafe`, and a degraded ledger (`grounding-mcp not declared in manifest`, query error) leaves the satisfying `branch:non-protected` tag unfound, which blocks. The only allow-on-uncertainty carve-outs are deliberate: a pack not declared or `enabled: false` allows (the hook was wired without `harness apply`), and a detached HEAD / non-git cwd allows at the blocker (blocking every Write in non-git workspaces would be hostile; `preflight-before-push` catches the push). That carve-out does not cover a git file that is present but cannot be read as a regular file (a FIFO, a device, a directory or an oversized file where `HEAD` belongs, or a node that is neither a directory nor a regular file (or an oversized or unreadable pointer file) where `.git` itself belongs, which stops the upward walk at that directory instead of resolving an enclosing repository's branch; a `.git` entry that exists but does not resolve, a symlink that dangles or loops included, counts the same way (task b56d95d3, operator decision: it is part of this repository, the same call `mayBeInsideRepository` in `src/runtime/intercept.ts` makes); only a `.git` that is ABSENT is still walked past, so a nested work tree whose `.git` was removed resolves the enclosing repository, as git itself would; task 323bd5b9): `resolveGitContext` reports it in `refused`, and the blocker blocks with `could not read the git metadata ...` (`src/cli/pack/hook-branch-protection.ts:417#"gitContext.refused.length > 0) {"`) instead of reading "no branch" as safe. Every git file the context lookup needs is read through one bounded, non-blocking descriptor read, so a FIFO planted at `.git/refs/heads/<branch>` no longer holds the hook until its budget runs out (which the runtime treats as an allow), and a refused loose ref is not replaced by the older tip in `packed-refs` (`src/runtime/git-context.ts:256-257#"} else if (refused.length > refusedBefore) {"`). `post-merge-gate` keeps its own fail-open posture on an unresolvable context and only names the refused file in its stderr diagnostic (`src/cli/pack/hook-post-merge-gate.ts:331#"describeRefusedGitFiles(gitContext)"`); `solution-acceptance` sees sha `""` and denies as for any unresolvable HEAD. Escape: the operator-only marker `harness.generated/.approvals/branch-protection-<sessionId>` via `harness approve branch-protection`; a self-written `branch-protection-ack:` ledger tag no longer opens the gate (audit finding #39).

## solution-acceptance: fail closed, scoped to completion actions

Header contract in `src/cli/pack/hook-solution-acceptance.ts` (lines 19–22): any error in load / parse / HEAD-resolution / verdict-read resolves to BLOCK ("branch-protection's fail-closed posture, not understanding-gate's fail-open"). `docs/policy-packs/solution-acceptance.md` (lines 56–60) enumerates the deny set: missing verdict, not-ready verdict, HEAD drift (`ready && head === current HEAD` is the whole decision), unresolvable HEAD, and no-claim/no-id; a malformed `SOLUTION_VERDICT_ID` env value also fails closed, and a sessionId fallback is intentionally absent. An `active-claim` path that holds something unreadable (a FIFO, a directory, an oversized or malformed file, a symlink that does not resolve) is not "no claim" either: `readActiveClaim` returns `refused`, the hook blocks naming the file and never falls back to `SOLUTION_VERDICT_ID` (task b56d95d3). The blast radius is bounded: on manifest load failure the hook blocks only when the tool is a completion action per the default completion matchers: the provider adapter's MCP verb set (`task_finish`, `task_submit_pr`, `task_merge`, `pull_requests_merge`) and `DEFAULT_PUSH_BASH_RE` in `src/policy-packs/builtin/solution-acceptance-runtime.ts` for Bash `git push` / `gh pr merge`; non-completion tools still allow ("manifest load failed (...) but <tool> is not a completion action; allowing"). `src/runtime/task-providers/agent-tasks.ts` owns the MCP default and the canonical agent-tasks event match; the hook retains the fail-posture and verdict decisions. The pack is a pure consumer that reads the verdict marker file directly and has no runtime dependency on grounding-mcp, so "grounding-mcp unreachable" here means the producer can never write a verdict: the gate becomes a permanent deny that looks protective. Both deadlock misconfigurations (grounding-mcp absent from `tools.mcp` = hard error; relative `SOLUTION_VERDICT_DIR` = warning) are surfaced by `harness validate` and `harness doctor` via `checkSolutionAcceptanceProducer` (`src/cli/validate/checks.ts`, per the pack doc).

## runtime-reality: fail open, with an opt-in fail-closed knob

`docs/runtime-reality-hook.md` (line 14): "Every load or probe error degrades to allow: a misconfigured probe never tarpits the session." The doc names two deny paths: a probe that actually produced state showing critical drift, and a stdin that stays open past the hook's 3000 ms idle bound (see the pack-hooks section below; `RUNTIME_REALITY_DISABLE` still wins). The source (`src/cli/pack/hook-runtime-reality.ts`) mirrors this: a stdin read error other than the timeout, hook construction failure, unset `RUNTIME_REALITY_KEYWORD` (no baseline), and unset `RUNTIME_REALITY_PROBE_CMD` (nothing to compare) all resolve via `allowResult(...)`; a thrown/hung probe (10s subprocess timeout) is treated as "probe failed" under the same fail-open policy. Operators can invert per tier (env toggles documented in `docs/runtime-reality-hook.md`'s reference table; the escalation logic lives in the external `@lannguyensi/runtime-reality-checker` package, not in the hook file): `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` denies on probe failure, `RUNTIME_REALITY_WARN_AS_BLOCK=1` escalates warnings, `RUNTIME_REALITY_CRITICAL_AS_WARN=1` degrades critical drift to allow, `RUNTIME_REALITY_DISABLE=1` short-circuits entirely. This fail-open default is why `harness init --template full` ships the hook entry commented out: an active entry without the three env values "would degrade to a silent allow (a no-op that looks like protection)".

## Pack hooks: a PreToolUse gate blocks on a timed-out stdin read (task `7dfdcaaf`)

The pack hooks read the event JSON through one idle-bounded reader (`readStdin`, `readStdinChecked` and the gate wrapper `runGateWithStdinRefusal` in `src/cli/pack/hook-bootstrap.ts`, the reader in `src/cli/pack/hook-runtime-reality.ts`, both on `src/cli/bounded-stdin.ts`, 3000 ms without a chunk). Claude Code closes stdin after writing the event, so only an open pipe that stays quiet for the bound reaches it; before the bound the hook waited for the host's own hook timeout, and a writer that was merely late (first byte or a mid-event stall longer than the bound, then the full event and a close) was still decided on its content.

A timeout is not an allow for a gate. Every PreToolUse gate verb fails CLOSED on a timed-out read, whether nothing, a partial event, or a complete event on a stdin that never closed was read: it blocks with a reason starting `stdin timeout:` that names the bound, instead of its empty or malformed event handling. The Claude Code gates (`pre-tool-use`, `branch-protection`, `solution-acceptance`, `solution-acceptance-writeguard`, `post-merge-gate`) write the usual `decision: "block"` envelope and exit 0, `codex-pre-tool-use` exits 2 with the reason on stderr, `runtime-reality` writes its `permissionDecision: "deny"` envelope and exits 2. The decision is taken right after the read and the operator pause check, before the manifest is loaded: the pause sentinel still yields (and `RUNTIME_REALITY_DISABLE` still disables `runtime-reality`), and a gate whose pack is disabled or undeclared also blocks on a timeout. This is a timeout-specific exception to the fail-open rows above: the understanding gate's allow on an empty event, `solution-acceptance-writeguard`'s allow on an unguarded surface, `post-merge-gate`'s allow on malformed JSON and `runtime-reality`'s degrade-to-allow all apply to an event that CLOSED, not to one that timed out. `branch-protection` already blocked an empty event, and its timeout block now also covers a partial or complete event. Measured with a child process holding stdin open (empty and complete events) and with a writer that waits past the bound and then writes the full gated event and closes: every gate verb blocks in both cases.

Every other pack hook (PostToolUse, Stop, SubagentStart and SubagentStop, UserPromptSubmit, `post-merge-gate-record`, `stay-in-scope`) is not a gate: on a timeout it writes one stderr note and treats the text read so far exactly like the same bytes on a closed stdin.

## `harness policy intercept`: a PreToolUse intercept blocks on a timed-out stdin read (task `aca3de04`)

`runInterceptCli` (`src/cli/policy/intercept.ts`) reads the event through the same idle-bounded reader as the pack hooks (`readStdinBounded` in `src/cli/bounded-stdin.ts`, 3000 ms without a chunk). Until task `aca3de04` a timed-out read continued as an empty event, which matches no policy and allows, so a host that stalled past the bound and then wrote a complete gated event and closed got an allow where the policy would have blocked: the hook had already exited when the event arrived. The pack PreToolUse gates had been closed against this by task `7dfdcaaf` (previous section); the policy engine had not.

A timed-out read now blocks. `runInterceptCli` checks the operator pause first (the same `checkPauseFromLoader` call it makes after parsing; a paused run exits 0 with no output, as the pack gates do), then writes `harness policy intercept: BLOCK: stdin timeout: ...` (with the `[hook=<name>]` tag after `intercept` under Codex) to stderr and the `decision: "block"` envelope with the PreToolUse `permissionDecision: "deny"` on stdout (`stdinTimeoutBlockReason` and `stdinTimeoutBlockJson`, shared with the pack gates, so the reason names the 3000 ms bound), and exits 0. The decision is taken before the manifest is loaded and before any policy is evaluated, so it does not depend on which policies are declared or on their enforcement tier: a manifest with only `warn` policies also blocks on a timed-out read, exactly as a pack gate whose pack is disabled does.

The rendered hook command does not say which event it is registered for (Claude Code's `settings.json` carries `harness policy intercept` with no event name, and the Codex projection adds only `--hook <name>`), and every shipped registration is PreToolUse, so the only signal the process has is the event the timed-out read itself declares. A text that parses to a JSON object whose `hook_event_name` is a non-empty string other than `PreToolUse` keeps the pre-existing continue behaviour (the `using the N bytes read` note, then the event is evaluated like any other, which for a non-PreToolUse event never produces a `permissionDecision`). Everything else is treated as the PreToolUse call the verb is registered for and blocks: nothing read, a truncated or unparseable prefix, a JSON value that is not an object, an object with no or an empty or non-string event name, and a `PreToolUse` event. The consequence for an operator who registers `harness policy intercept` on another event in a hand-written manifest is that a stalled stdin whose text names no event now produces the block envelope there too. A stdin that closes within the bound is decided exactly as before; measured with the built CLI at the base and at this change, the stdout, stderr and exit code of a gated event (block), an event no policy matches (allow), a PostToolUse event, malformed JSON and an empty input on a closed stdin are byte-identical.

## `bash_match` normalised-form matching: fail open above a size bound, now loud

Above `MAX_NORMALIZE_LENGTH` (100,000 characters), `normalizeCommand` (`src/runtime/command-normalize.ts`) skips normalisation entirely and returns the command unchanged — a defensive bound so command SIZE alone can never drive `harness policy intercept` past a hook's own timeout budget (`require-preflight-evidence` declares `budget_ms: 15000` since task 7bf47554). The RAW command is still tested by `policyMatchesEvent` regardless (raw-OR-normalised construction), so this only loses the ADDITIONAL normalised-form coverage — wrapper-peeled or git-global-option-collapsed spellings a `bash_match` regex would otherwise also have matched — never the baseline raw match. Until review round 2 (G4 finding, 2026-07-27) this skip was completely silent: no stderr line, no audit row, discoverable only by reading the source. `NormalizedCommand` now carries a `truncated: boolean` field, and `runInterceptCli` (`src/cli/policy/intercept.ts`) writes exactly one stderr line reporting the skip whenever it is `true`, keeping the normaliser module itself pure and I/O-free while making the fail-open loud at the one place that already owns a stderr stream for the event. The ampersand-aware SECOND pass added by task `aabbad63` (`normalizeCommandAmpAware`, same file) carries the IDENTICAL fail-open posture over the IDENTICAL bound — it is only ever invoked with the same Bash command `normalizeCommand` was, so its own `truncated` flag can never disagree with the primary pass's for the one production caller (`runInterceptCli`), and the one stderr line above already reports the skip for both passes at once; there is no separate stderr line naming the amp pass's own skip, nor does one need to exist while the two passes share both the bound and the input.

## Per-policy target attribution: additive fallback, never a new fail-open

(task `98ad072f`) Any policy whose `requires.ledger_tag` references
`${REPO}`/`${BRANCH}` or sets `at_head: true` is evaluated once per
DISTINCT repository a trigger-satisfying command segment names (its own
`-C`/`env -C`/`--git-dir`, or a target inherited from a genuinely
persisting `cd`) — the session's own cwd context is ALWAYS also
evaluated, never dropped except for a cwd outside every repository next to a resolved target (see the exception below; `resolveAttributedContexts`; the "always add, never replace" rule
D-021 and its four-review-pass history are restated in-tree in that
function's own doc comment, `src/runtime/intercept.ts:1460-1494#"disproved"`; the
original decision record under
`.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/` is local run state
and not shipped with the repo). This section covers only the FALLBACK side of that resolution,
since it is the part that changes this matrix's own fail-posture story:

- **A composition neither view resolves to a directory (`--work-tree`
  alone, a `~`, variable or substitution value) falls back to the cwd
  context ALONE: never fail-open, never a new gap, with the one
  exception in the next bullet.** Since task `7d4abf84` the quote-aware
  shell command model (`src/runtime/shell-command-model.ts`) resolves the
  compositions the per-segment view leaves at this fallback: more than
  one `-C` (composed in order, `--git-dir` after them, `env`'s last
  `-C`), a relative target after a preceding `cd` (each step resolved on
  the real filesystem, a plain `cd` lexically, a `-C` / `cd -P` through
  the real directory), and quoted values; the segment view's demands are
  computed first and the model's only appended, so it cannot drop one,
  including the blank cwd context of a working directory outside every
  repository that the segment view demands for a policy its arms matched
  (a policy only the model's arm matched has no segment-view demand). This is identical to the cwd-only resolution every such
  policy had before this task; the fallback is a PRECISION concern (does
  the demand correctly name the touched repo), not a safety one, because
  the cwd demand is never dropped when the fallback applies (the one
  exception, below, drops the context of a cwd outside every repository
  only next to a RESOLVED target, never in a fallback).
- **A repo-relocating value this module refuses to read fails CLOSED
  instead of falling back (task `cfb6b390`).** A `-C`, `--git-dir` or
  `env -C` value (every `-C` of an `env`, a `~` value included), or an
  argument of a `cd` / `pushd` / `popd` in a shape `scanCdFamily`
  recognises (flags and redirections after it; a `{` or `!`, `builtin`,
  `command`, `eval`, `time`, a compound-command keyword or a `VAR=value`
  assignment in front of it), that holds a backtick (quoted or not, an
  escaped backtick, a backtick command substitution), an ANSI-C quoted
  value (`$'...'`, which decodes escapes) or a locale quoted value
  (`$"..."`, which bash looks up in a locale catalogue that can translate
  it, decoding no escape; zsh reads it as a literal `$` plus a
  double-quoted string, where the rule over-blocks) started by an
  unquoted, unescaped `$` (`'a$'` and `"a$"` are plain quoted values), or
  that is otherwise unattributable AND holds a control, format or
  separator character, makes `segmentViewOf` flag the segment
  (`opaqueTarget`), also for a later segment that inherits the directory
  of such a `cd` or names a relative target against it.
  `resolveAttributedContexts` then returns `opaque-target` and
  `intercept()` records one decision without a ledger query (deny for a
  `block` policy, warn for a `warn` policy), the same shape as the bound
  below; no evidence can satisfy it, the remedy is a plain path, and it
  over-blocks harmless forms such as ``git -C `pwd` log``. The same
  fix makes the command tokeniser end a word only at a space or a tab (the
  shell's blanks), so a U+2028, U+00A0, carriage return or form feed inside
  an unquoted `-C` target stays in the target and the command still reads
  as the gated `git <subcommand>`; such a target is attributed to that
  literal directory. The per-segment view leaves a quoted value without
  those characters (`git -C 'vendor/lib' log`) and a quoted path with a
  space at the cwd-only fallback and does not carry the opaque directory
  past a later reset-class `cd` (`cd -P X`, `pushd X`, `popd`, `cd -`), a
  later `cd "sub"`, or a `||`, nor read `\cd`, `c''d` or the zsh `chdir`
  as a `cd`; since task `7d4abf84` the shell command model reads all of
  these (a quoted plain value is attributed, every one of the opaque
  propagations fails closed), and the gate takes the union of both views.
  Still the cwd-only fallback: a `$(...)` substitution, a `~` or variable
  value.
- **The shell command model's own fail-closed forms (task `7d4abf84`).**
  Besides the opaque values above, an unquoted glob target (`cd
  vendor/libpl*`; expansion is a follow-up), a relative `cd` / `pushd`
  while an in-command `CDPATH` assignment is in effect, a loop whose body
  changes directory relatively (for the commands after it and inside
  it), more than 8 possible directories for one command, a composed
  path over 4096 characters, and model paths that need more than the
  per-event filesystem work budget (`MAX_MODEL_PATH_WORK`, 4096 units of
  steps, realpaths, directory checks and repository-walk levels, counted
  by the event's `ModelPathResolver` in `src/runtime/shell-model-paths.ts`)
  make `resolveAttributedContexts` return `opaque-target`. A `cd` or
  `pushd` the model reads without doubt (top level, the builtin spelling,
  no redirection of its own and no `-e` / `-@`, a plain target with every `..` before any
  name, a `cd -P` target whose every `..` leaves a directory the shell can
  pass through, and no earlier function definition or command that can
  redefine `cd`: `enable`, `disable`, `alias`, `unalias`, `unfunction`,
  `hash`, `unhash`, `autoload`, `functions`, `source`, `.`, `trap`, a
  dynamic command word or `eval`, an assignment to the shell's function,
  alias or command tables) into a directory that exists when the hook
  runs has no failure branch (the resolver is the model's directory
  oracle); every other `cd` keeps it. The check reads the filesystem when
  the hook runs and does not see the shell's own functions, aliases,
  options or inherited `CDPATH`; both gaps can drop only a demand of the
  model's own, never one of the segment view's. When the model cannot lex the command (or it is longer
  than `MAX_NORMALIZE_LENGTH`), the segment view decides alone, except
  that a policy with a `bash_match` fails closed when the raw text holds
  a directory-changing word (`cd`, `pushd`, `popd`, `chdir`, `-C`,
  `--chdir`, `--git-dir`, also with quotes or backslashes removed). The
  over-block this adds (glob targets, `CDPATH`, verbs that never run) is
  recorded in the CHANGELOG entry for task `7d4abf84`.
- **More than `MAX_ATTRIBUTED_CONTEXTS` (4) distinct targets for one
  policy on one event fails CLOSED** — see the new table row above. This
  is the one place per-policy attribution ADDS a fail-closed posture the
  plain per-event resolution never needed (an event with only ever one
  context to evaluate could not exceed a bound on the count of contexts).
- **One exception to "the cwd context is always evaluated": a cwd
  outside every repository next to a resolved target (task `6c8ebd37`).**
  When the working directory is outside every git repository (checked on
  its real path, where git runs) and the policy's `${REPO}`, as the empty-identifier guard sees it (after the
  policy's own `trigger.extract`, which can shadow the builtin), is blank,
  the cwd context can never be satisfied (the empty-identifier row above
  denies it without a ledger query), so `resolveAttributedContexts` does
  not add it for a segment (or a shell model path) whose own target
  resolved to a real repository; a cwd context the segment view demanded
  stays demanded whatever the model adds (task `7d4abf84`):
  otherwise the remedy the deny message names (`git -C <repo> ...`, or
  `cd <repo> && ...` in one command) would be denied again. The target's
  own context is still demanded in full. The skip relies on two static
  models: the target attribution, whose known misattribution (a `GIT_DIR=`
  prefix or a third repository reached through another construct) exists
  for every cwd, and the cwd resolution, which errs toward inside
  (`mayBeInsideRepository`, not the `resolveGitContext` walk the builtins
  come from): the skip applies only when neither the cwd's real path nor
  any ancestor up to the filesystem root holds an entry named `HEAD` or
  `.git` (any type, valid or not) and no lstat there failed with an error
  other than ENOENT. Every git directory holds a `HEAD` entry, so this
  covers a `.git` directory without `HEAD`, any depth, a bare repository
  and a directory holding only `HEAD` and a `commondir` file; a stray
  `HEAD` entry is a conservative deny with the hint. The check runs at
  most once per event. What remains outside both models: a third
  repository the command really runs in (a `GIT_DIR=` prefix, or a `cd`
  into another repository before the misattributed segment), state the
  command itself creates while it runs (for example a `.git` it links
  before the git verb), and an ambient `GIT_DIR` or `GIT_COMMON_DIR` in
  the environment git runs with. A detached cwd (non-blank `${REPO}`, blank `${BRANCH}`) and
  every other non-blank cwd context keep the cwd context, as do a segment
  with no resolved target (a bare `git status`) and a target that is the
  cwd repository itself; the detached hint names the cwd repository.
- **What is unchanged:** every OTHER fail-posture row in this matrix
  (ledger degradation → tier-derived `warn-degraded` for `warn` /
  `deny-degraded` for `block`/`require_approval`, audit-write failure →
  stderr-only, `MAX_NORMALIZE_LENGTH` truncation → loud fail-open)
  applies IDENTICALLY to each attributed context independently —
  attribution introduces no new evidence source and no new degraded-mode
  path, it only multiplies how many times the existing per-policy
  evaluation in `evaluateOnePolicy` runs for one event.

## Cross-cutting rules

Two invariants hold across all gates. First, audit degradation never blocks: `LedgerClient.record` implementations "MUST be best-effort" (`src/runtime/intercept.ts` interface doc), and a record failure that survives the single fresh-session retry (task f1aea826) is written to stderr while the gate decision stands — the retry improves the audit trail's completeness, it never changes a decision. Second, fail-open is always loud: every allow-on-error path in every hook emits a stderr diagnostic, because "a silently-allowing gate manufactures false confidence, which is the worst direction for a governance hook to fail in" (`src/cli/pack/hook-pre-tool-use.ts`); since task f1aea826 the same loudness applies to the new fail-closed path (`deny-degraded` carries a degraded-specific envelope and stderr diagnostic naming the unreadable evidence source). The asymmetric fail-closed carve-outs inside otherwise fail-open surfaces are the risk gate's `when:` classifier ("unknown is not safe", `whenUnclassifiedFallback` in `src/runtime/intercept.ts`) and, since f1aea826, the entire block/require_approval tier under ledger degradation.
