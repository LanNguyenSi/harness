// Shared Risk Gate envelope enrichment for the verbs that predict or
// enforce a `when:` verdict: `harness policy intercept` (the PreToolUse
// hook) and `harness explain-policy` (the debug verb).
//
// Both must resolve the environment from the SAME inputs, or the tool an
// operator uses to predict a gate disagrees with the gate (task
// 7c3919a2: `DATABASE_URL=...prod... psql ...` resolved `production` in
// the hook and `unknown` in explain-policy). This module owns the
// leading-prefix parse of a Bash command and the three merges it feeds:
// inline `VAR=value` env, a leading `cd <path> &&` (git context), and a
// leading `git switch|checkout <branch> &&` (upgrade-only).
//
// Deliberately NOT here: any ledger or evidence read (explain-policy
// stays hypothetical and read-free; keep this module free of
// `policies/` imports), and the kubectl `--context`/`--namespace`
// merge (hook-only today, tracked separately).

import * as path from "node:path";
import {
  buildActionEnvelope,
  resolveEnvironment,
  resolveGitContext,
  type GitRepoContext,
  type ToolEvent,
} from "../../runtime/index.js";
import { parseBashPrefix, type BashPrefix } from "../../runtime/bash-prefix-parse.js";
import type { Manifest, MatchableEnvironment } from "../../schema/index.js";

/**
 * Read the command string out of a Bash tool's `tool_input.command`,
 * returning null when the shape is wrong (defensive — production input
 * comes from Claude Code, but tests and Codex bridges have varied
 * payload shapes).
 */
export function readBashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
}

// Mirrors `ENV_PRECEDENCE` in `../../runtime/environment-resolver.ts`
// (most-dangerous-first). Kept as a local, small, duplicate table
// instead of importing that module's private const, so this file stays
// a read-only consumer of `resolveEnvironment`'s public API rather than
// reaching into its internals. `unknown` is deliberately ranked lowest:
// resolving to no signal at all must never look like an "upgrade" over
// a branch that DID fire a resolver.
export const ENV_RANK: Record<MatchableEnvironment, number> = {
  production: 0,
  staging: 1,
  dev: 2,
  local: 3,
  unknown: 4,
};

/**
 * Branch-switch, upgrade-only merge (task 341e024b): a leading `git
 * switch <branch>` / `git checkout <branch>` names the branch the REST
 * of the command actually runs against, the same way a leading `cd
 * <path>` names a different working directory (see `resolverGit`'s own
 * comment at the call site). Unlike that `cd` merge — which fully
 * REPLACES the git context and can move the resolved environment in
 * EITHER direction (G5, pre-existing, out of scope for this task) —
 * this merge is deliberately asymmetric: it only ever pushes the
 * resolved environment to something MORE dangerous, never less.
 *
 * Both the base git context and the switch-target candidate (same repo
 * / sha, only `branch` differs) are run through the SAME
 * `resolveEnvironment` call with IDENTICAL env / kube inputs, so any
 * difference in the result is attributable to the branch alone. The
 * more dangerous of the two (`ENV_RANK` order) wins; a switch AWAY from
 * a production branch never downgrades — when the candidate resolves to
 * something equally or less dangerous, `baseGit` is returned unchanged.
 */
function applyBranchSwitchUpgrade(
  event: ToolEvent,
  manifest: Manifest,
  cwd: string,
  baseGit: GitRepoContext,
  branchTarget: string | null,
  inputs: { env: Record<string, string | undefined>; kubeContext: string; kubeNamespace: string },
  user: string,
  host: string,
  now: Date | undefined,
): GitRepoContext {
  if (branchTarget === null || branchTarget === baseGit.branch) return baseGit;
  const candidateGit: GitRepoContext = { ...baseGit, branch: branchTarget };
  const effectiveNow = now ?? new Date();
  const baseResolution = resolveEnvironment(
    buildActionEnvelope(event, { cwd, git: baseGit, user, host, now: effectiveNow }),
    manifest.environments.resolvers,
    inputs,
  );
  const candidateResolution = resolveEnvironment(
    buildActionEnvelope(event, { cwd, git: candidateGit, user, host, now: effectiveNow }),
    manifest.environments.resolvers,
    inputs,
  );
  return ENV_RANK[candidateResolution.name] < ENV_RANK[baseResolution.name] ? candidateGit : baseGit;
}


export interface BashPrefixEnrichmentInput {
  event: ToolEvent;
  manifest: Manifest;
  cwd: string;
  /** Git context of `cwd` itself (the base the prefix merges on top of). */
  cwdGitContext: GitRepoContext;
  /** Ambient env the inline assignments are merged over. */
  env: Record<string, string | undefined>;
  kubeContext: string;
  kubeNamespace: string;
  user: string;
  host: string;
  now: Date | undefined;
}

export interface BashPrefixEnrichment {
  /** The Bash command string, or null for a non-Bash / shapeless event. */
  riskBashCommand: string | null;
  bashPrefix: BashPrefix | null;
  /** Git context after the `cd` merge and the branch-switch upgrade. */
  git: GitRepoContext;
  /** Ambient env with the inline `VAR=value` assignments merged on top. */
  env: Record<string, string | undefined>;
}

/**
 * Parse the leading Bash prefix once and merge it into the resolver
 * inputs (see the module header). Pure apart from `resolveGitContext`
 * for a `cd` target.
 */
export function resolveBashPrefixEnrichment(
  input: BashPrefixEnrichmentInput,
): BashPrefixEnrichment {
  const { event, manifest, cwd, cwdGitContext } = input;
  const riskBashCommand =
    event.tool_name === "Bash" ? readBashCommand(event.tool_input) : null;
  const bashPrefix = riskBashCommand === null ? null : parseBashPrefix(riskBashCommand);
  const resolverGit = (() => {
    if (bashPrefix === null || bashPrefix.cdTarget === null) return cwdGitContext;
    const effective = path.isAbsolute(bashPrefix.cdTarget)
      ? bashPrefix.cdTarget
      : path.resolve(cwd, bashPrefix.cdTarget);
    // resolveGitContext returns empty strings for non-git paths;
    // an empty repo means cd-target was bogus, fall through.
    const candidate = resolveGitContext(effective);
    return candidate.repo.length > 0 ? candidate : cwdGitContext;
  })();
  const env = (() => {
    const base = input.env;
    if (bashPrefix === null || Object.keys(bashPrefix.inlineEnv).length === 0) return base;
    // Inline assignments are the operator's explicit override; they
    // win over process.env (matches POSIX `VAR=value cmd` semantics).
    return { ...base, ...bashPrefix.inlineEnv };
  })();
  // A leading `git switch`/`checkout <branch>` (task 341e024b) is
  // merged on top of `resolverGit`, upgrade-only, using the AMBIENT kube
  // state. See `applyBranchSwitchUpgrade`.
  const git = applyBranchSwitchUpgrade(
    event,
    manifest,
    cwd,
    resolverGit,
    bashPrefix?.branchTarget ?? null,
    { env, kubeContext: input.kubeContext, kubeNamespace: input.kubeNamespace },
    input.user,
    input.host,
    input.now,
  );
  return { riskBashCommand, bashPrefix, git, env };
}
