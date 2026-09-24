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
  (`src/policy-packs/types.ts`) has `hooks`, `files` (written under
  `harness.generated/policy-packs/<name>/`), and an optional
  `permissions` contribution; none of the three reaches the generated
  `MEMORY.md`. `generate-memory-index.ts` builds that index solely from
  user-authored markdown files under `manifest.memory.directories[]`
  (frontmatter `name`/`type`/`description`), packs have no contribution
  path into it today, and adding one would be a new mechanism, out of
  scope for this pack and out of bounds for this change (the
  memory-contract worktrees own that file).

Decision: the completion-gate's deny text is the surface. Implemented in
`blockJson`, gated on `gate.verdict === null` (the `evaluateGate` branch
whose reason is `no solution-acceptance verdict recorded for "<id>"`).
That single condition covers three readings: never evaluated, an attempt
still running, or a marker `readVerdict` rejected. Which reading applies
for a given denial, and which of them gets the full reconnect-vs-retry
paragraph versus a short reading-named line, is detected and documented
once, in "Reading the attempt-lock anchor to distinguish the three
readings" below; this subsection is about WHY the deny text is the
chosen surface, not WHAT it renders for each reading, so it stops short
of restating that detection logic or its exclusion list here (an earlier
version of this doc did both, in two places, and the two drifted apart
across review rounds).

The guidance does NOT appear on a not-ready or stale verdict deny: both
mean a run already completed and produced a marker, so there is no
"is it still running" ambiguity to resolve there. It also does not appear
when no verdict id resolved at all (no active claim and
`SOLUTION_VERDICT_ID` unset, so there is no id to poll for yet), nor on the
manifest-load-failure failsafe deny, nor when an operator has configured a
custom `ux` block, which replaces the default deny text entirely (a
pre-existing pack behavior, unchanged here). `instructions.md`
(`buildInstructions`) stays the audit copy documented above; it renders
its own "Reconnecting vs. retrying" section verbatim, but that section
is no longer written by hand separately from this deny paragraph (see
the shared reconnect-fact-source redesign further below).

### Review round 3 redesign (fixing the round-2 findings): one shared fact source (harness/5c9cad05)

The recurring review-round class above was hand-written deny text
asserting producer semantics that drift from `instructions.md` and the
source: round 1 shipped the wrong join semantics in the deny text but
not (yet) in `instructions.md`; round 2 then found the deny text
asserting the reconnect lifecycle unconditionally, when it only holds
under grounding-mcp >= 0.11.0, the pack's own producer floor being
>= 0.3.2. Both symptoms come from the same root cause: two hand-written
prose surfaces stating the same facts independently, with no mechanism
keeping them in sync.

`src/policy-packs/builtin/solution-acceptance-reconnect.ts` now owns the
reconnect facts as exported data (`RECONNECT_FACT_RECONNECT_BY_ID`,
`RECONNECT_FACT_JOIN_NOT_RETRY`, `RECONNECT_FACT_POLL_AND_RETENTION`,
`RECONNECT_VERSION_QUALIFIER`), with two renderers:
`renderReconnectDenyParagraph` (consumed by `blockJson`, the deny
paragraph documented above) and `renderReconnectInstructionsSection`
(consumed by `buildInstructions`, this pack's `instructions.md` section).
Both renderers interpolate the SAME fact constants verbatim, and every
rendering opens with `RECONNECT_VERSION_QUALIFIER` instead of stating the
lifecycle as if the pack's own producer floor guaranteed it.
`tests/policy-packs/solution-acceptance-reconnect.test.ts`
asserts each fact constant appears verbatim in both rendered surfaces
(the deny paragraph and the emitted `instructions.md`), so an edit that
updates one surface but not the other fails that test instead of
shipping a silent drift.

This module (`solution-acceptance-reconnect.ts`) does not itself read the
documented attempt-lock anchor: it names all three `gate.verdict === null`
readings in its rendered prose (`RECONNECT_THREE_READINGS_LABELS`) rather
than claiming the paragraph alone has any signal to distinguish them:
that reading now happens one layer up, in the hook (see the attempt-lock
anchor section below), which decides WHICH of the three applies before
deciding whether to append this paragraph at all.

The rendered `instructions.md` "Reconnecting vs. retrying" section's
wording changed where the shared source now renders it (the surrounding
headings, the producer-required section, and every other section are
untouched): the section still teaches reconnecting by `attemptId`, never
retrying while the lock is held (the "Never re-call `solution_evaluate`
as a stall workaround" sentence stays pinned by
`tests/policy-packs/solution-acceptance-expand.test.ts`), and the poll
interval / retention bounds, now phrased through the shared fact
constants instead of restated by hand.

### Reading the attempt-lock anchor to distinguish the three readings (harness/799de976)

The shared-fact-source redesign above still left the three `gate.verdict === null`
readings unresolved in the deny text: the SAME paragraph fired for all
three, naming them only inside its own prose. The follow-up it named
("narrow this paragraph to the in-flight case by reading that lock
anchor") is now implemented, entirely inside `hook-solution-acceptance.ts`
(`classifyNullVerdictReading`, `readAttemptLockLiveness`): the
reconnect-vs-retry paragraph (`renderReconnectDenyParagraph`, still owned
by `solution-acceptance-reconnect.ts`) is appended only for reading (2),
"an attempt is live"; readings (1) ("never evaluated") and (3) ("a marker
path exists but what is there was not accepted as a verdict") instead get
a short, state-specific line (`nullVerdictReadingNote`) with no reconnect
paragraph.

**An unusable id is settled before anything is read.** Both derived paths
(the marker path and the attempt-lock anchor) go through the same
`sanitizeVerdictId`, so an id it rejects (`.`, `..`, or anything whose
basename sanitizes to empty, reachable from an active claim: the
`SOLUTION_VERDICT_ID` path validates through the same function and
answers null instead) has NO marker path and NO anchor path, and none of
the three readings applies to it. `classifyNullVerdictReading` therefore
answers a separate `kind: "unusable-id"` state, modelled as a union
member without a `liveness` field so that "the id was unusable" cannot be
rendered as "a path could not be read"; its note states that one fact,
points at the active claim, and asks for a usable id rather than
repeating `solution_evaluate` for an id that can never be accepted.

**Detection.** After id usability, `classifyNullVerdictReading` checks
liveness BEFORE the marker outcome (a live
attempt can coexist with a stale or corrupt marker left by an earlier run
for the same id, and "reconnect" is the actionable reading in that
overlap: pinned by a dedicated overlap fixture, a held lock plus a
co-present unparseable marker, in
`tests/cli/pack-hook-solution-acceptance.test.ts`), then splits "never
evaluated" from "unreadable marker" by the outcome of the read the GATE
already made.

**The marker is observed once, not twice.** `readVerdictDetailed`
(`solution-acceptance-runtime.ts`) reports WHY a read yielded no verdict
(`invalid-id`, `missing`, `symlink`, `not-regular`, `unreadable`,
`invalid-record`, the shared reader's own four kinds plus one), and the
hook passes that single outcome into the classifier. `readVerdict` is the
same function with the reason dropped, so every caller that only needs the
gate decision is unchanged. The earlier design read the marker at the
decision site and then probed the path again a few statements later
(`probePathPresence`) to classify it; the two could disagree, because a
background `solution_evaluate` attempt finishing in that window is exactly
the case this pack exists for. The note then told the agent its fresh
marker had been REJECTED when the gate had simply not seen it yet, and the
remedy it offered ("re-run `solution_evaluate`") was wrong for that state
(review finding, harness/799de976, round 6). No fixture could have caught
it, since a fixture holds the filesystem still; the fix removes the second
observation rather than adding a test for the race.

**One line per rejection kind.** Reading (3) no longer restates a
disjunction over the ways a marker can be refused ("not a regular file,
unreadable, or not a valid verdict record"). Each kind renders its own
line naming what the gate's read established: a symlink refused by policy
without being read, a path that is not a regular file, a file that could
not be read, and a file that was read but is not a valid verdict record.
The lines live in a `Record` keyed by `NULL_VERDICT_NOTE_STATES`, so a
state added to that list without a line fails the build, and the state
table's coverage test fails when a listed state has no fixture.

**Liveness is three-valued, not boolean.** `readAttemptLockLiveness`
reads `<verdict dir>/<id>.attempt-lock` through `src/io/lock.ts`'s
`checkFileLock`, the designated read-only wrapper around
`proper-lockfile`'s own `checkSync` (already a harness runtime
dependency, so this adds none), with `realpath: false` (mirroring the
producer's own `acquireAttemptLock` call; with the library default
`realpath: true` a check on an anchor that was never created, the common
"never evaluated" case, throws `ENOENT` resolving the anchor FILE's own
realpath instead of answering the ordinary "not locked" case). The
result is `"live"`, `"not-live"` (no lock directory, or a stale one: the
library's own check answers `false` for both and swallows the absent-lock
`ENOENT` internally), or `"unknown"` (the underlying check threw: an
unreadable directory, a symlink loop, ...). For reading (1) with
`"unknown"` liveness the note asserts neither a missing marker nor an
absent attempt, and names no cause at all: the marker probe folds every
`lstat` failure into "missing", and the check can throw for the verdict
directory, for the attempt-lock path alone, or for something else again,
which this hook does not tell apart. Four review rounds each replaced one
guessed cause in this line with a narrower guess that the next reachable
state falsified, so the line now names none.
`checkFileLock` never acquires the lock, so there is nothing to release
or restore.

`"unknown"` is never collapsed into `"not-live"`: doing so would assert
an attempt is confirmed absent when liveness simply could not be
determined. Readings (1) and (3)'s notes (`nullVerdictReadingNote`) name
what was actually observed instead, "no attempt reads as currently live"
for a genuine `"not-live"` read versus "liveness could not be
determined" for `"unknown"`; neither wording claims the attempt is
confirmed absent on `"unknown"`. Pinned by a dedicated indeterminate-liveness
fixture (a co-present unparseable marker plus a `.lock` path whose `stat`
throws `ELOOP`, via a self-referential symlink) and by the pre-existing
ENOTDIR regression (`verdictDir` pointed at a regular file), both in
`tests/cli/pack-hook-solution-acceptance.test.ts`.

**The stale-lock rule, and its source.** A lock directory
`proper-lockfile` left behind by a DEAD process must eventually stop
counting as "live", or a crashed attempt would wedge the reconnect
paragraph in front of every future denial for that id forever (nothing
else ever removes that directory). The rule is not independently chosen:
it is `proper-lockfile`'s own staleness formula
(`lib/lockfile.js` `isLockStale`, `stat.mtime.getTime() < Date.now() -
options.stale`) applied with the producer's own DOCUMENTED default
window, `DEFAULT_ATTEMPT_LOCK_STALE_MS = 30_000`
(`grounding-mcp-v0.12.0`, `packages/grounding-mcp/src/solution-attempt-log.ts:102`),
the `staleMs` value `acquireAttemptLock` passes straight through to
`lockfile.lock(anchor, { retries: 0, realpath: false, stale:
options.staleMs, ... })` (same file, lines 472-475) on every DEFAULT
acquisition. This hook applies the producer's documented default window
pinned to `grounding-mcp-v0.12.0`; it diverges from what the producer
actually enforces for a given attempt if that default changes in a later
grounding-mcp release, or if a caller of `acquireAttemptLock` overrides
`staleMs` away from the default (the producer's own option is
caller-settable, same file), since neither is observable from this side
of the lock. See `ATTEMPT_LOCK_STALE_MS` in
`hook-solution-acceptance.ts` for the same citation inline with the
code.

**What stayed the same, and what a later fix corrected.** The reconnect
paragraph is still rendered by `renderReconnectDenyParagraph`, still
naming all three readings in its own prose (see the note above this
subsection), and its shared fact constants (`RECONNECT_FACT_*`,
`RECONNECT_VERSION_QUALIFIER`) and `renderReconnectInstructionsSection`
are byte-identical to the shared-fact-source redesign above. Two clauses of the
paragraph's OWN wording were corrected: it had shipped still saying "this
hook does not read the documented attempt-lock anchor, so it cannot rule
any of these three apart", true of the pre-799de976 behavior but false
once the paragraph is appended only for the already-detected live-attempt
reading; it now says the hook read the anchor and is showing the
paragraph because it detected reading (2). `instructions.md` is
unchanged; grounding-mcp and its lock layout are unchanged; no new
runtime dependency was added.

Pinned by `tests/cli/pack-hook-solution-acceptance.test.ts` ("gate.verdict
=== null: three readings distinguished by the attempt-lock anchor": one
test per reading, a dedicated stale-lock regression whose back-date is a
literal rather than derived from the constant under test, the overlap and
indeterminate-liveness fixtures above, and a symlinked-anchor test that
builds its lock through the real `proper-lockfile` acquisition). The
agent-facing wording itself is pinned by a second block in the same file
("null-verdict deny note: one exact line per reachable state"), a state
table carrying one exact expected line per reachable (note state,
liveness) combination plus the assertion that no other state's line
appears: the note's "state only what was established" invariant is
checked mechanically there, rather than one fixture per finding as each
round named it. Its coverage test iterates `NULL_VERDICT_NOTE_STATES` and
fails when a listed state has no fixture, which is what makes the table a
checklist rather than a convention; the renderer's own
`Record<NullVerdictNoteState, ...>` covers the other direction at compile
time. Backed further by
the pre-existing parity/negative tests unchanged from the redesign above
(the not-ready/stale/no-verdict-id/manifest-load-failure denies still
carry no reconnect guidance;
`tests/policy-packs/solution-acceptance-reconnect.test.ts` still pins the
deny paragraph's wording against `instructions.md`); `src/io/lock.ts`'s
own `tests/io/lock.test.ts` pins `checkFileLock`'s three-valued read
directly (live, not-live, stale-as-not-live, and unknown via ELOOP).

### The converge list's next action, per reading (harness/58c65bc9)

The deny text's converge list (`blockJson` in
`src/cli/pack/hook-solution-acceptance.ts`) used to name step 2 as calling
`solution_evaluate` for every reading. For readings (1) (never evaluated) and (3) (a marker
path exists but what is there was not accepted as a verdict) that is the
right next action: a call there genuinely starts the evaluation. For
reading (2) (an attempt is live) it is the wrong one: a call for an id
whose attempt is still live just JOINS that attempt and returns its
`attemptId`, it never starts a second `preflight` run
(`RECONNECT_FACT_JOIN_NOT_RETRY`, `solution-acceptance-reconnect.ts`);
only `forceNewAttempt` is refused while the lock holds. Before this
change, step 2 named `solution_evaluate` for every reading including (2),
sitting directly above the reconnect paragraph's own "do not call it
again" / "Never re-call `solution_evaluate`" sentences, one converge step
and the paragraph appended right below it disagreeing on the same tool
call.

`convergeStep2For` now renders step 2 as a function of the reading:
readings (1) and (3), and every non-null-verdict deny (drift, not-ready,
manifest-load-failure, ...), keep the original line naming
`solution_evaluate` unqualified (its wording is unchanged apart from a
colon in place of a dash). Reading (2) instead gets its own line
naming `solution_evaluate_status` / `solution_evaluate_result` (the same
poll tools `RECONNECT_STATUS_TOOL` / `RECONNECT_RESULT_TOOL` the reconnect
paragraph itself names) and pointing at the reconnect paragraph below it,
with no `solution_evaluate(` call instruction anywhere in the reading-(2)
deny text. `solution-acceptance-reconnect.ts` and
`renderReconnectInstructionsSection`'s rendered output are unchanged by
this: the shared reconnect wording still owns the paragraph, only the
converge list's step 2 line changed, and only for reading (2). Pinned in
`tests/cli/pack-hook-solution-acceptance.test.ts`: a dedicated test
asserts the reading-(2) deny contains no `solution_evaluate(` call
instruction and that step 2 itself (not only the reconnect paragraph)
names both poll tools, and the reading-(1) and reading-(3)
fixtures each assert step 2 still names `solution_evaluate` unqualified.

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
