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
    │  writes ledger tag: understanding-approved:${SESSION_ID}
    │  flips approvalStatus=approved on the persisted report
    ▼
PreToolUse hook               ← Phase 6 #4 (harness-side blocker)
    │  consults BOTH the ledger tag AND the persisted report
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

The pack will ship three reference permission profiles. The shape and key names are still tentative; the table records the **intent**.

```yaml
# safe-start: pre-approval default for any harnessed agent.
read:   { allow: true }
edit:   { allow: false, mode: ask_or_deny }
bash:   { allow: limited, mode: ask }
commit: { allow: false }
push:   { allow: false }
pr:     { allow: false }
```

```yaml
# implementation-after-approval: unlocks once the ledger tag is present.
requires:
  ledger_tag: "understanding-approved:${SESSION_ID}"
read:   { allow: true }
edit:   { allow: true }
bash:   { allow: ask }
commit: { allow: ask }
push:   { allow: ask }
pr:     { allow: ask }
```

```yaml
# high-risk-grill-me: never allows commit/deploy automatically; ask-everything.
requires:
  - understanding_report.status == approved
  - verification_plan.present == true
  - out_of_scope.present == true
  - human_approval.explicit == true
edit:   { allow: ask }
bash:   { allow: ask }
commit: { allow: false }
deploy: { allow: false }
```

These profiles are documentation-only until Phase 6 #5 lands the runtime semantics.

## Approval state

Two parallel sources of truth, by design:

1. **Persisted JSON report** at `.understanding-gate/reports/<iso>-<slug>-<hash>.json`. Owned by `@lannguyensi/understanding-gate`; the canonical source for solo users running the package without harness.
2. **Evidence ledger tag** `understanding-approved:${SESSION_ID}`. Owned by harness; the canonical source for harnessed sessions, queried via `grounding-mcp`'s `ledger_summary`.

The harness-side PreToolUse blocker (Phase 6 #4) consults both: ledger tag wins when present, persisted report is the fallback. `harness approve understanding` (Phase 6 #4) round-trips both: it writes the ledger tag AND flips `approvalStatus: "approved"` on the most recent persisted report.

This avoids the failure mode where one source goes stale relative to the other. It also means a solo `understanding-gate` user can adopt harness later without losing approval history.

## Adapter notes

### Claude Code (first-class target)

The `understanding-gate` package's existing claude-code adapter handles UserPromptSubmit (instruction injection) and Stop (report persistence). Phase 6 #4 adds the harness-side PreToolUse blocker on top of the package's minimal blocker (which only checks the persisted JSON). No changes required in `~/.claude/settings.json` beyond what `harness apply` regenerates.

### OpenCode

The package ships an OpenCode plugin (`message.updated` for the auto-capture path; `tool.execute.before` for the standalone blocker). Harness orchestration on top is the same shape as for Claude Code; no new harness-side surface is required for OpenCode v1.

### Codex

Not yet covered by `@lannguyensi/understanding-gate`. Harness will ship a Codex adapter as Phase 6 #6. The hook contract used by Codex (UserPromptSubmit + PreToolUse with `apply_patch`/`Bash` matching) maps cleanly onto the same `policy_packs:` config; the deltas are in adapter scripts, not in the pack's manifest shape.

## What the pack ships at apply time (Phase 6 #2)

Once `harness apply` integrates pack expansion, declaring this pack will install:

- `~/.claude/CLAUDE.md` instruction stanza explaining the gate (driven by the `mode:` setting; sourced from the package's `src/prompts/{full,fast-confirm,grill-me}.ts`).
- Three hooks in `~/.claude/settings.json`: UserPromptSubmit (instruction injection), Stop (report capture), PreToolUse (blocker).
- A `.harness/policy-packs/understanding-before-execution/` directory under the project containing the resolved instruction text and a copy of the pack metadata for drift detection.
- Drift detection: `harness diff --since-apply` flags edits to any of the above; `harness doctor` warns when hooks are not registered or templates have drifted.

None of this happens today; this section describes the shape Phase 6 #2 will deliver.

## See also

- [`docs/ROADMAP.md` Phase 6](../ROADMAP.md#phase-6--understanding-gate-policy-pack) for the sub-task decomposition.
- [`docs/ARCHITECTURE.md` §6](../ARCHITECTURE.md) for the policies/requires/grounding-mcp wiring this pack composes on top of.
- `@lannguyensi/understanding-gate` source: <https://www.npmjs.com/package/@lannguyensi/understanding-gate>.
