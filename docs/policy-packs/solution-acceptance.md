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

`harness validate` warns when the pack is enabled but one of the two
deadlock misconfigurations is present (see Failure mode). Warning-tier
in v1; escalation to a hard error, and surfacing the same finding in
`harness doctor`, are tracked follow-ups.

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
residual, not arbitrary same-uid forgery. Cryptographic marker signing
is a tracked follow-up.

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
2. **`grounding-mcp` declares a non-default `SOLUTION_VERDICT_DIR`**:
   harness does not project `tools.mcp` env into the hook context, so
   the consumer keeps reading the producer-default location and never
   sees the override. Unset it, or mirror the same value into the hook
   environment.

Both are surfaced as `harness validate` warnings when the pack is
enabled.

## Env knobs

Read by the hook process (NOT from the manifest's `tools.mcp` env
block; see Failure mode #2):

| Variable | Effect | Default |
|----------|--------|---------|
| `SOLUTION_VERDICT_DIR` | Overrides the verdict directory the consumer reads. Must match where the producer writes. | `$XDG_STATE_HOME/agent-grounding/solution-verdicts`, falling back to `~/.local/state/agent-grounding/solution-verdicts` |
| `SOLUTION_VERDICT_ID` | Verdict id for solo / non-agent-tasks sessions. Consulted only when no `active-claim` exists. Validated as a safe single path segment; malformed fails closed. Set it to the same id passed to `mcp__agent-grounding__solution_evaluate({ id })`. | unset (fail-closed without a claim) |

## See also

- [`understanding-before-execution.md`](understanding-before-execution.md), [`branch-protection.md`](branch-protection.md): the other two builtin packs.
- [`../runtime-reality-hook.md`](../runtime-reality-hook.md): the opt-in drift gate that shares the "operator-configured producer, harness-side consumer" split.
- CHANGELOG `v0.32.0` / `v0.33.0` for the shipping rationale and the operator decisions behind the defaults.
