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
 */
export const GH_PR_MERGE_BASH_RE = /(?:^|\n|;|\||&&|\()\s*(?:\w+=\S+\s+)*gh\s+pr\s+merge\b/;

/**
 * Blocker deny-scope v1 (03-decisions.md): the curated mutation command
 * list. Deliberately NOT "every Bash command" — read-only git
 * (status/log/diff/branch) and unrelated shell stay unaffected. Same
 * anchoring convention as `GH_PR_MERGE_BASH_RE`.
 */
export const CURATED_MUTATION_BASH_RE =
  /(?:^|\n|;|\||&&|\()\s*(?:\w+=\S+\s+)*(?:git(?:\s+-C\s+\S+)?\s+(?:commit|add|push|merge|rebase|cherry-pick|revert|reset|stash\s+(?:pop|apply))\b|gh\s+pr\s+(?:create|merge)\b)/;

/**
 * Escape allowlist, git verbs (03-decisions.md): the exact recovery path
 * the deny message recommends, plus read-only stash inspection. Checked
 * BEFORE the curated-mutation match and before any manifest/ledger access
 * — see hook-post-merge-gate.ts for the ordering guarantee.
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
 * payload. Returns `null` on ANY shape other than a plain finite number —
 * missing field, a differently-named variant (e.g. a future
 * `tool_response`-shaped payload), a string, etc. — so the producer's
 * "no fact on anything but a confirmed success" rule (03-decisions.md)
 * degrades to "no fact" rather than guessing.
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
