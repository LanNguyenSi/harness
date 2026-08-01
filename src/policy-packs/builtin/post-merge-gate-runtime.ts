// Shared runtime constants + helpers for the `post-merge-gate` policy pack.
//
// The pack itself (`post-merge-gate.ts`) only emits hooks + the audit-copy
// instructions. The actual enforcement lives in two CLI verbs — `harness
// pack hook post-merge-gate-record` (producer, PostToolUse) and `harness
// pack hook post-merge-gate` (blocker, PreToolUse) — both under `src/cli/
// pack/`. This module is the small shared surface they pull from: the
// merged-tag format, the curated mutation matcher, the escape allowlist,
// and a couple of small payload/command helpers.
//
// Binding decisions this module encodes (see
// .ai/runs/2026-07-23-post-merge-gate/03-decisions.md, BINDING):
//
//   - The merged fact is keyed on an EXACT branch-tip sha match, not
//     ancestry. `gh pr merge` merges the PR on the remote side; it does
//     NOT move the local branch's tip. So the local tip observed by the
//     PostToolUse producer, right after a successful merge, IS the exact
//     commit that got merged. The blocker denies only while the current
//     tip still equals that recorded value — a new local commit moves the
//     tip and the gate falls silent (deliberate: that is legitimate
//     continued work, not stale post-merge state), and a recycled branch
//     name with a different tip never matches either. No expiry /
//     freshness window is needed as a result (squash-fest, offline).
//
//   - Deny scope v1 is a CURATED command list (git commit / add / push /
//     merge / rebase / cherry-pick / revert / reset / stash pop|apply, gh
//     pr create / merge), not "every Bash call" — mirrors
//     branch-protection.ts's documented v1 scope-cut (see its "Out of
//     scope" section). Read-only git (status/log/diff/branch) and
//     unrelated shell are never touched.
//
//   - The escape allowlist is checked FIRST in the blocker, unconditionally,
//     before manifest load or any ledger query — see hook-post-merge-gate.ts.
//     This module only supplies the matcher; the ordering guarantee lives
//     in the hook, not here.
//
//   - Fails OPEN (allows) when the ledger is unreachable, unlike
//     branch-protection's fail-closed posture: without the ledger,
//     "merged" and "not merged" are indistinguishable, and fail-closed
//     here would block every feature branch's git history forever. This
//     pack is advisory-strength against a hostile agent, same honesty as
//     the other `requires.ledger_tag`-style gates
//     (docs/okf/evidence-ledger-trust-boundary.md).

import { findGitEntry, resolveCommonDir, resolveOriginHeadBase } from "../../runtime/git-context.js";

export const PACK_NAME = "post-merge-gate";

/**
 * Content prefix the producer writes and the blocker substring-matches.
 * The full recorded content is
 * `${MERGED_TAG_PREFIX}:${repo}:${branch}:${sha}[ pr:<n>] at:<iso>`; the
 * blocker only ever tests for the `${MERGED_TAG_PREFIX}:${repo}:${branch}:
 * ${sha}` prefix (an exact 40-hex-char sha), so the trailing `pr:` / `at:`
 * tokens are audit decoration, not part of the match key.
 */
export const MERGED_TAG_PREFIX = "post-merge-gate:merged";

/** The exact substring the blocker tests ledger entries for. */
export function mergedTagMatchKey(repo: string, branch: string, sha: string): string {
  return `${MERGED_TAG_PREFIX}:${repo}:${branch}:${sha}`;
}

/** Build the full fact content the producer writes (match key + audit decoration). */
export function buildMergedTagContent(args: {
  repo: string;
  branch: string;
  sha: string;
  pr: string | null;
  whenIso: string;
}): string {
  const prPart = args.pr ? ` pr:${args.pr}` : "";
  return `${mergedTagMatchKey(args.repo, args.branch, args.sha)}${prPart} at:${args.whenIso}`;
}

/**
 * Producer trigger: does this Bash command look like a `gh pr merge`
 * invocation? Same anchoring convention as `DEFAULT_PUSH_BASH_RE`
 * (solution-acceptance-runtime.ts): tolerates a leading `cd … &&`, inline
 * `VAR=val` assignments, and chaining. Known gap, same class as that
 * regex's own documented residual: a heredoc / `sh -c` / `eval`
 * indirection defeats this match before the producer ever runs — not
 * attempted to close here (the MCP merge path, `pull_requests_merge`, is
 * the other documented gap; see the pack's instructions.md).
 *
 * Task 76671e5a: bare `&` added to the boundary alternation (`&&` kept to
 * its left only to mirror `src/runtime/command-normalize.ts`'s alternation
 * order for readability — NOT because order is load-bearing here, unlike
 * that module). Same fix as `d834a065` applied to every policy trigger —
 * bash starts a new command after a single `&`, so `A=x&gh pr merge` used
 * to miss this trigger entirely and the producer silently never recorded
 * the merged-tip fact for that spelling. Broadening a TRIGGER only widens
 * when the producer fires (a strictly safer direction, mirrors the
 * deny-side reasoning below), unlike the escape allowlist further down.
 * Measured: swapping to `&|&&` produces a byte-identical match set for this
 * matcher (a `RegExp.test` existential check over every start offset, not a
 * segmenter — the reasoning that makes order matter in
 * `command-normalize.ts`'s `BOUNDARY_RE`/`AMP_BOUNDARY_RE` does not transfer
 * to a plain `.test()` matcher like this one).
 */
export const GH_PR_MERGE_BASH_RE = /(?:^|\n|;|\||&&|&|\()\s*(?:\w+=\S+\s+)*gh\s+pr\s+merge\b/;

/**
 * Blocker deny-scope v1 (03-decisions.md): the curated mutation command
 * list. Deliberately NOT "every Bash command" — read-only git
 * (status/log/diff/branch) and unrelated shell stay unaffected. Same
 * anchoring convention as `GH_PR_MERGE_BASH_RE`.
 *
 * Task 76671e5a: bare `&` added to the boundary alternation, same reasoning
 * as `GH_PR_MERGE_BASH_RE` above — this is a DENY-scope matcher, so
 * broadening it is the STRICTER direction (more commands recognized as
 * curated mutations, none dropped). Verified disjoint from the escape
 * allowlist below on a single-command corpus (no verb overlap), so this
 * broadening cannot lock out the documented recovery path.
 */
export const CURATED_MUTATION_BASH_RE =
  /(?:^|\n|;|\||&&|&|\()\s*(?:\w+=\S+\s+)*(?:git(?:\s+-C\s+\S+)?\s+(?:commit|add|push|merge|rebase|cherry-pick|revert|reset|stash\s+(?:pop|apply))\b|gh\s+pr\s+(?:create|merge)\b)/;

/**
 * Escape allowlist, git verbs (03-decisions.md): the exact recovery path
 * the deny message recommends, plus read-only stash inspection. Checked
 * BEFORE the curated-mutation match and before any manifest/ledger access
 * — see hook-post-merge-gate.ts for the ordering guarantee.
 *
 * Task 76671e5a, DELIBERATELY LEFT on the old (no bare-`&`) boundary
 * alphabet: this is an ALLOW-list, not a deny/trigger, so broadening it is
 * the LOOSER — dangerous — direction. `isEscapeCommand` (below) is checked
 * FIRST and unconditionally by `hook-post-merge-gate.ts`, before the
 * curated-mutation deny match; widening this alternation would let MORE
 * commands skip the gate entirely, the opposite of what `d834a065` and the
 * broadenings above are for. Pinned by a regression test asserting this
 * regex's source never gains the `&|` boundary token.
 */
export const ESCAPE_GIT_BASH_RE =
  /(?:^|\n|;|\||&&|\()\s*(?:\w+=\S+\s+)*git(?:\s+-C\s+\S+)?\s+(?:switch\b|checkout\b|pull\b|fetch\b|branch\s+-(?:d|D)\b|stash\s+(?:list|show)\b)/;

/**
 * Escape allowlist, harness verbs (03-decisions.md): any invocation of
 * harness's own CLI (recovery commands like `harness session-start
 * branch-check`, diagnostics, a future self-check) always passes,
 * regardless of spelling — mirrors the `npx` / absolute-path /
 * `./node_modules/.bin` robustness the `deny-kill-switch-bash` regex in
 * `src/cli/init/templates.ts` already established for the same class of
 * bypass concern.
 *
 * Task 76671e5a: DELIBERATELY LEFT narrow, same reasoning as
 * `ESCAPE_GIT_BASH_RE` immediately above — an allow-list, checked first and
 * unconditionally, so broadening its boundary alphabet would only ever
 * widen the bypass surface.
 */
export const ESCAPE_HARNESS_BASH_RE = /(?:^|\n|;|\||&&|\()\s*(?:\w+=\S+\s+)*(?:npx\s+|\S*\/)?harness\b/;

/** True when `command` matches any escape pattern. Checked first, unconditionally. */
export function isEscapeCommand(command: string): boolean {
  return ESCAPE_GIT_BASH_RE.test(command) || ESCAPE_HARNESS_BASH_RE.test(command);
}

/** True when `command` matches the curated v1 deny-scope. */
export function isCuratedMutationCommand(command: string): boolean {
  return CURATED_MUTATION_BASH_RE.test(command);
}

/**
 * Defensive `tool_output.exit_code` reader for the PostToolUse Bash
 * payload — Contract A. Returns `null` on ANY shape other than a plain
 * finite number — missing field, a differently-named variant, a string,
 * etc. — so the producer's "no fact on anything but a confirmed success"
 * rule (03-decisions.md) degrades to "no fact" rather than guessing.
 *
 * PAYLOAD REALITY (2026-07, follow-up to 03-decisions.md): live
 * verification against a real Claude Code 2.1.218 native install (a
 * `claude -p --settings` dump-hook capture, 19/19 fired events) found NO
 * `tool_output` field at all — the field is `tool_response`, shaped
 * `{ stdout, stderr, interrupted, isImage, noOutputExpected }` with no
 * exit-code equivalent (see `tests/fixtures/post-merge-gate/
 * real-posttooluse-payload-2.1.218.json`, a verbatim capture). The
 * `tool_output.stdout/stderr/exit_code` shape this function reads
 * evidently describes a DIFFERENT — newer, or differently-shimmed —
 * Claude Code contract than 2.1.218's, not a documentation error to
 * "fix" here: Contract A is left exactly as it was (any install that
 * DOES send `tool_output.exit_code` still works unchanged), and Contract
 * B below is the fallback that makes the producer fire on 2.1.218 at
 * all. See `resolveMergeConfirmation`.
 */
export function extractExitCode(toolOutput: unknown): number | null {
  if (typeof toolOutput !== "object" || toolOutput === null) return null;
  const ec = (toolOutput as Record<string, unknown>)["exit_code"];
  return typeof ec === "number" && Number.isFinite(ec) ? ec : null;
}

// Matches the first bare integer following `gh pr merge` — audit
// decoration only (the deny/allow decision never depends on this).
const PR_NUMBER_RE = /gh\s+pr\s+merge\b[^\n;|&]*?(\d+)\b/;

/** Best-effort PR number extraction from a `gh pr merge` command string. */
export function extractPrNumber(command: string): string | null {
  const m = PR_NUMBER_RE.exec(command);
  return m ? m[1]! : null;
}

/**
 * Contract B success-text matcher (2.1.218 payload-reality follow-up).
 * `gh pr merge`'s own past-tense confirmation sentence, verbatim across
 * all three merge methods.
 *
 * SOURCE (verified against the installed `gh` binary, v2.94.0,
 * `pkg/cmd/pr/merge/merge.go` lines 369-376): the success line is built
 * as `infof("%s %s pull request %s#%d (%s)", icon, action,
 * ghrepo.FullName(baseRepo), pr.Number, pr.Title)` — i.e. the repo
 * FULLNAME sits directly between "pull request" and the bare `#<n>`,
 * GLUED to the `#` with no space (`%s#%d`, not `%s #%d`):
 *
 *   ✓ Squashed and merged pull request owner/repo#65 (Some title)
 *   ✓ Rebased and merged pull request owner/repo#65 (Some title)
 *   ✓ Merged pull request owner/repo#65 (Some title)
 *
 * `infof` writes to `gh`'s STDERR (the informational-message channel,
 * distinct from `gh`'s own stdout, which is reserved for machine-
 * consumable output) — another reason this matcher tests the CONCATENATED
 * `stdout`+`stderr`, not stdout alone. `icon` is a bare `✓` (or `!` for
 * warnings) with no ANSI color codes when `gh` detects a non-TTY output
 * stream, which a hook-captured Bash hijacks it into.
 *
 * `[^\s#]*` between "pull request" and `#` accepts BOTH that real
 * `owner/repo#<n>` shape AND a bare `#<n>` (no fullname) — the latter is
 * not `gh`'s actual current wording but is accepted defensively as a
 * documentation-shape / future-`gh`-version tolerance, at zero matching-
 * surface cost (repo fullnames never contain whitespace or `#`, so the
 * character class cannot itself widen what counts as a match beyond
 * "some non-space run immediately before the PR number").
 *
 * Still deliberately narrow overall (conservative — false negatives are
 * the safe direction here, false positives are not):
 *   - exact past-tense phrase, not a bare "merged" substring — excludes
 *     `gh pr merge --auto`'s pending text (real wording, same source
 *     file: "Pull request owner/repo#65 will be automatically merged via
 *     squash when all requirements are met" — capitalized standalone
 *     "Pull request", no "Squashed/Rebased and merged" or standalone
 *     "Merged" immediately precedes it), and excludes the already-merged
 *     warning (real wording: "Pull request owner/repo#65 was already
 *     merged" — word order is reversed: "Pull request ... was already
 *     merged", not "Merged pull request ...").
 *   - case-sensitive, matching gh's own capitalization exactly (no `/i`)
 *     — narrower matching surface, same conservative direction.
 *   - `\b` word boundaries on both ends so a partial-word coincidence
 *     (e.g. a hypothetical "ReMerged") cannot match.
 *
 * KNOWN GAP (documented, not attempted to close here): this is coupled
 * to `gh`'s current wording. A future `gh` release that rephrases its
 * success sentence makes this matcher — and therefore the whole
 * Contract-B path — silently, fail-safely inert (no fact written, same
 * as any other unmatched shape; never a false "merged" record). See the
 * pack's instructions.md / docs/policy-packs/post-merge-gate.md "Known
 * gaps" for the operator-facing verification path.
 */
export const GH_MERGE_SUCCESS_RE =
  /\b(?:Squashed and merged|Rebased and merged|Merged)\s+pull request\s+[^\s#]*#(\d+)\b/;

export type GhMergeSuccessMatch = { matched: true; pr: string | null } | { matched: false };

/**
 * Contract B confirmation: does `toolResponse` carry a real Claude Code
 * 2.1.218-shaped Bash result (`{ stdout, stderr, interrupted, ... }`)
 * whose `stdout`+`stderr` contain a `gh pr merge` success sentence?
 *
 * `interrupted` must be the LITERAL boolean `false` — missing, `true`,
 * or any other value all fail closed (no match), the same fail-safe
 * direction as Contract A's exit_code check. `stdout`/`stderr` default
 * to `""` when absent or non-string (never throws), and are joined with
 * a newline before matching so a phrase cannot accidentally form by
 * concatenating the tail of one stream with the head of the other.
 */
export function matchGhMergeSuccessText(toolResponse: unknown): GhMergeSuccessMatch {
  if (typeof toolResponse !== "object" || toolResponse === null) return { matched: false };
  const tr = toolResponse as Record<string, unknown>;
  if (tr["interrupted"] !== false) return { matched: false };
  const stdout = typeof tr["stdout"] === "string" ? tr["stdout"] : "";
  const stderr = typeof tr["stderr"] === "string" ? tr["stderr"] : "";
  const combined = `${stdout}\n${stderr}`;
  const match = GH_MERGE_SUCCESS_RE.exec(combined);
  if (!match) return { matched: false };
  return { matched: true, pr: match[1] ?? null };
}

export interface MergeConfirmation {
  confirmed: boolean;
  /** Which contract produced the verdict; "none" when `confirmed` is false. */
  contract: "exit_code" | "gh_success_text" | "none";
  /** Resolved PR number (command-first; text-fallback only for gh_success_text), or null. */
  pr: string | null;
  /** Human-readable reason, always populated (feeds the producer's stderr diagnostic). */
  reason: string;
}

/**
 * Dual-contract merge confirmation (2.1.218 payload-reality follow-up).
 * Tries Contract A (`tool_output.exit_code`, unchanged) first; falls
 * back to Contract B (`tool_response` + a matching `gh` success
 * sentence) only when Contract A yields no verdict at all.
 *
 * BINDING ordering decision — Contract A wins whenever it resolves to
 * ANY definite verdict, success OR failure: a well-formed, non-zero
 * `exit_code` is Contract A's own explicit failure signal and short-
 * circuits WITHOUT consulting Contract B, so a coincidental gh success
 * phrase sitting in a sibling `tool_response` field (the hypothetical
 * "both present" shape) can never override an authoritative failure.
 * Contract B is consulted only when `exit_code` is entirely unresolvable
 * (`extractExitCode` returns `null` — missing field, wrong shape, or the
 * field genuinely absent as on 2.1.218).
 */
export function resolveMergeConfirmation(
  toolOutput: unknown,
  toolResponse: unknown,
  command: string,
): MergeConfirmation {
  const exitCode = extractExitCode(toolOutput);
  if (exitCode === 0) {
    return {
      confirmed: true,
      contract: "exit_code",
      pr: extractPrNumber(command),
      reason: "tool_output.exit_code === 0 (Contract A)",
    };
  }
  if (exitCode !== null) {
    return {
      confirmed: false,
      contract: "none",
      pr: null,
      reason: `tool_output.exit_code is ${exitCode}, not 0 (Contract A reports failure; Contract B not consulted)`,
    };
  }
  const ghSuccess = matchGhMergeSuccessText(toolResponse);
  if (ghSuccess.matched) {
    return {
      confirmed: true,
      contract: "gh_success_text",
      pr: extractPrNumber(command) ?? ghSuccess.pr,
      reason: "tool_response carries a confirmed gh merge success sentence (Contract B)",
    };
  }
  return {
    confirmed: false,
    contract: "none",
    pr: null,
    reason:
      "no confirming tool_output.exit_code (Contract A) and no matching gh merge success text in tool_response (Contract B)",
  };
}

/**
 * Best-effort default-branch name for the deny message's `git switch
 * <default>` line. Offline, reusing the same `origin/HEAD` resolution
 * `harness record review --base` uses (now shared via
 * `runtime/git-context.ts`, see that module's header). Returns `null`
 * when `cwd` is not in a git work tree, or the repo has no resolvable
 * `origin/HEAD` (e.g. no remote) — the caller falls back to a generic
 * placeholder in that case; this is advisory text, never a gate input.
 */
export function resolveDefaultBranchName(cwd: string): string | null {
  const gitDir = findGitEntry(cwd)?.gitDir;
  if (!gitDir) return null;
  return resolveOriginHeadBase(resolveCommonDir(gitDir));
}
