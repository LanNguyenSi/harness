# Policy Pack: `solution-acceptance`

Make task completion EARNED instead of self-attested: the consumer half
of the "Verifier-gated Done" gate. The producer
(`@lannguyensi/grounding-mcp` >= 0.3.2, `solution_evaluate`) records a
HEAD-pinned verdict from a real `preflight run --json`; this pack then
denies the task-finishing tools until a ready verdict exists at the
current git HEAD. An agent can no longer declare a task done on a tree
that never passed its own preflight.

Shipped in `v0.32.0`; the `SOLUTION_VERDICT_ID` solo-session knob in
`v0.33.0`.

## Status

Opt-in. Enable via `harness pack add solution-acceptance`, or flip the
disabled exemplar the `full` init template ships (no No-Op default: the
template entry is `enabled: false` so a fresh install never carries a
gate that silently can't fire). Requirements:

- `grounding-mcp` (>= 0.3.2) declared under `tools.mcp` (the producer).
- The `preflight` binary on PATH (the producer shells out to it).

`harness validate` and `harness doctor` both surface the two deadlock
misconfigurations when the pack is enabled (see Failure mode).
Condition #1 (grounding-mcp absent) is a hard error in both; condition
#2 (relative `SOLUTION_VERDICT_DIR`) is a warning in both. Both also
warn when the pack is enabled but the OW knob path
`.ai/solution-acceptance.json` is git-ignored in the current repository
(see "Repo state and gitignore" below).

## How it works

Two `blocking: hard` PreToolUse hooks:

### `harness pack hook solution-acceptance` (completion-gate)

Denies the task-finishing tools unless a ready verdict exists at the
current HEAD:

- MCP completion verbs: `task_finish`, `task_submit_pr`, `task_merge`,
  `pull_requests_merge` (agent-tasks).
- Bash: `git push`, `gh pr merge`.

The verdict id resolves in this order (`solution-acceptance-runtime.ts`):

1. the agent-tasks `active-claim` task id, when present;
2. `SOLUTION_VERDICT_ID`, only when NO claim is present, so a claimed
   session's id stays authoritative and cannot be redirected by env;
3. otherwise fail-closed.

A sessionId fallback is intentionally absent (the wrong-scope bug class
the understanding gate closed). The env value is validated as a safe
single path segment; a malformed value fails closed.

The gate decision is `ready && head === current HEAD` only. The
verdict's `confidence` field is informational (parity with the
producer's `solution_gate`); it does not change the decision. Missing
verdict, not-ready, HEAD drift, unresolvable HEAD, and no-claim/no-id
all deny.

### `harness pack hook solution-acceptance-writeguard` (anti-forgery)

The completion-gate is only as trustworthy as the verdict marker, and
the understanding gate allows all Bash post-approval, so this companion
denies the agent's enumerated write paths into the verdict directory:

- Bash redirects, `tee`, `mv` / `cp` / `ln` / `install`, interpreter
  one-liners that reference the dir, including glob-obscured spellings,
  plus `chmod` / `chattr` on the dir itself, and non-read-only Bash
  whose working directory is inside the dir;
- `Write` / `Edit` / `MultiEdit` / `NotebookEdit` whose target lands
  inside it, and Codex `apply_patch` whose patch body references it.

Reference detection matches on the stable dir tail
(`agent-grounding/solution-verdicts`), so any spelling of the home
prefix is caught (`~/.local/state/...`, `$HOME/...`,
`$XDG_STATE_HOME/...`, the literal absolute path). The only legitimate
writer is the producer.

Anti-forgery scope is v1-honest: it closes the enumerated-write-path
residual, not arbitrary same-uid forgery.

### Reconnecting vs. retrying a call (grounding-mcp >= 0.11.0)

`solution_evaluate` waits only up to an internal bound before returning; a
large repo's `preflight` run can outlive that bound and keeps running in
the background regardless. When the run does not finish inside the
bound, the call returns a running handle instead of a verdict:

```json
{ "status": "running", "attemptId": "<server-generated uuid>", "id": "task-42", "pollAfterMs": 5000 }
```

A caller whose own request timed out before ever seeing a response is in
the same situation: nothing to read yet, an attempt possibly still live.
Either way, poll for the result; do not treat the wait as a stall and
call `solution_evaluate` again to "unstick" it.

Poll `mcp__grounding-mcp__solution_evaluate_status` or
`mcp__grounding-mcp__solution_evaluate_result` for the SAME `id`. Pass
the `attemptId` from the running handle, or omit it to resolve the
latest attempt for that id (the recovery path for a caller with no
handle at all, because its own call timed out with nothing). Wait at
least the returned `pollAfterMs` between polls.

Once the attempt finishes, the payload the two lookup tools return
depends on which process answers. When the SAME process that ran the
attempt still holds it in memory, the response is today's verdict
payload plus `status` (`completed` or `failed`) and `attemptId`, exactly
what `solution_evaluate` itself would have returned. When a DIFFERENT
process answers (another session, or this one after a restart), the
response is a reduced payload instead: `outcomeClass`, `summary`, and the
persisted `error` (a size-bounded copy, not the full diagnostics), with
`verdict`/`markerPath` included only when the attempt is still the
latest recorded for the id and its marker file is present. A
`running-unconfirmed` status means the id's lock is held but no attempt
row names it yet; it still means keep polling, not stall or escalate,
and it resolves by itself into `running` or clears once the lock is
reclaimed as stale.

Re-calling `solution_evaluate` for an id whose attempt is still live
joins that attempt rather than starting a second one; `forceNewAttempt`
is refused while an attempt is live. A prior attempt's reported status
(`completed`, `failed`, `unknown`, or `expired`) is informational, not
the gate: `unknown`/`expired` never license a new attempt by themselves
while another process still holds the id's lock. A genuinely new attempt
becomes possible only once the previous one is terminal AND the id's
lock is free again, at which point an ordinary `solution_evaluate` call
starts one; an `unknown` status means the attempt's fate was never
established, not that it is safe to assume success. Never escalate to a
human before the advertised `pollAfterMs` has elapsed.

The ordinary tool-call lifecycle above (poll with `solution_evaluate_status`
/ `solution_evaluate_result`) is the only mechanism this pack relies on or
documents as guaranteed. grounding-mcp separately sends
`notifications/progress` pings while a call is pending, when the caller
supplies a progress token; those pings are a caller-side, per-client
convenience (see the grounding-mcp README for what each client does with
them) and are not part of this pack's contract, and this pack makes no
claim that they resolve a client's own request timeout for any specific
client.

### Agent-facing surface for the in-flight case (decision, harness/5c9cad05)

The section above lived only in `instructions.md`, this pack's operator
audit copy (rendered once by `buildInstructions` and never re-read by the
agent mid-session). Nothing surfaced it to the agent at the one moment it
actually matters: the completion-gate denies a completion verb, and the
agent needs to know whether to reconnect or to wait, not to re-call
`solution_evaluate` as a "fix".

Two candidate surfaces were considered:

- **The completion-gate's deny text** (`harness pack hook
  solution-acceptance`, `blockJson` in
  `src/cli/pack/hook-solution-acceptance.ts`): fires exactly when the
  agent is blocked on a completion verb with no ready verdict, which is
  exactly the moment this guidance is needed.
- **A pack MEMORY.md contribution**: rejected. `PackContribution`
  (`src/policy-packs/types.ts`) has exactly two fields, `hooks` and
  `files` (written under `harness.generated/policy-packs/<name>/`);
  neither reaches the generated `MEMORY.md`. `generate-memory-index.ts`
  builds that index solely from user-authored markdown files under
  `manifest.memory.directories[]` (frontmatter `name`/`type`/
  `description`) — packs have no contribution path into it today, and
  adding one would be a new mechanism, out of scope for this pack and
  out of bounds for this change (the memory-contract worktrees own that
  file).

Decision: the completion-gate's deny text is the surface. Implemented in
`blockJson`, gated on `gate.verdict === null` (the `evaluateGate` branch
whose reason is `no solution-acceptance verdict recorded for "<id>"`).
That single condition is DELIBERATELY ambiguous between "`solution_evaluate`
was never called for this id" and "an attempt for this id is still running
in the background": the verdict marker is written only once an attempt
finishes, so the hook has no attempt-log or `running`-status visibility
that would tell the two apart. Rather than let an agent read "no verdict
recorded" as licence to call `solution_evaluate` again, the SAME deny
carries the reconnect-vs-retry facts either way: reconnect with
`solution_evaluate_status` / `solution_evaluate_result` by `attemptId`
(omit it to resolve the latest attempt); never retry `solution_evaluate`
while the id's lock is held (a second call joins the live attempt,
`forceNewAttempt` is refused while it holds); the poll interval and
retention bounds from the released grounding-mcp version this pack
requires (>= 0.3.2, verified against grounding-mcp v0.11.0's README):
`pollAfterMs` is advertised as `5000` in the README's example handle,
retention is 24h by default and always at least 100x `pollAfterMs`, and a
pruned terminal attempt reads `expired`.

The guidance does NOT appear on a not-ready or stale verdict deny: both
mean a run already completed and produced a marker, so there is no
"is it still running" ambiguity to resolve there. It also does not appear
when no verdict id resolved at all (no active claim and
`SOLUTION_VERDICT_ID` unset) — there is no id to poll for yet — nor when
an operator has configured a custom `ux` block, which replaces the
default deny text entirely (a pre-existing pack behavior, unchanged
here). `instructions.md` (`buildInstructions`) is unchanged: it stays the
audit copy documented above. Pinned by
`tests/cli/pack-hook-solution-acceptance.test.ts` ("the no-verdict deny
carries the reconnect-vs-retry facts...", plus the not-ready/stale tests'
negative assertions).

### Marker signing (harness/c7c3f606)

The verdict now carries an HMAC-SHA256 signature, reusing the SAME
`signMarker` / `verifyMarkerSignature` primitive
(`src/runtime/approval-signing.ts`) shipped for the understanding-gate
approval marker and its branch-protection twin (harness/f9485cc7): same
crypto, same operator-side key at `<generatedDir>/.approval-signing.key`,
same fail-closed contract. The signed tuple mirrors the approval
marker's payload shape onto the verdict's own fields — `timestamp` plays
the role of `approvedAt`, `source` plays the role of `approvedBy`, and a
content hash of `head`/`ready`/`confidence`/`blockers` plays the role of
`reportContentHash`, so tampering ANY of those fields after signing
invalidates the signature, not just editing `signature` itself.

`harness pack hook solution-acceptance` REJECTS a verdict with a missing
or invalid signature — `allowed: false`, same as no verdict at all, but
with a distinct `forged/unsigned solution-acceptance verdict rejected`
reason, so an operator/auditor can tell an active forgery attempt (or a
not-yet-signing producer) apart from the routine "no verdict yet" or
"not ready yet" cases. Signature verification runs BEFORE `ready`/`head`
are ever trusted, so a forged-but-plausible `ready:true` verdict is
rejected before it would otherwise pass.

**Back-compat is strict, no migration window** — the same strict
no-grace-period POLICY f9485cc7 made (the RECOVERY differs — there is no
operator-side command that resolves this one until the grounding-mcp
producer ships): a verdict with no `signature` field is rejected exactly
like a forgery.

The HMAC markerId is derived from the CALLER's id, not from `verdict.id`
read back out of the marker body — a producer mirroring `signVerdict`
MUST set `verdict.id` to the exact id string the consumer looks the
marker up by (byte-identical, no trimming or case normalization), and
the consumer additionally rejects outright when `verdict.id !== id`
even if the signature itself still verifies (belt-and-braces against a
cross-id replay of a validly-signed verdict). The hook also emits a
short, greppable STDERR-only audit tag,
`[audit: forged/unsigned verdict marker rejected]`, whenever a denial
is specifically a forged/unsigned/identity-mismatched verdict — an
audit-sweep target distinct from the routine "no verdict" / "not ready"
/ "stale" denials, which never carry it.

**Honest residual — read this before assuming more than it delivers.**
Unlike the understanding-gate marker, harness does not WRITE this one.
The producer is `@lannguyensi/grounding-mcp`, a separate package/repo
(see "How it works" above). This task shipped the CONSUMER side only
(pattern + exemplar): `signVerdict` /
`verifyVerdictSignature` in `solution-acceptance-runtime.ts` are the
reusable pair a producer-side change mirrors, but **no currently-released
grounding-mcp version signs its output**. Concretely, until a matching
producer release ships (tracked as a cross-repo follow-up):

- every verdict this consumer reads is "unsigned" and the completion-gate
  denies it UNIVERSALLY, even a perfectly legitimate `ready:true` verdict
  at the correct HEAD;
- re-running `solution_evaluate` does NOT recover from this — the new
  verdict is unsigned too, so it denies again;
- `harness pause` remains the operator override in the interim (or
  temporarily disabling the pack via `harness pack remove solution-acceptance`
  / flipping `enabled: false`, same as any other misconfigured hard-block
  pack).

grounding-mcp's own `solution_gate` does NOT (yet) enforce this signature
either — only this harness consumer does. That asymmetry closes once the
producer-side change ships.

Glob-every-segment / interpreter-runtime-path-construction spellings of
the write-guard's own residual (the enumerated-write-path scope above)
are UNCHANGED by signing: signing verifies the AUTHENTICITY of whatever
bytes land at the marker path, it does not additionally restrict which
write primitives can reach that path.

## Orchestrator-workflow process arm

From `grounding-mcp` >= 0.5.0 the producer folds orchestrator-workflow
(OW) process-completeness into the same verdict. When a run is present,
`solution_evaluate` checks the run's process state (for example a handoff
whose final status is not `done`) on TOP of the preflight floor and, on
failure, records a not-ready verdict whose reasons land in the EXISTING
`blockers`, each prefixed `orchestrator-workflow: `. No new verdict field
is added, so this consumer is unchanged: a not-ready verdict still denies
the completion verbs and the OW reasons reach the agent through the same
deny message.

Markers from older producers (< 0.5.0) stay shape-compatible and remain
preflight-only. There is no hard incompatibility; an older producer
simply records no OW blockers.

### Producer-side knob

The arm is controlled on the PRODUCER side via
`.ai/solution-acceptance.json`:

| Key | Values | Meaning |
|-----|--------|---------|
| `orchestratorWorkflow` | `auto` (default) \| `on` \| `off` | `auto` enforces the OW arm iff a run is present under `.ai/runs/`; `on` always enforces; `off` disables the OW arm. An unreadable or malformed file fails SAFE to `auto`. |

Resolution is marker-first (the structured run files), with a prose
fallback when the structured signal is absent. When `.ai/runs/` is absent
entirely the OW arm auto-skips, so a repo that does not use the
orchestrator workflow is never gated on it.

This knob is agent-writable, so it is a BOUNDED residual: setting it to
`off` (or having no run present) only drops the OW arm; it does NOT
disable the preflight floor, which still gates every completion. The
same-uid forgery honesty from the write-guard above applies here too.

### Repo state and gitignore

The OW arm reads REPO state: the knob above plus run completeness under
`.ai/runs/`. That state interacts with `.gitignore` in a way that can
silently disarm the arm (ow-review-2026-07-01, finding 2):

- `.ai/runs/` SHOULD stay ignored — run directories are per-machine
  auditable history, not shared configuration.
- The knob `.ai/solution-acceptance.json` (and `.ai/workflow/`, the kit
  templates + manifest) SHOULD be committed. Ignoring `.ai/` wholesale
  makes the enforcement posture per-machine by construction: the repo
  cannot commit `"orchestratorWorkflow": "on"`, and the committed
  workflow docs reference kit files that do not exist on other
  checkouts.

**Worktree / fresh-clone residual (honest limits).** `.ai/runs/` being
local means a fresh clone or a git worktree starts with NO run present.
Under the default `auto` knob the OW arm then auto-skips — the gate that
exists to prevent process skipping is skipped exactly where process
skipping happens (parallel worktree batch sessions, new machines). Two
mitigations, both partial:

- Commit `"orchestratorWorkflow": "on"`: the arm then enforces in every
  checkout, and a fresh environment must produce a complete run before
  its completions pass. This repo does exactly that.
- `harness validate` / `harness doctor` warn when the pack is enabled
  but the knob path is git-ignored, so the wholesale-ignore
  misconfiguration is at least visible instead of silent. The check
  probes `git check-ignore` in the current working directory and stays
  quiet outside a git repository (validate remains usable for pure
  home-config linting) and in `doctor --shallow` runs (no spawns).
  Note the warning reflects the CURRENT WORKING DIRECTORY's repository,
  not the manifest's location: linting a home-level manifest from
  inside an unrelated repo that ignores `.ai/` reports that repo's
  ignoredness (and `--strict` upgrades it to an error like every other
  warning) — run from the repo whose completions the pack gates.

Neither mitigation binds a run to the CURRENT change; a stale accepted
run keeping the arm green is a separate producer-side gap tracked as
agent-grounding `067bede3` (ow-review-2026-07-01/run-binding).

> Contract note: the producer contract this consumer depends on (the 7-key
> verdict shape AND the `orchestrator-workflow: ` blocker prefix) is now PINNED
> against a real `grounding-mcp@0.5.0` producer marker via
> `tests/fixtures/solution-acceptance/golden-verdict-0.5.0.json`, generated by
> running the real 0.5.0 `evaluateSolution` producer against a blocked-handoff
> OW run (preflight stubbed green). The
> consumer test asserts the 7-key drift guard, the `orchestrator-workflow: `
> prefix, and that the OW blocker reaches the deny message. The in-session
> producer-side knob/fallback semantics (marker-first resolution, fail-safe to
> `auto`, the `auto`/`on`/`off` values) still live in `grounding-mcp`'s own
> tests, not here.

## Failure mode

The pack is a pure consumer: it reimplements the marker read locally
and has no runtime dependency on `grounding-mcp`. Two misconfigurations
turn the gate into a permanent deny that LOOKS protective
(`src/cli/validate/checks.ts`, `checkSolutionAcceptanceProducer`):

1. **`grounding-mcp` absent from `tools.mcp`**: the producer is
   unreachable, no verdict can ever be written, every completion verb
   deadlocks on deny.
2. **`grounding-mcp` declares a RELATIVE `SOLUTION_VERDICT_DIR`**:
   `harness apply` now projects an absolute non-default
   `SOLUTION_VERDICT_DIR` into the hook at apply time (see
   `buildExpectedFiles` in apply.ts), so an absolute override is handled
   silently. A relative path cannot be reconciled: it resolves against
   each process's working directory, so the producer (grounding-mcp) and
   the hook can land on different dirs and the gate would deny.

Condition #1 is a hard error; condition #2 is a warning. Both are
surfaced by `harness validate` and `harness doctor` when the pack is
enabled.

## Post-completion work: the Release-Task pattern

After `task_finish` succeeds, post-done work like Release, deploy, or publishing is OUT OF SCOPE for the current task's verdict. Any post-done action that modifies repository state (a new commit, a tag, a published package) must run WITHIN its own separate task.

**Pattern:**

1. Main work task: claim with `task_start`, do work, finish with `task_finish` (gated by a verdict for the main work).
2. Post-done task (Release, deploy, etc.): create a separate task, claim with `task_start` (the verdict id for post-done work is this new task's id), run the post-done action, then `task_finish` (gated by a verdict for the post-done work).

This ensures each distinct completion boundary (main work vs. post-done) has its own separate preflight run and verdict. Trying to finish post-done work under the original task's verdict id would fail: the original task's verdict was earned for the state BEFORE post-done changes, not after.

## Env knobs

Read by the hook process (NOT from the manifest's `tools.mcp` env
block; see Failure mode #2):

| Variable | Effect | Default |
|----------|--------|---------|
| `SOLUTION_VERDICT_DIR` | Overrides the verdict directory the consumer reads. Must match where the producer writes. | `$XDG_STATE_HOME/agent-grounding/solution-verdicts`, falling back to `~/.local/state/agent-grounding/solution-verdicts` |
| `SOLUTION_VERDICT_ID` | Verdict id for solo / non-agent-tasks sessions. Consulted only when no `active-claim` exists. Validated as a safe single path segment; malformed fails closed. Set it to the same id passed to `mcp__grounding-mcp__solution_evaluate({ id })`. Must be set in the environment at Session-Start time (an Operator decision, not agent-sideeffect-settable from within the session). | unset (fail-closed without a claim) |

## See also

- [`understanding-before-execution.md`](understanding-before-execution.md), [`branch-protection.md`](branch-protection.md), [`post-merge-gate.md`](post-merge-gate.md): the other three builtin packs.
- [`../runtime-reality-hook.md`](../runtime-reality-hook.md): the opt-in drift gate that shares the "operator-configured producer, harness-side consumer" split.
- CHANGELOG `v0.32.0` / `v0.33.0` for the shipping rationale and the operator decisions behind the defaults.
