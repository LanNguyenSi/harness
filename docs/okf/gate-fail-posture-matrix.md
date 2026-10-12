---
type: overview
title: Gate fail-posture matrix
description: Which harness enforcement gates fail OPEN vs fail CLOSED when their evidence source (the grounding-mcp ledger, git, a probe) is unreachable or errors, with the exact code paths and override knobs.
tags: [gates, fail-open, fail-closed, enforcement]
timestamp: 2026-10-12T15:58:41Z
sources:
  - docs/policy-packs/branch-protection.md
  - docs/runtime-reality-hook.md
  - src/runtime/intercept.ts
  - src/runtime/command-normalize.ts
  - src/runtime/shell-command-model.ts
  - src/runtime/shell-model-paths.ts
  - src/runtime/git-context.ts
  - src/cli/policy/intercept.ts
  - src/cli/pack/hook-branch-protection.ts
  - src/cli/pack/hook-runtime-reality.ts
  - src/cli/pack/hook-bootstrap.ts
  - src/cli/bounded-stdin.ts
  - src/cli/validate/checks.ts
---

# Gate fail-posture matrix

Every harness enforcement gate has a deliberate posture for the moment its evidence source cannot answer. The split is intentional and documented per gate: gates whose whole purpose is preventing a specific irreversible incident fail CLOSED (branch-protection and — since task f1aea826 — the policy engine's own block/require_approval tier); gates that add advisory friction fail OPEN so a bug or a missing dependency never bricks the session (the policy engine's warn tier, runtime-reality). Inside the policy engine the split runs along `enforcement:` itself, with no manifest opt-out: a `block` or `require_approval` policy whose evidence cannot be read always fails closed. One universal fail-open overrides the policy engine and runtime-reality: the operator pause sentinel (`harness pause`) makes them allow without evaluating (`checkHookPause`; e.g. `src/cli/pack/hook-runtime-reality.ts:235#"harness paused; runtime-reality allowing without evaluating."`). branch-protection is the exception: it does not yield to a pause (`src/cli/pack/hook-branch-protection.ts:333#"this gate does not yield to a pause"`).

| Gate | Runtime entry | Evidence source | Posture on source failure | Degraded outcome |
|---|---|---|---|---|
| Policy engine | `harness policy intercept` → `intercept()` in `src/runtime/intercept.ts` | grounding-mcp evidence ledger | fail **CLOSED** for `block`/`require_approval`, fail **OPEN** for `warn` (task f1aea826; there is no manifest opt-out, old manifests that still carry one load with a warning and the key is ignored) | `deny-degraded` blocks with a degraded-specific envelope for `block`/`require_approval`; `warn-degraded` never blocks for `warn` |
| `bash_match` normalised-form matching (both passes) | `harness policy intercept` → `normalizeCommand` / `normalizeCommandAmpAware` in `src/runtime/command-normalize.ts` | command length vs `MAX_NORMALIZE_LENGTH` (100,000 chars) | fail **OPEN** above the bound | normalised-form matching skipped for BOTH the primary and the ampersand-aware second pass (task `aabbad63`) — they share the identical bound on the identical input command, so one stderr line covers both; raw match only. Previously silent, no stderr line, no audit row (G4 fix, review round 2, 2026-07-27) |
| Per-policy target attribution bound (`${REPO}`/`${BRANCH}`/`at_head`) | `harness policy intercept` → `resolveAttributedContexts` in `src/runtime/intercept.ts` | segment-derived repository targets (a filesystem `.git`-shape check, no evidence source of its own) | fail **CLOSED** above 4 distinct targets (`MAX_ATTRIBUTED_CONTEXTS`) | one synthetic decision naming the ambiguity, mapped through the policy's OWN `enforcement:` (`block` denies, `warn` warns, `require_approval` requires approval — never a hardcoded outcome); ZERO ledger queries for that policy |
| Quote-aware shell command model (`${REPO}`/`${BRANCH}`/`at_head` policies) | `harness policy intercept` → `resolveAttributedContexts` in `src/runtime/intercept.ts`, model in `src/runtime/shell-command-model.ts` | the command text (no evidence source of its own) | fail **CLOSED** on an opaque possibility (a target it refuses to read, a glob, an in-command `CDPATH` search, a relative step after an opaque directory, a loop that moves relatively, more than 8 possibilities, a composed path over 4096 characters), on model paths that need more than the per-event filesystem work budget (`MAX_MODEL_PATH_WORK`, `src/runtime/shell-model-paths.ts`), and on a command it cannot lex or longer than `MAX_NORMALIZE_LENGTH` when the text holds a directory-changing word; otherwise it only adds demands to the segment view's, which are computed first (task `7d4abf84`). Also fail **CLOSED** on a command line the model refuses (an unparseable compound shape its walk would place in the wrong directory, listed at `REFUSAL_CONSTRUCTS`), whatever the text holds (task `9238cc27`) | the same `opaque-target` decision as the row above's shape: one synthetic decision through the policy's OWN `enforcement:`, ZERO ledger queries; a refused line gets the `unparsed-command` decision instead, with the ledger tag `(unparsed command: ...)` and a reason that names the construct and asks for separate commands |
| Empty `${REPO}`/`${BRANCH}` in a `ledger_tag` | `harness policy intercept` → `evaluateOnePolicy` in `src/runtime/intercept.ts` | none queried: the value resolved for the context (cwd outside every repo, detached HEAD, empty override) | decided per the policy's OWN `enforcement:` (never fail-open to a blank tag) | `deny` / `require_approval` / `warn` with a reason naming `cd <repo>` / `git -C <repo>` or `git switch <branch>`; ZERO ledger queries; NOT `deny-degraded` (task `6c8ebd37`) |
| branch-protection | `harness pack hook branch-protection` (`src/cli/pack/hook-branch-protection.ts`) | `git symbolic-ref -q HEAD`, run by the hook itself (no ledger, marker or session state) | fail **CLOSED** on a manifest that does not load, a malformed or never-closing stdin, a git error, an unknown answer and the 3000 ms bound | block envelope (JSON deny, or exit 2 under Codex) |
| runtime-reality | `harness pack hook runtime-reality` (`src/cli/pack/hook-runtime-reality.ts`) | `RUNTIME_REALITY_PROBE_CMD` output vs expectations file | fail **OPEN** on every load/probe error | allow + stderr warning; flip with `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` |

## Policy engine: fail posture derived from `enforcement:` (task f1aea826)

The generic PreToolUse policy pipeline (`evaluateOnePolicy` in `src/runtime/intercept.ts`) routes every could-not-decide condition through `degradedOutcome`, which derives the fail posture from the policy's own `enforcement:` tier: `warn` maps to the non-blocking `warn-degraded` (unchanged availability-first behaviour), while `block` and `require_approval` map to the blocking `deny-degraded` — `isBlockingDecision` treats `deny-degraded` as aborting unconditionally, since it is only ever produced for those two tiers. The degraded paths are enumerable in the source and all share the same routing: unresolved template variables in `requires.ledger_tag`, a thrown or `kind: "degraded"` ledger query (including the timeout latch the 2026-08-06 audit measured flipping a `git push` deny to ALLOW at 1-100ms budgets), an invalid `requires.within` duration, a thrown `evaluateRequires`, and the defensive schema-invariant branch. When grounding-mcp is not declared in the manifest at all, the CLI wrapper substitutes `degradedLedgerClient("grounding-mcp not declared in manifest")` (`src/cli/policy/intercept.ts`), so every query degrades — under the new posture a manifest that declares block-tier policies but no grounding-mcp now denies loudly instead of silently no-opping. The `deny-degraded` envelope deliberately bypasses the policy's `ux:` surface and names the degraded cause (bounded and control-stripped, since it embeds subprocess output) plus an operator-facing recovery path, so nobody debugs a phantom missing tag — and it deliberately names no way to disable the posture: that text is fed back to the blocked agent, and a deny that includes its own disable recipe is not a gate. There is no manifest opt-out restoring the pre-0.45 mapping for any tier: an old manifest that still carries the former posture key loads with a warning naming it, the key is stripped, and `block` and `require_approval` fail closed whenever their evidence is unreadable. A default-verbosity surface exists too: one stderr hint line per degraded-denied event at DEFAULT verbosity (suppressed under `HARNESS_POLICY_VERBOSE`, where the full diagnostic supersedes it), carrying the decision's own (sanitised) reason and pointing at `harness doctor` and the verbose diagnostic, deliberately WITHOUT any disable recipe, because hook stderr can be surfaced to the model in some harness configurations. Hardening notes that ride this contract: since v0.39.0 (task a2589fa3, `CHANGELOG.md:#0.39.0`) one pooled grounding-mcp session per intercept invocation replaces two subprocess spawns per policy, closing the load-induced fail-open where the hook budget timed out; the pooled session's timeout LATCH previously guaranteed a degraded deny lost its own audit row (every post-timeout call on the session short-circuits), so `realLedgerClient.record` now retries at most once per invocation, RESERVED for `deny-degraded` rows, over a fresh session whose own per-call budget is max(250ms, timeoutMs/4) — worst-case added stall is 2x that per-call budget (initialize + ledger_add), i.e. <=timeoutMs/2 for timeouts >=1s, dominated by the 250ms floor below that; and an audit-write failure that survives the retry is surfaced to stderr but never blocks — the decision is still applied. The OUTER hook-budget layer stays fail-open by harness contract (a hook exceeding `budget_ms` is allow) and is not reachable from this schema; hook budgets must stay comfortably above the ledger timeout for the fail-closed decision to be delivered at all. This is doubly load-bearing on the Claude Code projection, where `apply` emits the budget into settings.json's `timeout` field which is in SECONDS: task 7bf47554 fixed a prior 1:1 ms-into-seconds projection (a 1000x inflation that had accidentally kept the outer timer at thousands of seconds) and, in the same change, raised every blocking ledger-consulting `harness policy intercept` hook across the shipped manifest surfaces (FULL and TEAM templates, the interactive Custom composer and the full-manifest fixture) to `budget_ms: 15000`, a 15s outer timeout that clears the ~13.75s ledger round-trip worst case with margin, so the `deny-degraded` decision lands before Claude Code cancels the hook. `tests/runtime/hook-budget-ledger-margin.test.ts` pins this invariant (a hard 15000ms floor plus the ledger-timeout+retry margin) across every manifest surface; the mechanical enforcement is the validate check `checkHookBudgetLedgerMargin`, an error for a `blocking: hard` policy-intercept hook whose `budget_ms` is below the margin its ledger timeout requires (`src/cli/validate/checks.ts:885-918#"return diags;"`). branch-protection's hook does not consult the ledger and carries its own 5000 ms budget. The trade-off is deliberate and f1aea826-consistent: on a down or hanging ledger a gated action now freezes up to ~15s and then denies, rather than allowing. Two wrapper-level fail-opens also sit outside the enumerable degraded family: malformed event JSON and a failed manifest load both resolve to allow-with-stderr in `runInterceptCli`, so the engine's posture is only as fail-closed as manifest integrity.

## branch-protection: fail closed, and it asks git

`docs/policy-packs/branch-protection.md` ("Failure mode"): the blocker fails **closed**. A manifest that does not load, an event on stdin that is not a JSON object, a stdin that never closes within the 3000 ms bound, and every git error refuse the call, because a bug that silently allowed Writes through would defeat the pack's whole purpose (preventing edit-on-master). The source enforces this at each step (`src/cli/pack/hook-branch-protection.ts`): empty or malformed stdin resolves to BLOCK, a manifest load failure blocks with reason `manifest load failed (...); refusing on failsafe`, and a git answer the hook cannot read, or one that names a protected branch, blocks. The hook decides from what git reports about each directory a write touches (`git symbolic-ref -q HEAD`, run directly, bounded at 3000 ms for all of one tool call); it reads no ledger, so a degraded grounding-mcp cannot open or close it, and it keeps no override marker, so there is nothing for the agent to write. The allow-on-uncertainty carve-outs are deliberate and narrow: a pack not declared or `enabled: false` allows (the hook was wired without `harness apply`; `hook-branch-protection.ts:368#"not declared in manifest, allowing"`), a directory outside every repository (no `.git` entry above it, git not run) allows, and a detached HEAD (git exits 1 with no output) allows, because blocking every Write in a non-git workspace would be hostile. A manifest that still carries a key or pack a newer release removed does not count as one that fails to load: removed entries are stripped with a warning and the gate keeps working.

## Unreadable git files in the `${BRANCH}` lookup: refused, never read as "no branch"

The policy engine resolves `${REPO}`/`${BRANCH}`/`at_head` for `ledger_tag` through `resolveGitContext` (`src/runtime/git-context.ts`). A git file that is present but cannot be read as a regular file (a FIFO, a device, a directory or an oversized file where `HEAD` belongs, a `.git` that is neither a directory nor a readable `gitdir:` pointer, a symlink that dangles or loops, a `HEAD` git itself would not accept, a `commondir` that does not lead to the directory git reaches) is reported in `refused` instead of being read as "no branch" or walked past; only a `.git` that is ABSENT is walked past (task b56d95d3, task 51bfba5a; pinned against real git by `tests/runtime/git-context-differential.test.ts`). An empty `${BRANCH}` caused by a refused file gets its own deny text naming the file and telling the operator to repair it, since switching branches cannot clear it (`src/runtime/intercept.ts:800#"function emptyBranchMessage("`), and a refused loose ref is not replaced by the older tip in `packed-refs` (`src/runtime/git-context.ts:528-529#"} else if (refused.length > refusedBefore) {"`). Every git file the lookup needs is read through one bounded, non-blocking descriptor read (see [evidence-ledger-trust-boundary.md](evidence-ledger-trust-boundary.md)), so a FIFO planted at `.git/refs/heads/<branch>` cannot hold the hook past its budget, which the runtime treats as an allow.

## runtime-reality: fail open, with an opt-in fail-closed knob

`docs/runtime-reality-hook.md` (line 14): "Every load or probe error degrades to allow: a misconfigured probe never tarpits the session." The doc names two deny paths: a probe that actually produced state showing critical drift, and a stdin that stays open past the hook's 3000 ms idle bound (see the pack-hooks section below; `RUNTIME_REALITY_DISABLE` still wins). The source (`src/cli/pack/hook-runtime-reality.ts`) mirrors this: a stdin read error other than the timeout, hook construction failure, unset `RUNTIME_REALITY_KEYWORD` (no baseline), and unset `RUNTIME_REALITY_PROBE_CMD` (nothing to compare) all resolve via `allowResult(...)`; a thrown/hung probe (10s subprocess timeout) is treated as "probe failed" under the same fail-open policy. Operators can invert per tier (env toggles documented in `docs/runtime-reality-hook.md`'s reference table; the escalation logic lives in the external `@lannguyensi/runtime-reality-checker` package, not in the hook file): `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` denies on probe failure, `RUNTIME_REALITY_WARN_AS_BLOCK=1` escalates warnings, `RUNTIME_REALITY_CRITICAL_AS_WARN=1` degrades critical drift to allow, `RUNTIME_REALITY_DISABLE=1` short-circuits entirely. This fail-open default is why `harness init --template full` ships the hook entry commented out: an active entry without the three env values "would degrade to a silent allow (a no-op that looks like protection)".

## Pack hooks: a PreToolUse gate blocks on a timed-out stdin read (task `7dfdcaaf`)

The pack hooks read the event JSON through one idle-bounded reader (`readStdinChecked` in `src/cli/pack/hook-bootstrap.ts`, the reader in `src/cli/pack/hook-runtime-reality.ts`, both on `src/cli/bounded-stdin.ts`, 3000 ms without a chunk). Claude Code closes stdin after writing the event, so only an open pipe that stays quiet for the bound reaches it; before the bound the hook waited for the host's own hook timeout, and a writer that was merely late (first byte or a mid-event stall longer than the bound, then the full event and a close) was still decided on its content.

A timeout is not an allow for a gate. Every PreToolUse gate verb fails CLOSED on a timed-out read, whether nothing, a partial event, or a complete event on a stdin that never closed was read: it blocks with a reason starting `stdin timeout:` that names the bound, instead of its empty or malformed event handling (`src/cli/bounded-stdin.ts:110#"stdin timeout: no complete event arrived"`). `branch-protection` writes the usual `decision: "block"` envelope and exits 0 (exit 2 with the reason on stderr under Codex), `runtime-reality` writes its `permissionDecision: "deny"` envelope and exits 2. The decision is taken right after the read, before the manifest is loaded, so a gate whose pack is disabled or undeclared also blocks on a timeout; `runtime-reality` still yields to the pause sentinel and to `RUNTIME_REALITY_DISABLE`, and branch-protection yields to neither. This is a timeout-specific exception to the fail-open rows above: `runtime-reality`'s degrade-to-allow applies to an event that CLOSED, not to one that timed out. `branch-protection` already blocked an empty event, and its timeout block also covers a partial or complete event.

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
function's own doc comment, `src/runtime/intercept.ts:1300-1334#"disproved"`; the
original decision record under
`.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/` is local run state
and not shipped with the repo). This section covers only the FALLBACK side of that resolution,
since it is the part that changes this matrix's own fail-posture story:

- **A composition neither view resolves to a directory (`--work-tree`
  alone, a `~` or `~/...` value or a bare `cd` with nothing in the
  command assigning `HOME`) falls back to the cwd context ALONE: never
  fail-open, never a new gap, with the one exception in the next
  bullet.** Since task `e927e903` a variable or substitution value, any
  other tilde prefix and a `cd -` before any move no longer fall back:
  the shell command model reads them as opaque (next bullets). Since task `7d4abf84` the quote-aware
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
  The segment view alone still leaves a `$(...)` substitution, a `~` or a
  variable value at the cwd-only fallback; since task `e927e903` the
  model reads a substitution or variable value, and a tilde prefix
  other than `~` and `~/...`, as opaque, so the union fails closed on
  them, and only a `~` or `~/...` value keeps the fallback.
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
  recorded in the CHANGELOG entry for task `7d4abf84`. Since task
  `9238cc27` the model also refuses a command line holding a compound
  shape its walk would place in the wrong directory (the kinds are listed
  at `REFUSAL_CONSTRUCTS` in `src/runtime/shell-command-model.ts`). Such a line fails closed for every
  per-repository policy (`${REPO}`, `${BRANCH}` or `at_head`) with a
  `bash_match`, whether or not the text holds a directory-changing word,
  as one `unparsed-command`
  decision (ledger tag `(unparsed command: ...)`, the reason names the
  construct and asks for separate commands). The model's own trigger arm
  keeps matching on the reading without the refusals
  (`ShellModelView.triggerCommands`), so a policy only that arm matched
  fails closed too instead of dropping out. A few more words that steer
  a later relative `cd` make it opaque as well. Since task `e927e903` a
  directory target that depends on a value the model cannot resolve is
  opaque too (one more clause in `OPAQUE_TARGET_REASON`): a `cd`,
  `pushd`, `git -C`, `env -C` or `--git-dir` value only known at run time
  (a variable, a command substitution, an arithmetic expansion); a tilde
  prefix other than `~` and `~/...` in such a value; a `cd -` or
  `pushd -` before any move (the session's previous directory); a bare
  `cd`, a `~` / `~/...` target and zsh's empty-stack `pushd` when the
  command line assigns `HOME` anywhere, `cd -` and `pushd -` when it
  assigns `OLDPWD` anywhere (`WalkState.homeSteered` / `oldpwdSteered`,
  set before the walk by `steeredInLine` from every producer in the line,
  one inside a subshell or in front of another command included, unlike
  the `CDPATH` flag, which the walk sets when it meets its producer); and
  a `cd` stack index, which bash reads as a path. The over-block it adds
  (a `cd` or `-C` into a substitution or variable that names the cwd's
  own repository, a tilde prefix that names the cwd, a `cd -` before any
  move, a home target in a line that assigns `HOME` only after it, in a
  subshell or for another command) is recorded in the CHANGELOG entry
  for task `e927e903`. Valid
  one-liners in a refused form are over-blocked until the model reads
  them.
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

Two invariants hold across all gates. First, audit degradation never blocks: `LedgerClient.record` implementations "MUST be best-effort" (`src/runtime/intercept.ts` interface doc), and a record failure that survives the single fresh-session retry (task f1aea826) is written to stderr while the gate decision stands — the retry improves the audit trail's completeness, it never changes a decision. Second, fail-open is always loud: every allow-on-error path in every hook emits a stderr diagnostic, because a silently-allowing gate manufactures false confidence, the worst direction for a governance hook to fail in (the allow-on-error paths of `src/cli/pack/hook-runtime-reality.ts` each write one); since task f1aea826 the same loudness applies to the new fail-closed path (`deny-degraded` carries a degraded-specific envelope and stderr diagnostic naming the unreadable evidence source). The asymmetric fail-closed carve-out inside an otherwise fail-open surface is, since f1aea826, the entire block/require_approval tier under ledger degradation (the former risk gate's `when:` classifier beside it, "unknown is not safe", was removed with the Risk Gate).
