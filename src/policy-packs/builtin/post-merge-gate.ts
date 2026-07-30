// Builtin Policy Pack: `post-merge-gate`.
//
// Catches the "kept working on a branch after it was already merged"
// pattern: an agent (or operator) merges a PR via `gh pr merge`, then
// keeps committing / pushing / rebasing on the SAME local checkout
// without switching back to the default branch first — silently
// building on top of a commit that is already integrated, which either
// produces a confusing duplicate-merge PR or loses the new work off the
// side of a branch nobody looks at again.
//
// Mechanics, mirroring `branch-protection` (see that pack's header for
// the identical two-hook shape):
//
//   1. PostToolUse producer (`harness pack hook post-merge-gate-record`)
//      watches every Bash call and, ONLY when the command matched
//      `gh pr merge` AND the merge is CONFIRMED, writes a
//      `post-merge-gate:merged:<repo>:<branch>:<sha>` fact (plus PR
//      number and timestamp, audit-only) to the evidence ledger — `sha`
//      being the LOCAL branch tip observed right after the merge, which
//      is the exact commit that got merged (`gh pr merge` merges on the
//      remote side; it does not move the local tip). Confirmation is
//      DUAL-CONTRACT (payload-reality follow-up, 2026-07): a `tool_output.
//      exit_code === 0` (Contract A) is NOT reliably present — live
//      verification against a real Claude Code 2.1.218 install found the
//      PostToolUse Bash payload carries no `tool_output` / exit-code field
//      at all, only `tool_response` (`{ stdout, stderr, interrupted,
//      isImage, noOutputExpected }`) — so a `gh pr merge` success sentence
//      match against `tool_response` (Contract B) is the fallback that
//      makes the producer fire at all on that install. See
//      `resolveMergeConfirmation` in post-merge-gate-runtime.ts for the
//      exact dual-contract / "Contract A wins" ordering. Payload reads are
//      defensive throughout: an unexpected shape on either contract writes
//      nothing.
//
//   2. PreToolUse blocker (`harness pack hook post-merge-gate`) checks a
//      CURATED list of history-mutating commands (see
//      post-merge-gate-runtime.ts for the exact list) and denies them
//      when the CURRENT branch tip still equals a recorded merged tip
//      for this repo+branch — an exact sha match, not ancestry, so a new
//      commit (moving the tip) or a recycled branch name (a different
//      tip) both fall silently outside the gate. An ESCAPE ALLOWLIST
//      (git switch/checkout/pull/fetch, git branch -d/-D, git stash
//      list/show, any `harness ...` command) is checked FIRST, before
//      any manifest load or ledger query, so the recovery path can never
//      be starved by an unrelated failure.
//
// Fails OPEN when the ledger is unreachable (unlike branch-protection's
// fail-closed posture): without the ledger, "merged" and "not merged"
// are indistinguishable, and fail-closed here would block ordinary git
// history work on every branch whenever grounding-mcp hiccups. This pack
// is advisory-strength against a hostile agent, like the other
// `requires.ledger_tag`-style gates (docs/okf/evidence-ledger-trust-boundary.md);
// see post-merge-gate-runtime.ts's header for the full rationale.
//
// No auto-switch: the blocker only ever recommends the recovery commands
// in its deny message, never runs them (operator/agent decides).
//
// Enabled per-installation via `harness pack add post-merge-gate`. The
// `full` init template wires it with `enabled: false` (opt-in — a fresh,
// higher-risk gate; see templates.ts for the rationale), unlike
// branch-protection's default-enabled precedent.
//
// Claude Code only in v1 (no Codex adapter): both hooks match on the
// `Bash` tool name and classify by command text, a mechanism that has
// no established Codex-adapter parity yet (mirrors `solution-acceptance`,
// which ships with no Codex variant either). `resolve()` warns if wired
// under `runtime: "codex"`.

import { z } from "zod";
import { PolicyUxSchema } from "../../schema/policies.js";
import type { Hook, PolicyPack, PolicyUx } from "../../schema/index.js";
import { DEFAULT_RUNTIME, type Runtime } from "../runtime.js";
import type { PackContribution, PackContributionFile } from "../types.js";
import {
  CURATED_MUTATION_BASH_RE,
  ESCAPE_GIT_BASH_RE,
  ESCAPE_HARNESS_BASH_RE,
  GH_MERGE_SUCCESS_RE,
  GH_PR_MERGE_BASH_RE,
  MERGED_TAG_PREFIX,
  PACK_NAME,
} from "./post-merge-gate-runtime.js";

export { PACK_NAME };

/**
 * Zod schema for this pack's `config:` block. Strict by design so
 * typo'd keys fail loud at lint time (mirrors sibling packs). `ux` is
 * the only operator-tunable key today — the curated mutation list and
 * escape allowlist are fixed in v1 (03-decisions.md); a config override
 * for either can land as a follow-up if operators need it.
 */
export const configSchema = z
  .object({
    ux: PolicyUxSchema.optional(),
  })
  .strict();

/**
 * Shipped default `config.ux` for this pack. Canonical source for the
 * `full` init template and `harness pack reseed` (mirrors
 * branch-protection's `defaultUx`): a future wording fix lands here once
 * and reaches both a fresh `harness init --template full` and an
 * operator running `harness pack reseed post-merge-gate` against an
 * already-installed manifest. `${DEFAULT_BRANCH}` is always populated by
 * the blocker (falling back to the literal placeholder `<default-branch>`
 * when it cannot resolve `origin/HEAD`), never left as an unresolved
 * template var.
 */
export function defaultUx(): PolicyUx {
  return {
    cannot:
      "You cannot run ${TOOL_NAME} on branch ${BRANCH} yet — its current tip was already merged.",
    required: [
      "a branch tip that is not sitting at an already-merged commit (switch off `${BRANCH}`, or move its tip with a new commit)",
    ],
    run: [
      "git switch ${DEFAULT_BRANCH}",
      "git pull --ff-only",
      "git branch -d ${BRANCH}  # optional cleanup",
    ],
  };
}

const HOOK_NAME_PREFIX = `policy-pack:${PACK_NAME}`;

const PRODUCER_COMMAND = "harness pack hook post-merge-gate-record";
const BLOCKER_COMMAND = "harness pack hook post-merge-gate";

function buildHooks(): Hook[] {
  return [
    {
      name: `${HOOK_NAME_PREFIX}:post-tool-use`,
      event: "PostToolUse",
      match: "Bash",
      command: PRODUCER_COMMAND,
      blocking: false,
      budget_ms: 5000,
      description:
        "Producer: on a `gh pr merge` Bash call that exited 0, write `post-merge-gate:merged:<repo>:<branch>:<sha>` to the evidence ledger. Non-blocking; any failure just leaves the gate silent for that merge.",
    },
    {
      name: `${HOOK_NAME_PREFIX}:pre-tool-use`,
      event: "PreToolUse",
      match: "Bash",
      command: BLOCKER_COMMAND,
      blocking: "hard",
      budget_ms: 5000,
      description:
        "Blocker: deny curated history-mutating Bash commands (git commit/add/push/merge/rebase/cherry-pick/revert/reset/stash pop|apply, gh pr create/merge) when the current branch tip matches a recorded merged tip. An escape allowlist (git switch/checkout/pull/fetch, git branch -d/-D, git stash list/show, any `harness ...` command) is checked first, unconditionally. Fails open when the ledger is unreachable.",
    },
  ];
}

function buildInstructions(pack: PolicyPack, runtime: Runtime): string {
  const description = pack.description?.trim() ?? "";
  return `# Policy Pack: ${PACK_NAME}

> Operator audit copy. This pack denies curated history-mutating Bash
> commands on a branch whose tip was already merged via \`gh pr merge\`,
> closing the loop on the "kept working on a merged branch" incident
> pattern.

## Runtime

${runtime}${runtime === "codex" ? " (UNSUPPORTED — see \"Known gaps\" below; both hooks assume the Claude Code Bash tool surface)" : ""}

## Trigger + signals

1. \`PostToolUse\` producer (\`${PRODUCER_COMMAND}\`, blocking: false) on
   \`Bash\`: matches \`${GH_PR_MERGE_BASH_RE.source}\` against the command
   text. Fires only on a CONFIRMED merge, via either of two contracts
   (dual-contract, payload-reality follow-up — real Claude Code shims
   have shipped both shapes in the wild):
   - **Contract A** — \`tool_output.exit_code\` is the number \`0\`.
   - **Contract B** — \`tool_response\` is present with
     \`interrupted === false\` AND its \`stdout\`+\`stderr\` contain \`gh pr
     merge\`'s own past-tense success sentence: \`${GH_MERGE_SUCCESS_RE.source}\`
     (covers all three merge methods: Squashed / Rebased / plain Merged).
     Verified against the installed \`gh\` binary (v2.94.0,
     \`pkg/cmd/pr/merge/merge.go\` lines 369-376): the line is built as
     \`infof("%s %s pull request %s#%d (%s)", icon, action,
     ghrepo.FullName(baseRepo), pr.Number, pr.Title)\` — the repo
     fullname sits between "pull request" and the PR number, GLUED to
     \`#\` with no space (e.g. \`Squashed and merged pull request
     owner/repo#65 (title)\`), and \`infof\` writes to \`gh\`'s STDERR,
     which is why this contract checks the concatenated
     \`stdout\`+\`stderr\`, not stdout alone.
   Contract A wins whenever it resolves to ANY definite verdict, success
   OR failure — a well-formed non-zero \`exit_code\` short-circuits
   WITHOUT consulting Contract B. Contract B is tried only when Contract
   A's \`exit_code\` is entirely unresolvable (missing field, wrong
   shape, or genuinely absent — as verified live against Claude Code
   2.1.218, whose real PostToolUse Bash payload carries NO \`tool_output\`
   / no exit-code field at all, only \`tool_response\`; the
   \`tool_output.exit_code\` shape appears to describe a different,
   possibly newer, Claude Code contract). Any other shape on either
   contract writes NO fact; fail-safe against a false "merged" record.
   On a confirmed match, records
   \`${MERGED_TAG_PREFIX}:<repo>:<branch>:<sha>[ pr:<n>] at:<iso>\` to the
   evidence ledger, where \`<sha>\` is the LOCAL branch tip observed right
   after the merge (the exact commit that got merged — \`gh pr merge\`
   merges remote-side and does not itself move the local tip). \`<n>\`
   prefers extraction from the \`gh pr merge\` command itself, falling
   back to the number captured out of the Contract-B success sentence.

2. \`PreToolUse\` blocker (\`${BLOCKER_COMMAND}\`, blocking: hard) on
   \`Bash\`: checked in this order —
   a. **Escape allowlist first, unconditionally** (before any manifest
      load or ledger query): \`${ESCAPE_GIT_BASH_RE.source}\` OR
      \`${ESCAPE_HARNESS_BASH_RE.source}\` — always allowed.
   b. **Curated mutation match**: \`${CURATED_MUTATION_BASH_RE.source}\`
      — commands that don't match this pass through untouched.
   c. **Ledger check**: denies only when the current branch tip exactly
      equals a recorded \`${MERGED_TAG_PREFIX}:<repo>:<branch>:<sha>\` fact
      for this repo+branch. A new commit moves the tip (gate falls
      silent — that's legitimate continued work); a recycled branch name
      has a different tip (no false positive). No freshness window is
      needed as a result.

## Escape hatches

- **Recovery path** (named in every deny message): \`git switch
  <default-branch>\`, then \`git pull --ff-only\`, then optionally
  \`git branch -d <branch>\` to clean up the merged local branch.
- **Read-only / inspection commands** (\`git switch\`/\`checkout\`,
  \`pull\`/\`fetch\`, \`branch -d\`/\`-D\`, \`stash list\`/\`show\`, and any
  \`harness ...\` invocation) always pass, independent of ledger
  reachability — the gate can never itself become the reason the
  recovery path is unavailable.

## Known gaps (documented, not attempted in v1)

- **MCP merge path**: \`mcp__agent-tasks__pull_requests_merge\` is NOT a
  producer trigger. Only the \`gh pr merge\` Bash surface is watched;
  merges done through the agent-tasks MCP tool leave no
  \`${MERGED_TAG_PREFIX}\` fact, so the blocker never fires for that
  branch. Left as a documented gap (spec decision), not silently faked
  as covered.
- **Regex-vs-shell-eval residual**: same class of gap as every other
  \`bash_match\`-style matcher in this codebase (branch-protection,
  solution-acceptance, the kill-switch deny policies) — a heredoc,
  \`sh -c\`, \`eval\`, or similarly indirected command defeats the TRIGGER
  match before either hook ever runs. Not attempted to close here.
- **Curated scope, not every Bash command**: destructive non-git
  commands on a just-merged branch (e.g. hand-editing files outside
  git's own history primitives) are out of v1 scope, mirroring
  branch-protection's documented scope-cut.
- **Chained-escape bypass**: escape-first is checked against the WHOLE
  command string, not per-clause, so a curated mutation chained with an
  escape verb (e.g. \`git commit -am x && git switch main\`) is fully
  ALLOWED — the escape match wins for the entire compound command. Same
  accepted class as the regex-vs-shell-eval residual above (\`eval\`,
  heredoc, \`sh -c\`); not attempted to close here, and deliberate: the
  alternative (per-clause splitting) would need a real shell parser.
- **Inverted trust-boundary residual**: a merged fact written by any
  means OTHER than the producer (e.g. directly via
  \`mcp__grounding-mcp__ledger_add\`) that happens to exactly match the
  CURRENT \`repo:branch:sha\` triple denies curated mutations on that
  branch — recoverable via any escape command or by making a new commit
  (which moves the tip and the fact no longer matches). A fact for a
  different \`repo:branch:sha\` triple is inert; this is availability-only
  (a spurious deny, always escapable), never a privilege the agent gains,
  consistent with docs/okf/evidence-ledger-trust-boundary.md.
- **Contract B is coupled to \`gh\`'s current wording**: \`${GH_MERGE_SUCCESS_RE.source}\`
  matches \`gh\`'s OWN past-tense success sentence, verbatim, as verified
  against the installed \`gh\` v2.94.0 source
  (\`pkg/cmd/pr/merge/merge.go\` lines 369-376). A future \`gh\` release
  that rephrases that sentence makes
  Contract B silently, FAIL-SAFELY inert on installs that never send
  \`tool_output.exit_code\` (Contract A stays available wherever it's
  actually sent) — never a false "merged" record, but the blocker also
  never fires for that merge. Not attempted to close here (would need a
  \`gh\` wire-format contract, e.g. \`--json\`, out of this pack's Bash-text
  matching design). Verification path after upgrading \`gh\`: merge a
  throwaway PR and check for a fresh \`${MERGED_TAG_PREFIX}\` fact in the
  evidence ledger.
- **No Codex adapter**: see "Runtime" above.

## Fail posture

Fails OPEN (allows, with a stderr warning) when the evidence ledger is
unreachable — deliberately the OPPOSITE of branch-protection's
fail-closed posture, because without the ledger "merged" and "not
merged" are indistinguishable, and fail-closed here would block ordinary
git history work on every branch whenever grounding-mcp hiccups. This
pack is advisory-strength against a hostile agent, like the other
\`requires.ledger_tag\`-style gates
(docs/okf/evidence-ledger-trust-boundary.md).

## Pack metadata
${description ? `\n> ${description.replace(/\n/g, "\n> ")}\n` : ""}
- Source: \`builtin\`
- Pack: \`${PACK_NAME}\`
- Runtime: \`${runtime}\`
`;
}

export function resolve(
  pack: PolicyPack,
  runtime: Runtime = DEFAULT_RUNTIME,
): { contribution: PackContribution; warnings: string[] } {
  const hooks = buildHooks();
  const files: PackContributionFile[] = [
    {
      relativePath: `policy-packs/${PACK_NAME}/instructions.md`,
      content: buildInstructions(pack, runtime),
    },
  ];
  const warnings: string[] = [];
  if (runtime === "codex") {
    warnings.push(
      `policy_packs[${pack.name}]: post-merge-gate has no Codex adapter in v1; hooks are wired assuming the Claude Code Bash tool surface and will not fire correctly under a Codex runtime.`,
    );
  }
  return { contribution: { hooks, files }, warnings };
}
