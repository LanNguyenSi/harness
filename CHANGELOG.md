# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Integration pin for operator-state-isolation acceptance smoke** (agent-tasks/5107504c, PR #201). PR #199 verified its acceptance criterion ("vitest suite still passes when the operator has a real `harness pause` sentinel pre-written") manually but did not encode it. This adds `tests/integration/operator-state-isolation.test.ts`: snapshots the real sentinel, plants a 1h-expiry test sentinel via `writeSentinel`, spawns a `vitest run --exclude tests/integration/**` subprocess, asserts exit 0, restores prior state in `try/finally` so a test crash never leaves a phantom sentinel behind. Gated by `HARNESS_INTEGRATION_TESTS=1` via `describe.skipIf` so default `npm test` shows `1 skipped` (no second-spawn overhead on the CI hot path). New `npm run test:integration` script flips the env var on. The spawn approach is load-bearing: an in-process re-run would self-contaminate (inner test discovers the outer's planted sentinel and the recursion would corrupt restore).
- **Marker-GC matcher covers legacy v1 `tasks_transition` verb with status filter** (agent-tasks/9e06175f, PR #200). Closes the GC half of the gate auto-bypass class that PR #198 fixed at evaluation time. Before this, `tasks_transition --status done` (the v1 way to close a task, still used by scripts and external integrations) did NOT fire either the `track-active-claim` or `post-tool-use` PostToolUse hooks, so the work-claim file and the operator's approval marker lingered after the task ended. PR #198 made the leftover marker inert (the gate now scopes to active-claim), but the marker itself stayed in `.approvals/` until manual cleanup. Both hooks now also match `mcp__agent-tasks__tasks_transition` with an in-hook status filter: `status === "done"` releases the claim and clears the marker (matching `task_finish` → done semantics), every other value (`open`, `in_progress`, `review`, missing, malformed) is a no-op so the work claim and marker survive in-flight transitions. Mirrors the v2 contract that `task_finish → review` keeps the work claim, only `→ done` releases. Updated: `TRACK_ACTIVE_CLAIM_MATCH` regex, `DEFAULT_EXPIRE_ON_TOOL_MATCH` array, two test-relevant hooks (`hook-track-active-claim`, `hook-post-tool-use`), three init template sources (`profiles.ts`, `templates.ts`, `composer.ts`), and both manifest goldens (`full-manifest.yaml`, `full-manifest.expected.yaml`). 8 new tests across the two hooks cover each status value plus the missing-status defensive path. **Operator action**: re-run `harness apply` to pick up the new matchers; existing installs continue working (their settings.json simply doesn't fire the hook on `tasks_transition` events, which is the pre-PR behaviour) but will keep accumulating inert task markers AND a stale `active-claim` file (the `track-active-claim` matcher symmetrically gains the new tool, so a single `harness apply` refreshes both surfaces). **Known limitation**: `tasks_transition --status open` (manual release / unclaim) is treated as no-op rather than clear. In practice `open` is rare (release uses the dedicated `tasks_release` v1 verb) and the worst case is a stale marker that the next claimant either matches or replaces; if you exercise the `open` path routinely, file a follow-up.
- **`resolvePaths` test-isolation guard via `HARNESS_ALLOW_REAL_GENERATED_DIR` env opt-in** (agent-tasks/3692cdf4, PR #199). Third incident in the recurring "test silently reads/writes the operator's real `~/.claude/`" class. v0.21.1 fixed preflight stage; v0.22.0 fixed `approveUnderstanding` markers; this one closes the architectural hole that lets the class re-spawn at every new call site. `resolvePaths` now throws unless one of `homeDir`, `configPath`, or `process.env.HARNESS_ALLOW_REAL_GENERATED_DIR === "1"` is set. The harness binary (`src/cli/main.ts`) sets the env var before invoking `run()`; tests do not, so any future test caller that forgets to inject `homeDir` / `generatedDir` fails loudly at the assertion site instead of silently mutating operator state. Surfaced 23 latent leak sites on first run (21 in `approve-understanding.test.ts`, 1 in `pack-hook-codex-stop.test.ts`, 1 in `session-start/preflight.test.ts`); all addressed in the same PR via lazy `resolvePaths` evaluation when the relevant override is already supplied (e.g. `reportsDir`), or by adding `homeDir: tmp` to the test caller. New pin-test at `tests/cli/loader-isolation.test.ts` (5 cases) asserts the throw fires when expected and the env-var opt-in re-opens the fallback. Acceptance smoke: full vitest suite (1520 / 1520) passes with a fake `harness pause` sentinel pre-written into the operator's real `~/.claude/harness.generated/.harness-paused`, confirming no test short-circuits because of operator state.

### Fixed

- **Understanding-gate silently auto-bypassed via any stale task marker, active-claim ignored** (agent-tasks/a13a537b, PR #198). `checkAnyTaskApprovalMarker` scanned `<gen>/.approvals/` and matched the FIRST fresh `task-<id>` marker it found, regardless of whether that task was the currently-claimed one. A single approval marker left lying around (typical pattern: operator approves task A, the marker is not GC'd at task A's completion, a fresh session picks up task B and never sees an understanding-gate prompt) silently auto-allowed every Edit/Write/Bash in every subsequent session until the marker aged out. Discovered when an operator on a freshly-assigned task ran the pre-tool-use hook by hand and watched it report `task-scoped marker for task <unrelated-id>: approved at <hours ago> by harness-approve-cli, allowing` for a task that had been merged earlier the same day. The behaviour was design-by-comment ("Any fresh `.approvals/task-<id>` marker satisfies the gate, regardless of which session approved it") but the comment encoded the bug: a session-agnostic check is exactly what makes a task-scoped marker secure across sessions; a task-agnostic check is what makes it insecure across tasks. Replaced with `checkActiveClaimApprovalMarker`, which reads `<gen>/active-claim` and ONLY consults the marker for that specific task. When `active-claim` is absent (legacy / solo workflows that never call `task_start`), the new function returns `matched:false` and the gate falls through to the session marker, preserving the legacy contract. `checkAnyTaskApprovalMarker` is removed from the runtime surface (only one internal caller). New tests pin the security contract: a `task-OTHER` marker plus an `active-claim` pointing elsewhere now blocks. **Operator cleanup**: list `.approvals/task-*` entries whose UUIDs do NOT match any task you are currently working on, and rm those that pre-date the next `task_start`:

```bash
ls ~/.claude/harness.generated/.approvals/task-* 2>/dev/null
# For each entry: confirm the task is closed, then rm it.
cat ~/.claude/harness.generated/active-claim
# Markers whose taskId does not match this file are inert under the
# new gate; they can be removed without affecting any live approval.
```

## [0.22.0] - 2026-05-18

**Headline: two operator-experience deliveries in one release.** First, `harness pause` / `harness resume`, two operator-only verbs that make every PreToolUse / PostToolUse pack hook dormant by writing a JSON sentinel under `harness.generated/`. Replaces the `ledger_add understanding-approved:<sessionId>` lockout-recovery hack, the comment-out-and-readd `settings.json` dance for gate debugging, and the no-clean-answer incident-hotfix path; the operator-only guardrails (refuses agent shell, refuses non-TTY) keep it from becoming a routine bypass. Second, a critical test-isolation fix: every `npx vitest run` since v0.20.0 silently wrote `.approvals/task-<real-task-id>` markers into the operator's real `~/.claude/harness.generated/.approvals/`, auto-approving whatever task the live `active-claim` pointed to and short-circuiting the understanding-gate. Same class as the v0.21.1 preflight leak; this release fixes 10 leak sites and adds a pin-test that asserts no writes happen under real `~/.claude/` for any future `approveUnderstanding` test caller.

### Added

- **`harness pause` / `harness resume`: sentinel-based hook bypass without unwiring** (harness/07850f73, PR #196). New operator-only verbs write a JSON sentinel under `<generatedDir>/.harness-paused`; every PreToolUse / PostToolUse pack hook (`pre-tool-use`, `codex-pre-tool-use`, `post-tool-use`, `track-active-claim`, `branch-protection`) checks the sentinel before evaluating and short-circuits to allow plus a one-line stderr notice while it is active. Auto-resume on first hook fire past the expiry. Default window is 15 minutes; `--for <duration>` accepts the same shorthand and ISO-8601 forms `requires.within` does. `--indefinite` exists for genuinely open-ended recovery flows but requires `--i-am-the-operator-and-accept-no-auto-resume` as a separate verbose flag, so the friction itself discourages routine indefinite-pausing. Each pause / resume / auto-expiry also writes an `harness-paused:<pausedAt>` / `harness-resumed:<pausedAt>` evidence-ledger fact in the synthetic `default` session bucket so the audit trail outlives the ephemeral sentinel file. Intended for three narrow flows: lockout recovery (replaces the `ledger_add understanding-approved:<sessionId>` hack documented in `feedback_understanding_gate_lockout_recovery`), "is this harness or my code?" debug A/B-tests, and incident hotfix mode. NOT a routine bypass: the load-bearing guardrail is `harness pause` refuses to run when `$CLAUDE_SESSION_ID` is set (always set inside an agent shell) AND refuses non-TTY stdin without `--i-am-the-operator`. For permanent per-policy disable, edit `policies[].enabled` in the manifest, pause exists for the temporary case only. New docs section in `docs/for-humans.md` enumerates the boundary; the trust-boundary callout recommends a blanket Write deny on `harness.generated/` for operators with restrictive policies, since the sentinel file has no signature. `harness audit --since 24h` surfaces the ledger trail alongside policy decisions. 38 new tests across sentinel I/O, the CLI verbs, and pair-tests (pause + hook + resume + hook for both understanding-before-execution and branch-protection).

### Fixed

- **Test isolation: `approveUnderstanding` test callers leaked task markers into operator's real `~/.claude/harness.generated/`** (agent-tasks/b5a743fc). Same class as the v0.21.1 preflight side-effect leak. 9 sites in `tests/cli/approve-understanding.test.ts` and 1 in `tests/cli/pack-hook-codex-stop.test.ts` called `approveUnderstanding({ manifest, session, reportsDir })` without `generatedDir`/`homeDir` injection. `resolvePaths()` defaulted to the operator's real `~/.claude/harness.yaml`, then `~/.claude/harness.generated/`, and the call wrote `.approvals/<sessionId>` (test fixture session id) AND `.approvals/task-<real-task-id>` (read from the operator's real `active-claim` file, written by the v0.20.0 `track-active-claim` PostToolUse hook on `task_start`) into the real dir. The task-scoped marker silently auto-approved whatever task the operator was currently on, short-circuiting the understanding-gate without them ever running `harness approve understanding`. Discovered when an operator with a fresh session asked why the gate did not fire for a newly-assigned task; forensics showed `task-<id>` markers with `approvedBy: harness-approve-cli` and timestamps matching exactly when `npx vitest run` was last executed. All 10 sites now inject `generatedDir`; new pin-test at `tests/cli/approve-understanding-isolation.test.ts` (mirrors `tests/cli/session-start/preflight.test.ts`'s `defaults to no staging` pattern from PR #195) catches future regressions by snapshotting `~/.claude/harness.generated/.approvals/` before and after a tmp-`homeDir` `approveUnderstanding` call and failing on any new entry. **Operator cleanup**: if you ran `npx vitest run` against the harness repo any time since v0.20.0 (2026-05-18), list the test-leaked markers in your real approvals dir. Filter on NAME shape: legitimate markers are keyed by UUID (session id or `task-<UUID>`); test fixtures use literal names like `sess-1`, `sess-stop-roundtrip`, `task-uuid-abc`, `task-isolation-pin-test-task`. Note that filtering on `approvedBy` does NOT work, the test fixture and the real `harness approve understanding` CLI share the same default `harness-approve-cli` actor string, so an `approvedBy`-only grep would also match your legitimate approvals. The safe filter is name-shape:

```bash
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
ls ~/.claude/harness.generated/.approvals/ 2>/dev/null \
  | grep -vE "^(task-)?${UUID}$"
# Inspect the list, then rm only the entries that match. Real operator
# approvals are never matched by this filter because their names are UUIDs.
``` Follow-up filed at agent-tasks/3692cdf4 for the lower-severity hook-test READ dependency on the same path (34 hook callers inherited a passive read from the pause-sentinel check added in PR #196, but no write leak).

## [0.21.1] - 2026-05-18

### Fixed

- **preflight staging side effect must be opt-in, not default-on**. v0.21.0 made `runSessionStartPreflight` write `<generatedDir>/.pending-approval` automatically as the bootstrap fix from PR #193. The default-on behaviour leaked through to vitest: every existing test that calls `runSessionStartPreflight` without isolating `homeDir` clobbered the operator's real `~/.claude/harness.generated/.pending-approval` with whatever literal session_id the test happened to pass. The leak surfaced live because `harness preflight` runs `agent-preflight`, which includes an `npm-test` check, which spawns vitest, which writes "real-uuid" (a test fixture string) to the real pending-approval file. `harness approve understanding` then resolved to "real-uuid" instead of the operator's session. Hotfix: the staging side effect is now opt-in, the CLI entry points (`harness preflight`, `harness session-start preflight`) wire `writePendingApproval` explicitly so operators still get the bootstrap fix; library callers (and every vitest case) get the no-op default. New regression test pins the default-off behaviour with an on-disk side-effect assertion. Caveat: this is a self-inflicted-via-our-own-test-fixture bug, but the user-visible effect (approve resolving to the wrong session) was severe enough to merit a same-day patch release.

## [0.21.0] - 2026-05-18

**Headline: preflight and approve ergonomics, two friction loops closed.** v0.20 documented (PR #186) that a preflight from earlier in the session does not cover a push that landed a new commit since, the time-window check was the only freshness mechanism. v0.21 closes the loop with `at_head: true`: a preflight whose recorded HEAD equals the current HEAD now satisfies the gate at any age, so the per-commit re-preflight churn disappears when nothing structural changed. The other loop: `harness approve understanding` (no flags) used to require a prior PreToolUse gate-block to have staged the session id, making the proactive "Understanding Report at task start" flow impossible without manual `--session <id>` coordination. `harness session-start preflight` now stages the same `.pending-approval` file as a side effect, so an arg-less `harness approve` works right after the first preflight. Two small wizard polish drops round out the release: the Full profile picker no longer claims "5 reference policies" (it has been 8 since v0.20's Bash-surface parallels), and the post-validate reminder for Full now correctly names both the agent-tasks MCP AND `gh pr (merge|create)` Bash surfaces as gated.

### Added

- **preflight-before-push: HEAD-match freshness (`at_head: true`)** (agent-tasks/a0af50cb, PR #192, follow-up to PR #186). The `requires` block accepts a new optional `at_head: boolean` flag. When true, an evidence-ledger entry whose `head:<sha>` token equals the runtime-resolved current HEAD sha satisfies the gate regardless of `within`. The standard `harness session-start preflight` producer now writes `head:<sha>` into the tag content (loose ref read with packed-refs fallback; raw sha for detached HEAD). FULL_TEMPLATE's `preflight-before-push` policy sets `at_head: true` with `within: 10m` kept as the freshness ceiling for the head-mismatch case (operator switched branch, preflight predates HEAD shift, runtime couldn't resolve a sha). Eliminates per-commit re-preflight churn when nothing structural changed since the recorded preflight. Deny reason now names the drift explicitly: `(HEAD drift: last preflight at <7-char-sha>, current <7-char-sha>)`. Back-compatible: old ledger entries lacking `head:` continue to satisfy via the standard window check; policies without `at_head` behave unchanged.

### Fixed

- **`harness approve understanding` bootstrap: preflight now stages `.pending-approval`** (agent-tasks/0dbc9549, PR #193). Before this change, `harness approve understanding` (no flags) required a prior PreToolUse gate-block to have staged `<generatedDir>/.pending-approval` with the session id. That meant the proactive flow (operator writes Understanding Report at task start, then approves before any tool fires) was impossible: with no block, no staging, no usable session id, approve exit'd with `no session id available`. Now `harness session-start preflight` (which operators run anyway as the standard producer for `preflight-before-*` gates) writes the same staging file as a side effect whenever it resolves a non-default session id, so an arg-less `harness approve understanding` works right after the first preflight. Skipped when the resolved id is the literal `"default"` (would never satisfy any task-scoped gate anyway). Best-effort: a staging-file write failure never breaks the SessionStart hook loop. The error message for the still-no-session-id case now points at `harness preflight` as the one-command fix. Existing PreToolUse-block-then-approve flow unchanged. 4 new tests on the producer side, 1 on the consumer error-message side.

- **Wizard: Full profile picker drops the stale policy count** (agent-tasks/4cd6baf8, PR #190). `harness init --interactive`'s profile picker showed "Full (Team + 5 reference policies wired through harness policy intercept)". The "5" was off-by-one before v0.20.0 (FULL_TEMPLATE had 6 then) and drifted to 8 after PR #188's Bash-surface parallels. Replaced with "the reference policies" so the label survives future policy adds without re-drifting; the composer label at the same surface already used count-free phrasing.

- **Wizard: Full post-validate reminder names gh-cli + MCP coverage** (agent-tasks/c9ac78eb, PR #191). The reminder block at `interactive.ts:650-680` told both Team and Full operators that "the review-merge gate only matches agent-tasks MCP tool names today, not `gh pr` Bash calls". For Full that has been false since PR #188 added `review-before-merge-bash` + `review-subagent-before-pr-create-bash`. Split the reminder: Team text byte-identical; Full now names both surfaces, the tag-shape difference (`review:${PR_NUMBER}` MCP vs `review:${BRANCH}` gh-cli), and offers `--template team` or `--template solo` as fallbacks. Regression test in the Full describe block of `init-interactive.test.ts` asserts the new shape and rejects the stale Team-only wording.

## [0.20.0] - 2026-05-18

**Headline: two ergonomics gaps closed at the gate surface.** v0.18 introduced per-task understanding-gate marker expiry as opt-in via `--task <id>`; this release auto-resolves the active agent-tasks claim from a PostToolUse-maintained `active-claim` file, so operators with agent-tasks wired never need to type the UUID. The full template's PR-review gates also become tool-agnostic: parallel Bash-surface policies now guard `gh pr merge` / `gh pr create` alongside the agent-tasks MCP variants, with `${BRANCH}` substituting for `${PR_NUMBER}` / `${TASK_ID}` since the extract DSL cannot capture from `tool_input.command`. Two fixes close subtle bypasses: the marker-expiry mechanism now also flips the persisted-report `approvalStatus` from `approved` to `expired` (closing the multi-task silent-bypass that survived v0.18), and branch-protection gates on the target file's repo rather than the cwd's, so writes to memory or cross-repo edits stop falsely refusing when cwd happens to sit on master.

### Added

- **understanding-gate v2: auto-resolve active agent-tasks claim** (harness/494fd1e5, PR #187). v1 (PR #184) shipped task-scoped markers as opt-in via `--task <id>`. v2 closes the ergonomics gap: a new PostToolUse hook (`harness pack hook track-active-claim`) maintains `<generatedDir>/active-claim` from agent-tasks `task_start` / `task_finish` / `task_abandon`. `harness approve understanding` reads the file when `--task` is absent and auto-supplies the id. Operators with agent-tasks wired never need to type the UUID; the file is a one-line cat-able artefact. Without agent-tasks (or when no task is claimed), behaviour falls back to v1: only the session-scoped marker is written. `--task` takes precedence over the file when both are present, with the result payload's new `source: "flag" | "active-claim"` field telling the operator which surface fed the id. New runtime helpers: `writeActiveClaim`, `readActiveClaim`, `clearActiveClaim`, `activeClaimPathFor`, `ACTIVE_CLAIM_FILENAME`. 13 new tests across the hook + approve + apply surfaces. No cross-repo coordination needed: harness owns both the writer (PostToolUse hook) and the reader (approve verb), so agent-tasks-bridge stays untouched.

- **understanding-gate: task-scoped approval markers** (harness/1ee26e77, PR #184). The marker file the gate consults is now keyed by `task-<taskId>` in addition to `<sessionId>` when the operator passes `--task <id>` to `harness approve understanding`. Either marker satisfies the gate, but the task-scoped one is the design-intent target for multi-task sessions: when the task ends, the post-tool-use hook extracts `tool_input.taskId` from the matched MCP boundary tool (e.g. `mcp__agent-tasks__task_finish`) and deletes the specific task marker (in addition to the session marker, as today). Without `--task`, behaviour is unchanged, the session marker is the only one written, fall-through semantics preserve every existing flow. New helpers in the runtime module: `writeTaskApprovalMarker`, `checkAnyTaskApprovalMarker`, `clearTaskApprovalMarker`, `taskApprovalMarkerPathFor`. 8 new tests across approve / pre-tool-use / post-tool-use surfaces. The intent: enable the cross-session continuity case (operator approved task A from session X, agent continues task A in session Y so the approval still holds) without disrupting the legacy per-session contract for solo workflows.

- **Tool-agnostic PR-review gates (Bash-surface parallels)** (harness/7eed0bb2, PR #188). The full template now ships `review-before-merge-bash` and `review-subagent-before-pr-create-bash` alongside the existing agent-tasks MCP variants, so `gh pr merge` / `gh pr create` get the same review-evidence gate. A `PolicyTrigger` can only AND-match one surface (MCP tool-name OR Bash command), so two parallel policies are the minimum-scope answer (V3 from the deferred-2026-05-17 task analysis, picked over a schema-bump V1 that would have introduced a new Array `match` form plus regex-capture from Bash stdout for a single use case). Tag shape switches to `${BRANCH}` on the Bash side because no `PR_NUMBER` / `TASK_ID` is extractable from `tool_input.command` via the JSONPath-only extract DSL. Hybrid operators using both surfaces get both gates active with two tag shapes, which is honest at the ledger layer. New worked example in `docs/writing-custom-policies.md` ("Same gate, two PR-surface variants") plus pointers in `docs/for-humans.md` and `docs/init-interactive.md`.

### Fixed

- **understanding-gate: persisted-report bypass** (harness/1ee26e77 root-cause follow-up, PR #185). Forensics on a multi-task session that didn't re-prompt: PR #172 (v0.18, May 17) shipped marker-expiry on task_finish but only deleted the FILESYSTEM MARKER, not the persisted JSON report at `.understanding-gate/reports/...json`. The pre-tool-use gate falls through to the persisted report when the marker is absent, so the report (still `approvalStatus: "approved"`) silently kept satisfying the gate after task_finish. The marker-expiry mechanism was performing its half of the contract, the report's half was missing. This patch closes the gap: the post-tool-use hook now also flips the matching report's `approvalStatus` from `approved` to `expired` (with an `expiredAt` timestamp), atomic rewrite, operator's report body preserved for audit. Hook command is now wrapped with `UNDERSTANDING_GATE_REPORT_DIR` so it resolves the same reports directory the pre-tool-use blocker uses. 3 new tests on the post-tool-use surface (flips approved → expired, degrades gracefully when no reports exist, idempotent on already-expired). Without this fix, the v1 task-scoped marker work from PR #184 was load-bearing on the marker path only, which the bypass would have continued to defeat.

- **branch-protection: gate on target path, not cwd** (harness/efdbfa0b, PR #183). The branch-protection PreToolUse hook resolved the branch via `resolveGitContext(cwd)`, so any Write / Edit / MultiEdit / NotebookEdit fired from a checkout on master got refused regardless of where the target path actually lived. Two practical cases hit every session: (1) writes to `~/.claude/memory/*.md` (outside any git repo at all) blocked when cwd was on a protected branch elsewhere; (2) cross-repo edits when cwd was on a protected branch in repo A and the target file lived in repo B on a feature branch, same wrong refusal. Fix introduces `extractTargetPath(toolName, toolInput)` for the single-file mutator tools and resolves the branch context from `dirname(targetPath)` instead of cwd. Relative paths resolve against cwd before the dirname walk. Tools without a single resolvable target (Bash, search verbs) fall back to cwd as before. Same-repo writes on a protected branch still block, the substance of the gate is unchanged, only its anchor moved. 6 new tests, 23 total in the file. Subsumes duplicate friction 5427e455.

### Changed

- **preflight-before-push gate message: explain the post-commit re-run requirement** (harness/ec7390c9, PR #186). The error said "a fresh preflight for `${BRANCH}` (within the last 10 minutes)", technically correct but hid the load-bearing detail: a preflight from earlier in the session does not cover a push that landed a new commit since. Result was "I just ran preflight, why is the gate blocking?" and a round-trip to docs. The required clause now splits the two cleanly: state the gate's actual check (time window) and give the operator-side rule (re-run after each commit) as a "what you need to do" hint rather than a "what the gate verifies" claim, since today only the time check is enforced. Same wording mirrored to `templates.ts`, `composer.ts`, the canonical `docs/examples/full-manifest.yaml` example, and its expected-render snapshot used by the parity test. The heavier half (HEAD-match freshness so any preflight whose recorded HEAD matches current HEAD satisfies the gate, removing the per-commit re-preflight churn entirely) is filed as a follow-up at agent-tasks/a0af50cb.

## [0.19.0] - 2026-05-17

**Headline: setup UX gap closed for non-agent-tasks operators.** Through v0.18.x several pieces of the harness experience silently degraded for operators picking Solo (or Team without an agent-tasks account): the new per-task understanding-gate marker expiry never fired because the configured boundary list was agent-tasks MCP names, `harness init --interactive` left the bridge wired but unauthenticated, `harness doctor` flagged the deliberately operator-driven `dogfood-before-release` policy as a missing-producer false positive, and an nvm-drift class of bug went undiagnosed. This release closes those four gaps: profile-aware reset defaults plus a new `expire_on_bash_match` regex list for gh-CLI workflows, a post-install auth probe with login / skip / abort dialog, doctor respect for the policy's own `producers:` array, and a doctor warning that catches when `npm prefix -g`'s bin dir is not on PATH. Doc cleanup made the external-account assumptions of each profile explicit up-front.

### Added

- **understanding-gate: `approval_lifecycle.expire_on_bash_match`** (harness/f54e0ecb). New optional schema field on the `understanding-before-execution` pack config: a string array of regex patterns matched against the `Bash` tool's `tool_input.command`. When a Bash command matches, the per-session approval marker is deleted on PostToolUse, same semantics as the existing `expire_on_tool_match` does for MCP tool names. Enables gh-CLI / pure-Bash workflows to declare task boundaries (e.g. `^gh pr (merge|close)\b`, `^git push origin (master|main)\b`) so the gate's per-task re-prompt works for them too. Profile defaults updated: Solo drops the agent-tasks tool list (dead weight there) and ships only the Bash list with `max_age: 1h`; Team and Full keep the tool list and add the Bash list for hybrid coverage. Patterns are pre-compiled at parse time, invalid regexes dropped with stderr warnings. Round-trip regression tests in `tests/cli/init-full-template-pins.test.ts` parse each template through `yaml.parse + new RegExp + .test()` to pin the escape-pipeline correctness, since the unit-level tests bypass that surface.

- **`harness doctor`: warn when `npm prefix -g`'s bin dir is not on PATH** (harness/4ddd78ed). Surfaces the nvm-drift footgun where `harness init --interactive` runs `npm i -g` against the active Node's prefix but the operator's shell PATH points at a different one, so installed binaries are silently invisible to subsequent doctor probes. Doctor now resolves the bin dir via `npm prefix -g` (the modern replacement for the removed `npm bin -g`) and renders an `Environment` section with the actionable PATH-patch suggestion when the bin dir is not in `process.env.PATH`. The section stays absent on ok and on the unknown branch (npm missing); skipped under `--shallow` so the 100ms timing budget stays intact.

- **`harness init --interactive`: post-install auth probe for the agent-tasks bridge** (harness/3f775180). After a successful `npm i -g @agent-tasks/mcp-bridge`, the wizard runs `agent-tasks-mcp-bridge status` to detect whether a token is configured. Three branches:
  - **ok**: prints `✓ agent-tasks token validated against the backend.` and continues.
  - **token present but validation fails** (backend unreachable, expired token, wrong base URL): prints an informational warning naming the bridge's reason and continues. The wizard does not block on this because the recovery is not actionable from inside it.
  - **no token stored**: opens a three-option dialog: (a) run `agent-tasks-mcp-bridge login` interactively now via stdio pass-through, (b) skip with a reminder, (c) abort the wizard with a pointer to the signup URL and the re-run command. After a successful login the wizard re-probes to confirm.

  Closes the silent footgun where a fresh operator could finish the wizard with `harness doctor` reporting all-green but every `mcp__agent-tasks__*` call returning an auth error.

- **FULL_TEMPLATE `git-preflight` hook pin: `min_version: "0.1.1"` + `version_command: ["preflight", "--version"]`** (agent-preflight/cb5a1770). Same pattern as the existing pins for `agent-tasks-mcp-bridge`, `grounding-mcp`, `memory-router-user-prompt-submit`. Floor at agent-preflight 0.1.1, the release that distinguishes "tool not installed" (e.g. an npm script invoking eslint that is not in devDependencies) from real lint/test/typecheck failures. Stale 0.1.0 installs silently emit false-positive blockers that keep the `preflight-before-*` policies closed forever; with the floor wired, `harness doctor` now warns operators to upgrade.

### Changed

- **`harness doctor`: producer-gap warning now respects the policy's own `producers:` array** (harness/f97e152f). A `block` policy with a `within:` window used to be flagged with `⚠ ... no manifest hook produces it` whenever no automatic SessionStart hook wrote the required tag, even when the policy itself declared a `producers:` entry pointing the agent at the manual recovery (`mcp__agent-grounding__ledger_add`). For `dogfood-before-release` in the Full template that was a false positive: the gate is deliberately operator-driven (an automatic SessionStart producer would defeat its purpose), and the `producers:` array IS the schema-blessed manual recovery path the agent sees in the deny envelope. Doctor now treats a non-empty `producers:` array as a documented producer and suppresses the warning. The warning still fires when both kinds are absent. Visible effect on the Full template: one fewer false-positive warning (dogfood-before-release flips from `⚠` to `✓`); the two preflight policies were already satisfied by the `git-preflight` SessionStart hook and stay green.

- **Profile dependency clarity in README + wizard** (harness/75de11c4). README, `docs/init-interactive.md`, `docs/for-humans.md`, the wizard's profile-choice descriptions, and the Team-profile confirm prompt now state the external-account assumptions of each profile up-front: Solo is standalone, Team requires an agent-tasks account, Full additionally requires `@lannguyensi/agent-preflight` and `gh` on PATH. The wizard also prints a post-init reminder for Team/Full operators naming `agent-tasks-mcp-bridge login` as the auth recovery path and `--template solo` as the fallback for non-agent-tasks workflows.

## [0.18.0] - 2026-05-17

**Headline: per-task understanding-gate marker expiry.** Through v0.17.x the approval marker had no lifetime: one `harness approve understanding` covered every subsequent Edit / Write / Bash for the whole session. That contract was correct when the gate was about "agent starts a session, picks ONE interpretation, runs", but no longer matches multi-task sessions, where a stale interpretation can silently drive the next task's edits. Live failure mode from the v0.17.4 dogfood: three sequential tasks in one session, marker stayed valid across all three, the third task started implementing the wrong fix surface before the operator caught the misdiagnose. v0.18 expires the marker on configurable task-boundary tools and (optionally) on a TTL safety net, so a fresh task gets a fresh Understanding Report. Backing task: agent-tasks/d8ee60ca.

**Operator action required (sort of):** the new behaviour is default-on for every install via `harness init --template solo / team / full` and via `init --interactive` Custom. Existing manifests that already use the pack will see the stricter behaviour on the next `harness apply` if they re-render from the template. Operators who prefer the legacy "one approval per session, no expiry" contract opt out by setting `policy_packs[].config.approval_lifecycle: { mode: "session" }`. Manifests that copy the pack config verbatim from the README / docs and pin it inline keep working unchanged until they explicitly add the new block.

### Added

- **`config.approval_lifecycle` on the understanding-before-execution pack** (agent-tasks/d8ee60ca). New schema-shape under the pack's `config:`:

  ```yaml
  policy_packs:
    - name: understanding-before-execution
      config:
        approval_lifecycle:
          expire_on_tool_match:
            - mcp__agent-tasks__task_finish
            - mcp__agent-tasks__task_abandon
            - mcp__agent-tasks__pull_requests_merge
          max_age: 4h
  ```

  `expire_on_tool_match` is a list of tool name patterns whose successful PostToolUse fires marker expiry. `max_age` is a duration (`24h` / `30m` / `PT1H` / ...) that the PreToolUse blocker enforces against the marker's `approvedAt` field. Both are optional. `{ mode: "session" }` opts out of both and restores the legacy behaviour. Coupling note: the default tool list names `mcp__agent-tasks__*` verbs because that is what every wizard-defaulted install uses, but the field is purely string-based, so operators on Linear / JIRA / GitHub Projects override with their own task-system verbs.

- **PostToolUse marker-expiry hook** (`harness pack hook post-tool-use`, new subcommand). Reads the PostToolUse event JSON from stdin and, when the just-completed tool matches the pack's `expire_on_tool_match` list, deletes the per-session approval marker. Fails closed-to-noop: any error path is logged and the hook exits 0, so a bug in this code never escalates into a session-wide tool block. Worst case the marker persists past the intended boundary, which degrades to the legacy per-session contract.

- **`checkApprovalMarker` honours `opts.maxAgeMs`** (extended). When set, a marker whose `approvedAt` is older than `now - maxAgeMs` is treated as expired and returns `matched:false` with an "expired" detail, so the agent sees the same "no approval" UX as a never-approved session and must re-approve. A marker with no readable `approvedAt` (body corrupted, missing field) skips the freshness check, so the existence-only DoS-resistance contract from v0.13.0 still wins.

### Changed

- **`init --template solo / team / full` + Custom-composer all ship `approval_lifecycle` defaults by default.** Re-running `harness init --force` on an existing install picks them up; an existing operator-edited manifest keeps the legacy behaviour unchanged until the operator manually adds the block or re-renders from a template.

- **`policy_packs[].config.approval_lifecycle` flows into the pack-expand surface.** `expandPolicyPacks` now contributes 4 Claude hooks instead of 3 (UserPromptSubmit + Stop + PreToolUse + the new PostToolUse). Operators who pinned the v0.17 3-hook shape in custom infrastructure should expect the new hook in their generated `settings.json` after the next `harness apply`.

### Verification

- `npm test`: 1361/1361 (was 1344, +17 new tests across `tests/cli/pack-hook-post-tool-use.test.ts`, `tests/policy-packs/marker-max-age.test.ts`, and additions to `tests/policy-packs/expand.test.ts`).
- `npm run typecheck`: clean.
- Golden fixture: `docs/examples/full-manifest.expected.yaml` updated for the new pack config block.

## [0.17.4] - 2026-05-17

**Headline: `harness init --interactive` wire-now actually wires settings.json now.** Closes a silent-no-op bug surfaced during the v0.17.2 dogfood (operator picked Full, picked claude-code in wire-now, but branch-protection's hooks never reached `~/.claude/settings.json`). Root cause: wireRuntime called `apply({ target, merge: true })` without `overwriteDrift`. A pre-existing stale or missing `~/.claude/harness.generated/.last-apply` snapshot made the freshly-rendered `harness.generated/settings.json` look like full-file drift, so apply returned `outcome: "drift-refuse"` without throwing. wireRuntime only checked `targetWritten` and printed nothing when it was false — leaving the operator with a "restart hint" line that implied success while settings.json was never updated. Fix: init's wire-now passes `overwriteDrift: true` with an auto-confirm prompt. Drift safeguards remain in place for ad-hoc `harness apply`; init's canonical "start from scratch" intent now always lands. Backing task: agent-tasks/df68b3e6.

### Fixed

- `src/cli/init/interactive.ts`: wireRuntime for claude-code now passes `overwriteDrift: true` + auto-confirming prompt to apply. Also prints a clear stderr message + sets `recoveryHint` when targetWritten ends up false (instead of being silently empty), so operators are never left guessing why the "wired into ..." line is missing. Adds a regression test (`wire-now bypasses stale-snapshot drift`) that seeds a stale `harness.generated/settings.json` and asserts the wire-now merge still lands.

## [0.17.3] - 2026-05-17

**Headline: `branch-protection` pack now emits the agent-facing `ux:` block on deny.** Closes the gap from v0.17.2 (which shipped the pack in defaults but left its `blockJson` on the legacy "branch-protection: refusing ..." vocabulary, inconsistent with the rest of the 0.17.x UX work). `hook-branch-protection.ts` now reads `config.ux` and renders the plain-language `{ cannot, required, run }` shape with `${BRANCH}` substituted from the resolved git context. Engine-vocabulary BLOCK reason still lands on stderr for operator audit. Backing task: agent-tasks/9806d4f8.

### Changed

- `src/cli/pack/hook-branch-protection.ts`: `blockJson` accepts an optional `ux: PolicyUx` and renders the agent-facing shape via `renderAgentFacing` when set. Adds `parseConfigUx` helper (third copy of this pattern; cleanup follow-up will extract into a shared module).
- `src/cli/init/templates.ts`, `src/cli/init/composer.ts`, `docs/examples/full-manifest.yaml`: ship `ux:` defaults on the branch-protection pack config. Substitutes `${BRANCH}` so the agent sees "You cannot edit files on protected branch master yet." rather than the legacy refusing-on-protected-branch paragraph.

## [0.17.2] - 2026-05-17

**Headline: `branch-protection` pack ships in Full + Custom init defaults.** The pack (#158, v0.16.0) was previously opt-in via `harness pack add branch-protection`, so wizard users picking Full or Custom got an install without master/main protection unless they knew to add it manually. `init --template full` now enables the pack by default; the Custom composer surfaces it as a checkbox option. Existing installs are NOT auto-migrated, see the operator note. Backing task: agent-tasks/2fdc5bbe.

Operator note: this is opinionated default. Workflows that routinely edit master directly (one-file repos, dotfiles, docs-only setups) can opt out with `enabled: false` on the pack entry or by removing the entry from `~/.claude/harness.yaml`. Existing manifests are untouched; pick the new defaults via `harness pack add branch-protection` or by re-running `harness init --force` after backing up.

Known gap (tracked at agent-tasks/9806d4f8, v0.17.3 follow-up): the branch-protection pack's deny envelope still emits legacy engine vocabulary, inconsistent with the rest of the 0.17.x UX work. Will plumb `ux:` through `hook-branch-protection.ts` in a separate patch.

### Changed

- `src/cli/init/templates.ts` (FULL_TEMPLATE), `src/cli/init/composer.ts` (COMPOSABLE_PACKS + pack-emit), `docs/examples/full-manifest.yaml`: ship `branch-protection` pack `enabled: true` with default config (`protected_branches: ["master", "main", "develop"]` via the pack's resolver).

## [0.17.1] - 2026-05-17

**Headline: Solo + Team templates ship `ux:` defaults for parity with Full + Custom.** v0.17.0 wired `ux:` into `init --template full` and `init --interactive` Custom branch, but the Solo and Team profiles in `src/cli/init/profiles.ts` were missed, so wizard users picking either of those got the new release without the UX fix. This patch closes the gap: Solo's understanding-before-execution pack and Team's pack + review-before-merge policy now ship the same plain-language `{ cannot, required, run }` defaults. Existing installs still need to opt in by re-running `init --force` or hand-editing their manifest. Backing task: agent-tasks/60bc93e5.

### Changed

- `src/cli/init/profiles.ts`: Solo and Team templates emit `ux:` defaults matching the Full + Custom shape (agent-tasks/60bc93e5).

## [0.17.0] - 2026-05-17

**Headline: agent-facing policy block messages stop leaking engine vocabulary.** A new optional `ux: { cannot, required[], run[] }` field on every policy and on the understanding-before-execution pack config replaces deny envelopes like `no matching ledger entry for tag preflight:harness` with a plain-language three-section message:

```
You cannot investigate this repository yet.

Required:
- verified repository preflight

Run:
  harness preflight
```

The internal model (session IDs, ledger entries, recordHint, ledgerTag, policy DAGs) is unchanged and still feeds the audit ledger, so `audit` / `explain --trace` / `session-export` keep their full trace. All five block-enforcement built-in policies plus the understanding-gate pack ship `ux:` defaults; the warn-only `two-reviewers-required` policy correctly omits ux (the agent never sees it). The Codex blocker mirrors the Claude blocker's UX through its stderr diagnostic. Adjacent: `harness preflight` is now a top-level alias for `harness session-start preflight` so the `ux.run` lines can show the short form agents should type.

Operator note: no required action. Manifests without `ux:` keep the legacy deny envelope verbatim.

### Added

- **Policy `ux:` block: agent-facing surface separated from engine internals** (agent-tasks/6b74b69d). Optional schema field on every `policies[]` entry: `ux: { cannot, required[], run[] }`. When declared, the deny envelope the agent sees becomes a plain-language three-section message (state / requirement / remedy) instead of engine vocabulary like `no matching ledger entry for tag preflight:harness`. The internal `PolicyDecision` (reason, recordHint, matchedCount, ledgerTag) is unchanged and still feeds the audit ledger, so `audit` / `explain --trace` / `session-export` keep their full trace. Templates substitute `${VAR}` against the same extract.values map the `ledger_tag` resolved against. Producers are suppressed when `ux:` is declared (the `run:` list is the canonical remedy surface; rendering both would give the agent two different command suggestions). The `preflight-before-investigation` and `preflight-before-push` policies ship with `ux:` defaults whose `run:` points at the new `harness preflight` top-level alias for `harness session-start preflight`. The understanding-before-execution pack continues to emit its own engine-vocabulary envelope until agent-tasks/e48e3b45 lands.
- **`ux:` on review-before-merge, review-subagent-before-pr-create, dogfood-before-release** (agent-tasks/902c1b4e). The three remaining built-in policies whose satisfying action is an MCP `ledger_add` recipe rather than a shell verb now ship with `ux:` defaults too. The `run:` field names the MCP verb invocation directly (`mcp__agent-grounding__ledger_add { type: "fact", content: "review:${PR_NUMBER} — <verdict>" }`), mirroring the form the existing `producers:` MCP entries already used and giving the agent a copy-pasteable recipe. Snapshot tests pin the verbatim agent-facing form for each policy.
- **`ux:` on the understanding-before-execution pack (Claude + Codex blockers)** (agent-tasks/e48e3b45). Both PreToolUse pack hooks (`src/cli/pack/hook-pre-tool-use.ts` for Claude Code, `src/cli/pack/hook-codex-pre-tool-use.ts` for Codex) now read an optional `config.ux` block on the pack and render the plain-language `{ cannot, required, run }` shape to the agent surface in place of the legacy "Understanding Gate: ..." + schema-hint vocabulary. The Claude blocker writes the agent-facing form to the stdout JSON `reason` (and `permissionDecisionReason`); the Codex blocker writes it to the stderr diagnostic that drives its non-zero-exit block. In both runtimes the engine-vocabulary BLOCK reason (which names the session id and which approval sources failed) stays on stderr so a flapping gate remains diagnosable from logs. Full-template + composer ship a sensible `ux:` default that names the nine required report sections inline, so agents see a self-contained call-to-action without consulting external docs. Schema reuses `PolicyUxSchema` from the policy layer; malformed configs are logged to stderr and fall back to the legacy envelope.

## [0.16.0] - 2026-05-16

**Headline: structural enforcement for the edit-on-master incident pattern, plus a single-command teardown.** New built-in policy pack `branch-protection` (opt-in) blocks `Write`/`Edit` (claude-code) or `apply_patch` (codex) at the FIRST source mutation when the agent is on a protected branch, complementing `preflight-before-push` (which fires at the LAST reversible step). Where the existing rule lived only in agent-discipline (memory `feedback_one_branch_per_task`), now it lives in the hook chain. Adjacent: `harness uninstall` replaces the manual `rm -rf` rollback recipe with a dry-run-by-default verb that backs up + snapshots before mutation; the Understanding Gate's deny envelope now enumerates the nine sections the parser actually requires so freeform reports stop silently failing; `harness doctor` flags leftover rogue `~/-prefixed` evidence-ledger DBs and the rogue-ledger scan itself got hardened against symlink false-positives.

Operator note: no required action. `branch-protection` is opt-in (`harness pack add branch-protection`); everything else is additive.

### Added

- **Built-in policy pack: `branch-protection`** (#158, agent-tasks/79fd5895). Blocks `Write`/`Edit` (claude-code) or `apply_patch` (codex) at the first source mutation when the agent is on a protected branch. Two satisfying signals: a fresh `branch:non-protected:<branch>` tag from the SessionStart producer (`harness session-start branch-check`, runnable on demand from the operator's `!` shell), or a `branch-protection-ack:<reason>` override the operator writes via `mcp__agent-grounding__ledger_add`. Default protected list `master, main, develop` is overridable via `config.protected_branches`. Fails closed (any load / parse / ledger error refuses, inverse of `understanding-before-execution`'s fail-open contract). Filters `policy_decision` audit rows out of the satisfying-tag scan so a past denied decision against this pack doesn't falsely unblock the next evaluation (mirrors `src/policies/requires.ts:75-83`). OFF by default; enable with `harness pack add branch-protection`. Full reference: `docs/policy-packs/branch-protection.md`.
- **`harness uninstall`** (#157, agent-tasks/92e851f3). Single-command teardown of a harness installation: inventories harness-owned entries in `~/.claude/` (manifest, lock, `harness.generated/`, hook groups + `mcpServers` entries in settings.json, leftover `settings.json.pre-harness-<TS>` backups) and prints them. With `--apply`, removes them after writing a reversible `settings.json.bak.uninstall.<ISO>` + `harness.uninstall.<ISO>.json` snapshot next to settings.json. With `--restore-from <path>`, atomically overwrites settings.json from a pre-harness backup. Ownership rules: hook group owned iff every inner command starts with `harness ` / `npx @lannguyensi/harness `; mcpServers owned = union of manifest's `tools.mcp[].name` and the bundled-template default allowlist (`agent-tasks`, `codebase-oracle`, `grounding-mcp`). Mixed hook groups are left in place with a warning so we never split operator-authored composites. Pattern mirrors `harness gate disable`.
- **Understanding Gate: deny envelope enumerates required parser sections** (#152, agent-tasks/5ec5772d). The PreToolUse gate (both claude-code and codex variants) now lists the nine sections `@lannguyensi/understanding-gate`'s parser requires (currentUnderstanding, intendedOutcome, derivedTodos, acceptanceCriteria, assumptions, openQuestions, outOfScope, risks, verificationPlan) with friendly aliases, plus a one-line explanation of what happens when the parser rejects a freeform report (marker write succeeds, audit trail stays empty). Verified end-to-end: a report shaped from the hint round-trips through `parseReport` with `ok: true`.
- **`harness doctor` flags rogue `~/-prefixed` evidence-ledger DBs** (#151, agent-tasks/232cf592). Bounded scan over `$HOME`, `$HOME/git/*` (one level), and `$PWD` for literal `~` subdirs containing `.evidence-ledger/ledger.db`, the orphan artefact pattern from the `EVIDENCE_LEDGER_DB` literal-tilde leak (PR #101). Findings render in their own "Rogue evidence-ledger DBs" section with a cleanup hint; never auto-deleted. Always-on (warning-only, cheap), counts toward `warningCount`, leaves `errorCount` untouched.

### Changed

- **CI: drift-guard for `understanding-gate` parser SECTIONS** (#153, agent-tasks/a3d329e2). New `npm run check:ug-schema-drift` runs after Build, npm-packs `@lannguyensi/understanding-gate@latest`, regex-extracts the `key:` entries from its SECTIONS array (bracket-balanced slice, ignores the sibling fast_confirm bullet-prefix table), and diffs against `UNDERSTANDING_REPORT_REQUIRED_SECTIONS` in `src/cli/pack/understanding-report-schema-hint.ts`. Detects order mismatch, upstream-added section, and upstream-removed section, surfacing combination cases as both diffs. The decision to pin to `@latest` over a fixed version (vs cron) is recorded in `docs/decisions/0001-ug-drift-guard-pin.md` (#156, agent-tasks/40452b01) with explicit reopen criteria.

### Fixed

- **`harness doctor` rogue-ledger scan hardening** (#154, polish on agent-tasks/232cf592). Four polish items on PR #151: dedup by `realpathSync` (collapses two parent dirs symlinked to the same physical location into one hit, falls back to the joined path on `EACCES`/`ENOENT`); `lstat` the `~` dir so a symlinked `~` pointing at the real `~/.evidence-ledger` doesn't false-flag; shell-quote `rogueDir` in the cleanup-hint output with POSIX-recipe escape for embedded `'` so a repo name like `weird's-repo` doesn't render a copy-paste footgun; extra dedup test for `$HOME/git/<repo> == $PWD`.
- **`ug-drift-guard`: string-aware bracket walker + build-hint precheck + cleanup** (#155). Three follow-ups bundled from PR #152 / #153 review: (a) `extractUpstreamSectionKeys` now tracks string-literal state with `\` escape handling so a SECTIONS alias containing `]` no longer truncates the slice and produces false-positive drift (all three delimiter styles covered); (b) `loadHarnessMirror` existsSync-prechecks the compiled module path and throws a typed error naming `npm run build`, replacing the generic Node "Cannot find module" cascade in the common forgot-to-build case; (c) drop misleading single-alias example from the gate hint intro (the bullets carry the canonical names and the parser's alias-tolerance is a quiet bonus).

## [0.15.0] - 2026-05-16

**Headline: interactive wizard major upgrade.** `harness init --interactive` gains a runtime multiselect for the wire-now step (Claude Code + Codex, with `opencode` parked until its adapter lands) and a real Custom-profile composer at full reference-policy parity (1 pack, 4 MCPs, 6 reference policies, ticked à la carte). The old Custom branch, an advertised menu item that printed "use --template full and hand-edit" and aborted, is gone. Adjacent: every policy's deny envelope now carries a one-line producer hint so a blocked operator sees not just the missing tag but the satisfying contract; runtime tilde expansion on MCP env values at spawn time closes the "literal `~/foo` creates rogue cwd files" footgun for every wired server, not just `grounding-mcp`.

Operator note: no required action. Custom is still opt-in from the wizard, and the new producer hints are additive.

### Added

- **Interactive wizard: runtime multiselect** (#147, agent-tasks/696f7560). The wire-now step is now an `@inquirer/prompts` `checkbox` over `claude-code` and `codex`; whichever runtimes `detect()` found configured are pre-checked so the historical single-runtime flow stays one Enter press. Selecting Codex runs `harness apply --runtime codex` and prints the manual-merge instruction for `~/.codex/config.toml`; selecting both warns the operator that `harness.lock` reflects the last-applied runtime. `opencode` listed disabled until task `f34eb233` lands the runtime adapter.
- **Interactive wizard: Custom-profile composer** (#148 + #149, agent-tasks/31d2fbb5 + 5dd3d8a6). Custom is a real à-la-carte builder: three checkbox prompts (packs / MCPs / policies) feed `composeCustom(selection)` which emits YAML the rest of the wizard's tail (validate → wire-now) consumes unchanged. v0.15.0 ships parity with `--template full`: 1 pack (`understanding-before-execution`), 4 MCPs (`agent-tasks`, `grounding-mcp`, `memory-router` routed under `memory.router`, `codebase-oracle` with an env-var advisory), 6 reference policies (review-before-merge, preflight-before-investigation, review-subagent-before-pr-create, preflight-before-push, dogfood-before-release, two-reviewers-required). Producer-coupling advisories print to stderr when a selected policy has no producer for its ledger tag.
- **Policy deny envelope: producer hints** (#141 + #142 + #143). Every reference policy in `FULL_TEMPLATE` now has a populated `producers:` field rendered into the deny envelope + `harness explain` output. The understanding-gate deny envelope picks up the same treatment so a blocked agent sees the `harness approve understanding` golden path rendered verbatim. The producer choice (`harness session-start preflight` vs `mcp__agent-grounding__ledger_add`) is recorded next to the tag the operator must produce.
- **Wizard dep table: min_version floor** (#144). The "Profile X depends on these binaries" table now shows `pkg@x.y.z+` next to packages whose `min_version` is declared, so operators see the floor a feature needs even without running `harness doctor`.

### Changed

- **`dependenciesForCustom` resolves codebase-oracle + agent-preflight** (#149 dependency layer). Custom selections that tick `codebase-oracle` or any `preflight-*` policy now get the matching binaries added to the wizard's `npm i -g` list, mirroring `PROFILE_DEPENDENCIES.full`.
- **Internal: shared `expandHome` helper** (#146). Three duplicate implementations consolidated into `src/runtime/expand-home.ts`. No behaviour change; refactor lands in the same release as #145 so the fix and the consolidation can be reasoned about together.
- **`codebase-oracle` stays out of the FULL default** (#138 + #139 + #140 net). The thrash trio settles on "not in default, opt-in via Custom composer or hand-edit"; the FULL template now carries an explicit comment explaining the omission plus the manual wiring recipe with required env vars (`ORACLE_SCAN_ROOT`, `OPENAI_API_KEY`).

### Fixed

- **MCP env values: leading `~/` expands at spawn time** (#145). Previously a literal `~/foo` in an `env:` block was passed verbatim, and the receiving MCP server (process started by the runtime, not a login shell) saw no tilde expansion, creating rogue cwd-relative files. Now every value beginning with `~/` is rewritten to `$HOME/...` at the runtime spawn boundary. Closes the same class of incident grounding-mcp hit in v0.14.0.

## [0.14.0] - 2026-05-15

**Headline: understanding-gate self-approval backdoor closed.** Through v0.13.0 the gate read a `understanding-approved:<sessionId>` row from the evidence ledger as approval. The agent has direct MCP access to that ledger via `grounding-mcp`'s `ledger_add`, so any agent could write the row for its own session and self-approve, collapsing the human-in-the-loop control to advisory. v0.14.0 moves the canonical signal to a filesystem marker at `harness.generated/.approvals/<sessionId>` written by `harness approve understanding` from the operator's shell. Edit / Write / Bash are all gated by the same PreToolUse hook and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes. Headline regression test (`tests/cli/pack-hook-pre-tool-use.test.ts`): an injected ledger row with `source: "mcp"` (exact shape `ledger_add` produces) MUST still block. Pinned for Claude and Codex blockers alike.

**Operator action required**: re-run `harness approve understanding` once in your active session after upgrade. Sessions without a live block need no action.

Adjacent release content: the backdoor closure itself (PR #132, agent-tasks/88ca4bb3); a one-line "to satisfy" hint on every deny envelope and `harness explain` output (PR #131, agent-tasks/32ed47cb); a tighter phrasing for `count.max`-only deny (PR #134, agent-tasks/aee9c085); symlink reject at the marker path (PR #135, agent-tasks/d39f160e); regression guard that `harness apply` preserves `.approvals/` and `.pending-approval` byte-for-byte across re-applies (PR #133, agent-tasks/bf8e1be8); marker-lifetime + session-id-reuse docs subsection (PR #136, agent-tasks/a65c32a8); README + quickstart relabel of `docs/examples/full-manifest.yaml` as a schema-coverage reference (PR #130, agent-tasks/1d1911ec).

### Security (BREAKING for upgraders)

- **Understanding-gate self-approval backdoor closed** (agent-tasks/88ca4bb3). Through v0.13.0 the gate read a `understanding-approved:<sessionId>` ledger row as approval. Because the agent has direct MCP access to `grounding-mcp`'s `ledger_add`, any agent could write that row itself and self-approve, collapsing the gate to advisory. Starting this release the canonical gate signal is `harness.generated/.approvals/<sessionId>`, a filesystem marker that `harness approve understanding` writes from the operator's shell. Edit / Write / Bash are all gated by the same PreToolUse hook, and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes.
  - The ledger row is still written by `harness approve understanding` for audit / forensics. `harness audit` and the gate's diagnostic output still surface it, labelled `(no longer satisfies the gate)`. The Claude blocker and the Codex blocker share the same change.
  - **Operator action required after upgrade**: re-run `harness approve understanding` once in your active session; the file marker will write and the gate will pass. Sessions that had no live block (`.pending-approval` absent) need no action.
  - **Persisted JSON report path** (the `@lannguyensi/understanding-gate` package's fallback for solo users) is unchanged. The agent's Stop hook only ever writes `pending` reports; flipping to `approved` requires the operator-side rewrite in `harness approve`, which the agent has no path to forge.
  - **`harness apply` preserves `.approvals/` across re-applies** (agent-tasks/bf8e1be8). Regression-pinned by new tests in `tests/cli/apply/apply.test.ts`; `.pending-approval` staging gets the same pin so a future "clean up harness.generated/" refactor cannot regress either file silently.

### Added

- Policy deny messages now include a one-line "to satisfy" hint so a blocked operator sees the satisfying ledger contract, not just the missing tag (agent-tasks/32ed47cb). Format: `<policy>: no matching ledger entry for tag \`<resolved-tag>\`. To satisfy: record an evidence-ledger entry containing \`<tag>\` (session \`<id>\`).` The hint covers the `count.min`/`count.exact` and `within` variants too. Deliberately omits the *how* (no recording verb named) so the deny path stays neutral on producer; see agent-tasks/88ca4bb3 for why pointing at a specific MCP would be the wrong suggestion.
- `harness explain <policy>` (non-trace) now prints a `toSatisfy` line built from the policy's `requires` spec with the un-substituted tag template, so contributors reading the policy contract see the same shape a blocked operator sees in Claude Code.
- `harness explain <policy> --trace` reuses the same hint, synthesised from the current manifest's `requires` so older audit-log payloads (which predate the field) still render `toSatisfy:` in the trace.
- New `buildRecordHint(requires, tag)` exported from `src/policies/index.ts` so consumers can render the same hint without firing an evaluation.

### Changed

- `buildRecordHint` now flips to a `keep evidence-ledger entries containing \`<tag>\` at or below <N>` phrasing for `count.max`-only requires (agent-tasks/aee9c085). The previous "record N entries" shape was exactly the wrong nudge for a "too many already" deny. `count.min`-only and the combined min/max cases keep the recording phrasing (recording more is the satisfying action).
- `checkApprovalMarker` uses `lstatSync` (not `statSync`) and rejects symlinks at the marker path (agent-tasks/d39f160e). Defense-in-depth: the agent has no Edit / Write / Bash path to plant a symlink under `harness.generated/` today, but the gate's contract is to assume the agent is hostile, so the lstat reject is cheap insurance.

### Docs

- `docs/policy-packs/understanding-before-execution.md` "Approval state" gains a "Marker lifetime and session-id reuse" subsection (agent-tasks/a65c32a8). Documents the no-TTL contract, names the two operator-controlled paths that carry approval across logical session boundaries (manual marker copy, scripted session-id reuse), and points operators at `rm harness.generated/.approvals/<sessionId>` for forced re-approval.

## [0.13.0] - 2026-05-15

**Headline: `harness doctor` detects MCP, hook, and memory-router version drift end-to-end.** PR #125 added the `tools.mcp[]` `min_version` schema + production probe and shipped the load-bearing fix for the prior `tools.cli` no-op (`opts.versionProbe` defaulted to `null` outside tests). PR #126 extended the same contract to `hooks[]` and `memory.router`, lifting the numeric compare into a shared `src/io/version-compare.ts` so all three sites use one implementation. PRs #127 and #128 then activated the surface in FULL_TEMPLATE with three concrete floors so a fresh `harness init` ships the drift signal turned on.

Operator note: a fresh `harness init --template full` now expects three published bins on PATH at the floor versions. Upgrade with `npm i -g @agent-tasks/mcp-bridge@latest @lannguyensi/grounding-mcp@latest @lannguyensi/memory-router@latest` if `harness doctor --shallow` reports an outdated entry.

### Added

- `tools.mcp[].min_version` + `tools.mcp[].version_command` (#125): same shape as the existing `tools.cli[]` fields. `harness doctor` runs a production version probe (`spawnSync` with a 5s timeout) and emits a `versions:` sub-block under `MCP servers`. Outdated entries warn (informational, not error: a stale MCP still works). Empty when no entry has `min_version`, to keep the report quiet by default.
- `hooks[].min_version` + `hooks[].version_command` (#126): both must be present together. Hook commands are arbitrary shell strings (`harness session-start preflight`, `~/.claude/hooks/foo.sh`, npm bins, wrappers) so there is no useful default for `version_command`; `min_version` alone is rejected at validate time. Docs nudge operators to point `version_command` at the underlying source-of-truth binary, not at the wrapper.
- `memory.router.min_version` + `memory.router.version_command` (#126): same default shape as `tools.mcp[]`. The check skips when the router is disabled or the executable cannot be located.
- FULL_TEMPLATE pins (#127 + #128) for the three published bins:
  - `agent-tasks-mcp-bridge`: `min_version: "0.6.0"` (PR agent-tasks/240 added the flag, PR agent-tasks/241 cut the release)
  - `grounding-mcp`: `min_version: "0.2.0"` (PR agent-grounding/76 added the flag, PR agent-grounding/77 cut the release)
  - `memory-router-user-prompt-submit`: `min_version: "0.3.0"` (PR agent-memory/40 added the flag, PR agent-memory/41 cut the release)

### Changed

- `cli/index.ts` now wires `defaultVersionProbe` into the doctor invocation (#125). Prior to this, even the existing `tools.cli[]` `min_version` check was a no-op in production because `opts.versionProbe ?? (() => null)` defaulted to null when no test injected a probe. The fix unblocks `tools.cli`, `tools.mcp`, hook, and memory-router probes alike.
- `src/io/version-compare.ts` (#126): new leaf module exporting `compareNumericVersions`. Lifts the duplicated implementation out of `doctor/index.ts` so `memory.ts` can reuse it without re-creating the runtime/policies cycle that #123 just broke.

### Schema

- `McpServerSchema`, `HookSchema`, and `MemoryRouterSchema` all gain optional `min_version: z.string()` and `version_command: z.string()` fields, validated together where co-required.

## [0.12.0] - 2026-05-15

**Headline: the understanding-gate stack is now operator-recoverable
end-to-end.** The persisted-report directory desync that silently broke
`harness approve understanding` from a second terminal (#116) is closed
by anchoring the path to the manifest at apply time. The lockout class
that twice during install dogfood left a session unable to recover
without a hand-crafted Python snippet now has a first-class reversible
escape hatch: `harness gate disable` / `harness gate enable` (#119).
And two adjacent silent-degradation paths are loud now: `harness approve
understanding` surfaces the standalone Stop-hook's parse-error reason
inline instead of just "no reports found" (#117), and
`harness session-start preflight` no longer pretends success when it
silently falls back to the literal "default" session (#118).

### Added

- `harness gate disable` / `harness gate enable`: reversible operator
  escape hatch for hard-blocking hooks. `gate disable` with no flags
  lists every hook group in `~/.claude/settings.json` with its event,
  index, matcher, and command summary; with `--matcher <substring>` it
  removes every group whose matcher contains the substring, writes a
  snapshot of the removed groups to
  `<settings-dir>/harness.gate-disable.<ts>.json`, and backs up the
  original to `settings.json.bak.<ts>` before the live rewrite. `gate
  enable` restores from the newest snapshot, is idempotent on an
  already-restored file, and refuses when settings.json has been edited
  since the snapshot was taken; `--force` overrides and the restore
  only touches the `hooks` key so every other operator-added top-level
  key is preserved verbatim. Both verbs refuse to operate on a
  settings.json that is not a JSON object, so a broken file is
  surfaced rather than silently rewritten. v1 scope: substring matcher
  + latest-snapshot restore; `--event` filter, `--all`, named-snapshot
  selection ship later if demand surfaces. (#119)
- `harness session-start preflight --session <id>`: explicit session-id
  flag for manual or scripted invocations where no SessionStart event
  JSON is piped on stdin. (#118)

### Fixed

- The `understanding-before-execution` pack's persisted-report
  directory was `path.join(process.cwd(), ".understanding-gate",
  "reports")` with no precedence, so the three actors that touch it
  (the standalone Stop hook, the PreToolUse blocker, and `harness
  approve understanding`) silently diverged whenever the operator
  approved from a second terminal. `defaultReportsDir()` now honors
  `UNDERSTANDING_GATE_REPORT_DIR` ahead of the cwd fallback, and
  `harness apply` bakes
  `UNDERSTANDING_GATE_REPORT_DIR=<manifest-dir>/.understanding-gate/reports`
  onto every command the pack contributes (Stop + PreToolUse, both
  claude-code and codex variants). The path is resolved absolute at
  apply time so the spawned hook process inherits a stable location
  regardless of the cwd Claude Code launches it with. `harness approve
  understanding` uses the manifest directory as the fallback cwd, and
  `harness doctor --target codex` switches to the same resolver so its
  reported writable path matches what the rest of the stack actually
  touches. Same bug class as the v0.10.0 EVIDENCE_LEDGER_DB
  literal-tilde fix. (#116)
- `harness approve understanding` reported "no reports found at <dir>"
  as a silent dead end when the standalone Stop hook fired but its
  `parseReport` rejected the agent's last message (missing sections,
  schema errors, etc). The verb now checks the sibling parse-errors
  directory (`<dir-of-reports>/../parse-errors/`, where the standalone
  package writes its diagnostic logs) and surfaces the newest entry's
  `message` or `reason` plus optional `missing[]` array inline in the
  diagnostic. Format-tolerant: the JSON header is preferred, with a
  freeform-line fallback so future Stop-hook log-format changes still
  surface something. Missing parse-errors dir stays silent. (#117)
- `harness session-start preflight` invoked manually (no SessionStart
  event piped on stdin, `$CLAUDE_SESSION_ID` unexported) recorded its
  `preflight:` tags under the literal session `"default"`. The success
  line read as if the producer worked, but no `preflight-before-*`
  policy queries `"default"`, they query the real Claude Code session
  id, so the tag was a no-op. The resolver now mirrors `harness approve
  understanding`'s chain: `--session` flag → stdin `event.session_id`
  → `$CLAUDE_SESSION_ID` → newest Claude Code transcript (the same
  heuristic `harness audit` / `harness explain --trace` use) → literal
  `"default"`, with a loud stderr WARNING when the fallback hits
  explaining that the recorded tag will not satisfy any
  preflight-before-* gate. The result also exposes `sessionId` +
  `sessionSource` for in-process callers. (#118)

## [0.11.0] - 2026-05-14

**Headline: the policy layer works end-to-end and is legible.** The
founding-incident preflight loop is now closed: `harness session-start
preflight` produces the `preflight:${REPO}` / `preflight:${BRANCH}` tags
(#111), `${REPO}` / `${BRANCH}` resolve per-repo instead of collapsing
to one global `preflight:` tag (#110), and `harness audit` /
`explain --trace` can finally read the decisions the engine records
(#108). `harness doctor` now surfaces a `block` policy that has no
producer for its required tag (#109) instead of reporting it healthy.
And the understanding gate no longer hard-locks a session: its hook
asks instead of denying for the operator-approval command (#105), which
resolves the session id from a staging file with no arguments (#107).

### Added

- `harness session-start preflight`: the SessionStart producer for the
  `preflight-before-*` policies. The Full template restores its
  `git-preflight` hook wired to this command; it runs `agent-preflight`
  (`preflight run --json <cwd>`) against the session cwd and, on a
  `ready:true` result, records one ledger fact carrying both
  `preflight:${REPO}` and `preflight:${BRANCH}` so it satisfies
  `preflight-before-investigation` (REPO, within 1h) and
  `preflight-before-push` (BRANCH, within 10m). Both are resolved with
  the same git-context walk the intercept engine uses, so producer and
  consumer agree on the tags. Caveat: a SessionStart producer cannot
  keep the 10m push window fresh through a long session, so
  `preflight-before-push` benefits from a push-time refresh that this
  hook does not provide. A `ready:false` result deliberately leaves the
  tags unwritten so the gates stay closed. SessionStart hooks are
  `blocking:false`: a missing `preflight` binary, a timeout, or an
  unreachable ledger logs one line to stderr and exits 0, never
  breaking the session. The Full init profile now lists
  `@lannguyensi/agent-preflight` so the wizard offers to install it. (#111)
- `harness doctor` now flags a `block`-enforcement policy whose required
  ledger tag carries a `requires.within` freshness window but has no
  producer hook in the manifest. Such a policy needs the tag kept fresh,
  so with nothing producing it the gate silently walls off whatever it
  triggers on while doctor still reports it healthy. Producer detection
  is a coarse substring match of the tag prefix against hook commands,
  excluding the policy's own consumer hook: it is a floor, so "no
  producer found" is reliable but "producer found" is heuristic and can
  miss tag-suffix or cadence mismatches. Policies without a `within`
  window are not flagged, since a one-time tag is supplied by the normal
  review / PR workflow. Each gap counts as a doctor warning. (#109)
- `harness approve understanding` now resolves the session id from a
  `harness.generated/.pending-approval` staging file when neither
  `--session` nor `$CLAUDE_SESSION_ID` is given. The
  `understanding-before-execution` PreToolUse hook writes the blocked
  session's id to that file on every block or ask, so an arg-less
  `harness approve understanding` run from the operator's `!`-shell (where
  `$CLAUDE_SESSION_ID` is not set) resolves the exact id instead of the
  operator hand-deriving it from the newest project transcript. The CLI
  prints which tier supplied the id, and the staging file is consumed on a
  successful approve so a later call cannot revive a stale id. (#107)

### Fixed

- The `${REPO}` and `${BRANCH}` policy-template builtins resolved only
  from the `HARNESS_REPO` / `HARNESS_BRANCH` env vars, which nothing
  sets, so every `preflight:${REPO}` and `preflight:${BRANCH}` ledger
  tag collapsed to the literal `preflight:`. That silently degraded the
  founding-incident policies to one session-global tag: a preflight run
  in repo A satisfied the gate in repo B, defeating the per-repo
  isolation the policies are written to provide. The intercept engine
  now derives `REPO` (work-tree basename) and `BRANCH` from the tool
  event's `cwd` via a bounded filesystem walk (no `git` subprocess, so
  it stays cheap on the per-tool-call hook path); the env vars are kept
  as an explicit operator override. `harness dry-run` resolves them the
  same way so its prediction matches runtime. (#110)
- `harness audit` and `harness explain --trace/--last` reported "no
  policy decisions" even though `harness policy intercept` had recorded
  them: the readers resolved the session id via `resolveSessionId`,
  which falls back to the literal `"default"` session when neither
  `--session` nor `$CLAUDE_SESSION_ID` is set, and Claude Code does not
  export `$CLAUDE_SESSION_ID` into the Bash tool environment. The
  read path now uses `resolveReadSessionId`, which adds a
  transcript-discovery tier: it reads the live session id off the newest
  `~/.claude/projects/*/<uuid>.jsonl`. The write path (`policy
  intercept`) is unchanged. Separately, `realLedgerClient.record` no
  longer discards `recordPolicyDecision`'s failure result; a failed
  audit write now emits a one-line stderr diagnostic. (#108)
- The `understanding-before-execution` policy pack's PreToolUse hook
  hard-denied every `Edit`/`Write`/`Bash` call until an Understanding
  Report was approved, including `harness approve understanding` itself (a
  Bash call caught by the same matcher). A hook `deny` gives no interactive
  prompt, so the gate could lock a session out with no in-session recovery.
  The hook now emits `permissionDecision: "ask"` for the operator-approval
  command `harness approve ...` instead of `"deny"`: Claude Code surfaces
  the normal permission prompt, and the operator's approval of that prompt
  is the human approval the gate was waiting for. The escape-command match
  is strict (no shell chaining, substitution, or redirection), so it cannot
  be used to smuggle other work past the gate. (#105)

## [0.10.0] - 2026-05-14

**Headline: the init wizard becomes a real installer, the Full template
goes self-contained, and a class of cwd-relative path footguns is closed.**
Operators on `npm i -g @lannguyensi/harness` were still on v0.9.1 behavior:
a stale agent-tasks MCP template, a buried apply hint, unbundled Full
hooks, and a literal-tilde `EVIDENCE_LEDGER_DB` env that scattered rogue
ledger databases. This release ships those fixes plus a hardened publish
workflow and a policy-matching correctness fix.

### Added

- `harness init --interactive` is now a real installer: it runs a
  per-profile dependency check, offers to `npm i -g` the missing packages
  with operator permission, and aborts cleanly with a manual-install
  fallback on failure. A wire-now prompt at the end offers to run
  `harness apply` immediately. Full is surfaced as a fourth wizard
  profile. (#98)

### Changed

- `harness init` templates now reference published bin names
  (`agent-tasks-mcp-bridge`, `memory-router-user-prompt-submit`,
  `grounding-mcp`) instead of `~/git/pandora/...` local paths. The Full
  template is self-contained: its PreToolUse hooks run through the bundled
  `harness policy intercept` engine, so no external shell scripts are
  required. Full now also ships `Glob` + `Grep` in `builtin.known` and
  includes the understanding-before-execution policy pack. (#98, #100)
- `harness apply` Next-steps now leads with the user-global
  `--target ~/.claude/settings.json --merge` recommendation, and uses a
  softer lede on no-op re-runs. Hooks with an identical
  `(command, timeout)` inside one matcher group are deduplicated. (#97)
- `.github/workflows/publish-npm.yml` retries the `npm publish` step up to
  3 times with exponential backoff to ride out transient Sigstore Rekor
  `TLOG_CREATE_ENTRY` 409s, short-circuits when the version is already on
  the registry, and gains a `workflow_dispatch` trigger with a `tag` input
  so a release can be re-published without re-tagging. (#102)

### Fixed

- `harness init`: the interactive wizard wired a stale agent-tasks MCP
  template, `harness apply`'s target was not surfaced clearly, and a
  `{project}` memory-dir pattern produced a false-positive warning. (#97)
- `harness doctor` treats `{project}` patterns as informational rather
  than a warning. The memory-router probe resolves bare bin names through
  `PATH` and guards against `node` / `npx` / wrapper false positives.
  (#97, #100)
- `harness approve understanding`: the no-session-id error message is
  expanded with concrete one-liners for retrieving the active session id.
  (#100)
- `grounding-mcp` wiring: the literal-tilde `EVIDENCE_LEDGER_DB` env block
  is removed from the Team and Full templates. It expanded to a literal
  `~` directory and scattered rogue `<cwd>/~/.evidence-ledger/` databases
  on every spawn cwd; the ledger now resolves to `~/.evidence-ledger/` via
  `os.homedir()`. An apply-time warning catches operators still carrying
  the old wiring. (#101)
- Policy `bash_match` regexes in the reference manifest
  (`preflight-before-investigation`, `preflight-before-push`,
  `dogfood-before-release`) were start-anchored (`^git push`), so a
  command that did not literally begin with the pattern, such as
  `cd <repo> && git push`, `git -C <repo> push`, or an env-var-prefixed
  `git push`, slipped past the gate ungated. The patterns now match at
  command position: start of string, or after `;`, `|`, `&&`, `(`, a
  newline, or optional env-var assignments. String-argument mentions like
  `git commit -m "...git push..."` and `echo "git status"` are not
  false-positives. (#103)
- CI: the interactive-wizard tests no longer shell out to a real
  `npm i -g` on CI runners. (#99)

## [0.9.1] - 2026-05-13

**Headline: wizard hint fix + two new canonical example policies.** A
patch release for the surface that shipped in v0.9.0. The interactive
wizard printed a `harness apply --runtime claude` follow-up that was
not a valid runtime value (`claude-code` and `codex` are accepted, not
`claude`); operators who ran `harness init --interactive` on v0.9.0
saw the wrong instruction. Fixed in source and the documentation
echo, plus a regression test that locks the corrected hint. The
reference manifest gains two more example policies covering incident
classes already documented in the operator's memory log.

### Fixed

- `harness init --interactive`: the wizard's "Next:" hint after a
  successful run now prints `harness apply --runtime claude-code`
  (not `harness apply --runtime claude`, which fell back to the
  default at runtime with a warning). Source fix in
  `src/cli/init/interactive.ts` and the matching echo in
  `docs/init-interactive.md`. Regression guard locked in
  `tests/cli/init-interactive.test.ts` so the next drift fails loudly.
  (#94)

### Changed

- `docs/for-humans.md`: added a "First-time setup (recommended)"
  block that walks operators through `harness init --interactive`
  before the manual template path; replaced the bogus
  `--template starter` invocation with `--template solo` and listed
  the four valid templates. (#94)
- `docs/for-agents.md`: split the CLI cheat-sheet's `init` row into
  `init --template`, `init --interactive`, and `init --probe` (the
  last is read-only); added rows for `pack add/remove/list`,
  `approve understanding`, and `doctor --target codex`. (#94)
- `README.md`: one-line bridge from the "Try it in 60 seconds"
  dry-run pitch to `npm i -g @lannguyensi/harness && harness init
  --interactive` so readers can graduate from evaluation to install
  without scrolling. (#94)

### Added

- Two new canonical policy patterns in
  `docs/examples/full-manifest.yaml` and
  `src/cli/init/templates.ts:FULL_TEMPLATE`:
  `review-subagent-before-pr-create` gates
  `mcp__agent-tasks__pull_requests_create` on a
  `review-subagent:${TASK_ID}` ledger entry (stronger than
  `review-before-merge` because the rigorous review subagent must
  have actually run BEFORE the PR opens). `preflight-before-push`
  gates `Bash` matching `^git push` on a fresh `preflight:${BRANCH}`
  entry with `within: 10m` (complements the read-side
  `preflight-before-investigation`). Both policies wired into the
  init template so `harness init --template full` produces a
  manifest consistent with the example file. Field-level invariants
  locked in `tests/schema.test.ts`. (#95)
- `docs/for-humans.md`: "More policy patterns" section that walks
  operators through both new gates plus `dogfood-before-release` as
  a coherent set. (#95)

## [0.9.0] - 2026-05-13

**Headline: guided onboarding.** `harness init` grows three new entry
points so first-time operators do not have to hand-author a manifest.
`harness init --interactive` runs a wizard via `@inquirer/prompts` that
detects the environment, picks a profile, and writes a validate-clean
starting manifest. `harness init --template solo|team` lands the two
new opinionated profile templates non-interactively. `harness init
--probe` prints a read-only JSON snapshot of what the harness sees in
the operator's config dirs.

### Added

- `harness init --interactive`: guided wizard that detects the
  environment, picks a profile (Solo / Team / Custom), confirms a
  memory directory, writes the manifest, and runs `harness validate`.
  Aborts cleanly on Ctrl-C with no partial write. The wizard never
  invokes `harness apply` itself, it prints the suggested command and
  lets the operator review the manifest first. Adds `@inquirer/prompts`
  as a runtime dependency. Operator docs: `docs/init-interactive.md`.
  E2E smoke: `dogfood/interactive-init/scripted-solo.mjs`.
- `harness init --template solo|team`: two new opinionated profile
  templates beside the existing `minimal` / `full` pair. `solo` wires
  memory-router plus the `understanding-before-execution` policy pack.
  `team` extends solo with the `agent-tasks` MCP server,
  `grounding-mcp` (required for policy enforcement to bind, per
  `feedback_harness_policies_warn_mode`), and the `review-before-merge`
  policy. Both profiles pass `harness validate` cleanly. The `team`
  hook command uses the built-in `harness policy intercept` CLI verb,
  so no per-policy shell script under `~/.claude/hooks/` needs to exist
  for the gate to fire.
- `harness init --probe`: read-only JSON snapshot of detected runtimes
  (Claude Code, Codex), the existing `~/.claude/harness.yaml`, and MCP
  servers wired in Claude's `settings.json`. Foundation for the
  `init --interactive` wizard, standalone-useful for operators
  debugging what the harness sees in their environment.

### Changed

- The README's first-time-setup path now points at
  `harness init --interactive` instead of jumping straight to `dry-run`.

## [0.8.1] - 2026-05-11

**Headline: policy-pack enforcement actually blocks now.** 0.8.0 shipped
the runtime intercept, the ledger plumbing, and the manifest schema, but
the deny path was effectively observability-only: Claude Code never
honoured the hook output shape harness emitted, so a denied tool call
proceeded to the MCP transport and only failed at the downstream
service. Live verification on 2026-05-11 against
`mcp__agent-tasks__pull_requests_merge` with no matching
`review:${PR_NUMBER}` ledger entry confirmed the new build is refused
at the hook layer, before reaching agent-tasks. Operators on 0.8.0
should upgrade.

### Changed

- `harness policy intercept` now writes a one-line stderr diagnostic
  when the manifest has policies but none of them matched the inbound
  event, e.g. `no policy matched event hook_event_name=(missing)
  tool_name="..." (registered policy events: PreToolUse). If probing
  by hand, ensure stdin includes hook_event_name (...).`. Previously
  the engine exited 0 with empty stdout in that case, so an operator
  hand-probing the CLI without `hook_event_name` saw what looked like
  "the policy did not load" while the real cause was just a stripped
  trigger field. The hint fires unconditionally (not gated on
  `--verbose`) and stdout is unchanged, so the Claude Code hook
  contract is preserved. Also extends the `harness policy intercept`
  command help with the documented stdin shape so the next operator
  does not have to source-dive. (Tracked as `harness#4fef0e1f`.)

### Fixed

- `harness policy intercept` now emits a Claude Code hook output that
  Claude Code actually honours as a deny. Previously the CLI wrote
  `{"decision":"deny","reason":...}`, which Claude Code parsed as "no
  recognised decision" (the documented top-level value is `"block"`,
  not `"deny"`) and let the tool call proceed; the policy ran, the
  `policy_decision` row landed in the ledger, but the agent still
  merged. The new payload always carries the documented top-level
  `decision: "block"` field, and for PreToolUse events it additionally
  emits the `hookSpecificOutput.permissionDecision: "deny"` envelope
  Claude Code 2.1+ prefers. Non-PreToolUse events (UserPromptSubmit,
  PostToolUse, Stop, ...) get the top-level form only, since
  `permissionDecision` is PreToolUse-only per Anthropic's hook
  protocol. Repro for the regression was a
  `mcp__agent-tasks__pull_requests_merge` call with no matching
  `review:${PR_NUMBER}` ledger entry: it reached agent-tasks and 404'd
  there instead of being blocked at the hook. The sibling
  Understanding-Gate emitter at `src/cli/pack/hook-pre-tool-use.ts`
  was unaffected; it already emits `decision: "block"`, though it does
  not yet carry the modern envelope. (Tracked as `harness#2436d9bf`.)

## [0.8.0] - 2026-05-10

**Headline: Understanding-Gate Policy Pack, end-to-end.** Phase 6 lands
the *Policy Pack* concept as a first-class harness unit: a reusable
bundle of instruction template, hooks, policies, and permission
profiles that ships under one name and is referenced from
`harness.yaml` with one key. The first showcase pack,
`understanding-before-execution`, forces an agent to expose its task
interpretation, an Understanding Report, before any write-capable
tool fires. The user confirms or corrects; only after explicit
approval is recorded as evidence may the agent edit, run shell,
commit, push, or open a PR. The pack ships across two runtimes
(Claude Code and Codex), three permission profiles
(`safe-start` / `implementation-after-approval` / `high-risk-grill-me`),
a CLI surface (`harness pack add / remove / list`,
`harness apply --runtime <runtime>`, `harness approve understanding`,
`harness doctor --target codex`), and a synthetic-stdin dogfood smoke
under `dogfood/phase6-6/` that exercises block, allow, capture, and
approve round-trips without a real Codex binary.

Operator note: no schema bump (still `version: 1`). New manifest blocks
(`policy_packs:`, `permission_profiles:`) are additive and default to
empty, so `0.7.0` manifests parse byte-identically. Manifests with the
pack enabled need a one-time `harness apply` after upgrade so the new
`harness pack hook pre-tool-use` blocker replaces the npm package's
standalone bin in the rendered `settings.json`. Ensure `harness` is on
`$PATH` (`npm i -g @lannguyensi/harness@0.8.0`) before the next session
starts.

### Added
- Phase 6 #6 follow-up: `harness pack hook codex-stop` captures the
  agent's Understanding Report into
  `.understanding-gate/reports/<iso>-codex-<sessionhash>.json` with
  `approvalStatus: "pending"`. Wire format on stdin accepts either
  `last_assistant_message` directly or a `messages[]` array (the last
  assistant entry is used). The parser recognises markdown headings,
  bold labels, and plain colon-prefixed labels for the six report
  fields (interpretation, assumptions, openQuestions, outOfScope,
  risks, verificationPlan), with synonym support (Questions,
  Exclusions, Validation). Failure modes (malformed input, missing
  session id, unwritable reports dir, no recognisable fields)
  resolve to exit 0 + a stderr diagnostic; capture must never block
  the agent's stop path. The Codex pack now contributes a Stop hook
  alongside UserPromptSubmit and PreToolUse. Closes agent-tasks
  `adf356a0`.
- Phase 6 #6 follow-up: `harness doctor --target codex` evaluates the
  harness side of the Codex adapter (binary resolution, harness-managed
  `harness.generated/codex/config.toml` presence + banner, contributed
  `[[hooks.*]]` command resolution, and persisted-report directory
  writability). Codex error/warning counts roll into the top-level
  totals; `--json` adds a structured `codexTarget` block to the
  `DoctorReport`. The default `harness doctor` invocation is
  unchanged. Closes agent-tasks `125fd02b`.
- Phase 6 #6: Codex adapter for the `understanding-before-execution`
  policy pack. New CLI flag `harness apply --runtime codex` emits
  `harness.generated/codex/config.toml` (TOML hook stanzas) instead of
  `settings.json`; operators copy or include the generated TOML into
  their own `~/.codex/config.toml`. Two new pack hook subcommands ship:
  `harness pack hook codex-pre-tool-use` (PreToolUse blocker on
  `apply_patch|Bash|shell`: exit 2 + reason on stderr when no source
  has approved, exit 0 otherwise) and `harness pack hook
  codex-user-prompt-submit` (instruction-template injector that emits
  the Understanding-Gate prompt on stdout for Codex to prepend to
  `additional_instructions`). The Codex blocker shares the
  approval-check pipeline with the Claude Code blocker (ledger source
  via grounding-mcp + persisted report under
  `.understanding-gate/reports/`, either approves). Synthetic-stdin
  smoke under `dogfood/phase6-6/` exercises block + allow paths
  end-to-end without a Codex binary. `--target` is rejected with
  `--runtime codex` (target wires Claude Code's `settings.json`, not
  produced under codex). Phase 6 #6 follow-ups filed as separate
  agent-tasks entries: `harness doctor --target codex` adapter-health
  check; Codex Stop-equivalent for transcript capture; permission
  profile translator into Codex's sandbox shape.
- Phase 6 anchor: additive `policy_packs:` manifest block (schema-only;
  no runtime behaviour yet). Each entry has `name`, `source`
  (default `builtin`), `enabled`, optional `description`, and an
  opaque `config:` record validated by the pack itself at resolve
  time. Duplicate names rejected at parse time; `.strict()` rejects
  unknown keys per entry. The block defaults to `[]` so manifests
  written for `0.7.0` parse byte-identically.
- `docs/policy-packs/understanding-before-execution.md`: canonical
  documentation for the first Policy Pack, covering target
  architecture, manifest reference, mode semantics, permission-profile
  sketches, adapter notes for Claude Code / OpenCode / Codex, and the
  two-source approval-state model (evidence-ledger tag for harnessed
  sessions; persisted JSON report for solo `@lannguyensi/understanding-gate`
  users). Phase 6 #2 through #6 will wire the surfaces this doc
  describes; see `docs/ROADMAP.md` for the sub-task decomposition.
- `docs/examples/full-manifest.yaml` carries the canonical
  `understanding-before-execution` pack as a worked example; the
  byte-for-byte `harness describe` golden test covers the resulting
  output.
- Phase 6 #2: `harness apply` now expands enabled `policy_packs[]`
  entries into hook contributions and an operator audit copy. For the
  builtin `understanding-before-execution` pack this writes three
  namespaced hooks into the generated `settings.json`
  (`UserPromptSubmit` injector, `Stop` capture, `PreToolUse` blocker
  matching `Edit|Write|Bash`, all pointing at the
  `@lannguyensi/understanding-gate` bins) and an audit copy at
  `harness.generated/policy-packs/<name>/instructions.md`. Pack files
  flow through the existing three-state-compare + lock pipeline, so
  drift on the audit copy is caught by `harness apply` and surfaced in
  `harness diff --since-apply`. `enabled: false` skips the pack
  entirely. `harness validate` rejects an enabled pack with an
  unrecognised source (only `builtin` resolves in v1) or an unknown
  builtin name. Phase 6 #4 will add the harness-side ledger-aware
  PreToolUse blocker; the standalone blocker shipped in
  `@lannguyensi/understanding-gate@>=0.2.0` is already wired today.
- Phase 6 #3: new `harness pack` CLI subtree for managing `policy_packs[]`
  declaratively. `harness pack add <name>` performs a schema-validated
  insert (rejects unknown source/name pre-flight, then the schema
  superRefine catches duplicates). `harness pack remove <name>` is
  reference-checked against `.last-apply`: it refuses without `--force`
  when applied state is present, and `--force` removes the manifest
  entry, deletes the on-disk pack files under
  `harness.generated/policy-packs/<name>/`, and prunes the
  corresponding `.last-apply` entries so a follow-up `harness apply`
  reconverges in one step. `harness pack list [--enabled-only] [--json]`
  prints a flat table or pipeable JSON.
- Phase 6 #4: harness-side PreToolUse blocker + approve flow. The
  `understanding-before-execution` pack now ships its `PreToolUse` hook
  pointing at the new `harness pack hook pre-tool-use` runtime verb
  (was: the npm package's standalone bin). The harness blocker is the
  superset: it consults BOTH the evidence-ledger tag
  `understanding-approved:${SESSION_ID}` (via grounding-mcp's
  `ledger_summary`, canonical for harnessed sessions) AND the
  persisted JSON report under `.understanding-gate/reports/` (fallback
  for sessions without grounding-mcp wired). Either source approves;
  neither blocks the tool call with a Claude-Code-shaped deny JSON
  containing the actionable next step (`run \`harness approve
  understanding\``). Failure modes (manifest unreadable, pack disabled,
  no session id) resolve to allow with a stderr diagnostic, so the
  Understanding Gate never bricks a session. Ledger matching filters
  out `policy_decision` audit rows (typed and legacy-prefix backstop)
  so a policy decision whose serialised reason field happens to
  contain the approval substring cannot falsely approve.

  **Breaking change for users with `understanding-before-execution`
  enabled**: the regenerated `settings.json` calls `harness pack hook
  pre-tool-use` instead of the npm bin. Run `harness apply` after
  upgrading, and ensure `harness` is on `$PATH` (e.g.
  `npm i -g @lannguyensi/harness`) before the next session starts.
- New `harness approve understanding [--session <id>] [--reports-dir
  <path>] [--approved-by <actor>]` CLI verb that round-trips both
  approval sources: writes the `understanding-approved:${SESSION_ID}`
  ledger tag via `grounding-mcp`'s `ledger_add` AND flips
  `approvalStatus: "approved"` on the latest matching persisted JSON
  report (atomic rewrite). A degraded ledger surfaces as a one-line
  warning, not a hard failure, so a solo
  `@lannguyensi/understanding-gate` user without `grounding-mcp` wired
  still benefits from the persisted-report path.
- New generic `runtime/ledger-add.ts` writer mirroring the structural
  shape of `recordPolicyDecision` but exposed for non-policy-decision
  fact rows. Used by `harness approve understanding`; available to any
  future pack that wants to emit a session-tagged ledger entry without
  encoding a policy-decision payload.
- Phase 6 #5: permission profiles. New top-level `permission_profiles:`
  manifest block (additive, defaults to `{}`), with three v1 builtins
  bundled with the `understanding-before-execution` pack: `safe-start`
  (pre-approval default), `implementation-after-approval` (post-
  approval working profile), and `high-risk-grill-me` (high-friction
  for security / infra surfaces). Selection via the pack's
  `config.permission_profile`. Profile actions (`read` / `edit` /
  `bash` / `commit` / `push` / `pr` / `deploy`) translate to Claude
  Code's `permissions: { allow, ask, deny }` block at apply time;
  the new translator emits canonical tool patterns
  (`Edit`/`Write`/`MultiEdit` for `edit`, `Bash(git commit*)` for
  `commit`, etc.). `limited` and `ask_or_deny` collapse onto `ask`
  for v1 (Claude Code does not natively distinguish them); finer-
  grained shaping is a Phase 6 #5 follow-up. When multiple packs
  contribute permissions, the merge follows
  deny-wins-over-ask-wins-over-allow precedence: a stricter intent
  from any pack is not silently relaxed by a more permissive
  sibling. Profiles compose with the Phase 6 #4 PreToolUse blocker:
  the static permissions block is the always-applies floor, the
  blocker handles the conditional approval gate on top.

## [0.7.0] - 2026-05-06

**Headline: workflows-as-data and full-session audit forensics.** The
`workflows:` block (PR #66) lets adopters declare branch policy,
review-subagent gating, and merge method as schema-validated data
instead of prose in memory files. `harness session-export <sessionId>`
(PR #67) joins the on-disk Claude Code transcript JSONL with the
evidence ledger for the same session and emits a single chronologically
ordered audit artifact, with default-on regex redaction extended by a
new optional `audit.redact[]` manifest block. The README is split into
audience-specific guides (`docs/for-humans.md`, `docs/for-agents.md`)
and gains a control-loop flowchart that both audiences read
identically. `harness explain --last` closes the "what just denied me?"
loop without needing the policy name. No runtime enforcement of
`workflows:` yet; that ships as a follow-up.

Operator note: no schema bump (still `version: 1`). All new manifest
fields are optional and additive; manifests written for `0.6.0` parse
under `0.7.0` byte-identically. The new `audit.redact[]` defaults to a
denylist that catches the four obvious key/secret patterns even when
the operator declares no `audit:` block, so existing operators get
redaction-on-by-default for `session-export` for free.

### Changed
- `docs/for-agents.md` workflow lifecycle stateDiagram is now anchored
  on the four step kinds the `workflows:` schema actually defines
  (`branch`, `review_subagent`, `ci_gate`, `merge`) instead of
  agent-tasks-MCP-specific verbs (`task_start`, `open` / `in_progress` /
  `done`). A new "If you use agent-tasks MCP" footnote below the
  diagram maps the lifecycle markers to the concrete MCP verbs as one
  example integration; other task systems fit the same lifecycle.
  Spotted right after the audience split landed (PR #69).
- Root `README.md` gains a control-loop flowchart ("What harness does":
  declare, apply, enforce, record, observe, refine) that both
  audiences read identically. No audience-specific verbs (PR #69).
- Docs split into two audience-specific surfaces:
  `docs/for-humans.md` (operator guide: install, mental model, first
  hour, diagnostics cheat sheet) and `docs/for-agents.md` (workflow
  lifecycle, policy/ledger sequence, CLI cheat sheet by side-effect
  class, audit triumvirate). README shrunk to a landing page that
  picks audience, with the `Try it in 60 seconds` block, status
  checklist, and `Why this exists` preserved. Three mermaid diagrams
  added: a system flowchart in `for-humans.md`, a workflow
  stateDiagram and a policy/ledger sequenceDiagram in
  `for-agents.md`. Docs-only, no source changes (PR #68).

### Added
- `harness explain --last` traces the most recent policy decision in the
  evidence ledger without needing the policy name, closing the common
  "I just got a deny, what fired?" loop in one command instead of three.
  Pair with `--decision allow|deny|warn-degraded` to skip past intervening
  outcomes. `<policy>` and `--last` are mutually exclusive (PR #65).
- `harness session-export <sessionId>` joins the on-disk Claude Code
  transcript JSONL (`~/.claude/projects/<projectDir>/<sessionId>.jsonl`)
  with evidence-ledger rows for the same session and emits a single
  chronologically-ordered audit artifact. `--format json` (default) and
  `--format jsonl` ship in v1; `-o <file>` writes to disk. Each event
  carries an explicit `source: "transcript" | "ledger"` marker so the
  export is traceable back to its inputs (PR #67).
- New optional `audit.redact[]` block in the manifest. Each entry is
  either `{ regex, replacement? }` or `{ env_var, replacement? }`;
  `env_var:` resolves to the actual value at export time and
  string-replaces it. A default denylist (token / secret / password /
  api_key) ships even when the manifest declares no `audit:` block, so
  redaction is on by default. Manifests without `audit:` parse
  unchanged (PR #67).
- Additive `workflows:` and `review_templates:` top-level blocks in the
  manifest (still `version: 1`). Lets adopters declare review-subagent
  gating, branch policy, CI gate, and merge method as data instead of
  prose in memory files. The schema rejects duplicate workflow names,
  unknown step `kind` values, `spawn: required` without a `template`,
  and `template:` references not defined in `review_templates`. Surfaces
  via `harness describe --pillar workflows`, `harness list workflows`,
  and a new `Workflows` section in `harness doctor`. No runtime
  enforcement yet, that ships as a follow-up. Manifests without
  `workflows:` parse identically to before (PR #66).

## [0.6.0] - 2026-05-03

**Headline: the Phase-5 adoption-blocker cycle closes end-to-end.**
`harness apply` now writes directly into a Claude Code settings
discovery path (`--target` + `--merge`), translates the manifest's
`tools.mcp[]` into the settings.json `mcpServers` block (so a real
`claude -p --settings <apply'd>` session actually loads them), prints
a Next-steps hint that names the real wire-up commands instead of
leaving adopters to guess, and `harness adopt` round-trips hand-edits
to `mcpServers` back into the manifest. The full
`apply → hand-edit → adopt → apply` cycle is byte-identical on the
settings.json bytes.

Operator note: no schema changes; `harness.lock` gains an optional
`target` entry kind (additive). Existing `harness.lock` files without
target entries continue to parse. The new flags on `apply` are all
opt-in; the default invocation still writes to `harness.generated/`.
Per-package version bumped from 0.5.0 to 0.6.0; this is the first
minor release on the `@lannguyensi/harness` npm distribution. No
operator action required beyond `npm i -g @lannguyensi/harness@0.6.0`
on machines running the published binary.

### Added

- **`harness apply --target / --merge / --force`** (task `d38f6f91`, PR #58):
  write the rendered settings.json directly into a Claude Code settings
  discovery path (e.g. `.claude/settings.local.json` or
  `~/.claude/settings.json`). `--merge` does a 3-way merge that replaces
  harness-owned top-level keys (today: `hooks`, `mcpServers`) and preserves
  everything else. `harness.lock` records the target sha so `validate
  --check-lock` flags out-of-band edits. Closes the adoption blocker that
  forced every adopter into a hand `cp` or per-invocation `--settings`.
- **`apply` translates `tools.mcp[]` into the settings.json `mcpServers`
  block** (task `62380337`, PR #59). The Phase 5 #1a caveat is closed:
  `init.mcp_servers` in a `claude -p --settings <apply'd>` session now
  contains the manifest's MCP entries. Disabled servers (`enabled: false`)
  are omitted; warnings (not errors) cover entries that survive schema
  but produce no runnable command. String-form commands with embedded
  whitespace in paths must be expressed as the array form to preserve
  token boundaries.
- **`apply` prints a Next-steps hint after a successful run** (task
  `517aa919`, PR #60). After the summary line, the CLI prints concrete,
  copy-pasteable next actions: one-shot `claude -p --settings ...`,
  project-scope `harness apply --target .claude/settings.local.json`,
  and user-global `harness apply --target ~/.claude/settings.json --merge`.
  When `--target` was actually written, the hint collapses to a single
  verify line with `--settings <targetPath>` included (so non-canonical
  target paths still resolve through `claude -p`). Two new flags pair
  with this: `--quiet` suppresses the hint while keeping the summary,
  and `--json` emits a machine-readable JSON summary instead of prose
  (implies `--quiet`; refusal outcomes still set non-zero exit).
  Motivated by a 2026-05-03 hallucination incident where an agent
  fabricated a non-existent `claude -p --output-dir` flag because
  nothing in the apply output guided the wire-up step; both unit and
  CLI integration tests assert the hint never contains `--output-dir`.
- **`adopt` reverse-projection for `mcpServers` into `tools.mcp[]`**
  (task `7059d92b`, PR #61). Closes the round-trip gap: hand-edits to
  settings.json's `mcpServers` block can now be captured back into the
  manifest. New entries are appended; same-name entries with different
  command/env are replaced (preserving manifest-only fields like `health`
  and `enabled: false`, so adopting a hand-edit does not silently wipe
  doctor/probe/policy metadata). The full
  `harness apply --target ... --merge → hand-edit → harness adopt → harness apply`
  cycle is byte-identical on the settings.json bytes.

### Notes for upgraders

- The settings.json output now includes a `mcpServers` key when your
  manifest declares enabled MCP servers. On the first apply after
  upgrade, the file grows by that block. The three-state compare handles
  this safely (no spurious drift-refuse on the generated file), but if
  you have hand-edited a `mcpServers` block into a previously apply'd
  settings.json, the next apply will refuse (`drift-refuse`) until you
  reconcile via `harness adopt` or `--overwrite-drift`.

## [0.5.0] - 2026-05-01

**Phase 5: dogfood + polish.** Phase 4 shipped policies that fire; Phase 5
ran them end-to-end against real grounding-mcp + the live SQLite ledger,
caught the bugs that surfaced, and turned the whole feedback loop into a
quality-of-life pass over `audit`/`explain`/`policy intercept`. The
package is now also distributed under `@lannguyensi/harness` on npm
(install with `npm i -g @lannguyensi/harness` and use `harness ...` from
the command line).

The killer-test from the founding incident still works exactly the same
way; this release is about it staying that way under realistic
operational pressure.

### Added

- **`harness policy intercept --verbose`** (Phase 5 #3, PR #44) — opt-in
  stderr diagnostics for non-allow decisions: policy name, ledger_tag,
  matched count, reason, and sorted extract values. Default off; v0.4.0
  byte-equivalent. Also enabled via `HARNESS_POLICY_VERBOSE=1`
  (case-insensitive disable: `0`/`false`/`no`/`off`).
- **`$CLAUDE_SESSION_ID` env fallback** (Phase 5 #2, PR #43) for
  `audit`/`explain --trace`/`policy intercept` when `--session` is
  omitted. Real Claude Code sessions arrive via `event.session_id`, so
  reads under the literal `"default"` were silently invisible. New
  precedence: explicit > env > `"default"`.
- **`policy_decision` first-class entry type** (Phase 5 #4, PR #47) via
  the matching `@lannguyensi/evidence-ledger@0.2.0` change. Writer
  tries `type='policy_decision'` and falls back to legacy `type='fact'`
  on an old server. Reader tags rows with their bucket-derived type so
  the requires evaluator can drop policy-decision rows without the
  substring-pollution that inflated `matchedCount` in PR #39's dogfood.
  Legacy `policy_decision:`-prefixed `fact` rows are also dropped via a
  content-prefix backstop so upgraded users don't keep paying the
  pollution tax until their dev ledger ages out.
- **Server-side `audit` filter pushdown** (Phase 5 #5, PR #46) via the
  matching evidence-ledger 0.2.0 change. `audit` now passes
  `sinceIso` (derived from its `--since` cutoff) and
  `contentPrefix: "policy_decision:"` to `ledger_summary`. Capability
  detection via `tools/list` keeps it back-compatible with old servers
  (filter args are dropped silently when not advertised). Hot path
  (no filter requested) skips `tools/list` entirely.
- **`dogfood/phase5/`** — reproducible smoke driver against real
  grounding-mcp + live SQLite ledger (Phase 5 #1, PR #39). All five
  gates (deny / ledger_add / silent allow / 5m audit / 24h audit /
  explain --trace) exit non-zero on regression.
- **`tests/_helpers/manifest.ts` + `tests/_helpers/decision.ts`** (Phase 5
  #6, PR #45) — shared `makeManifest`, `makePolicy`, `makeDecision`,
  `makeDecisionEntry` builders. Pure refactor; existing test count
  unchanged.

### Fixed

- **`audit --since` window now parses UTC ledger timestamps correctly**
  (Phase 5 #8, PR #40). evidence-ledger stores `created_at` as SQLite
  `datetime('now')` (UTC, space-separated). V8's `Date.parse` parses
  the space form as local time; on any non-UTC host a `--since` window
  narrower than the host TZ offset silently filtered out fresh
  entries. New `parseLedgerTimestamp` coerces the SQL form to ISO-with-
  Z before delegating to `Date.parse`. Applied at all four call sites
  (audit row sort + cutoff filter, explain `selectLatestForPolicy`,
  `requires.entryTime`).
- **`explain --trace` picks the latest decision by `evaluatedAt`**
  (Phase 5 #9, PR #41). Sub-second collisions used to tie at
  `bt - at = 0` because the sort keyed on ledger `createdAt`
  (1-second precision), and V8's stable sort returned the earliest
  fire. New `decisionSortKey` prefers the decoded payload's
  `evaluatedAt` (ms precision), fallback to `createdAt`. Same fix in
  `audit` row order.

### Distribution

- Package renamed from `harness` (the unscoped name was already taken on
  npm) to `@lannguyensi/harness`. The CLI binary is still `harness`.
- New `publish-npm.yml` workflow tags `v*` → publishes to npm with
  provenance. Single package; no monorepo workspace.

## [0.4.0] - 2026-04-30

**Phase 4: policy layer.** Policies *fire*. The `requires` schema
(`ledger_tag`, `+ within`, `+ count` from `docs/ARCHITECTURE.md` §6) is
now evaluatable at the actual hook event. `harness policy intercept`
runs as a `PreToolUse` hook: it reads the tool-event JSON from stdin,
runs every matching policy through extract-substitution + ledger-query
+ requires-evaluation, and emits Claude Code's `{"decision":"deny",...}`
JSON when blocking. Each fire writes one `policy_decision` entry to the
evidence ledger via grounding-mcp `ledger_add` so `harness explain
--trace` and `harness audit` can replay decisions. The killer-test from
the founding incident is answered end-to-end: `mcp__agent-tasks__pull_requests_merge`
against a session without a `review:${PR_NUMBER}` ledger entry refuses;
the same call after `ledger record review:42 …` is allowed.

The exit-gate from `docs/ROADMAP.md` is met against a fresh tmpdir
install: deny without ledger entry / silent allow with one / silent
allow on unreachable ledger / `explain --trace` shows the full decision
trail / `audit --since 1h` lists both deny+allow fires sorted ascending
/ `dry-run "merge PR 42"` statically reports `[review-before-merge]` /
validate enhancements reject `within: yesterday`, `count.min: 0`, and
warn when policies are declared without `grounding-mcp` wired.

### Added

- **`evaluateRequires` library** (`src/policies/requires.ts`) — pure
  evaluator over the three v1 `requires` shapes returning
  `{ allowed, reason, matchedCount, traceData }`. Reason strings match
  the spec verbatim (`no matching ledger entry for tag \`<tag>\``,
  `no matching entry within <duration>`, `<n> of required <bound>
  entries found`). Rejects `within: <bad-duration>` and `count.min: 0`
  at evaluation time as well as validate time.
- **`evaluateExtract` evaluator + `validateExtractGrammar` parser**
  (`src/policies/extract.ts`) — JSONPath-restricted DSL: dotted
  accessors rooted at `toolArgs / event / session / git`, with
  bracket-quoted keys for non-identifier names. Function calls,
  numeric/slice indices, unknown namespaces all rejected with the
  spec-mandated literal phrases. Built-in vars (`SESSION_ID, REPO,
  BRANCH, TOOL_NAME, CWD`) auto-resolve; extracts override on
  collision with one trace row per variable. `substituteTemplate`
  completes the Appendix-A `review:${REPO}:${PR_NUMBER}` end-to-end.
- **`queryLedgerByTag` adapter** (`src/policies/ledger-client.ts`) —
  spawns the configured grounding-mcp, performs the
  init/notifications/initialized/`tools/call` handshake, parses
  `ledger_summary`, and returns
  `{ kind: "ok", entries } | { kind: "degraded", reason }`. Every
  spec-named failure mode (spawn ENOENT, JSON-RPC error, stdout
  closes, timeout, payload-shape drift) maps to `degraded`. Empty
  ledger ≠ degraded.
- **Validate enhancements** — schema delegates `within` to the runtime
  duration parser, rejects `count.min: 0` with the literal "no-op"
  message, validates `trigger.extract` grammar via
  `validateExtractGrammar`, and the CLI layer warns when
  `policies[]` is non-empty but no `tools.mcp[name: grounding-mcp]`
  is wired (links to `docs/ARCHITECTURE.md` §6).
- **Runtime hook interceptor** (`src/runtime/intercept.ts` +
  `src/cli/policy/intercept.ts`) — wired as `harness policy intercept`.
  Reads tool-event JSON from stdin; runs every matching policy;
  evaluates ALL, denies if any block-enforcement policy denies;
  warn-enforcement deny does NOT block. Unresolved extract →
  `warn-degraded`. Audit-write failure does NOT crash. Multiple
  matching policies on the same event all fire; one ledger entry
  per fire.
- **`harness explain <policy> --trace`** — replaces the Phase 1 stub.
  Reads the most-recent `policy_decision` entry for the named policy
  and renders the full decision trail (decision, reason,
  triggerMatched, extract substitutions, requiresEval, ledgerQuery).
  Cross-policy entries skipped; latest by `createdAt` wins; malformed
  content silently skipped. Exit codes: 64 missing policy / 1 missing
  evaluation / 1 degraded ledger.
- **`harness audit [--since <duration>] [--policy <name>] [--outcome
  <allow|deny|warn-degraded>] [--session <id>] [--json]`** — replays
  the evidence ledger for a window; default 24h. Sorted ascending.
  Empty window → documented literal, exit 0. Degraded ledger →
  `ledger unreachable: <reason>`, exit 69 (EX_UNAVAILABLE). Bad input
  → exit 64.
- **`harness dry-run "<prompt>" [--tool <name>] [--tool-args <json>]
  [--json]`** — static prediction (no LLM, no ledger I/O). With
  `--tool`, simulates a `PreToolUse` event and reports
  `ledgerQuery=<substituted tag>` for each matching policy.
  PreToolUse policies bucket as "could match" without `--tool`.
- **`policy_decision` audit-log encoding**
  (`src/runtime/ledger-record.ts`) — canonical
  `policy_decision:<name>:<outcome> <json-blob>` format with
  encode/decode round-trip helpers the audit/explain verbs consume.

### Changed

- `harness explain` is now async; the CLI awaits the result. Default
  output gains a `--trace` hint replacing the "ships in Phase 4"
  placeholder.
- Schema modules (`src/schema/extract.ts`, `src/schema/requires.ts`)
  delegate to the runtime grammar/duration helpers. No cycle:
  `policies/duration.ts` and `policies/extract.ts` are leaves.

### Notes

- Real Claude Code dogfood (vs. a fake stdio script) is captured in
  the v0.4.0 release PR description; tests use the fake-stdio pattern
  from `tests/probes/mcp.test.ts`.
- Test count: 519/519 green (pre-release; up from 417 at v0.3.0).

## [0.3.0] - 2026-04-30

**Phase 3: declarative truth.** `harness apply` regenerates
`harness.generated/settings.json` and `harness.generated/MEMORY.md` from
the manifest, with the three-state drift detection from
`docs/ARCHITECTURE.md` §7 protecting hand-edits. `harness.lock` pins
SHA-256 of every referenced asset (hook scripts, MCP entrypoints, skill
SKILL.md, memory-router binary) plus per-directory Merkle aggregates for
memory dirs. `harness diff --since-apply` reports drift across three
sections (generated files, asset SHAs, memory dirs); `--memory-detail`
expands per-directory Merkle entries to per-file changes. Asset-content
drift is reported on every apply against the lock with the canonical
message format: `asset drift detected: <path> changed since last apply`.

The exit-gate from `docs/ROADMAP.md` is met: against a fresh tmpdir
install of `init --template full`, `apply` writes both generated files
and the lock; re-`apply` is `no changes`; hand-edited
`harness.generated/settings.json` refuses with the documented diff +
hint and `--overwrite-drift yes` restores it; an externally-edited hook
script surfaces `asset drift detected:` on stderr; a memory-file edit
under a tracked memory directory surfaces a single Merkle drift line
which `diff --since-apply --memory-detail` expands to the changed
filename.

### Added

- `harness apply [--config <path>] [--project <name>] [--dry-run] [--overwrite-drift]`
  — regenerate runtime files from the manifest. Three-state comparator
  (manifest-expected / last-applied / on-disk-current) decides per file:
  `safe-overwrite` (write fresh), `no-drift` (overwrite is safe), or
  `drift-refuse` (refuse with diff + adopt-or-overwrite hint). Drift
  refusal exits 1; `--overwrite-drift` requires literal `yes` (case-
  insensitive, rejects `y`) before discarding hand-edits. `--dry-run`
  prints the would-be diff and restart hints, exits 0 without writing.

- `harness diff --since-apply [--memory-detail] [--json]` — diff against
  the last applied state. Three sections: `# Generated files` (unified
  diff per file), `# Asset drift` (lock SHA mismatches), `# Memory
  directories` (Merkle drift; `--memory-detail` expands to per-file
  added / removed / modified). Exit 0 on no drift; exit 1 on any
  drift. Mutually exclusive with `--since <ref>` (EX_USAGE).

- Asset-content drift detection on every apply: re-hashes every locked
  asset / memory-dir Merkle, surfaces mismatches as warning-style
  stderr lines. Warn-only by default; the lock is rewritten with current
  SHAs at the end of the run, so drift is reported once and the next
  apply is clean. Users wanting enforcement wrap apply in a script that
  greps for `asset drift detected:`.

- Restart-hint emitter: comparing the prior-apply manifest snapshot with
  the current effective manifest, apply prints `mcp servers changed; …`
  on `tools.mcp[]` change, `memory router command changed; …` on
  `memory.router.command` change, `hooks changed; …` on hook /
  policy structure change. Description-only edits emit no hints.

- Library modules (no CLI verbs of their own):
  - `src/io/three-state.ts` — `compare()` returning `safe-overwrite` /
    `no-drift` / `drift-refuse` per the §7 decision table.
  - `src/io/last-apply.ts` — read/write `harness.generated/.last-apply`
    with file SHA + content + optional manifest snapshot + optional
    per-memory-dir per-file index. Atomic-write contract from Phase 2.
    `verifyLastApplyIntegrity()` defends against on-disk corruption.
  - `src/io/harness-lock.ts` — NDJSON `harness.lock` writer/reader.
    Asset entries (hook scripts, MCP entrypoints, skill SKILL.md,
    memory-router binary) plus Merkle-style memory-dir aggregates.
    `enabled: false` mcp[] / `memory.router` and known interpreter
    binaries (`node`, `npx`, `python`, `bash`, `sh`, `tsx`, `deno`,
    `bun`) are excluded. Locale-independent byte-order sort.
    `computeDrift()` returns missing/modified per locked asset.
  - `src/io/restart-hints.ts` — pure manifest-delta to hint list.
  - `src/cli/apply/generate-settings.ts` — manifest hooks projection
    into Claude Code's nested `settings.json` shape.
  - `src/cli/apply/generate-memory-index.ts` — walks
    `memory.directories[]`, parses frontmatter, emits the markdown
    index. CRLF-tolerant; matches the canonical loader's strict
    `name` + `type` requirement; warns + skips on basename collision
    across memory directories.

### Decided here

- **Lock granularity.** Every referenced path gets one entry, except
  memory directories which collapse to a Merkle aggregate per directory
  (so a 1000-memory install does not produce a 1000-line lock). Per-
  file detail is recoverable on demand via
  `harness diff --since-apply --memory-detail`. Per-file index lives
  in `.last-apply` (next to the directory hash); the lock stays small.

- **Asset drift is warn-only at apply time.** Enforcement is one shell
  script wrapper away (`grep "asset drift detected:"`); coupling
  enforcement into the verb itself would be the wrong default for the
  founding-incident use case (where one edit upstream of harness
  shouldn't block the user from re-applying).

- **`apply` writes to `harness.generated/`.** When `--config` is passed
  without an explicit home, generated artefacts live next to the
  configured manifest, not in `~/.claude/harness.generated/`. This
  closes a smoke-test footgun where running with `--config /repo/...`
  silently scribbled into the user's global runtime directory.

- **Manifest snapshot integrity.** The optional manifest snapshot in
  `.last-apply` is sha-checked before being used for restart-hint
  comparison; on mismatch, hints fall back to "no prev manifest" so a
  corrupted record does not produce confidently-wrong restart hints.

- **`path_match` and `bash_match` do NOT survive the settings.json
  projection.** Per ARCHITECTURE Appendix A canonical pattern, these
  filters are enforced inside the referenced hook script. The manifest
  fields exist for `validate` / `doctor` inventory.

### Carried into Phase 4

- **No policy enforcement.** Policies are still schema-only;
  `requires.ledger_tag` / `+ within` / `+ count` evaluation against the
  evidence ledger lands in Phase 4.
- **No `validate --check-lock`.** Lock-drift is surfaced by `apply`
  and `diff --since-apply` in Phase 3; folding it into `validate`
  is a deferred follow-up.

## [0.2.0] - 2026-04-29

**Phase 2: managed edits.** Five write verbs (`init`, `add`, `remove`,
`adopt`, `export`) plus the foundation library (file lock, atomic write,
schema-validate-before-write, unified-diff emitter). The exit-gate from
`docs/ROADMAP.md` is met: a fresh tmpdir round-trip of init → add (mcp /
cli / hook / skill) → adopt → export → remove → validate runs clean,
with comments preserved across every mutation.

### Added

- `harness init [--template minimal|full] [--force] [--config <path>]` —
  bootstrap a starter manifest. `minimal` is the empty-but-valid header
  + comment block (`harness validate` passes immediately). `full` is
  pre-populated from ARCHITECTURE.md Appendix A (3 MCPs, 3 CLIs, 4
  skills, 4 hooks, 3 policies). Refuses to overwrite without `--force`;
  `--force` emits an `(overwriting ...)` line on stderr.

- `harness add <type> <name> ...` — managed insert. Four sub-commands:
  `add mcp <name> --command <cmd> [--health-verb <v>] [--health-timeout-ms <n>] [--enabled <bool>]`,
  `add cli <name> --binary <b> [--required] [--min-version <v>]`,
  `add skill <name>` (managed enable in `tools.skills.enabled[]`),
  `add hook <name> --event <e> --command <c> [--match <r>] [--blocking false|soft|hard] [--budget-ms <n>]`.
  Common flags `--config <path>`, `--dry-run`. Two-stage gate before
  writing: schema (catches duplicate names, dangling references) +
  asset (catches non-+x hook scripts, missing required CLIs). Dry-run
  emits the unified diff and exits 0 without writing.

- `harness remove <type> <name>` — drop entries by name with hook-aware
  reference check. Refuses to remove a hook still referenced by a
  policy unless `--force`; with `--force`, the schema gate (dangling
  `policy.hook`) is the safety net so a broken manifest never lands.
  `<unknown>` exits 1 with the available-name list. `--dry-run` shows
  the patch with `-` lines.

- `harness adopt <file> [--yes]` — capture hand-edits from
  `~/.claude/settings.json` back into the manifest. Computes drift
  (settings hooks not declared in the manifest), synthesises names
  from command basenames with `-2/-3/...` disambiguation, prints the
  unified diff, prompts `Apply (y/N)?` per the write-and-confirm
  decision. `--yes` skips the prompt. Adopted hooks default to
  `blocking: false` so capture never starts gating tool calls
  unintentionally. Idempotent on re-run.

- `harness export [--sanitize] [--json] [-o <file>]` — emit the
  effective merged manifest as a single self-contained YAML or JSON.
  `--sanitize` rewrites `/home/<user>/...` → `~/...` (with a trailing-
  separator anchor so `/home/lan` does not match inside
  `/home/landscape`) and redacts env values whose key matches
  `/(_|^)(KEY|TOKEN|SECRET|PASSWORD|API_KEY)$/i` to `<REDACTED>`.
  Footer comment names what is and is not covered. `-o <file>` writes
  atomically via the foundation's tmp+fsync+rename.

- `src/io/` foundation library: `withFileLock(lockPath, fn)` (via
  `proper-lockfile`, lock-then-mutate-then-release), `atomicWriteFile`
  (tmp+fsync+rename), `withDocument` (CST round-trip preserving user
  comments and long flow sequences), `validateBeforeWrite`
  (parseManifest gate returning structured errors), `unifiedDiff`
  (compatible with `patch -p0`).

- Example manifest + Appendix A: `grounding-mcp` MCP entry with
  `EVIDENCE_LEDGER_DB` env, the `require-preflight-evidence` hook,
  and the `preflight-before-investigation` policy that gates
  investigative `git status|log|diff|branch` on a fresh
  `agent-preflight` ledger entry. Wires the founding-incident
  block-policy concretely.

- Phase 4 ROADMAP acceptance bullet: `validate` warns when `policies[]`
  is non-empty but no `tools.mcp[]` entry named `grounding-mcp` is
  wired (prevents silent degraded-mode failure).

### Changed

- `agent-preflight` repositioned in README §Related and across
  VISION / ARCHITECTURE / ROADMAP as the **canonical implementation**
  of preflight hook content, not a sibling tool. The hook script
  `~/.claude/hooks/git-preflight.sh` is canonically a thin wrapper
  around `preflight run --json` + a `ledger record preflight:${REPO}`
  call. ARCHITECTURE §5 acknowledges this pattern: hook commands are
  routinely thin wrappers around named tools, not bespoke shell.

- `withDocument` now passes `lineWidth: 0` to the YAML stringifier so
  long flow sequences are not silently rewritten to block style on
  round-trip.

### Decided here

- **`harness adopt` UX: write-and-confirm.** Reads the file, computes
  the patch, prints a unified diff, prompts `Apply (y/N)?`. No editor
  mode, no patch-to-stdout shape. `--yes` is the non-interactive
  escape hatch. Per ROADMAP "Open decisions resolved here #2".

- **`harness add policy` is intentionally absent in Phase 2.** Policy
  evaluation lands in Phase 4; shipping `add policy` here would create
  the schema-without-behaviour failure mode.

### Known limitations carried from Phase 1

- No `harness apply` (Phase 3): adopt captures from settings.json into
  the manifest, but the inverse — generating settings.json *from* the
  manifest — is Phase 3.
- No policy evaluation (Phase 4): the schema parses `requires` /
  `trigger.extract` and `validate` lints them, but no policy fires
  against the ledger yet.
- No `harness.lock` (Phase 3): asset-content drift (a hook script
  edited under your feet) is not yet detectable; manifest-layer
  drift is.

## [0.1.0] - 2026-04-29

**Phase 1: read-only inventory.** First releasable cut. Six CLI verbs
(`describe`, `validate`, `doctor`, `list`, `explain`, `diff`) backed by a
single zod-validated YAML manifest with a per-machine + per-project
override layer. No write-side verbs yet, no policy evaluation, no lock
file. The exit-gate from `docs/ROADMAP.md` is met: `harness doctor` against
a real manifest reproduces the Appendix-D structure with `✗ FAILED:` lines
that surface the actual MCP-server stderr, not generic "unhealthy" labels.

### Added

- `harness describe [--config <path>] [--project <name>] [--pillar <p>] [--json]` —
  print the effective merged manifest. YAML by default, JSON via `--json`.
  `--pillar` filters to one of grounding / tools / memory / hooks /
  policies. Golden fixture `docs/examples/full-manifest.expected.yaml`
  locks the format down byte-for-byte.

- `harness validate [--config <path>] [--project <name>] [--strict]` —
  schema lint plus six asset-existence checks: `mcp[].command` first-arg
  rooted-path resolution, `cli[].binary` `$PATH` resolution + semver
  comparison against `min_version`, `tools.skills.required` SKILL.md
  presence, `hooks[].command` exists/regular-file/`+x`, `tools.builtin`
  one-sided drift warning. `--strict` promotes warnings to errors.
  Diagnostics print to stderr; clean runs print "no validation findings"
  to stdout. Exit codes per `sysexits.h`: 1 / 64 / 66.

- `harness doctor [--config <path>] [--project <name>] [--shallow]` —
  the killer-test value-demo. Spawns each `mcp[]` server, runs
  initialize → tools/call over JSON-RPC stdio, races against the
  configured `health.timeout_ms` and the child's exit. Captures stderr
  verbatim so a broken server surfaces with the actual error message.
  `--shallow` skips probe spawning (useful in tight iteration loops);
  reports `~ name  manifest-only (probe skipped)` instead of falsely
  claiming "healthy". Output follows ARCHITECTURE Appendix D structure
  (Manifest / Tools / Memory / Hooks / Policies / Summary).

- `harness list <category> [--filter <substr>] [--json]` —
  pipe-friendly flat listing across the six categories
  (`mcp` / `cli` / `skills` / `memories` / `hooks` / `policies`).
  Default output is a column-aligned table; `--json` gives a flat
  array suited for `jq`. `--filter` is case-insensitive substring
  match on `name` (or `path` for `memories`).

- `harness explain <policy-name> [--json]` — schema-only printer for a
  named policy. Includes the Phase-1 caveat
  `schema valid; last-evaluated tracking ships in Phase 4`. Missing
  policy → exit 64 with the available-name list (`(none)` when zero
  policies are declared). `--trace` is intentionally NOT wired here;
  it lands in Phase 4.

- `harness diff --since <ref>` — manifest-layer diff against a git ref.
  Name-keyed lists (`tools.mcp[]`, `hooks[]`, `policies[]`) diff by
  `name`, so a single field change emits exactly one hunk on that
  field rather than a wholesale list re-emit. Output groups changes
  under per-pillar headers (`## tools`, `## hooks`, etc.).
  `--since-apply` is explicitly Phase 3 and not wired.

- **Manifest schema (zod)** for `version: 1` covering all five pillars
  (grounding / tools / memory / hooks / policies) with strict-by-default
  unknown-key rejection. Includes the `trigger.extract:` JSONPath
  grammar (restricted to dotted accessors rooted at `toolArgs` /
  `event` / `session` / `git`) and the three v1 `requires` shapes
  (`ledger_tag`, `+ within`, `+ count`). Cross-policy validation
  rejects `${PR_NUMBER}` references that lack a matching
  `trigger.extract` entry.

- **Override engine** implementing every `ARCHITECTURE.md` §8 rule:
  scalar replace, map merge, name-keyed list merge, plain-list
  wholesale replace, `null` tombstone, empty-list `[]` clears,
  mixed-shape rejection, `_delete: true` removal. Result is fully
  owned (deep-cloned), so callers can mutate without corrupting the
  parsed base.

- **Per-machine override layer** at
  `~/.claude/machines/<discriminator>.harness.overrides.yaml` with
  three discriminator types (`hostname` / `os` / `default`) and
  WSL2 detection via `/proc/version` containing `microsoft`
  (case-insensitive). Merge order: base → os → hostname → project.

- **MCP stdio probe** (`src/probes/mcp.ts`) with `RealMcpProbe` (real
  spawn) + `McpProbe` interface for test injection. Concurrent probes
  via `Promise.all`. EPIPE handling on early-exit servers; pending
  timers are cleared in `finally`.

- **Memory introspection** (`src/probes/memory.ts`): walks declared
  memory directories, surfaces `*.md` files older than
  `retention.staleness_days` with last-touched dates. Router-executable
  detection picks the first absolute / `~/...` path in
  `memory.router.command`, not the runtime binary.

- **Loader split** (`loadMergedRaw` vs `loadManifest`) so `validate`
  can convert schema errors to structured diagnostics (exit 1) while
  `describe` keeps refusing to print broken manifests (exit 66).

### Resolved design questions

Per `docs/ROADMAP.md` "Open decisions resolved here":

- **Phase-1 doctor health checks: real call default + first-class
  `--shallow` flag.** The default mode invokes each `mcp[].health.verb`
  with the configured `timeout_ms` so users learn the diagnostic value
  immediately. `--shallow` is the explicit fast-path opt-in; both modes
  are first-class.

- **Override granularity for memory directories.** Lists of
  name-keyed entries (`tools.mcp`, `hooks`, `policies`) merge by
  `name`; lists without `name` (`memory.directories`) replace
  wholesale. Mixed-shape lists are rejected at merge time.

- **`harness adopt` UX (Phase 2 deferred).** Per ROADMAP, write-and-confirm
  is the chosen pattern: `harness adopt <file>` will read the on-disk
  file, compute the manifest patch, print a unified diff, and prompt
  `Apply (y/N)?`. This release does not ship `adopt`; the decision is
  recorded so Phase 2 picks up where the design left off.

- **Policy storage location (Phase 4 deferred).** Inline `policies:` in
  the main manifest is the runtime-firing surface; library-style
  imported policies (e.g. claim-gate via `grounding.policies_source`)
  stay in their own DSL files. Phase 1 only validates the inline shape;
  Phase 4 wires the evaluator.

### Known limitations (deferred to later phases)

- **No `harness apply`.** Source-of-truth applies at the *manifest*
  layer only; runtime files (`~/.claude/settings.json`, etc.) stay
  user-owned in Phase 1. Generation lands in Phase 3.
- **No policy evaluation.** Policies are schema-only in Phase 1;
  `harness explain --trace` and `harness audit` ship in Phase 4.
- **No `harness.lock`.** Asset-content drift (a hook script edited
  under your feet) is detectable only after the lock file ships in
  Phase 3.
- **No write verbs.** `init`, `add`, `remove`, `adopt`, `export`
  ship in Phase 2.

### Tests

147 vitest cases across 12 files. Line coverage: 93.75% on `src/`.

[0.1.0]: https://github.com/LanNguyenSi/harness/releases/tag/v0.1.0
