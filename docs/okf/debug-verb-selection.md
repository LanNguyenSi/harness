---
type: overview
title: Debug verb selection — which harness verb answers which question
description: Decision guide mapping "why did my policy (not) fire" questions to the right harness debug verb — ledger-replay vs live-hypothetical vs static-prediction vs stage-isolation vs end-to-end — with each verb's key discriminators and fail-postures.
tags: [debugging, cli, audit, explain, dry-run, smoke]
timestamp: 2026-09-01T07:28:10Z
sources:
  - docs/for-agents.md
  - docs/CLI.md
  - docs/risk-gate.md
  - src/cli/index.ts
  - src/cli/dry-run.ts
  - src/runtime/command-normalize.ts
  - src/runtime/intercept.ts
  - src/io/extract.ts
  - src/cli/explain.ts
  - src/cli/explain-action.ts
  - src/cli/explain-policy.ts
  - src/cli/test-risk.ts
  - src/cli/resolve-env.ts
  - src/cli/audit.ts
  - src/cli/session-export/index.ts
  - src/cli/smoke/index.ts
  - src/cli/smoke/runner.ts
  - src/cli/doctor/index.ts
  - src/cli/exit-codes.ts
---

# Debug verb selection — which harness verb answers which question

The harness ships nine read-side debug verbs plus one end-to-end runner. They differ on three axes: **what they read** (the evidence ledger, a hand-crafted event JSON, or nothing but the manifest), **when they evaluate** (replaying a past decision vs. evaluating a hypothetical now vs. predicting statically), and **how much of the pipeline they exercise** (envelope only, one Risk-Gate stage, full policy evaluation, or a real `claude -p` session). Picking the wrong verb is the most common source of confusing answers, e.g. asking `explain --trace` about a policy that never fired, or trusting `dry-run` to prove a gate is wired when only `smoke` can.

## Question → verb

| Your question | Verb | Reads ledger? | Evaluates policies? |
|---|---|---|---|
| "Is this gate firing at all today?" | `harness audit --since 1h [--policy <name>] [--outcome deny]` | yes (replay) | no — replays recorded decisions |
| "Why did the decision I just got land where it did?" | `harness explain <policy> --trace` or `explain --last` | yes (last recorded evaluation) | no — renders the recorded trail |
| "WOULD this policy apply to this event?" | `harness explain-policy <policy> --event <event.json>` | no | yes — live, hypothetical |
| "Which hooks/policies/memories would this prompt trigger?" | `harness dry-run <prompt> [--tool <name>]` | no (no ledger I/O) | statically — match prediction only |
| "What envelope does the Risk Gate actually see?" | `harness explain-action <event.json>` | no | no — envelope normalization only |
| "What risk tier does this event classify as?" | `harness test-risk <event.json>` | no | classifier stage only |
| "Which environment does this event resolve to?" | `harness resolve-env <event.json>` | no | resolver stage only |
| "What actually happened in session X, end to end?" | `harness session-export <sessionId>` | yes (joined with transcript) | no |
| "Is the whole pipeline wired correctly, for real?" | `harness smoke --prompt <p> --output-dir <d> --expect-*` | writes one (real run) | yes — real `claude -p` |
| "Is my install healthy (hooks, packs, MCPs, versions)?" | `harness doctor` | scans for rogue ledgers | no |

## audit — replay recorded decisions over a time window

`harness audit [--since 1h] [--policy <name>] [--outcome <o>] [--session <id>] [--json]` replays `policy_decision` rows from the evidence ledger for a time window, one row per decision (timestamp, policy, outcome, reason), sorted chronologically (src/cli/index.ts, `command("audit")`; src/cli/audit.ts). Default window is 24h (`DEFAULT_SINCE = "24h"` in src/cli/audit.ts); `--outcome` accepts `allow / warn / require_approval / deny / warn-degraded / deny-degraded` (the last added by task f1aea826 for degraded-ledger denials). `--session <id>` selects the grounding session, defaulting to `$CLAUDE_SESSION_ID` then `'default'`. Next to the decisions table, `audit` also renders an `approvals` section listing the raw understanding-gate ledger facts (`understanding-approved:<sid>`, its `:forced:<field>` variant, `understanding-auto-approved:<sid>`) in the same `--since` window, filtered by `--session` only (never `--policy` / `--outcome`); empty is omitted in text, always present (as `[]`) in `--json`, and a degraded approvals-only fetch renders `approvals unavailable: <reason>` without discarding the decisions table. Use it for the coarse question "did anything fire, and what was denied", it shows outcomes, not reasoning depth (docs/for-agents.md, "The audit triumvirate").

## explain — the LAST RECORDED evaluation, from the ledger

`harness explain [policy] [--trace] [--last] [--decision <outcome>] [--session <id>]` (src/cli/index.ts, `command("explain [policy]")`). Without `--trace` it just prints the policy definition plus the record hint. With `--trace` it fetches the ledger for the session and renders the most recent recorded evaluation of that policy: decision, enforcement, ledger tag, extracted variables, and (for post-Phase-7 rows) the recorded risk verdict. This **requires a real prior decision**: if the policy never fired in that session it exits `EX_FAIL` with "no recorded evaluations for policy ... the policy may not have fired yet, grounding-mcp is unreachable, or the decisions landed under a different session (pass `--session <id>`)" (src/cli/explain.ts, lines 229-233). `--last` is mutually exclusive with naming a policy and traces the most recent decision of ANY policy; `--decision` narrows `--last` by outcome. If grounding-mcp is unreachable the fetch degrades to a hard `cannot read audit log` error, not a silent empty trace.

## explain-policy --event — a HYPOTHETICAL event, evaluated live, ledger untouched

`harness explain-policy <policy> --event <event.json>` (Risk Gate debug verb, Phase 7) answers the counterfactual: would this policy APPLY to this event? It builds and enriches the Action Envelope from the event file, then shows the trigger match, the risk classification, the resolved environment, and a per-clause `when:` breakdown. Its own `--description` in src/cli/index.ts states the discriminator verbatim: "Evaluates a hypothetical event live and reads nothing from the ledger (use `harness explain <policy> --trace` for the last recorded decision)." So: past decision → `explain --trace`; what-if → `explain-policy --event`. The `--event <event.json>` flag is `requiredOption`.

## dry-run — static prediction for a PROMPT, no ledger I/O

`harness dry-run <prompt> [--tool <name>] [--tool-args <json>]` statically predicts which hooks fire, which policies match, and which memory directories route for a prompt, "without ledger I/O" (docs/for-agents.md line 263). src/cli/dry-run.ts confirms: it never fetches the ledger; for each matching policy it computes the `ledgerQuery` string the runtime WOULD run (`staticLedgerQuery`) and reports it alongside `requires`/`enforcement`, plus `couldMatchPolicies` with a reason. **Trigger-matching parity (since task `ea8becf5`, extended by task `aabbad63`, extended by task `f561e44c`):** `policyMatchesTool`'s `bash_match` check (`src/cli/dry-run.ts`) now tests raw-OR-normalised-OR-amp-normalised-OR-quote-normalised via the same `normalizeCommand`, `normalizeCommandAmpAware`, AND `normalizeCommandQuoteAware` (`src/runtime/command-normalize.ts`) the real `policyMatchesEvent` uses, so a wrapper-prefixed, extra-global-option, bare-`&`-background-job (`echo hi & nice git status`), or quoted-assignment-boundary (`VAR='a; b' git push origin master`) command predicts the same match/no-match as the runtime. The same parity contract covers `trigger.input_match` (task `2699b476`): `policyMatchesEvent` (`src/runtime/intercept.ts`) and dry-run's `policyMatchesTool` (`src/cli/dry-run.ts`) call the SAME shared evaluator, `firstInputMatchMismatch` (`src/io/extract.ts`), against the single `toolArgs` object each side builds, so `dry-run --tool mcp__agent-tasks__task_finish --tool-args '{"autoMerge":true}'` predicts gated exactly when `policy intercept` would gate it. One arm is intercept-only, not a parity gap: when a payload carries `tool_input` and `raw_input` as separate non-null objects, `inputMatchMismatchesEvent` (`src/runtime/intercept.ts`, task `2699b476` round 2) arms the gate if EITHER field matches the map, a mixed-envelope shape `dry-run` cannot reproduce because its `--input` is always one JSON object: there is no second envelope for it to disagree with. It is NOT fully hermetic, and **as of task `98ad072f` (v0.44.0) it is no longer full parity on `${REPO}`/`${BRANCH}` either.** `builtinsFor` still derives them from the cwd alone via `resolveGitContext` — unchanged since the `ea8becf5` era, when a per-command target-directory resolution for these builtins was built, reviewed, and removed before shipping (three consecutive review rounds each found a different way it regressed security; see `CHANGELOG.md`'s `ea8becf5` entry and `src/runtime/command-normalize.ts`'s module header). But the runtime side of that story moved on: `src/runtime/intercept.ts`'s `resolveAttributedContexts` now evaluates a `${REPO}`/`${BRANCH}`/`at_head`-bearing `requires:` policy once per DISTINCT repository context a trigger-satisfying command segment names, additively alongside cwd (capped at `MAX_ATTRIBUTED_CONTEXTS = 4`). `dry-run` was not updated to match: `staticLedgerQuery` still computes exactly one, cwd-only `ledgerQuery` string per policy, so for a command naming a foreign repo target (e.g. `git -C <B> push`) `dry-run` now UNDER-predicts what the runtime actually demands — the runtime queries both cwd's and `<B>`'s preflight evidence, `dry-run` shows only cwd's. This is a live, currently undocumented-elsewhere gap between the debug verb and the runtime it exists to predict. Prediction ≠ decision: dry-run tells you a policy WOULD match, not what outcome its `requires:` evaluation would produce, because that depends on ledger state it deliberately does not read.

## explain-action — the normalized Action Envelope, nothing else

`harness explain-action <event.json> [--json]` reads a tool-event JSON file (the Claude Code PreToolUse hook payload shape: `{ hook_event_name, tool_name, tool_input, session_id, cwd }`) and prints the normalized Action Envelope — the inspection surface for the normalization all downstream Risk-Gate stages consume. Its description says it plainly: "does not evaluate policies" (src/cli/index.ts, `command("explain-action <event.json>")`). Use it first when a downstream verb gives a surprising answer, to check whether the envelope itself is what you expected.

## test-risk / resolve-env — one Risk-Gate stage in isolation

Both take a hand-crafted event JSON and run exactly one enrichment stage against the manifest:

- `harness test-risk <event.json>` classifies the envelope against `risk.classifiers[]` and prints the risk profile (severity, categories, reversibility, confidence, reasons). Fail-posture, stated in the command description and the source comment: "An action no pattern matches reports as **unclassified, not as safe**"; a manifest with no `risk.classifiers[]` is valid and then EVERY action is unclassified ("unknown is not safe", src/cli/test-risk.ts lines 39-40). It reports the same classification the runtime gate uses (docs/risk-gate.md lines 144-145), including the built-in floors (harness's own read-only verbs classify `low`; `harness preflight && rm -rf /var` still classifies `critical` because highest-severity wins).
- `harness resolve-env <event.json>` resolves the target environment against `environments.resolvers[]` (branch / env-var / kube-context / kube-namespace signals). Same posture: "An action no resolver matches resolves to **`unknown`, not to a safe default**"; no resolvers configured means everything resolves `unknown` (src/cli/resolve-env.ts lines 50-51).

Use these when `explain-policy` shows a `when:` clause failing and you need to know whether the classifier or the resolver stage produced the surprising input.

## session-export — one session, transcript + ledger joined chronologically

`harness session-export [sessionId] [--format json|jsonl] [-o <file>]` exports "a chronological audit artifact joining the on-disk transcript JSONL and the evidence ledger for a session" (src/cli/index.ts). src/cli/session-export/index.ts merges transcript events (prompts, tool_use/tool_result blocks) with ledger entries via `mergeEvents`, sorted by timestamp, each event tagged `source: "transcript" | "ledger"`; the header reports `ledgerStatus: ok | degraded | missing` so a half-empty export is visible, and it errors if BOTH sides are empty. Default-on redaction applies `manifest.audit.redact` rules (src/cli/session-export/redact.ts). This is the "what did the agent actually do in session X" verb; it explains nothing, it reconstructs.

## smoke — the only verb that runs a real `claude -p` end to end

`harness smoke --prompt <text> --output-dir <path> [--expect-hook a,b] [--expect-no-hook c] [--expect-exit <n>] [--expect-decision allow|deny|warn] [--session-id <id>] [--claude-bin <path>] [--timeout-ms <n>]`. It reuses the `apply` machinery to render a settings.json from the manifest, spawns `claude` with `-p` and the canonical stream-json flags, and asserts the `--expect-*` flags against the observed stream (src/cli/smoke/index.ts, src/cli/smoke/runner.ts). Artifacts land under `--output-dir`: `stream.jsonl`, `stderr.log`, and the rendered `settings.json`. Exit codes: `EX_OK` (0) on green, `EX_FAIL` (1) on any expectation miss, `EX_UNAVAILABLE` (69) when the claude binary is missing (`ensureClaudeAvailable`, src/cli/smoke/index.ts lines 99-123; `EX_FAIL = 1` in src/cli/exit-codes.ts). A claude exit not equal to 0 without a terminal `result` event is treated as an implicit failure with a pointer to stderr.log. Every other verb on this page reasons ABOUT the pipeline; smoke is the only one that proves the applied manifest actually intercepts a live session, which is also why the Risk Gate's low-severity floor for harness commands deliberately EXCLUDES `smoke` (it stays classifiable as a mutating command, docs/risk-gate.md lines 129-132). Reach for it after `init --interactive`, a version bump, or whenever dry-run says a hook should fire but you doubt the wiring.

## doctor — install health, not decision debugging

`harness doctor [--shallow] [--target codex] [--json] [--rm-rogue-ledgers [--yes]]` is the health summary across pillars: hooks, policy packs (declared-but-not-live detection, config-shape checks), MCP registrations and probes, runtime detection, and binary versions (src/cli/doctor/index.ts, src/cli/doctor/types.ts). It runs `min_version` probes for `tools.cli[]`, `tools.mcp[]`, and hooks that declare `min_version` + `version_command`, via a synchronous `--version` spawn with a 5s timeout (`defaultVersionProbe` in src/cli/index.ts); an installed version below `min_version` reports `installed vX < required Y`. `--shallow` skips MCP probes (CLI version probes still run). It also scans for rogue evidence-ledger directories and can delete them behind per-hit prompts. Since task a07b379a / PR #342, `harness doctor` exits `1` whenever the report's `errorCount > 0` (warnings-only reports still exit `0`), so CI can gate on it directly instead of parsing text; a spawn `ENOENT` on a missing MCP/CLI binary no longer crashes the whole report (PR #340) — it surfaces as a finding, with a PATH-shadow hint when the binary is actually installed under an npm global bin dir not on PATH. Since task `init-mcp-wiring-claude-code`/T-003, whenever `tools.mcp[]` is non-empty the report also carries a `claudeMcp` section ("Claude Code MCP Registration", `src/cli/doctor/claude-mcp.ts`) that re-verifies registration against the surface Claude Code actually reads — `claude mcp list`'s live user-scope registry — rather than the (now dead) `mcpServers` block harness used to write into settings.json; it also flags harness-owned names still stuck in that dead settings.json block as a migration hint. The live `claude mcp list` spawn additionally self-gates on `!shallow` and at least one enabled `tools.mcp[]` entry. Doctor tells you whether the machinery CAN work; it says nothing about why a specific decision landed.

## Selection heuristics

- Start from what you have. A denial in hand → `explain --last` (or `explain <policy> --trace`). Only a suspicion → `audit --since 1h`. Only a plan → `dry-run` or `explain-policy --event`.
- "Policy didn't fire and I don't know why": `dry-run` (does it even match?) → `explain-policy --event` (which `when:` clause fails?) → `test-risk` / `resolve-env` (is the failing clause fed a surprising classification/environment?) → `explain-action` (is the envelope itself wrong?).
- "Policy fired and I don't know why": `explain --last` first; it shows the recorded trigger, extracted variables, and (post-Phase-7) the recorded risk verdict, including the fail-closed-unclassified flag.
- Remember the fail-postures when reading stage output: `test-risk` "unclassified" and `resolve-env` "unknown" are DENY-leaning states under fail-closed policies, not neutral ones.
- Ledger-reading verbs (`audit`, `explain --trace/--last`, `session-export`) are session-scoped: an empty answer often means the decisions landed under a different session id, so pass `--session <id>` before concluding the gate never fired.
