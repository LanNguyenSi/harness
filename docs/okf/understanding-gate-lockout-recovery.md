---
type: runbook
title: Understanding-gate lockout recovery
description: Operator procedure to unblock a session locked by the understanding-before-execution PreToolUse gate via `harness approve understanding`, including the 6-tier session-id resolution and the expiry semantics that re-arm the gate.
tags: [runbook, understanding-gate, lockout, recovery, operator]
timestamp: 2026-07-16T02:26:27Z
sources:
  - src/cli/approve/understanding.ts
  - src/cli/index.ts
  - src/runtime/session-id.ts
  - src/runtime/pending-approval.ts
  - src/runtime/home-dir.ts
  - src/io/generated-dir.ts
  - src/policy-packs/builtin/understanding-before-execution-runtime.ts
  - src/policy-packs/builtin/understanding-before-execution.ts
  - src/cli/pack/hook-post-tool-use.ts
  - docs/policy-packs/understanding-before-execution.md
---

# Understanding-gate lockout recovery

## Symptom

Every `Edit` / `Write` / `Bash` call is refused by the `understanding-before-execution` pack's PreToolUse blocker (`harness pack hook pre-tool-use` on the Claude side; the Codex variant matches `apply_patch|Bash|shell|exec_command|functions.exec_command`). Block contract: exit 2 with the reason on stderr. The agent cannot clear this itself: the historic ledger tag `understanding-approved:<sessionId>` no longer satisfies the gate (agent-tasks/88ca4bb3 closed the self-approval backdoor; `matchLedgerEntries` is audit-only now), and the agent has no filesystem path into `harness.generated/` because the same hook gates Edit/Write/Bash.

## Why the gate is closed

The blocker consults two operator-authored sources, either of which approves (`src/policy-packs/builtin/understanding-before-execution-runtime.ts`):

1. **Approval marker files** under `<generatedDir>/.approvals/` — the canonical signal. `checkOperatorApprovalMarkers` checks the **task-scoped** marker first (`task-<taskId>`, where the task id comes from `<generatedDir>/active-claim`, written by the `track-active-claim` PostToolUse hook on `mcp__agent-tasks__task_start`), then the **session-scoped** marker (`<generatedDir>/.approvals/<sessionId>`). Both are subject to the same optional `max_age` TTL. Since harness/f9485cc7, existence alone is NOT enough: the marker also carries an HMAC-SHA256 signature verified against an operator-side key at `<generatedDir>/.approval-signing.key`; a marker with an unreadable body, malformed/non-object JSON, or a missing/invalid signature is rejected exactly like a missing marker (`matched:false`, tagged `forged:true` for the signature cases). Symlinks at the marker path are still refused.
2. **Persisted JSON report** under the reports dir with `approvalStatus: "approved"` matching the session — fallback for solo `@lannguyensi/understanding-gate` users.

You are locked out because no fresh marker exists for this session/task: it was never approved, it was deleted at a task boundary, or it aged past `max_age`.

**Where these paths actually are.** `<generatedDir>` = `harness.generated/` next to the manifest (`src/io/generated-dir.ts`). The manifest defaults to `~/.harness/harness.yaml` (home-dir precedence in `src/runtime/home-dir.ts`: explicit `homeDir` → `$HARNESS_HOME` → `~/.harness/` if it exists → legacy `~/.claude/` if it carries `harness.yaml` or `harness.generated/` → `~/.harness/` create-on-first-use). So a default install has markers in `~/.harness/harness.generated/.approvals/`. The reports dir resolves `--reports-dir` flag → `$UNDERSTANDING_GATE_REPORT_DIR` env (`REPORTS_DIR_ENV` constant) → `<manifest-dir>/.understanding-gate/reports`, i.e. typically `~/.harness/.understanding-gate/reports` (`defaultReportsDir`, anchored on `path.dirname(resolvePaths(opts).base)` in `approveUnderstanding`).

## Recovery: exact steps

Recovery is **operator-only**, from a shell the hooks do not gate (the `!`-shell or any other terminal the operator launched — this is the whole trust boundary).

1. Read the agent's Understanding Report. Then run, bare:

   ```sh
   harness approve understanding
   ```

   Flags (`src/cli/index.ts:1480-1495`): `--session <id>`, `--task <ids...>` (variadic; also comma-joined `--task a,b,c`), `--reports-dir <path>`, `--approved-by <actor>` (default `harness-approve-cli`), `--force`, `--config <path>`, `--project <name>`.

2. **Session-id resolution** — the bare command works because the id is resolved through a 6-tier precedence chain (`resolveApprovalSessionId`, `src/runtime/session-id.ts:241`; used by `src/cli/approve/understanding.ts:513`):
   1. explicit `--session` flag
   2. `$CLAUDE_CODE_SESSION_ID` (the variable Claude Code actually exports; read first so the runtime's id beats a hand-exported legacy value)
   3. `$CLAUDE_SESSION_ID` (legacy peer)
   4. `$CODEX_SESSION_ID` (live Codex session)
   5. `<generatedDir>/.pending-approval` — staged by the PreToolUse blocker on every block/ask (Claude path: `src/cli/policy/intercept.ts:531`; Codex path: `src/cli/pack/hook-codex-pre-tool-use.ts:320`) and by `harness session-start preflight` on every run with a resolved id (`src/cli/session-start/index.ts`). Deleted after a successful resolve **and** marker write, so a stale id cannot be revived; a failed marker write keeps it for retry.
   6. the freshest persisted report under the reports dir whose JSON `sessionId` is non-null **and** whose `approvalStatus` is `pending` (approved/expired reports belong to finished cycles and are never adopted, harness/56f51f2b). The CLI prints a loud "session id was GUESSED" warning naming the report file — verify it is your live session before trusting the marker.

   All six empty → `HarnessExitError`, no guess. Fastest fix per the error text: run `harness preflight` once (it stages `.pending-approval` as a side effect), then re-run `harness approve understanding`.

3. **What the command writes** (round-trips all sinks, `approveUnderstanding` in `src/cli/approve/understanding.ts`):
   - the canonical session marker `<generatedDir>/.approvals/<sessionId>` (atomic JSON `{approvedAt, approvedBy, reportContentHash, alg, signature}` since harness/f9485cc7 — the marker is now HMAC-signed, with `reportContentHash` the sha256 of the persisted Understanding Report bound to this approval, `null` when no report exists to bind). A failed marker write is a **hard error** — `marker: ✗ FAILED`, the gate keeps blocking.
   - one task-scoped marker `<generatedDir>/.approvals/task-<taskId>` per resolved task id: from `--task` (deduped, comma-split), else auto-resolved from `<generatedDir>/active-claim`. Either marker satisfies the gate; a task-marker failure degrades to session-marker-only, loudly.
   - an **audit-only** ledger row `understanding-approved:<sessionId>` via grounding-mcp `ledger_add` (degraded/missing grounding-mcp is a warning, never fatal: `ledger: ⚠ skipped (...) (audit only)`).
   - flips the latest matching persisted report `approvalStatus` → `approved`, stamping the session id onto sessionId-less reports. SessionId-less fallback adoption is restricted to non-terminal reports younger than 15 min (`TOLERANT_FALLBACK_MAX_AGE_MS = 15 * 60_000`; future-skew tolerance 5 min).
   - **report capture from stdin** (task 61fd36db): when the command carries the Understanding Report as a quoted heredoc (`harness approve understanding <<'UNDERSTANDING_REPORT' … UNDERSTANDING_REPORT` — the only extra shell shape the gate's escape matcher accepts), approve parses it with the canonical `@lannguyensi/understanding-gate` parser, persists it session-bound + `pending` into the reports dir, and the same run flips it (`stdin: ✓` + `report: ✓` lines). Unparseable stdin degrades loudly — `stdin: ⚠` line plus a parse-error log — but never blocks the approval itself.

4. **`report: ⚠ skipped (no reports found at <dir>)`** in the output is a warning, not a failure — the marker is the canonical gate signal and the gate opens regardless. It means no producer ever persisted a report to that dir. The reliable producer is the approve command itself (stdin heredoc, previous bullet): the Stop-hook producer fires only at END of turn — after a same-turn approve already ran — and current Claude Code builds do not reliably persist mid-turn assistant text to the transcript, so the Stop-hook path alone leaves this dir empty on real agent flows. The Stop-hook producers are: npm bin `understanding-gate-claude-stop` (Claude Code) or `harness pack hook codex-stop` (Codex), both writing `approvalStatus: "pending"` files named `<iso>-<slug>-<hash>.json`; `harness apply` prefixes every pack hook command with `UNDERSTANDING_GATE_REPORT_DIR=<absolute>` so producer, blocker, and approve CLI agree on the directory. If a report was expected, check `<reports-dir>/../parse-errors/` — the approve CLI surfaces the newest parse-error log whose header `sessionId` matches yours (`findLatestParseError`).

5. **Validation refusal**: a `grill_me` report with a missing/empty/all-`None` `priorArt` list short-circuits **every** write (no marker, no ledger, no flip; batch `--task` ids are dropped) and exits non-zero. Emergency bypass: `--force` writes everything anyway and stamps the ledger tag `understanding-approved:<sid>:forced:<field>` for audit.

6. Verify: the next gated tool call passes; the blocker's diagnostic names the marker file. To revoke, `rm <generatedDir>/.approvals/<sessionId>` (and any `task-<id>` file).

## Expiry semantics: what re-arms the gate

Configured per pack via `config.approval_lifecycle` (parsed by `parseApprovalLifecycle`, runtime lines 576-664; task-scope machinery lines 742-905):

- **`expire_on_tool_match`** (exact MCP tool names, no wildcards): when a listed tool completes, the `harness pack hook post-tool-use` PostToolUse hook deletes the **session** marker, deletes the finished task's **`task-<taskId>`** marker (when `tool_input.taskId` is present), and flips the persisted report `approved` → `expired` so the fallback can't silently re-satisfy the gate. Default list when the block is absent (`DEFAULT_EXPIRE_ON_TOOL_MATCH`, `src/policy-packs/builtin/understanding-before-execution.ts:235`): `mcp__agent-tasks__task_finish`, `task_abandon`, `pull_requests_merge`, `tasks_transition` (transition only expires when `tool_input.status === "done"`). PostToolUse fires only for tools that actually ran.
- **`expire_on_bash_match`** (regex list vs `Bash` `tool_input.command`, e.g. `gh pr merge`): same expiry effects; an invalid regex is skipped with a warning.
- **`max_age`** (duration string like `"4h"`): `checkApprovalMarker` treats a marker whose `approvedAt` is older as expired (`matched:false`, detail `expired: age Xm > max Ym`). Applies uniformly to task-scoped and session-scoped markers (`checkOperatorApprovalMarkers` is shared by the Claude and Codex hooks). Omitted = no TTL. A marker with an unreadable body skips the freshness check (existence wins).
- **`{ mode: "session" }`**: explicit legacy opt-out — no expiry hook is emitted at all; one approval lasts the session.

**Scope summary.** The *session* marker is session-scoped: one per `sessionId`, expired by boundary tools/commands or `max_age`. *Task* markers are task-scoped and expire independently: each is keyed to one agent-tasks id, cleared when that task finishes, and inert for the next task because the gate only consults the marker matching the **current** `active-claim` (v1's "any task marker" scan was removed in PR #198). This is why a multi-task session re-locks after every `task_finish` — and why `harness approve understanding --task a b c` (variadic batch pre-approval) is the sanctioned way to approve a homogeneous batch in one operator action: each later `task_start` finds its own marker already present. `harness apply` never touches `.approvals/` or `.pending-approval`, so re-applies do not revoke a live approval.

