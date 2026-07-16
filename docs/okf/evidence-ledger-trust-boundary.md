---
type: invariant
title: Evidence-ledger trust boundary
description: The agent-writable evidence ledger is audit-only for the builtin enforcement gates; only operator- or trusted-process-authored filesystem markers (read via the shared symlink-rejecting reader in src/io/read-regular-file.ts) open them, while custom requires.ledger_tag policies are process gates by design.
tags: [evidence-ledger, trust-boundary, approvals, security]
timestamp: 2026-07-16T02:26:27Z
sources:
  - src/io/read-regular-file.ts
  - src/policy-packs/builtin/understanding-before-execution-runtime.ts
  - src/policy-packs/builtin/branch-protection-runtime.ts
  - src/policy-packs/builtin/solution-acceptance-runtime.ts
  - src/policies/requires.ts
  - src/cli/init/templates.ts
  - src/cli/init/composer.ts
  - docs/policy-packs/understanding-before-execution.md
  - docs/policy-packs/branch-protection.md
  - docs/writing-custom-policies.md
  - docs/CLI.md
  - CHANGELOG.md
---

## The invariant

No evidence sink the gated agent can write — above all the evidence ledger, reachable directly via `mcp__agent-grounding__ledger_add` — is sufficient to open a builtin enforcement gate; those gates open only on evidence authored by an actor the agent does not control (an operator-written marker under `harness.generated/.approvals/`, an operator-flipped persisted report, or a trusted-producer verdict marker), each read through the single symlink-rejecting reader.

## Where it's enforced

**Shared marker reader.** `readRegularFileRejectingSymlink` in `src/io/read-regular-file.ts` is "THE shared implementation for every gate-marker read" (its own doc comment). It `lstatSync`s (not `stat`) and returns a 5-kind result (`ok` / `missing` / `symlink` / `not-regular` / `unreadable`), so a symlink planted at a marker path can never redirect approval to agent-controlled content (agent-tasks/d39f160e). Extracted as one copy in 0.39.0, task f86b2425 slice 1 (`CHANGELOG.md`). Consumers: `checkApprovalMarker` in `src/policy-packs/builtin/understanding-before-execution-runtime.ts` and `readVerdict` in `src/policy-packs/builtin/solution-acceptance-runtime.ts`.

**Understanding gate.** `checkApprovalMarker(generatedDir, sessionId)` reads `harness.generated/.approvals/<sessionId>` (`APPROVAL_MARKER_DIRNAME = ".approvals"`, `approvalMarkerPathFor`). The marker is written only by `writeApprovalMarker`, called from `harness approve understanding` in the operator's un-hooked shell; Edit/Write/Bash are all gated by the same PreToolUse hook and no configured MCP exposes filesystem writes, so the marker is operator-only (closes agent-tasks/88ca4bb3). The second accepted source is the persisted JSON report under `.understanding-gate/reports/`, flipped to `approvalStatus: "approved"` by the same approve verb — the agent's Stop hook only writes `pending` reports (docs/policy-packs/understanding-before-execution.md, "Approval state"). The `understanding-approved:${SESSION_ID}` ledger row that `harness approve understanding` still writes is forensics only: `matchLedgerEntries` in the runtime file is "Kept for the audit / forensics path only" and labels a hit `(no longer satisfies the gate)`. Marker existence is no longer the whole contract: since harness/f9485cc7, the marker also carries an HMAC-SHA256 signature over `(markerId, approvedAt, approvedBy, reportContentHash)`, verified against an operator-side key at `<generatedDir>/.approval-signing.key`. A marker with missing/invalid JSON, a missing or wrong-`alg` signature, or a signature that fails to verify is now REJECTED (`matched:false`, `forged:true`) with the same outcome as no marker at all, distinguishable via a `forged/unsigned marker rejected` detail string. A malformed sessionId still fails CLOSED, and `maxAgeMs` (agent-tasks/d8ee60ca) still expires markers, evaluated only after signature verification succeeds.

**Branch-protection gate.** Same mechanism, namespaced filename: `checkBranchProtectionMarker` delegates to `checkApprovalMarker` with `branchProtectionMarkerName(sessionId)` = `branch-protection-<sessionId>` in the same `.approvals/` dir (`src/policy-packs/builtin/branch-protection-runtime.ts`). Per audit finding #39 (docs/policy-packs/branch-protection.md, "Security"): a `branch-protection-ack:<reason>` ledger tag (`ACK_TAG_PREFIX = "branch-protection-ack"`) is NO LONGER a sufficient override because the agent could self-write it via `ledger_add`; `harness approve branch-protection` still records it as a best-effort audit echo, but only the marker file opens the gate.

**Solution-acceptance gate.** The trusted actor here is a process, not the operator: grounding-mcp (`solution_evaluate` / `solution_gate`, >= 0.3.2) runs a real preflight and writes a HEAD-pinned verdict marker "outside the agent-writable evidence ledger", by default under `$XDG_STATE_HOME`-resolved `agent-grounding/solution-verdicts` (`VERDICT_DIR_TAIL`, overridable via `SOLUTION_VERDICT_DIR`). Harness consumes it via `readVerdict` (shared reader; any non-`ok` kind closes the gate) and a write-guard blocks the agent's enumerated Bash/Edit/Write paths into the verdict dir. Explicitly NOT closed in v1: arbitrary same-uid forgery (module header, operator decision 2026-05-30).

**Custom `requires.ledger_tag` policies are process gates BY DESIGN.** docs/writing-custom-policies.md tripwire 4: "whoever can write the ledger can open the gate" — a custom `block` policy is advisory against the agent it gates; it forces a deliberate step but does not survive an agent that writes the tag directly. Enforcement requires an `ask`-kind producer, CI, or a distinct trusted process. The evaluator side (`evaluateRequires` machinery in `src/policies/requires.ts`) substring-matches ledger entries but skips `policy_decision` rows (`LedgerEntry.type`; `isPolicyDecisionRow` in the understanding runtime does the same) so audit rows can't pollute matches, and its `recordHint` deliberately never names the recording verb (agent-tasks/88ca4bb3 rationale in the doc comment).

**Ledger tags that remain load-bearing (as process gates).** The init-generated ship-flow policies in `src/cli/init/templates.ts` and `src/cli/init/composer.ts` still gate on ledger tags: `preflight:${REPO}` (before git investigation, within 1h; producer `harness session-start preflight`, docs/CLI.md), `review-subagent:${TASK_ID}` (before `mcp__agent-tasks__pull_requests_create`), `review-subagent:${BRANCH}` (before `gh pr create`, since no task UUID is in that command), `preflight:${BRANCH}` (before `git push`, HEAD-pinnable via `head:<sha>` / `requires.at_head` in `src/policies/requires.ts`), and `dogfood:${SESSION_ID}` (before `npm publish` / `git tag v*`). These declare their evidence source in `producers:` blocks and are intentionally advisory against a hostile agent.

## What breaks it

- Any new gate that accepts a ledger tag as sufficient to unblock an *enforcement* decision (re-opens the 88ca4bb3 self-approval hole that shipped through v0.13.0).
- A gate-marker read that bypasses `readRegularFileRejectingSymlink` — e.g. a new pack using bare `fs.readFileSync`/`statSync` — loses the lstat symlink defense; the shared file's contract says future defensive fixes (O_NOFOLLOW race, ENOTDIR) belong there "and nowhere else".
- Giving the agent any filesystem-write path into `harness.generated/.approvals/` or the verdict dir: a configured MCP server exposing file writes, or un-gating Edit/Write/Bash, collapses the marker's operator-only property (both runtime headers state this explicitly).
- Letting a malformed sessionId throw out of the gate hook (the top-level handler would turn it into a non-blocking exit — fail-open). (Invalidating on malformed/unsigned marker JSON is no longer a hypothetical to avoid — since harness/f9485cc7 it is the deliberate, shipped behavior: signature verification, not raw existence, is now the contract; see "Marker signing" in docs/policy-packs/understanding-before-execution.md.)
- `harness apply` starting to clean `.approvals/` siblings would wipe live approvals; pinned by `tests/cli/apply/apply.test.ts` "apply preserves sibling state under harness.generated/".
- Treating a custom `requires.ledger_tag` policy as enforcing: it never was; `harness validate` warns when a `block` policy declares no `producers:` because that trade-off was then never made visible.
