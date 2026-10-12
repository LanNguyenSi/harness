---
type: invariant
title: Evidence-ledger trust boundary
description: The agent-writable evidence ledger never opens a builtin enforcement gate (branch-protection asks git, operator_only policies read no evidence at all); every requires.ledger_tag policy is a process gate by design, and the hook-path file reads and writes go through bounded, non-blocking, descriptor-typed helpers.
tags: [evidence-ledger, trust-boundary, security]
timestamp: 2026-10-12T15:56:42Z
sources:
  - src/io/read-regular-file.ts
  - src/io/write-regular-file.ts
  - src/io/lock.ts
  - src/policy-packs/builtin/branch-protection-runtime.ts
  - src/cli/pack/hook-branch-protection.ts
  - src/policies/requires.ts
  - src/runtime/intercept.ts
  - src/cli/validate/checks.ts
  - src/cli/init/templates.ts
  - src/cli/init/composer.ts
  - docs/policy-packs/branch-protection.md
  - docs/writing-custom-policies.md
---

## The invariant

No evidence sink the gated agent can write, above all the evidence ledger reachable directly via `mcp__grounding-mcp__ledger_add`, is sufficient to open a builtin enforcement decision. Two things are builtin and enforce against the agent: the `branch-protection` pack hook, which decides from what git reports about the checked-out branch and consults no ledger, marker or session state, and a policy marked `operator_only: true`, which denies unconditionally and reads no evidence at all. Everything else that unblocks on a ledger tag (`requires.ledger_tag`) is a process gate: it forces a deliberate step and is advisory against an agent that writes the tag itself.

## Where it's enforced

**Branch-protection asks git.** The hook (`src/cli/pack/hook-branch-protection.ts`) runs `git symbolic-ref -q HEAD` itself for each directory a write touches and refuses on a protected branch, on any answer it cannot get, and on any error; the pack keeps no ledger tag, no session state and no override marker (`docs/policy-packs/branch-protection.md:31-32#"state or override marker"`). The protected-list comparison is `isProtectedBranch` in `src/policy-packs/builtin/branch-protection-runtime.ts:72#"export function isProtectedBranch"`. Because nothing the agent can write reaches the decision, an earlier design in which a ledger tag or an approval marker could override the gate is gone, and there is no CLI verb that mints one.

**`operator_only` policies read no evidence.** The schema guarantees such a policy carries no `requires:` and `enforcement: block`; `evaluateOnePolicy` short-circuits before the requires pipeline, so no ledger query, template substitution or `evaluateRequires` call can flip the outcome (`src/runtime/intercept.ts:891#"if (policy.operator_only === true) {"`). `harness validate` skips such a policy in the no-producers warning because it has no evidence source to leave undocumented (`src/cli/validate/checks.ts:537#"if (p.operator_only === true) continue;"`).

**Custom `requires.ledger_tag` policies are process gates BY DESIGN.** `docs/writing-custom-policies.md:52#"4. **The trust model"` states it: whoever can write the ledger can open the gate. A custom `block` policy is advisory against the agent it gates. Enforcement needs an `ask`-kind producer, CI or a distinct trusted process. The evaluator substring-matches ledger entries but skips `policy_decision` rows (`src/policies/requires.ts:90#"POLICY_DECISION_TYPE) return false"`), so the audit rows the engine writes cannot pollute a match, and its `recordHint` names the evidence to record without naming a recording verb (`buildRecordHint`, `src/policies/requires.ts:130#"export function buildRecordHint"`). `harness validate` warns when a `block` policy declares no `producers:` (and is not `operator_only`), so the trade-off is visible (`src/cli/validate/checks.ts:522#"export function checkPolicySelfAttestation"`).

**Ledger tags the shipped templates gate on (as process gates).** The `team` and `full` templates and the composer gate on `review:${PR_NUMBER}` (before `mcp__agent-tasks__pull_requests_merge`), `review:${BRANCH}` (before `gh pr merge`, which carries no PR number), `review:${TASK_ID}` (before `mcp__agent-tasks__task_merge`, and before `mcp__agent-tasks__task_finish` narrowed by `trigger.input_match` to `autoMerge: true`), `review-subagent:${TASK_ID}` and `review-subagent:${BRANCH}` (before an agent-tasks PR create and before `gh pr create`) and `dogfood:${SESSION_ID}` (before `npm publish` and `git tag v*`); see `src/cli/init/templates.ts` and `src/cli/init/composer.ts`. Each declares its evidence source in a `producers:` block, and the generated `ux.run` hints name `harness record {review,review-subagent,dogfood}` (`docs/CLI.md`, "Evidence-ledger producers"): a CLI front-door over the same agent-writable `ledger_add` write path, which changes ergonomics and not this boundary.

**Shared bounded reader.** Every hook-path read of a file by path goes through `src/io/read-regular-file.ts`. `readRegularFileBytesBounded` opens the path once, read-only, with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`, decides on `fstat` of the opened descriptor and reads through that same descriptor, never a separate stat of the path (`src/io/read-regular-file.ts:178#"export function readRegularFileBytesBounded("`). A file over `MAX_REGULAR_FILE_READ_BYTES` (1 MiB) is refused as `unreadable` before any byte is read, and the read stops one byte past the cap (`src/io/read-regular-file.ts:57#"export const MAX_REGULAR_FILE_READ_BYTES"`). The result is one of five kinds (`ok`, `missing`, `symlink`, `not-regular`, `unreadable`), so a FIFO swapped in after any earlier look is refused at once instead of blocking the hook past its budget, which the runtime treats as an allow, and a symlink at the final path component is refused unless the caller opts in. `O_NOFOLLOW` covers only the last component; on a platform without it (Windows) an `lstat` runs before the open. A caller with a legitimately larger input passes its own `maxBytes` and justifies it at the call site (`src/io/read-regular-file.ts:119#"export interface BoundedReadOptions"`): `packed-refs` gets 32 MiB (`src/runtime/git-context.ts:93#"const MAX_PACKED_REFS_BYTES"`) and the Claude Code user registry 32 MiB (`src/io/claude-mcp.ts:626#"const MAX_REGISTRY_BYTES"`). A caller that reads a file the operator keeps behind a link (a dotfiles-managed manifest) passes `followSymlinks`; the type of the opened descriptor still refuses a link to a FIFO. `readTextFileBoundedOrThrow` is the same read thrown as a `BoundedReadError` (`ENOENT` for an absent path, `E_<KIND>` otherwise) for call sites that already wrap a by-path read in a try/catch (`src/io/read-regular-file.ts:269#"export function readTextFileBoundedOrThrow"`). The importers (the manifest loader, the pause sentinel, the pending-approval staging file, git-context and the Claude registry reader) are listed by `rg "read-regular-file" src`.

**Write side of the same rule.** A by-path `fs.writeFileSync` opens the path blocking, so a FIFO with no reader at a hook-path file would hold the write until the hook ran out of its budget. `writeRegularFileNonBlocking` opens once with `O_WRONLY | O_NONBLOCK | O_NOCTTY` (a FIFO with no reader fails `ENXIO` at once) and checks the type on the opened descriptor before a byte is written or the file is truncated (`src/io/write-regular-file.ts:93#"export function writeRegularFileNonBlocking("`). Its one production caller creates the lock target exclusively, so whatever already sits at that path is left alone (`src/io/lock.ts:47#"writeRegularFileNonBlocking(lockPath"`). Writes through `atomicWriteFile` were already safe: their temp file is created `O_EXCL`.

## What breaks it

- A new gate that accepts a ledger tag as sufficient to unblock an *enforcement* decision, or that marks a policy `block` and expects it to hold against the agent: it re-opens the self-approval hole the ledger-tag model has by design.
- Giving the agent a filesystem-write path into state a gate trusts, or un-gating Edit/Write/Bash so it can write that state.
- A hook-path read that bypasses `src/io/read-regular-file.ts`, for instance a bare `fs.readFileSync` or `statSync` on a path the agent can influence: it loses the symlink, FIFO and size defenses, and a FIFO planted there blocks the hook until its budget runs out. The shared file's own contract says future defensive fixes land there and nowhere else.
- A by-path write on a hook path that bypasses `writeRegularFileNonBlocking`, for the same FIFO reason.
- Treating a custom `requires.ledger_tag` policy as enforcing: it never was.
