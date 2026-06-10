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

`harness validate` and `harness doctor` warn when the pack is enabled
but one of the two deadlock misconfigurations is present (see Failure
mode). Warning-tier in v1; escalation to a hard error is a tracked
follow-up.

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

- Bash redirects, `tee`, `mv` / `cp` / `ln`, interpreter one-liners that
  reference the dir, including glob-obscured spellings, plus `chmod` /
  `chattr` on the dir itself;
- `Write` / `Edit` / `MultiEdit` / `NotebookEdit` whose target lands
  inside it.

Reference detection matches on the stable dir tail
(`agent-grounding/solution-verdicts`), so any spelling of the home
prefix is caught (`~/.local/state/...`, `$HOME/...`,
`$XDG_STATE_HOME/...`, the literal absolute path). The only legitimate
writer is the producer.

Anti-forgery scope is v1-honest: it closes the enumerated-write-path
residual, not arbitrary same-uid forgery. Cryptographic marker signing
is a tracked follow-up.

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
