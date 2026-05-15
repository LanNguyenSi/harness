# Policy Pack: `understanding-before-execution`

> **Status (Phase 6 anchor):** vocabulary only. The `policy_packs:` manifest key parses and validates; nothing in `harness apply`, `harness doctor`, or runtime enforcement honours it yet. Sub-tasks #2 through #6 in [`ROADMAP.md`](../ROADMAP.md#phase-6--understanding-gate-policy-pack) wire those surfaces in. Until they ship, this doc describes the **target shape**, with the implementation status of each piece called out inline.

## What this pack does

Forces an agent to expose its task interpretation, an *Understanding Report*, before any write-capable tool fires. The user confirms, corrects, or "grills" the understanding until it is precise enough. Only after explicit human approval is recorded as evidence may the agent edit files, run shell commands, commit, push, or open PRs.

The motivating failure mode: an agent reads a task, picks an interpretation, and starts editing. The user notices three commits in that the scope is wrong. The Understanding Gate cuts this off at the point of interpretation, not at code review.

Long-form design and rationale: [`lava-ice-logs/2026-04-30/harness-pre-execution-understanding-integration.md`](https://github.com/LanNguyenSi/lava-ice-logs/blob/master/2026-04-30/harness-pre-execution-understanding-integration.md).

## How it works (target architecture)

```
User prompt
    │
    ▼
UserPromptSubmit hook        (from @lannguyensi/understanding-gate)
    │  injects the Understanding-Gate instruction template
    ▼
Agent emits an Understanding Report
    │
    ▼
Stop hook persists report     (from @lannguyensi/understanding-gate)
    │  → .understanding-gate/reports/<iso>-<slug>-<hash>.json
    ▼
Human reviews and approves
    │  via `harness approve understanding`  ← Phase 6 #4
    │  writes approval marker: harness.generated/.approvals/${SESSION_ID}
    │  flips approvalStatus=approved on the persisted report
    │  also writes ledger tag understanding-approved:${SESSION_ID} (audit only)
    ▼
PreToolUse hook               ← Phase 6 #4 (harness-side blocker)
    │  consults the approval marker file OR the persisted report
    │  passes for Edit / Write / Bash / commit / push / PR creation
    ▼
Agent executes
```

## Requirements

- `@lannguyensi/understanding-gate@>=0.2.0` available on PATH (the package ships `understanding-gate-claude-hook`, `understanding-gate-claude-stop`, `understanding-gate-claude-pre-tool-use`, plus the `understanding-gate` CLI). The package owns templates, parser, schema, persistence, and the minimal standalone PreToolUse blocker. Harness owns ledger glue, permission profiles, doctor wiring.
- An evidence ledger reachable via `grounding-mcp` (per [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §6) when running in *ledger-canonical* mode (the default for harness users). Solo users without harness can still run the pack against the persisted JSON file alone.

## Manifest reference

```yaml
policy_packs:
  - name: understanding-before-execution
    source: builtin           # default; resolves to the bundled pack definition
    enabled: true             # default
    description: "..."        # optional, falls back to the pack's own description
    config:
      mode: grill_me          # fast_confirm | grill_me | strict
```

### `config.mode`

| Mode | Friction | When the gate fires |
|---|---|---|
| `fast_confirm` | low | Only on prompts the classifier recognises as execution-relevant. Brief Understanding Report; one-line approval. |
| `grill_me` | medium (default) | On any prompt that the agent might respond to with a write. Full Understanding Report (assumptions, openQuestions, outOfScope, risks, verificationPlan). User is encouraged to push back. |
| `strict` | high | On every prompt. Report must include `verificationPlan` and `outOfScope`; `requiresHumanApproval` is forced to `true`. |

The mode lives under `config:` rather than at the top level because it is pack-specific. Other packs will define their own `config:` shape.

### Source

`source: builtin` resolves to the pack definition that ships with harness itself. Future values (`path:./packs/foo`, `npm:@scope/pack@1.2.3`, `git:https://...`) are reserved for community-authored packs and are **not** part of the v1 vocabulary; they parse as an opaque string today and will gain dedicated resolution in Phase 6 #3 (the `harness pack add` validate-on-write step) or later.

## Suggested permission profiles (Phase 6 #5)

Three reference profiles ship as Phase 6 #5 builtins. Select one via the pack's `config.permission_profile`:

```yaml
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      permission_profile: safe-start    # or implementation-after-approval / high-risk-grill-me
```

`harness apply` translates the active profile into Claude Code's `permissions: { allow, ask, deny }` block in the generated `settings.json`. Action keys map to tool patterns at translate time:

| Action | Patterns emitted into settings.json |
|---|---|
| `read` | `Read`, `Glob`, `Grep` |
| `edit` | `Edit`, `Write`, `MultiEdit` |
| `bash` | `Bash` |
| `commit` | `Bash(git commit*)` |
| `push` | `Bash(git push*)` |
| `pr` | `mcp__agent-tasks__pull_requests_create`, `Bash(gh pr create*)` |
| `deploy` | `Bash(kubectl*)`, `Bash(terraform destroy*)`, `Bash(npm publish*)` |

`allow:` enum:

- `true` and `false` map to `permissions.allow` and `permissions.deny`.
- `ask` maps to `permissions.ask`.
- `limited` and `ask_or_deny` collapse to `ask` for v1; finer-grained shaping is a Phase 6 #5 follow-up.

### The three v1 profiles

`safe-start` (pre-approval default):

```yaml
read:   { allow: true }
edit:   { allow: ask }
bash:   { allow: ask }
commit: { allow: false }
push:   { allow: false }
pr:     { allow: false }
deploy: { allow: false }
```

`implementation-after-approval` (post-approval working profile; activate by re-running `harness apply` after `harness approve understanding`):

```yaml
read:   { allow: true }
edit:   { allow: true }
bash:   { allow: ask }
commit: { allow: ask }
push:   { allow: ask }
pr:     { allow: ask }
deploy: { allow: false }
```

`high-risk-grill-me` (high-friction profile for security/infra surfaces; asks per-Edit and per-Bash even after approval):

```yaml
read:   { allow: true }
edit:   { allow: ask }
bash:   { allow: ask }
commit: { allow: false }
push:   { allow: false }
pr:     { allow: ask }
deploy: { allow: false }
```

Profile composition with the harness PreToolUse blocker (Phase 6 #4): the static `permissions` block sets the always-applies floor; the blocker handles the conditional approval gate on top. A request denied by `permissions.deny` is refused before the blocker runs; a request matched by `permissions.ask` still goes through the blocker, which can additionally refuse based on approval state.

Phase 6 #5 follow-ups still queued: an inline `requires:` shape on profile actions (the schema parses it today; runtime evaluation lands later); `permissions.allow` overrides for finer-grained `limited` semantics; per-pack profile overrides via `harness pack profile activate <name>` so the user does not need a manual re-apply.

## Approval state

Two parallel sources of truth, by design:

1. **Filesystem approval marker** at `harness.generated/.approvals/<sessionId>`. Owned by harness; the canonical source for harnessed sessions. Written by `harness approve understanding` from the operator's shell. Edit / Write / Bash are all gated by this same PreToolUse hook, and no configured MCP exposes filesystem writes, so the marker is reachable only from operator-launched processes. This is what closes the self-approval boundary (agent-tasks/88ca4bb3).
2. **Persisted JSON report** at `.understanding-gate/reports/<iso>-<slug>-<hash>.json`. Owned by `@lannguyensi/understanding-gate`; the canonical source for solo users running the package without harness. Flipped to `approvalStatus: "approved"` by the same `harness approve understanding` call. The agent's Stop hook only writes `pending` reports; the operator-side flip has no agent-reachable equivalent.

The harness-side PreToolUse blocker (Phase 6 #4) consults both: marker beats persisted-report. `harness approve understanding` round-trips both, plus writes a `understanding-approved:${SESSION_ID}` row to the evidence ledger as a forensics audit trail. The ledger row no longer satisfies the gate on its own (the agent has direct MCP access to the same ledger); it is surfaced in the diagnostic output, labelled `(no longer satisfies the gate)`, so an operator chasing a flapping approval can see when an approval was actually recorded.

This avoids the failure mode where one source goes stale relative to the other. It also means a solo `understanding-gate` user can adopt harness later without losing approval history.

## Adapter notes

### Claude Code (first-class target)

The `understanding-gate` package's existing claude-code adapter handles UserPromptSubmit (instruction injection) and Stop (report persistence). Phase 6 #4 adds the harness-side PreToolUse blocker on top of the package's minimal blocker (which only checks the persisted JSON). No changes required in `~/.claude/settings.json` beyond what `harness apply` regenerates.

### OpenCode

The package ships an OpenCode plugin (`message.updated` for the auto-capture path; `tool.execute.before` for the standalone blocker). Harness orchestration on top is the same shape as for Claude Code; no new harness-side surface is required for OpenCode v1.

### Codex

Shipped in Phase 6 #6. Apply the pack with the Codex runtime selector:

```sh
harness apply --runtime codex --config <path>/harness.yaml
```

This emits `harness.generated/codex/config.toml` (instead of `settings.json`) with two harness-managed `[[hooks.*]]` stanzas: one `user_prompt_submit` injector pointing at `harness pack hook codex-user-prompt-submit`, and one `pre_tool_use` blocker on `apply_patch|Bash|shell` pointing at `harness pack hook codex-pre-tool-use`. Operators copy or include the generated TOML under their own `~/.codex/config.toml`; harness owns hook wiring only, not the operator-owned model/auth/sandbox config.

Wire format for the Codex adapter scripts (stdin):

```jsonc
{
  "session_id": "<string>",   // also tolerated: "id"
  "tool_name":  "<string>",   // also tolerated: "tool"
  "raw_input":  {  /* tool args, opaque */  },
  "event":      "<string>"    // optional event name
}
```

Block contract (PreToolUse): exit 2 + reason on stderr. Allow contract: exit 0, optional diagnostic on stderr. Injector contract (UserPromptSubmit): instruction template on stdout for Codex to prepend to `additional_instructions`.

`--target` and `--runtime codex` are mutually exclusive: `--target` wires the Claude-Code-shaped settings.json into a destination path, which the codex runtime does not produce. The two runtimes are mutually exclusive for v1; running apply against a single manifest under both runtimes requires two invocations into separate generated trees.

### Doctor wiring

`harness doctor --target codex` (Phase 6 #6 follow-up, shipped) evaluates the harness side of the integration:

- The `harness` binary itself is on `$PATH` (so the `harness pack hook codex-*` subcommands resolve).
- `harness.generated/codex/config.toml` exists and carries the harness-managed banner.
- Every contributed `[[hooks.*]]` stanza has a command first-token that resolves on `$PATH` (bare `harness` subcommands inherit the binary check above).
- `.understanding-gate/reports/` is writable, or its parent is (the directory is created on first persisted report).

`--json` emits the structured `DoctorReport` with a `codexTarget` block; the codex error/warning counts roll into the top-level totals. `harness doctor` without `--target codex` is unchanged (back-compat).

### Stop-equivalent (report capture)

`harness pack hook codex-stop` (Phase 6 #6 follow-up, shipped) captures the agent's Understanding Report into `.understanding-gate/reports/<iso>-codex-<sessionhash>.json` with `approvalStatus: "pending"`. Wire format on stdin:

```jsonc
{
  "session_id":              "<string>",
  "last_assistant_message":  "<string>",   // preferred shortcut
  "messages":                [ /* { role, content } rows; last assistant entry used as fallback */ ]
}
```

The parser is heading-driven and lenient: it recognises markdown headings (`## Interpretation`), bold labels (`**Interpretation:**`), and plain colon-prefixed labels (`Interpretation:`). Field names accept `assumptions`, `openQuestions` / `Questions`, `outOfScope` / `Exclusions` / `Scope Exclusions`, `risks`, `verificationPlan` / `Validation` / `Verification`. Bullet lines (starting with `-`, `*`, or `•`) collect into the list-typed fields (`assumptions`, `openQuestions`, `outOfScope`, `risks`); non-bullet lines under a list-typed heading are silently dropped. Lines under a scalar-typed heading (`interpretation`, `verificationPlan`) accumulate into one paragraph until the next heading or a blank line.

Failure mode: any error (malformed input, missing session id, unwritable reports dir, parser yielded zero recognisable fields) resolves to exit 0 + a stderr diagnostic. Stop must never block the agent's response path.

After capture, `harness approve understanding --session <id>` flips `approvalStatus` to `approved` on the captured file and writes the ledger tag, identical to the Claude Code path. Cross-runtime approval is automatic since both runtimes share the same persisted-report directory.

### Out of scope for v1 (still tracked as follow-ups)

- A Codex-side permission-profile translator. `harness apply --runtime codex` warns when `policy_packs[].config.permission_profile` is set; the codex generator does not yet emit a Codex sandbox stanza.

## What the pack ships at apply time

`harness apply` against a manifest with this pack enabled writes:

- Three hooks in the harness-managed `settings.json`:
  - `UserPromptSubmit` injector: bare bin `understanding-gate-claude-hook` (from the npm package; user must `npm i -g`).
  - `Stop` capture: bare bin `understanding-gate-claude-stop` (same).
  - `PreToolUse` blocker on `Edit|Write|Bash`: `harness pack hook pre-tool-use` (Phase 6 #4). The harness-side blocker consults the approval marker file `harness.generated/.approvals/${SESSION_ID}` (canonical for harnessed sessions, agent-tasks/88ca4bb3) and the persisted JSON report under `.understanding-gate/reports/` (fallback for solo users). Either source approves. The npm package's standalone `understanding-gate-claude-pre-tool-use` blocker remains available for solo users; the harness blocker is the superset (it covers the marker file and persisted-report cases). The blocker also probes the evidence ledger for the historic `understanding-approved:${SESSION_ID}` tag as forensics; that probe never grants approval but surfaces in the diagnostic so an operator can see the audit trail. On every block or ask it stages the session id to `harness.generated/.pending-approval` so `harness approve` can resolve it without a flag (see [Session-id resolution](#session-id-resolution)).
  - Hook names are namespaced (`policy-pack:understanding-before-execution:<role>`) to avoid collisions with operator-authored hooks.
- An operator audit copy at `harness.generated/policy-packs/understanding-before-execution/instructions.md`. This file documents what the pack is doing in the operator's voice (mode, hook list, approval flow); the agent-facing prompt is injected at runtime by the `UserPromptSubmit` hook and lives in the npm package, not here. Drift on the audit copy means an operator edited something they shouldn't have, and `harness diff --since-apply` flags it.

## Approving an Understanding Report

```sh
harness approve understanding [--session <id>] [--reports-dir <path>]
```

Round-trips all three approval-state sinks:

- Writes the approval marker `harness.generated/.approvals/${SESSION_ID}` (canonical gate signal, agent-tasks/88ca4bb3). A failed marker write is a HARD error in the CLI output; the gate will keep blocking until the marker exists.
- Flips `approvalStatus: "approved"` on the latest matching persisted JSON report (canonical for solo users without `grounding-mcp`).
- Writes the `understanding-approved:${SESSION_ID}` tag via `grounding-mcp`'s `ledger_add` for audit / forensics. A degraded ledger surfaces as a warning, not a hard failure.

The blocker on the next tool call sees the new approval from whichever operator-authored source landed (marker or persisted report).

### Session-id resolution

`harness approve` needs the running session's id. Operators usually run it from a fresh `!`-shell where `$CLAUDE_SESSION_ID` is not set, so the id is resolved in this precedence order:

1. `--session <id>` flag.
2. `$CLAUDE_SESSION_ID` env.
3. `harness.generated/.pending-approval`: the PreToolUse blocker writes the blocked session's id here every time it blocks or asks, so an arg-less `harness approve understanding` picks it up with no guessing.

The CLI prints which tier supplied the id (`session: <id> (resolved from .pending-approval ...)`), so a wrong id is visible before it lands. After a successful resolve from `.pending-approval` with the marker write landed, the staging file is deleted so a later arg-less call cannot revive a stale id; a failed marker write keeps it for a retry. When all three tiers come up empty, the command exits with the retrieval-path hint instead of a guess.

Phase 6 #2 follow-ups still queued: an automatically-injected stanza into the per-project `CLAUDE.md` for human discoverability, and a `harness doctor` wiring check that validates the package binaries are on `$PATH`.

## See also

- [`docs/ROADMAP.md` Phase 6](../ROADMAP.md#phase-6--understanding-gate-policy-pack) for the sub-task decomposition.
- [`docs/ARCHITECTURE.md` §6](../ARCHITECTURE.md) for the policies/requires/grounding-mcp wiring this pack composes on top of.
- `@lannguyensi/understanding-gate` source: <https://www.npmjs.com/package/@lannguyensi/understanding-gate>.
