// Phase 4 #5 — runtime hook interceptor + policy_decision audit log.
//
// Pure orchestration: takes a parsed event + a ledger client + the manifest,
// runs every matching policy through the Phase 4 #1/#2/#3 pipeline, returns
// the decisions and the Claude Code deny-JSON (or null when all allow).
// Side effects (stdin, stdout, ledger I/O) live in the thin CLI entrypoint
// that wraps this.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  evaluateExtract,
  evaluateRequires,
  firstInputMatchMismatch,
  parseDurationSeconds,
  substituteTemplate,
  type EvaluateRequiresOptions,
  type ExtractBuiltins,
  type ExtractEventContext,
  type InputMatchMap,
  type LedgerEntry,
  type LedgerQueryResult,
  type RequiresEvaluation,
} from "../policies/index.js";
import { renderProducers } from "../policies/producers.js";
import type { Manifest, Policy } from "../schema/index.js";
import { buildActionEnvelope } from "./action-envelope.js";
import { renderAgentFacing } from "./agent-facing.js";
import {
  MAX_NORMALIZE_LENGTH,
  normalizeCommand,
  normalizeCommandAmpAware,
  normalizeCommandQuoteAware,
  segmentViewOf,
  type AmpAwareNormalizedCommand,
  type CommandSegment,
  type NormalizedCommand,
  type QuoteAwareNormalizedCommand,
} from "./command-normalize.js";
import {
  resolveEnvironment,
  type EnvironmentResolution,
} from "./environment-resolver.js";
import {
  resolveDeletionTarget,
  type DeletionTargetVerdict,
} from "./deletion-target-resolve.js";
import { DEFAULT_SAFE_DELETION_ROOTS } from "../schema/risk.js";
import { resolveGitContext, type GitRepoContext } from "./git-context.js";
import {
  dirPossibilityKey,
  shellModelViewOf,
  type DirPossibility,
  type ModelCommand,
  type ShellModelView,
} from "./shell-command-model.js";
import { ModelPathResolver } from "./shell-model-paths.js";
import { POLICY_DECISION_TYPE } from "../io/ledger-record.js";
import { INVISIBLE_CHARACTER_CLASS } from "../io/invisible-characters.js";
import { classifyRisk, type RiskProfile } from "./risk-classifier.js";
import { resolveSessionId } from "./session-id.js";
import {
  expandToolNameAliases,
  extractShellCommand,
} from "./tool-name-aliases.js";
import { evaluateWhen, UNCLASSIFIED_FALLBACK_SEVERITY } from "./when-eval.js";

export interface ToolEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

// The Risk Gate decision space (Phase 7 #5). `allow` / `deny` are the
// Phase 4 outcomes; `warn` and `require_approval` are added here.
//   allow            — `requires` satisfied (or the policy did not apply).
//   warn             — `requires` failed, the policy's enforcement is
//                      `warn`: the call proceeds, the warning is recorded.
//   require_approval  — `requires` failed, enforcement is `require_approval`:
//                      a first-class outcome the evaluator RETURNS;
//                      Phase 7 #6 makes it block until approval evidence
//                      exists. In Phase 7 #5 it does not block.
//   deny             — `requires` failed, enforcement is `block`.
//   warn-degraded    — `requires` could not be evaluated (ledger
//                      unreachable, unresolved template, bad `within`);
//                      never blocks. Distinct from `warn`: `warn` is a
//                      real verdict, `warn-degraded` is "could not decide".
//                      Since task f1aea826 this outcome is produced only
//                      for `enforcement: warn` policies (or for every
//                      policy under the explicit
//                      `risk.degraded_fail_posture: fail_open` opt-out).
//   deny-degraded    — the SAME "could not decide" family, but the
//                      policy's enforcement is `block` or
//                      `require_approval`: the gate exists to prevent a
//                      specific irreversible incident, so an unreadable
//                      evidence source fails CLOSED (task f1aea826).
//                      Distinct from `deny` (a real verdict against
//                      present-but-unsatisfying evidence) so audit rows,
//                      `--outcome` filters, and the deny envelope can
//                      tell "the ledger said no" from "the ledger could
//                      not be read, denied on posture".
export type PolicyOutcome =
  | "allow"
  | "warn"
  | "require_approval"
  | "deny"
  | "warn-degraded"
  | "deny-degraded";

export interface PolicyDecision {
  policyName: string;
  enforcement: Policy["enforcement"];
  outcome: PolicyOutcome;
  reason: string;
  extractValues: Record<string, string>;
  ledgerTag: string;
  requiresEval?: { matchedCount: number; reason: string };
  /**
   * Risk Classifier verdict for the action this decision was made
   * about. Present only when the Risk Gate was active for the event
   * (the manifest declared at least one `when:`-bearing policy); absent
   * for a pure Phase-4 manifest, keeping its decisions byte-identical.
   * Recorded to the audit ledger so `harness explain --trace` can
   * replay the classification.
   */
  risk?: RiskProfile;
  /** Context Resolver verdict, present under the same condition as `risk`. */
  environment?: EnvironmentResolution;
  /**
   * One-line "to satisfy" hint synthesised from the policy's `requires`
   * spec. Carried on the live decision so the deny-envelope formatter
   * can append it to the user-facing reason text together with the
   * session id. Optional because the warn-degraded path (requires eval
   * threw) skips the requires evaluator and has no hint to forward.
   */
  recordHint?: string;
  /**
   * True when the policy's `when:` block matched because the action was
   * unclassified (the fail-close rule in `when-eval.ts`: "unknown is not
   * safe" for `risk.category_in` / `action.reversible`, the "treated as
   * high" rung for `risk.severity_at_least`). Absent when the policy has
   * no `when:` block, when the match was a genuine classification hit,
   * or when `unclassifiedFallback` was false. Present in the audit
   * record, the non-ux block-time deny message, AND (task 2929c5b7) the
   * ux-declared `cannot:` deny message, so an operator — or the agent
   * reading its own deny — can distinguish a real critical-severity
   * match from a fail-closed unclassified command at a glance.
   */
  whenUnclassifiedFallback?: boolean;
  /**
   * Set when the policy's `ledger_tag` references `${REPO}` / `${BRANCH}`
   * and the value resolved for this context was empty (cwd outside every
   * git repository, detached HEAD, or an empty override), so the engine
   * decided per enforcement WITHOUT rendering or querying a ledger tag.
   * In-memory only: it is not part of the serialised audit row (the
   * `reason` and the placeholder `ledgerTag` already carry the cause).
   * The agent envelope renders `reason` with precedence over the policy's
   * `ux:` / `producers:` text when this is set.
   */
  emptyIdentifier?: EmptyIdentifier;
  /**
   * Set when this decision was made for a FOREIGN attributed context: the
   * repository a target-naming command (`git -C <dir>`, `cd <dir> &&`)
   * resolved to, as opposed to the working directory's own. Absent for
   * every cwd-context decision. In-memory only (not part of the serialised
   * audit row); the block message uses it to name the repository and
   * directory whose evidence is missing.
   */
  foreignTarget?: ForeignTarget;
  /**
   * Set when the engine refused to evaluate the policy's `requires:` for
   * this command and decided per enforcement without a ledger query:
   * `"unparsed"` when the command line could not be parsed
   * (`UNPARSED_COMMAND_REASON`), `"opaque-target"` when it names a
   * repository target that cannot be attributed (`OPAQUE_TARGET_REASON`).
   * In-memory only (not part of the serialised audit row; `reason` and the
   * placeholder `ledgerTag` carry the cause). The agent envelope renders
   * `reason` with precedence over the policy's `ux:` / `producers:` text
   * and the record hint when this is set: recording the policy's evidence
   * cannot unblock a refusal.
   */
  refusal?: "unparsed" | "opaque-target";
  evaluatedAt: string;
}

/** The repository name and directory a foreign attributed context resolved to. */
export interface ForeignTarget {
  repo: string;
  dir: string;
}

/**
 * Claude Code hook "block" output. The top-level `decision: "block"` /
 * `reason` pair is the form every hook event accepts (UserPromptSubmit,
 * PostToolUse, Stop, ...). The `hookSpecificOutput.permissionDecision`
 * envelope is PreToolUse-only per Anthropic's hook protocol, so it is
 * present only when the inbound event is PreToolUse and absent
 * otherwise. Emitting both keys for a PreToolUse event keeps the deny
 * JSON readable by older Claude Code CLIs (which look at top-level
 * `decision`) and current 2.1+ ones (which prefer the envelope).
 *
 * The legacy `decision` value MUST be `"block"`, not `"deny"`: Claude
 * Code never recognised `"deny"` at the top level, so an emitter that
 * shipped that value silently let the tool call through.
 */
export interface ClaudeDenyJson {
  decision: "block";
  reason: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

export interface InterceptResult {
  decisions: PolicyDecision[];
  /** non-null iff at least one matching policy with enforcement=block denied. */
  blockJson: ClaudeDenyJson | null;
}

export interface LedgerClient {
  query(
    tag: string,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<LedgerQueryResult>;
  /**
   * Record a `policy_decision` entry to the evidence ledger. Implementations
   * MUST be best-effort: failures bubble back as `null`/false so a degraded
   * audit log doesn't itself block the tool call.
   */
  record(decision: PolicyDecision, sessionId: string): Promise<void>;
  /**
   * Release any pooled connection (the real client holds one grounding-mcp
   * subprocess across all queries + records of an intercept invocation).
   * Owned by the CLI wrapper that constructed the client — `intercept()`
   * itself never calls it. Optional so injected test doubles and the
   * degraded no-op client don't have to implement it.
   */
  dispose?(): void;
}

export interface InterceptOptions {
  manifest: Manifest;
  event: ToolEvent;
  ledger: LedgerClient;
  builtins: ExtractBuiltins;
  /** Timeout passed through to the ledger client. */
  ledgerTimeoutMs?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Current git HEAD sha for the event's cwd, resolved by the CLI
   * wrapper. Threaded through to `evaluateRequires` so the `at_head`
   * branch can compare against ledger entries' `head:<sha>` token.
   * Optional: omitted on non-git events, in which case the at_head
   * branch falls through to the standard time-window check.
   */
  currentHeadSha?: string;
  /**
   * Ambient context for the Risk Gate stages — the Action Envelope
   * build (#2) and the environment resolution (#4). Resolved by the CLI
   * wrapper (git / user / host / kube-config / env reads) and threaded
   * in, keeping `intercept()` itself I/O-free, the same
   * resolved-by-the-wrapper pattern as `currentHeadSha` and `builtins`.
   *
   * Optional: omitted by Phase-4-era callers and by unit tests that do
   * not exercise `when:`. When omitted, the envelope is built from the
   * event alone — risk then classifies as unclassified and the
   * environment resolves to `unknown`. A manifest with no `when:`
   * policy never reads any of this regardless (see `intercept`).
   */
  riskContext?: RiskGateContext;
  /**
   * Precomputed `NormalizedCommand` for a Bash event's
   * `tool_input.command`. `runInterceptCli` already calls
   * `normalizeCommand` once (for `bash_match` trigger normalisation);
   * threading the SAME result in here lets `policyMatchesEvent` reuse it
   * for every policy in the `matching` loop below instead of recomputing
   * it — same resolved-by-the-wrapper pattern as `currentHeadSha`,
   * `builtins`, and `riskContext`. Optional: omitted by non-Bash events
   * and by callers/tests that don't supply one, in which case
   * `policyMatchesEvent` computes it lazily per policy (correct, just
   * not de-duplicated).
   *
   * INVARIANT: this is NOT checked against `event` at runtime — nothing
   * verifies the `NormalizedCommand`
   * passed in was actually derived from THIS event's own
   * `tool_input.command`. Safe today because there is exactly one
   * production caller (`runInterceptCli`, `src/cli/policy/intercept.ts`),
   * which computes it from the SAME `event` it then passes to
   * `intercept()`. A future second caller that threads a mismatched
   * `NormalizedCommand` (e.g. reused across two different events) would
   * silently apply the wrong command's `bash_match` normalisation with
   * no error — keep this pairing manual-but-obvious at every call site
   * rather than assuming it self-enforces.
   */
  normalizedCommand?: NormalizedCommand;
  /**
   * Memoised thunk resolving the ampersand-aware SECOND normalisation
   * pass for the SAME Bash event's `tool_input.command` (task aabbad63,
   * `src/runtime/command-normalize.ts`'s `normalizeCommandAmpAware`).
   * `policyMatchesEvent`'s third arm calls this ONLY when a policy's
   * regex has already missed BOTH the raw command and `normalizedCommand`
   * above — most events never reach it. Threaded as a THUNK rather than
   * a precomputed value (unlike `normalizedCommand`) specifically so that
   * "compute at most once per event" can be achieved WITHOUT paying the
   * cost on the common (already-matched) path: `runInterceptCli`
   * constructs one self-memoising closure per event and hands it here;
   * every policy in the `matching` loop below that still needs the amp
   * form calls the SAME thunk, and only the FIRST such call does the
   * actual work.
   *
   * Optional: omitted by non-Bash events and by callers/tests that don't
   * supply one, in which case `policyMatchesEvent` falls back to calling
   * `normalizeCommandAmpAware` directly per policy (correct, just not
   * de-duplicated) — the same fallback shape `normalizedCommand` already
   * has.
   *
   * SAME INVARIANT as `normalizedCommand` above: this is NOT checked
   * against `event` at runtime. Nothing verifies the thunk passed in was
   * actually derived from THIS event's own `tool_input.command`. Safe
   * today because there is exactly one production caller
   * (`runInterceptCli`), which builds the thunk from the SAME `event` it
   * then passes to `intercept()` — keep this pairing manual-but-obvious
   * at every call site rather than assuming it self-enforces.
   */
  ampNormalizedCommandThunk?: () => AmpAwareNormalizedCommand;
  /**
   * Memoised thunk resolving the quote-aware THIRD normalisation pass for
   * the SAME Bash event's `tool_input.command` (task cf3dff51,
   * `src/runtime/command-normalize.ts`'s `normalizeCommandQuoteAware`).
   * `policyMatchesEvent`'s FOURTH arm calls this ONLY when a policy's
   * regex has already missed the raw command, `normalizedCommand`, AND
   * `ampNormalizedCommandThunk` above — mirrors `ampNormalizedCommandThunk`
   * exactly (same memoise-once-per-event-via-thunk shape, same reason:
   * "compute at most once per event" without paying the cost on the
   * common, already-matched path).
   *
   * Optional: omitted by non-Bash events and by callers/tests that don't
   * supply one, in which case `policyMatchesEvent` falls back to calling
   * `normalizeCommandQuoteAware` directly per policy (correct, just not
   * de-duplicated) — the same fallback shape `normalizedCommand` /
   * `ampNormalizedCommandThunk` already have.
   *
   * SAME INVARIANT as `normalizedCommand` / `ampNormalizedCommandThunk`
   * above: this is NOT checked against `event` at runtime. Nothing
   * verifies the thunk passed in was actually derived from THIS event's
   * own `tool_input.command`. Safe today because there is exactly one
   * production caller (`runInterceptCli`), which builds the thunk from
   * the SAME `event` it then passes to `intercept()` — keep this pairing
   * manual-but-obvious at every call site rather than assuming it
   * self-enforces.
   */
  quoteNormalizedCommandThunk?: () => QuoteAwareNormalizedCommand;
  /**
   * Precomputed per-segment view (`command-normalize.ts`'s
   * `segmentViewOf`) of a Bash event's `tool_input.command`, EAGERLY
   * supplied (task `98ad072f`, T-003). `null` mirrors `segmentViewOf`'s
   * own contract: the command exceeded `MAX_NORMALIZE_LENGTH`, so no
   * segment view exists (treated as `[]` — unattributable, cwd builtins,
   * identical to a command with no `bash_match` trigger at all).
   *
   * CORRECTED (D-015, fix round, run 2026-08-02-per-repo-gate-scoping-
   * redesign): the prior wording here claimed a manifest with no
   * `${REPO}`/`${BRANCH}`/`at_head` policy "never pays this cost even
   * when uninjected" — true only for a caller that omits BOTH this field
   * AND `commandSegmentsThunk` below. The one production caller
   * (`runInterceptCli`) previously injected THIS field eagerly, computed
   * unconditionally for every Bash event regardless of whether any policy
   * needed it — measured a real, avoidable second segmentation walk (see
   * `segmentViewOf`'s own doc comment in `command-normalize.ts` for the
   * +206% number). It now injects `commandSegmentsThunk` instead, which
   * IS deferred until first use. This eager field still exists for a
   * caller that already has a segment view in hand (or a test asserting
   * against a specific one) and wants to skip `intercept()`'s own lazy
   * resolution entirely — it is simply not, by itself, a laziness
   * guarantee. Optional: omitted by non-Bash events and by callers/tests
   * that don't supply one, in which case `resolveCommandSegments` falls
   * through to `commandSegmentsThunk`, then to computing it lazily itself.
   *
   * SAME INVARIANT as `normalizedCommand` / `ampNormalizedCommandThunk`
   * above: not checked against `event` at runtime; the one production
   * caller derives it from the identical event, same as those two.
   */
  commandSegments?: CommandSegment[] | null;
  /**
   * Memoised thunk resolving the per-segment view (task `98ad072f`,
   * T-003; D-015 fix round) — the SAME resolved-by-the-wrapper,
   * compute-at-most-once-per-event pattern `ampNormalizedCommandThunk`
   * above already uses, applied to `commandSegments` so the segmentation
   * walk it wraps is deferred until some matching policy actually needs
   * it (`usesPerRepoBuiltins` below), not paid on every Bash event
   * regardless. Preferred over the eager `commandSegments` field above
   * when both are supplied. Optional: omitted by non-Bash events and by
   * callers/tests that don't supply one, in which case
   * `resolveCommandSegments` falls back to `commandSegments`, then to
   * computing it lazily itself — same fallback chain shape as
   * `normalizedCommand` / `ampNormalizedCommandThunk`.
   *
   * SAME INVARIANT as `normalizedCommand` / `ampNormalizedCommandThunk`
   * above: not checked against `event` at runtime.
   */
  commandSegmentsThunk?: () => CommandSegment[] | null;
  /**
   * Memoised thunk resolving the quote-aware shell command model
   * (`src/runtime/shell-command-model.ts`, task 7d4abf84) for the SAME Bash
   * event's `tool_input.command`: every simple command with the
   * directories it can run in. Read by `policyMatchesEvent`'s fifth arm
   * (for every `bash_match` policy all four earlier arms missed, since
   * task d11762ce) and by `resolveAttributedContexts` (for a matched
   * per-repo policy), so it is computed at most once per Bash event and,
   * with any `bash_match` policy in the manifest, effectively for every
   * Bash event: such a policy is either missed by the four earlier arms
   * (the fifth arm reads the model) or matched (a per-repo policy's
   * attribution reads it). Same lazy, compute-once shape as `commandSegmentsThunk`;
   * omitted by non-Bash events and by callers/tests that do not supply
   * one, in which case `intercept()` builds its own memoised thunk for the
   * event's command (with `modelPathResolver` as the model's directory
   * oracle) and both consumers read that.
   *
   * SAME INVARIANT as `normalizedCommand` / `ampNormalizedCommandThunk`
   * above: not checked against `event` at runtime.
   */
  shellModelThunk?: () => ShellModelView;
  /**
   * The shell model's path resolver for this event
   * (`src/runtime/shell-model-paths.ts`, task 7d4abf84), rooted at
   * `builtins.CWD`: the model's directory oracle and the resolver of every
   * per-repo policy's model targets, with one per-event work budget. The
   * caller that builds `shellModelThunk` passes the resolver that thunk's
   * oracle uses, so both share one memo and one budget; omitted,
   * `intercept()` creates one when it first needs it.
   */
  modelPathResolver?: ModelPathResolver;
  /**
   * Whether `options.builtins.REPO` / `.BRANCH` were set by an explicit
   * operator override (`HARNESS_REPO` / `HARNESS_BRANCH` env vars) rather
   * than derived from the cwd's git context (D-015 fix round, run
   * 2026-08-02-per-repo-gate-scoping-redesign). `src/cli/policy/
   * intercept.ts`'s own comment on its `builtins` object says "an
   * explicit env var still wins" — true for the cwd context, but a
   * per-policy ATTRIBUTED context (a foreign target's resolved
   * `${REPO}`/`${BRANCH}`) unconditionally overwrote REPO/BRANCH with the
   * target repo's own identity, discarding the override — measured.
   * When true here, `resolveAttributedContexts` keeps
   * `options.builtins.REPO` (already the override value — see the CLI
   * wrapper) instead of substituting the attributed target's own repo
   * name; independently for BRANCH via `branchOverridden`. `false` /
   * absent — the default for every caller that does not set this,
   * including every existing test — when the corresponding builtin was
   * derived, not overridden.
   */
  repoOverridden?: boolean;
  /** See `repoOverridden` above; the same override for `${BRANCH}`. */
  branchOverridden?: boolean;
  /**
   * Destination for audit-write failure diagnostics. Defaults to
   * `process.stderr` when omitted. Goes to stderr so Claude Code's
   * stdout deny-JSON contract is unaffected.
   *
   * Injected by callers (tests, CLI wrapper) so the function stays
   * deterministic and testable without capturing process.stderr.
   */
  stderr?: NodeJS.WritableStream;
}

/**
 * Ambient inputs the Risk Gate needs that the CLI wrapper resolves from
 * the host (filesystem + process). Mirrors the `EnvelopeContext` /
 * `SignalInputs` split the debug verbs already use.
 */
export interface RiskGateContext {
  /** Git context resolved against the event's cwd. */
  git: GitRepoContext;
  /** Working directory the action runs in. */
  cwd: string;
  /** OS user, or "" when unavailable. */
  user: string;
  /** Host name, or "" when unavailable. */
  host: string;
  /** Environment variables, for resolver `env_var_patterns`. */
  env: Record<string, string | undefined>;
  /** Current kube context name, or "" when unknown. */
  kubeContext: string;
  /** Current kube namespace, or "" when unknown. */
  kubeNamespace: string;
}

/**
 * The sentence PREPENDED to a `ux:`-declared policy's `cannot:` text when
 * the deny was caused by the unclassified fallback rather than a real
 * classification (task 2929c5b7).
 *
 * Everything variable in it is interpolated: the RESOLVED environment
 * name and the policy's OWN declared threshold. Hard-coding "production"
 * and "critical" made both halves wrong for an unscoped
 * `severity_at_least: high` policy on a feature branch, which reported a
 * production context that had not been resolved and a critical-severity
 * comparison that never ran. The fallback rung itself comes from
 * `when-eval.ts`'s exported constant, not a second literal here.
 *
 * A policy whose `when:` block declares no `severity_at_least` can still
 * set the flag (via `risk.category_in` / `action.reversible`, which keep
 * the blanket "unknown is not safe" fallback), so the threshold-free
 * wording is a real case, not a defensive branch.
 */
function unclassifiedFallbackPrefix(
  environmentName: string | undefined,
  threshold: string | undefined,
): string {
  const env = environmentName ?? "unknown";
  const article = /^[aeiou]/i.test(env) ? "an" : "a";
  const lead = `This is an unclassified action in ${article} ${env} context: no risk classifier pattern recognized it, so`;
  return threshold === undefined
    ? `${lead} the fail-closed unclassified rule satisfied this policy's when: clause, rather than a genuine risk classification.`
    : `${lead} the fail-closed severity fallback (treated as ${UNCLASSIFIED_FALLBACK_SEVERITY}) satisfied this policy's severity_at_least: ${threshold}, rather than a genuine ${threshold}-severity match.`;
}

/** The Action Envelope plus the Risk Gate verdicts derived from it. */
interface EnrichedEnvelope {
  risk: RiskProfile;
  environment: EnvironmentResolution;
  /** Static deletion-target verdict (task d03af8f6); null when the
   *  command is not a recognized deletion verb. See
   *  `deletion-target-resolve.ts` and `when-eval.ts`'s
   *  `action.deletion_target_unresolvable` clause. */
  deletionTarget: DeletionTargetVerdict | null;
}

/**
 * Build the Action Envelope for an event and run it through the Risk
 * Classifier (#3) and Context Resolver (#4). Pure: every host fact
 * arrives via `riskContext`; when it is absent the envelope is built
 * from the event alone (unclassified risk, `unknown` environment).
 */
function enrichEnvelope(
  manifest: Manifest,
  event: ToolEvent,
  riskContext: RiskGateContext | undefined,
  now: Date | undefined,
): EnrichedEnvelope {
  const rc = riskContext;
  const envelope = buildActionEnvelope(event, {
    cwd: rc?.cwd ?? (typeof event.cwd === "string" ? event.cwd : ""),
    git: rc?.git ?? { repo: "", branch: "", sha: "" },
    user: rc?.user ?? "",
    host: rc?.host ?? "",
    now: now ?? new Date(),
  });
  const risk = classifyRisk(envelope, manifest.risk.classifiers);
  const environment = resolveEnvironment(
    envelope,
    manifest.environments.resolvers,
    {
      env: rc?.env ?? {},
      kubeContext: rc?.kubeContext ?? "",
      kubeNamespace: rc?.kubeNamespace ?? "",
    },
  );
  // Static deletion-target resolution (task d03af8f6) needs only the raw
  // command — unlike the environment resolver above, it deliberately
  // does not consult `riskContext` (cwd, env, kube): a relative target is
  // UNRESOLVABLE by design, not resolved against ambient cwd. See
  // `deletion-target-resolve.ts`'s module doc for the full rationale.
  const deletionShellCommand = extractShellCommand({ raw_input: envelope.raw_input });
  const deletionTarget =
    deletionShellCommand === null
      ? null
      : resolveDeletionTarget(
          deletionShellCommand,
          // Defensive fallback (not just the schema `.default()`): a
          // hand-built `Manifest` test fixture that constructs `risk:`
          // directly, bypassing `RiskSchema.parse`, may omit this field
          // entirely — never trust it present.
          manifest.risk.safe_deletion_roots ?? DEFAULT_SAFE_DELETION_ROOTS,
        );
  return { risk, environment, deletionTarget };
}

/**
 * Does a policy's `trigger:` match this event? This is the WHICH-tool-
 * calls filter; the WHETHER-it-applies filter is `policy.when:`,
 * evaluated separately (`evaluateWhen`). A policy fires only when both
 * hold. Exported so `harness explain-policy` can report the trigger
 * verdict on its own.
 *
 * `precomputedNormalizedCommand` is an optional caller-supplied
 * `NormalizedCommand` for the event's command: `intercept()` below
 * resolves ONE `NormalizedCommand` per event (via
 * `options.normalizedCommand`, itself computed once by
 * `runInterceptCli`) and threads it into every `policyMatchesEvent`
 * call in its `matching` loop, so a raw-miss event normalises the
 * command exactly ONCE across the whole manifest instead of once per
 * policy. Omitted by standalone callers (`harness explain-policy`, most
 * tests), which fall back to computing it lazily right here — correct
 * either way, since `normalizeCommand` is a pure function of the
 * command string alone.
 *
 * `ampNormalizedCommandThunk` (task aabbad63) is the SAME
 * resolved-by-the-wrapper pattern for the ampersand-aware SECOND
 * normalisation pass, but threaded as a memoised THUNK rather than a
 * precomputed value — see `InterceptOptions.ampNormalizedCommandThunk`
 * for why laziness matters here specifically. Omitted callers fall back
 * to calling `normalizeCommandAmpAware` directly, same shape as the
 * `precomputedNormalizedCommand` fallback above.
 *
 * `quoteNormalizedCommandThunk` (task cf3dff51) is the SAME thunk pattern
 * again, for the quote-aware THIRD normalisation pass — see
 * `InterceptOptions.quoteNormalizedCommandThunk`. Omitted callers fall
 * back to calling `normalizeCommandQuoteAware` directly, same shape as
 * the two fallbacks above.
 *
 * `shellModelThunk` (task 7d4abf84) feeds the FIFTH arm, the quote-aware
 * shell command model; see `InterceptOptions.shellModelThunk` and the arm
 * itself below. Omitted callers fall back to `shellModelViewOf`.
 */
export function policyMatchesEvent(
  policy: Policy,
  event: ToolEvent,
  precomputedNormalizedCommand?: NormalizedCommand,
  ampNormalizedCommandThunk?: () => AmpAwareNormalizedCommand,
  quoteNormalizedCommandThunk?: () => QuoteAwareNormalizedCommand,
  shellModelThunk?: () => ShellModelView,
): boolean {
  return (
    policyMatchArm(
      policy,
      event,
      precomputedNormalizedCommand,
      ampNormalizedCommandThunk,
      quoteNormalizedCommandThunk,
      shellModelThunk,
    ) !== "none"
  );
}

/**
 * Which part of the trigger matched: `"none"`, `"model"` when only the
 * fifth arm (the shell model) matched a `bash_match` trigger, `"segments"`
 * otherwise (every non-Bash match, and every match one of the first four
 * arms made). `intercept()` passes `"model"` on to
 * `resolveAttributedContexts`: the segment view never matched such a
 * policy, so it has no demand of its own to keep.
 *
 * `"unparsed"` (task d11762ce): the four text arms missed and the shell
 * model could not lex a command within `MAX_NORMALIZE_LENGTH` (a syntax
 * error, or nesting past the model's bounds). Bash runs the complete lines
 * before a syntax error on a later line (`{ git push; }` then a stray `)`),
 * and a compound head nested past the bounds hides the verb from the text
 * arms, so such a command cannot be shown not to run a gated verb: every
 * `bash_match` policy is refused for it as unclassifiable
 * (`UNPARSED_COMMAND_REASON`, no ledger query). Above
 * `MAX_NORMALIZE_LENGTH` the documented raw-only matching stays (`"none"`).
 */
export function policyMatchArm(
  policy: Policy,
  event: ToolEvent,
  precomputedNormalizedCommand?: NormalizedCommand,
  ampNormalizedCommandThunk?: () => AmpAwareNormalizedCommand,
  quoteNormalizedCommandThunk?: () => QuoteAwareNormalizedCommand,
  shellModelThunk?: () => ShellModelView,
): "none" | "segments" | "model" | "unparsed" {
  if (policy.trigger.event !== event.hook_event_name) return "none";
  if (policy.trigger.match !== undefined) {
    if (typeof event.tool_name !== "string") return "none";
    const toolNames = expandToolNameAliases(event.tool_name);
    if (
      !toolNames.some((toolName) => toolName.includes(policy.trigger.match!))
    ) {
      return "none";
    }
  }
  // `input_match` (task 2699b476): literal equality against the tool
  // call's own arguments, ANDed onto the tool-name match above. This is
  // what separates `task_finish { autoMerge: true }` (a merge, gated)
  // from a plain `task_finish` (not a merge, not gated) without needing
  // two different tool names. Evaluated from the SAME `toolArgs` context
  // `trigger.extract` reads (`buildEventContext`) for a SINGLE-envelope
  // event, and additionally against BOTH `tool_input` and `raw_input`
  // when a payload carries both as non-null objects (review round 1,
  // task 2699b476 round 2, see `inputMatchMismatchesEvent` below).
  // Mirrored in `policyMatchesTool` (`src/cli/dry-run.ts`) for the
  // single-envelope case only, since dry-run's `--input` is always one
  // object; `harness policy dry-run` cannot reproduce the mixed-envelope
  // arm. Both `input_match` parity and the mixed-envelope-is-intercept-only
  // caveat are recorded in docs/okf/debug-verb-selection.md's
  // trigger-matching parity paragraph.
  if (policy.trigger.input_match !== undefined) {
    if (inputMatchMismatchesEvent(policy.trigger.input_match, event)) {
      return "none";
    }
  }
  if (policy.trigger.bash_match !== undefined) {
    const command = extractShellCommand(event);
    if (command === null) return "none";
    let re: RegExp;
    try {
      re = new RegExp(policy.trigger.bash_match);
    } catch {
      return "none";
    }
    // Raw-OR-normalised-OR-amp-normalised-OR-quote-normalised (D-003, run
    // 2026-07-27-gate-target-repo-resolution; third arm added task
    // aabbad63; fourth arm added task cf3dff51): test the RAW command
    // first — cheap, and byte-identical to the pre-fix behaviour — then,
    // only if that fails, the primary NORMALISED command (wrapper
    // prefixes peeled, git global options dropped, whitespace collapsed,
    // BOUNDARY_RE segmentation) — then, only if THAT also fails, the
    // ampersand-aware second pass (AMP_BOUNDARY_RE segmentation, closing
    // the bare-`&` family BOUNDARY_RE cannot see: `A=x&env -C /tmp git
    // status`, `echo hi & nice git status`) — then, only if THAT also
    // fails, the quote-aware third pass (BOUNDARY_RE's own alphabet, but
    // quote-tracking, closing a shell-boundary character sitting INSIDE a
    // quoted assignment value: `VAR='a; b' git push origin master`).
    // Strictly additive at every step: a command that matched today keeps
    // matching via the raw test alone; the primary normalised form can
    // only ADD a match (env/nice/command wrappers, extra git global
    // options, doubled whitespace); the amp-aware form can only add a
    // FURTHER match on top of those two; the quote-aware form can only
    // add a FOURTH match on top of all three, never remove one any of the
    // others already found. Replacing the matcher input instead of OR-ing
    // it in risks silently REMOVING an existing match if some pass ever
    // mangles a shape — the fail-open direction for a gate — so this
    // stays additive rather than a substitution at every arm.
    if (!re.test(command)) {
      const { normalized } = precomputedNormalizedCommand ?? normalizeCommand(command);
      if (!re.test(normalized)) {
        const amp = ampNormalizedCommandThunk
          ? ampNormalizedCommandThunk()
          : normalizeCommandAmpAware(command);
        if (!re.test(amp.normalized)) {
          const quoted = quoteNormalizedCommandThunk
            ? quoteNormalizedCommandThunk()
            : normalizeCommandQuoteAware(command);
          if (!re.test(quoted.normalized)) {
            // FIFTH ARM (task 7d4abf84; unscoped by task d11762ce): the
            // quote-aware shell command model, for every `bash_match`
            // policy and every simple command it models. The model decodes
            // words, reads real operator boundaries, treats `!`, `{ }`,
            // `time` and the compound keywords as transparent prefixes and
            // peels wrappers (`env`, `nohup`, `xargs`, `coproc`, ...), so it
            // matches the gated verb in shapes the four arms above cannot
            // read: `{ git push; }`, `! git push`,
            // `if true; then git push; fi`, a loop body, `xargs git push`,
            // `git -C 'vendor/lib sp' log`, a line continuation inside the
            // git invocation. Until task d11762ce it ran only for per-repo
            // policies and only for commands naming a directory, so the
            // cwd-only spellings matched no policy at all. Additive like
            // the others: it can only add a match. Accepted over-match: a
            // verb that never runs (`while false; do git push; done`, a
            // function body never called) matches, as `false && git push`
            // already does through the text arms.
            const model = shellModelThunk ? shellModelThunk() : shellModelViewOf(command);
            if (model.commands === null) return command.length <= MAX_NORMALIZE_LENGTH ? "unparsed" : "none";
            if (attributeTriggerModelCommands(policy, model).length === 0) return "none";
            return "model";
          }
        }
      }
    }
  }
  return "segments";
}

function buildEventContext(event: ToolEvent): ExtractEventContext {
  return contextWithToolArgs(event, event.tool_input ?? event.raw_input ?? event.input);
}

function contextWithToolArgs(event: ToolEvent, toolArgs: unknown): ExtractEventContext {
  return {
    toolArgs,
    event,
    session: { id: event.session_id ?? "" },
    git: {},
  };
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether `input_match` fails to arm the gate for this event (review
 * round 1, task 2699b476 round 2, MEDIUM security finding).
 *
 * The default `toolArgs` context (`buildEventContext`) resolves ONE
 * field with `tool_input ?? raw_input ?? input`, so a payload that
 * carries a benign value in the PREFERRED field and the actual merge
 * request in the OTHER field never gets read:
 * `{tool_input:{taskId:"t"}, raw_input:{taskId:"t",autoMerge:true}}`
 * resolves `toolArgs` to `tool_input` alone, `autoMerge` reads as
 * absent, and the narrowed `task_finish` gate stays unarmed for a call
 * that DOES request an auto-merge.
 *
 * Mirrors the two-field handling `resolveCodexExemptionCommand`
 * (`hook-codex-pre-tool-use.ts`) already established for this exact
 * shape, but in the opposite fail-closed direction: that function
 * REFUSES an exemption when the two fields disagree (an exemption is an
 * allow, so disagreement must not grant it); here a `requires:` gate is
 * a block, so disagreement must not WITHHOLD it. When both `tool_input`
 * and `raw_input` are present as non-null objects, `input_match` is
 * evaluated against BOTH; if either one matches, the predicate holds
 * (the gate is armed) regardless of what the other field says. Only
 * when NEITHER field matches does the gate stay unarmed.
 */
function inputMatchMismatchesEvent(inputMatch: InputMatchMap, event: ToolEvent): boolean {
  const toolInput = event.tool_input;
  const rawInput = event.raw_input;
  if (isNonNullObject(toolInput) && isNonNullObject(rawInput)) {
    const toolInputMismatch = firstInputMatchMismatch(inputMatch, contextWithToolArgs(event, toolInput));
    const rawInputMismatch = firstInputMatchMismatch(inputMatch, contextWithToolArgs(event, rawInput));
    return toolInputMismatch !== null && rawInputMismatch !== null;
  }
  return firstInputMatchMismatch(inputMatch, buildEventContext(event)) !== null;
}

/** Map a failed-`requires` policy to its decision outcome by enforcement. */
function outcomeForFailedRequires(
  enforcement: Policy["enforcement"],
): PolicyOutcome {
  switch (enforcement) {
    case "block":
      return "deny";
    case "warn":
      return "warn";
    case "require_approval":
      return "require_approval";
  }
}

/**
 * Does a decision abort the tool call? Phase 7 #6 makes the Risk Gate
 * authoritative at the `PreToolUse` boundary:
 *   - `deny` aborts (a `block`-enforcement policy whose requires failed,
 *     the Phase 4 mechanism, unchanged).
 *   - `require_approval` aborts until the approval evidence exists. In
 *     Phase 7 #5 this outcome was returned but did not block; #6 makes
 *     it block. The approval tag is satisfiable through the policy's
 *     `requires:` (an operator runs `harness approve risk`); once the
 *     tag is on record the requires evaluation passes and the outcome
 *     is `allow` instead.
 *   - `deny-degraded` aborts (task f1aea826): it is only ever produced
 *     for `block` / `require_approval` policies under the default
 *     `preserve_enforcement` posture (see `degradedOutcome`), so its
 *     presence alone means "an incident-preventing gate could not read
 *     its evidence" — fail closed.
 *   - `allow` / `warn` / `warn-degraded` never abort.
 *
 * Exported for the CLI wrapper's pending-approval staging
 * (`src/cli/policy/intercept.ts`), which must agree with the runtime on
 * WHICH decision is the first blocking one — a hand-rolled copy there
 * drifted when `deny-degraded` was added (review 2026-08-08, low
 * finding). Keep this the single definition.
 */
export function isBlockingDecision(d: PolicyDecision): boolean {
  if (d.outcome === "deny") return d.enforcement === "block";
  if (d.outcome === "deny-degraded") return true;
  return d.outcome === "require_approval";
}

/**
 * Outcome for a policy whose `requires` could NOT be evaluated at all —
 * degraded/thrown ledger query, unresolved template variables, invalid
 * `within`, thrown `evaluateRequires`, or the defensive
 * schema-invariant branch. The fail posture is derived from the
 * policy's own `enforcement:` (task f1aea826):
 *
 *   warn                        → `warn-degraded` (availability first,
 *                                 unchanged: advisory friction never
 *                                 bricks the session)
 *   block / require_approval    → `deny-degraded` (fail closed: a gate
 *                                 against an irreversible incident must
 *                                 not open because its evidence source
 *                                 is unreadable)
 *
 * The manifest-level opt-out `risk.degraded_fail_posture: fail_open`
 * restores the pre-0.45 availability-first mapping (`warn-degraded`
 * for every tier). The hand-built-manifest case (`options.manifest.risk`
 * absent, only possible past `harness validate`) defaults to the
 * fail-closed posture, matching the schema default.
 */
function degradedOutcome(
  policy: Policy,
  manifest: Manifest,
): Extract<PolicyOutcome, "warn-degraded" | "deny-degraded"> {
  if (policy.enforcement === "warn") return "warn-degraded";
  const posture = manifest.risk?.degraded_fail_posture ?? "preserve_enforcement";
  return posture === "fail_open" ? "warn-degraded" : "deny-degraded";
}

/**
 * Control characters (C0 range plus DEL), built via fromCharCode so the
 * source file itself stays free of raw control bytes. Matches what the
 * envelope sanitiser collapses to a single space.
 */
const ENVELOPE_CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
  "g",
);

/**
 * Characters that are not printable text but can hide, reorder or smuggle
 * what a reader sees, or start a new "line" in model-visible text. Matched as
 * the shared rule in `src/io/invisible-characters.ts` rather than a hand list:
 * every code point with General_Category Cf (format: bidi marks and controls,
 * U+200B, U+FEFF, U+2060-U+2064, U+206A-U+206F, U+FFF9-U+FFFB, U+180E,
 * U+00AD, the tag characters U+E0001 and U+E0020-U+E007F, ...) or
 * Default_Ignorable_Code_Point (adds, for example, the variation selectors
 * U+FE00-U+FE0F and U+E0100-U+E01EF, U+034F, U+3164 and the rest of
 * U+E0000-U+E0FFF), plus the C1 controls
 * (U+0080-U+009F, including NEL) and the line and paragraph separators
 * (U+2028, U+2029). The zero width joiner U+200D is kept, because it joins
 * emoji sequences that are printable text. The backslash is escaped too, so
 * a name that literally spells an escape cannot be mistaken for one. Each
 * match is replaced by a visible `\u{XXXX}` escape (four or five hex
 * digits) rather than dropped, so a reader still sees that the name carried
 * it. Written as escapes so this source file holds none of them raw.
 */
const ENVELOPE_ESCAPED_CHARS = new RegExp(
  `(?!\\u200D)[\\u0080-\\u009F\\u2028\\u2029\\\\${INVISIBLE_CHARACTER_CLASS}]`,
  "u",
);

const ENVELOPE_MAX_LENGTH = 200;

/**
 * Bound and clean a transport-level reason before it is interpolated
 * into the agent-facing deny-degraded envelope. The string can embed
 * output captured from the grounding-mcp SUBPROCESS (`exitDiagnostic`
 * in `src/policies/ledger-client.ts` appends the child's last stderr
 * line), i.e. untrusted content that previously only reached stderr
 * and the audit ledger, never model-visible text. The full, untouched
 * string still goes to the audit row and the verbose diagnostic; only
 * the envelope interpolation and the default-verbosity operator hint
 * are bounded.
 *
 * Exported for the CLI wrapper's deny-degraded operator hint (review
 * 2026-08-08, round 3; default-verbosity only, suppressed under
 * verbose), which interpolates the same untrusted reason into its
 * one-line stderr surface.
 */
export function sanitizeEnvelopeReason(reason: string): string {
  const collapsed = reason.replace(ENVELOPE_CONTROL_CHARS, " ");
  // Build whole tokens (a code point, or one escape) so the length bound can
  // never cut an escape sequence or a surrogate pair in half.
  const tokens: string[] = [];
  for (const ch of collapsed) {
    tokens.push(
      ENVELOPE_ESCAPED_CHARS.test(ch)
        ? `\\u{${ch.codePointAt(0)!.toString(16).padStart(4, "0")}}`
        : ch,
    );
  }
  let total = 0;
  for (const t of tokens) total += t.length;
  if (total <= ENVELOPE_MAX_LENGTH) return tokens.join("");
  let out = "";
  for (const t of tokens) {
    if (out.length + t.length > ENVELOPE_MAX_LENGTH) break;
    out += t;
  }
  return `${out}...`;
}

/**
 * Agent-facing sentence appended to a block whose blocking decision came from
 * a foreign attributed context. Names the repository and directory the
 * command targets (both come from the agent's own command and the work tree
 * it resolves to, so both pass through `sanitizeEnvelopeReason`) and says the
 * missing evidence belongs to that repository, not to the working directory.
 * Names no command: which step produces the evidence is the policy's own,
 * and it has to be produced for the target repository.
 */
function foreignTargetSentence(target: ForeignTarget, structured: boolean): string {
  const sentence =
    `This command targets repository \`${sanitizeEnvelopeReason(target.repo)}\` ` +
    `(directory \`${sanitizeEnvelopeReason(target.dir)}\`). ` +
    `The required evidence is missing for that repository, not for the working directory, ` +
    `so it has to be produced for that repository itself.`;
  return structured ? `\n\n${sentence}` : ` ${sentence}`;
}

/** Which per-repo builtin resolved to an empty value; see {@link emptyIdentifierGuard}. */
export type EmptyIdentifier = "REPO" | "BRANCH";

export interface EmptyIdentifierGuard {
  identifier: EmptyIdentifier;
  /** Agent-facing text naming a state the agent can establish itself. */
  message: string;
}

const EMPTY_REPO_MESSAGE =
  "no git repository was found for this command: the working directory (or the directory the command targets) is not inside a git repository, so the repository-scoped evidence this policy checks cannot be looked up. " +
  "Change into the target repository first (`cd <repo>`) or name it explicitly (`git -C <repo> ...`), then retry the command.";

/**
 * Names the repository whose HEAD is detached, so a detached working
 * directory that is denied next to a `git -C <other repo>` target is
 * recognisable as the working directory's own repository. The name is the
 * resolved `${REPO}` value: the work-tree basename, a `HARNESS_REPO`
 * override, or the value of a policy extract named `REPO` (which can
 * carry tool input), so it is cleaned and bounded like any other untrusted
 * text before it reaches the agent envelope: C0 controls and DEL
 * collapsed to a space, invisible and format characters escaped as
 * `\u{XXXX}`, at most 200 characters (`sanitizeEnvelopeReason`).
 */
function emptyBranchMessage(repo: string): string {
  const name = sanitizeEnvelopeReason(repo);
  return (
    `no branch is checked out in repository \`${name}\`: HEAD is detached, so the branch-scoped evidence this policy checks cannot be looked up. ` +
    "Check out a named branch there (`git switch <branch>`, or `git switch -c <branch>` for a new one), create the evidence for that branch, then retry the command."
  );
}

function isBlankIdentifier(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Does `ledgerTagTemplate` reference `${REPO}` / `${BRANCH}` while the
 * value resolved for this context is empty? An empty identifier must
 * never be rendered into a ledger tag: `preflight:` is a substring of
 * EVERY preflight fact, so a blank tag lets any unrelated fact satisfy
 * the gate (and `preflight-before-push` would render "You cannot push
 * branch  yet."). The caller decides per enforcement with
 * `message` instead of querying the ledger.
 *
 * `REPO` wins over `BRANCH`, and a branch-only template evaluated where
 * REPO is empty too (no repository at all) gets the no-repository text,
 * since "HEAD is detached" would be false there. The messages name a
 * state the agent can establish (`cd` / `git -C` / `git switch`), never
 * a tag to produce, so there is no producer trap, and never an opt-out
 * (a block that names its own disable path is not a gate).
 *
 * Exported so `harness dry-run` shows the same hint instead of a blank
 * tag (`src/cli/dry-run.ts`).
 */
export function emptyIdentifierGuard(
  ledgerTagTemplate: string,
  values: Record<string, string>,
): EmptyIdentifierGuard | null {
  const refsRepo = ledgerTagTemplate.includes("${REPO}");
  const refsBranch = ledgerTagTemplate.includes("${BRANCH}");
  if (refsRepo && isBlankIdentifier(values.REPO)) {
    return { identifier: "REPO", message: EMPTY_REPO_MESSAGE };
  }
  if (refsBranch && isBlankIdentifier(values.BRANCH)) {
    return isBlankIdentifier(values.REPO)
      ? { identifier: "REPO", message: EMPTY_REPO_MESSAGE }
      : { identifier: "BRANCH", message: emptyBranchMessage(values.REPO ?? "") };
  }
  return null;
}

/**
 * Placeholder `ledgerTag` recorded on an `operator_only` decision (and on
 * the defensive schema-invariant-violated branch below). Both outcomes
 * are decided WITHOUT ever substituting or querying a real tag, so this
 * is a readable marker for `harness audit` / `explain --trace` / the
 * stderr diagnostic, not a value anything matches against.
 */
const NO_LEDGER_TAG = "(operator-only: no ledger tag — never evaluated)";

async function evaluateOnePolicy(
  policy: Policy,
  options: InterceptOptions,
): Promise<PolicyDecision> {
  const evaluatedAt = (options.now ?? new Date()).toISOString();
  const ctx = buildEventContext(options.event);
  const extract = evaluateExtract(
    policy.trigger.extract ?? {},
    ctx,
    options.builtins,
  );

  // Unconditional operator-only deny (schema `operator_only: true`, task
  // 2cc73f55). The schema's superRefine guarantees this form carries NO
  // `requires:` and `enforcement: block`, so short-circuit here, BEFORE
  // the requires pipeline: no ledger query, no template substitution, no
  // `evaluateRequires` call. That is the load-bearing property — there is
  // no in-session evidence (ledger tag, marker file, flag) this branch
  // ever reads, so none can flip the outcome to allow. `extract` above is
  // still computed (cheap, pure) only because a `ux:`/`producers:` block
  // on this policy may reference `${VAR}`s from `trigger.extract`; it
  // plays no role in the outcome below.
  if (policy.operator_only === true) {
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: "deny",
      reason:
        "operator-only: this policy declares no requires: and cannot be satisfied by any in-session evidence",
      extractValues: extract.values,
      ledgerTag: NO_LEDGER_TAG,
      evaluatedAt,
    };
  }

  const requires = policy.requires;
  if (requires === undefined) {
    // Unreachable under a schema-validated manifest: PolicySchema's
    // superRefine requires either `requires:` or `operator_only: true`.
    // Defensive branch only, for a manifest that bypassed
    // `harness validate` (hand-built Policy object, stale cached parse).
    //
    // Deliberately NOT a plain `deny`: this is the SAME "could not
    // decide" family as the other degraded returns in this function
    // (unresolved template variables, a degraded ledger query, an
    // invalid `within`, a throwing `evaluateRequires`) — the contract
    // for all of them is "the evaluator could not form a real verdict",
    // routed through `degradedOutcome` so the policy's own enforcement
    // decides the fail posture (task f1aea826): `warn` stays the
    // non-blocking `warn-degraded`, `block`/`require_approval` fail
    // closed as `deny-degraded`. Failing this branch as plain `deny`
    // would treat an internal schema-invariant violation as if it were
    // a deliberate `operator_only: true` policy authored by the
    // operator, which it is not — `deny-degraded` keeps the two
    // observably distinct in every audit row and envelope.
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: degradedOutcome(policy, options.manifest),
      reason:
        "policy declares neither requires: nor operator_only: true (schema invariant violated)",
      extractValues: extract.values,
      ledgerTag: NO_LEDGER_TAG,
      evaluatedAt,
    };
  }

  // Empty-identifier guard: decided BEFORE any tag is rendered or the
  // ledger is queried, per the policy's own enforcement (block -> deny,
  // require_approval -> require_approval, warn -> warn). Deliberately NOT
  // routed through `degradedOutcome` / the unresolved-variable branch
  // below: that path ends in the `deny-degraded` envelope, which blames
  // an unreadable ledger and tells the agent to ask the operator to
  // check grounding-mcp, false and misleading for an empty identifier.
  const emptyGuard = emptyIdentifierGuard(requires.ledger_tag, extract.values);
  if (emptyGuard !== null) {
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: outcomeForFailedRequires(policy.enforcement),
      reason: emptyGuard.message,
      extractValues: extract.values,
      ledgerTag: `(empty ${emptyGuard.identifier}: no ledger tag rendered, no ledger query)`,
      emptyIdentifier: emptyGuard.identifier,
      evaluatedAt,
    };
  }

  const missingExtracts = extract.traceData
    .filter((t) => t.source === "missing")
    .map((t) => t.var);
  const sub = substituteTemplate(requires.ledger_tag, extract.values);
  const ledgerTag = sub.result;
  const unresolved = [...missingExtracts, ...sub.missing];

  if (unresolved.length > 0) {
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: degradedOutcome(policy, options.manifest),
      reason: `template variables unresolved: ${unresolved.join(", ")}`,
      extractValues: extract.values,
      ledgerTag,
      evaluatedAt,
    };
  }

  const sessionId = resolveSessionId(options.event.session_id);
  let queryResult: LedgerQueryResult;
  try {
    queryResult = await options.ledger.query(
      ledgerTag,
      sessionId,
      options.ledgerTimeoutMs,
    );
  } catch (err) {
    queryResult = {
      kind: "degraded",
      reason: `ledger query threw: ${(err as Error).message}`,
    };
  }

  if (queryResult.kind === "degraded") {
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: degradedOutcome(policy, options.manifest),
      reason: queryResult.reason,
      extractValues: extract.values,
      ledgerTag,
      evaluatedAt,
    };
  }

  // Pre-validate `within` against the runtime parser so a manifest that
  // bypassed `harness validate` doesn't throw uncaught.
  if (requires.within !== undefined) {
    try {
      parseDurationSeconds(requires.within);
    } catch {
      return {
        policyName: policy.name,
        enforcement: policy.enforcement,
        outcome: degradedOutcome(policy, options.manifest),
        reason: `invalid within: ${requires.within}`,
        extractValues: extract.values,
        ledgerTag,
        evaluatedAt,
      };
    }
  }

  const evalOpts: EvaluateRequiresOptions = {
    ...(options.now && { now: options.now }),
    ...(options.currentHeadSha !== undefined &&
      options.currentHeadSha.length > 0 && {
        currentHeadSha: options.currentHeadSha,
      }),
  };
  const filtered = filterEntriesByTag(queryResult.entries, ledgerTag);
  let evaluation: RequiresEvaluation;
  try {
    evaluation = evaluateRequires(
      { ...requires, ledger_tag: ledgerTag },
      filtered,
      evalOpts,
    );
  } catch (err) {
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: degradedOutcome(policy, options.manifest),
      reason: `requires eval threw: ${(err as Error).message}`,
      extractValues: extract.values,
      ledgerTag,
      evaluatedAt,
    };
  }

  // Four-way decision (Phase 7 #5). A satisfied `requires` always
  // `allow`s; a failed one is mapped by the policy's enforcement —
  // `block` → `deny`, `warn` → `warn`, `require_approval` →
  // `require_approval`. The evaluator only RETURNS `require_approval`
  // here; Phase 7 #6 makes it block.
  const outcome: PolicyOutcome = evaluation.allowed
    ? "allow"
    : outcomeForFailedRequires(policy.enforcement);
  return {
    policyName: policy.name,
    enforcement: policy.enforcement,
    outcome,
    reason: evaluation.reason,
    extractValues: extract.values,
    ledgerTag,
    requiresEval: {
      matchedCount: evaluation.matchedCount,
      reason: evaluation.reason,
    },
    recordHint: evaluation.recordHint,
    evaluatedAt,
  };
}

function filterEntriesByTag(
  entries: LedgerEntry[],
  tag: string,
): LedgerEntry[] {
  // The ledger client returns the entire session's entries; filter to those
  // whose content/source matches the substituted tag. evaluateRequires also
  // does a substring match, but pre-filtering here keeps the trace quieter
  // and avoids the requires evaluator iterating unrelated session entries.
  //
  // Phase 5 #4 — also drop `policy_decision` rows so a past audit
  // payload doesn't incidentally match the same tag the decision was
  // about (the substring-pollution bug from PR #39's dogfood). The
  // requires evaluator's entryMatches has the same guard, but
  // pre-filtering keeps matchedCount honest in the trace data.
  return entries.filter(
    (e) =>
      e.type !== POLICY_DECISION_TYPE &&
      // Legacy backstop for pre-Phase-5-#4 rows: they were stored as
      // type='fact' but carry the `policy_decision:` content prefix.
      // Drop them at the same gate so a user upgrading harness without
      // flushing their dev ledger doesn't keep paying the pollution
      // tax. New rows are caught by the type check above.
      !e.content.startsWith(`${POLICY_DECISION_TYPE}:`) &&
      (e.content.includes(tag) ||
        (e.source !== undefined && e.source.includes(tag))),
  );
}

/**
 * Which of a policy's own trigger-satisfying segments name a target — the
 * attribution sibling of `policyMatchesEvent` (task `98ad072f`, T-003).
 * Re-tests the policy's OWN `bash_match` regex against each segment's
 * `text` in isolation: every shipped `bash_match` alternation includes a
 * `^` branch, so testing it against one segment's canonicalised text
 * alone (no leading boundary character — see `CommandSegment.text`'s own
 * doc comment) is well-defined. Returns every segment that matches on its
 * own — usually one, occasionally several (D-004: a decoy read and a cwd
 * read chained in one command can each independently satisfy the SAME
 * trigger).
 *
 * Never changes WHETHER a policy matches — `policyMatchesEvent` already
 * decided that from the WHOLE command (raw-or-normalised-or-amp-
 * normalised), unchanged by this function. This only narrows down WHICH
 * segment(s), if any, are individually responsible for the match, so
 * `intercept()` below knows which segment's target — if any — to resolve
 * the `${REPO}`/`${BRANCH}`/`currentHeadSha` builtins from instead of the
 * event's own cwd. `[]` when the policy has no `bash_match` trigger (an
 * MCP-tool-name-triggered policy — no segment concept applies), when its
 * regex is malformed (mirrors `policyMatchesEvent`'s own defensive
 * `try/catch`), or when the whole-command match came ONLY from the
 * ampersand-aware third arm: `segments` here is always built from the
 * PRIMARY (`BOUNDARY_RE`) segmentation, which — by construction — cannot
 * itself contain the bare-`&` split the amp arm relies on, so an amp-
 * only match finds no individually-matching segment and this returns
 * `[]` (D-003: cwd builtins, identical to shipped).
 */
export function attributeTriggerSegments(
  policy: Policy,
  segments: readonly CommandSegment[],
): CommandSegment[] {
  if (policy.trigger.bash_match === undefined) return [];
  let re: RegExp;
  try {
    re = new RegExp(policy.trigger.bash_match);
  } catch {
    return [];
  }
  return segments.filter((seg) => re.test(seg.text));
}

/**
 * The model sibling of `attributeTriggerSegments` (task 7d4abf84): the
 * commands of the quote-aware shell command model
 * (`src/runtime/shell-command-model.ts`) one of whose texts
 * (`ModelCommand.heads`: the command as written after the compound
 * prefixes, then after each peeled wrapper, then its canonical text)
 * satisfies the policy's own `bash_match` on its own. These texts hold no
 * shell boundary character, so a pattern can match one only at its start:
 * at the gated verb, or at a gated wrapper, itself. `[]` when the policy
 * has no `bash_match`, its regex is malformed, or the command could not be
 * lexed.
 *
 * Every model command is read, also one that runs only in the working
 * directory (task d11762ce): that is how `{ git push; }`, `! git push`,
 * `if ...; then git push; fi` and `xargs git push` reach the policy the
 * bare verb reaches (the fifth matching arm in `policyMatchArm`), and,
 * for a per-repo policy, how such a command's working-directory context
 * is demanded next to the targets of the other satisfying commands
 * (`resolveAttributedContexts` adds the cwd context for a possibility
 * without steps). Until that task only commands naming a directory were
 * read, which left those spellings matching no policy at all.
 */
export function attributeTriggerModelCommands(
  policy: Policy,
  model: ShellModelView,
): ModelCommand[] {
  if (policy.trigger.bash_match === undefined || model.commands === null) return [];
  let re: RegExp;
  try {
    re = new RegExp(policy.trigger.bash_match);
  } catch {
    return [];
  }
  return model.commands.filter(
    (c) => c.heads.some((text) => re.test(text)) || headTextNormalizations(c).some((text) => re.test(text)),
  );
}

/**
 * The normalisations the text arms apply (`normalizeCommand`,
 * `normalizeCommandAmpAware`, `normalizeCommandQuoteAware`) of a model
 * command's `headText`, the command written on its own, computed once per
 * model command and shared by every policy. With the raw `headText` among
 * them, a `bash_match` trigger matches a command inside a compound command
 * (`{ X; }`, `if ...; then X; fi`, `! X`) whenever it matches `X` as a bare
 * command, whatever wrapper option grammar the normalisers read
 * (`sudo --user root`, `nice --adjustment=5`, `timeout --kill-after 5 10`).
 */
function headTextNormalizations(c: ModelCommand): readonly string[] {
  let texts = HEAD_TEXT_NORMALIZATIONS.get(c);
  if (texts === undefined) {
    texts = [
      c.headText,
      normalizeCommand(c.headText).normalized,
      normalizeCommandAmpAware(c.headText).normalized,
      normalizeCommandQuoteAware(c.headText).normalized,
    ];
    HEAD_TEXT_NORMALIZATIONS.set(c, texts);
  }
  return texts;
}

const HEAD_TEXT_NORMALIZATIONS = new WeakMap<ModelCommand, readonly string[]>();

/**
 * Does a policy's `requires:` reference the per-repo `${REPO}`/`${BRANCH}`
 * builtins, or ask for `at_head`? Only these policies pay the per-policy
 * attribution cost below — every other matching policy keeps the plain,
 * per-event cwd builtins `options.builtins` already carries, byte-
 * identical to before this task. D-005: `at_head` is included even when
 * `ledger_tag` itself doesn't reference `${REPO}`/`${BRANCH}`, because
 * `at_head` compares against `currentHeadSha`, which this task resolves
 * from the SAME per-policy context — splitting the two would check
 * `at_head` against the cwd's HEAD while `${REPO}` (if present elsewhere)
 * named a different repo, the worse inconsistency D-005 rejects.
 */
export function usesPerRepoBuiltins(policy: Policy): boolean {
  const requires = policy.requires;
  if (requires === undefined) return false;
  return (
    requires.at_head === true ||
    requires.ledger_tag.includes("${REPO}") ||
    requires.ledger_tag.includes("${BRANCH}")
  );
}

/** One `${REPO}`/`${BRANCH}`/`currentHeadSha` context a policy is evaluated against. */
interface AttributedContext {
  builtins: ExtractBuiltins;
  currentHeadSha: string | undefined;
  /** Set only on a foreign context; the cwd context never carries it. */
  foreignTarget?: ForeignTarget;
}

/**
 * Bound on the number of DISTINCT attributed contexts one policy is
 * evaluated against for one event (D-013, fix round, run
 * 2026-08-02-per-repo-gate-scoping-redesign). Each distinct context costs
 * one ledger query and one audit write in `intercept()`'s evaluation loop
 * below; on a manifest with several per-repo-builtins policies (the
 * shipped `FULL_TEMPLATE` has four), an event naming K distinct targets
 * amplifies to 4K queries/writes, unbounded by `MAX_NORMALIZE_LENGTH` —
 * measured 200/200 at K=200 by reviewer 2, on a hook budget whose timeout
 * is ALLOW (same class as the 07-27 quadratic hot-path fail-open: a slow
 * enough event silently passes). `resolveAttributedContexts` returns a
 * `"bounded"` result instead of a `contexts` array once a policy's DISTINCT
 * targets would exceed this constant; `intercept()` denies that policy
 * directly (naming the ambiguity) without querying the ledger for any of
 * them, rather than silently evaluating all of them.
 */
export const MAX_ATTRIBUTED_CONTEXTS = 4;

/**
 * Realpath a path for identity comparison, never throwing (D-012, fix
 * round, run 2026-08-02-per-repo-gate-scoping-redesign). Falls back to the
 * LEXICAL path unchanged when the target does not exist or is otherwise
 * unreadable (`fs.realpathSync.native` throws `ENOENT` for a path this
 * module was never guaranteed to have on disk, and this function must
 * never throw — same fail-safe posture as `resolveGitContext` itself,
 * which returns empty strings rather than throwing on a bad path).
 * `.native` (not the plain JS `fs.realpathSync`) resolves via the OS
 * syscall directly — cheaper, and avoids Node's own pure-JS symlink-loop
 * bookkeeping for a value this function only uses for an identity
 * comparison, never for a filesystem walk of its own.
 */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Discriminated result of `resolveAttributedContexts` (D-013). */
export type AttributedContextsResult =
  | { kind: "contexts"; contexts: AttributedContext[] }
  | { kind: "bounded"; distinctCount: number }
  | { kind: "opaque-target" };

/**
 * Why a policy is denied outright for a command whose repository target
 * cannot be attributed (task `cfb6b390`). One text for the runtime
 * decision and the dry-run preview, so the two cannot drift.
 */
export const OPAQUE_TARGET_REASON =
  "ambiguous: this command names a repository directory through a path this gate cannot attribute " +
  "(a backtick, an ANSI-C or locale quoted value, a control or separator character, a glob, " +
  "a CDPATH search, a directory change repeated in a loop, or a command line the gate cannot parse), " +
  "so the evidence of the current directory's repository cannot stand in for it. Name the repository " +
  "with a plain path (`git -C <path>` or `cd <path> && ...`), or run the command from inside it";

/**
 * Why every `bash_match` policy the text arms missed is denied outright
 * for a command line the shell model cannot parse within
 * `MAX_NORMALIZE_LENGTH` (task d11762ce, `policyMatchArm`'s `"unparsed"`).
 * One text for the runtime decision, the agent envelope, the operator's
 * stderr line and the dry-run preview, so they cannot drift.
 */
export const UNPARSED_COMMAND_REASON =
  "unclassifiable: this gate cannot parse this command line (a syntax error, or compound commands, " +
  "subshells, substitutions or eval strings nested past the parser's bounds), so it cannot tell whether it " +
  "runs a gated command; bash still runs the complete lines before a syntax error. Fix the syntax or flatten " +
  "the nesting, then run it again";

/** The ledger-tag text of an `UNPARSED_COMMAND_REASON` decision: no tag is queried. */
export const UNPARSED_COMMAND_TAG = "(unparsed command: not classifiable, no context queried)";

/**
 * Resolve the distinct `${REPO}`/`${BRANCH}`/`currentHeadSha` contexts a
 * `usesPerRepoBuiltins` policy must be evaluated against (task `98ad072f`,
 * T-003, `01-plan.md` Proposed Approach items 2-4). The engine trusts a
 * trigger-satisfying segment's `effectiveTarget` UNIFORMLY as the
 * directory that segment's own invocation genuinely runs in (bash
 * semantics) — orchestrator decision D-010, 2026-08-02: an earlier
 * revision of this function additionally distrusted an inherited target
 * whenever a DIFFERENT invocation intervened between the `cd` and the
 * satisfying segment — REJECTED: that coupling has no basis in bash's own
 * semantics, is dodgeable by inserting any harmless read between the `cd`
 * and the gated verb, and carried its own unverified `cd`-recognition
 * gap. The `cd <B> && git log && git push` shape this was meant to guard
 * is not a regression at all under this design — `git push` genuinely
 * runs inside B — see `tests/runtime/intercept-cli.test.ts`'s "leading-cd
 * is now a deliverable" block.
 *
 * D-021 (UNIVERSAL-ADDITIVE, operator decision, fix round, run
 * 2026-08-02-per-repo-gate-scoping-redesign): attribution is uniformly
 * ADDITIVE, never REPLACE. Every satisfying segment with an attributable
 * target — `seg.effectiveTarget !== null`, whether it came from the
 * segment's OWN explicit repo-relocating flag (`-C`/`env -C`/`--git-dir`;
 * `--work-tree` is excluded from ever producing a target at all, D-017)
 * or was INHERITED from a preceding `cd` — demands the cwd context AND
 * that target's own context, side by side; `seg.ownTarget` is not
 * consulted for this decision. Any unsatisfied context blocks the whole
 * event (the existing per-context evaluation machinery below is
 * unchanged). `seg.effectiveTarget === null` (fully unattributable —
 * D-003) still adds ONLY the cwd context — there is no foreign target to
 * be additive WITH. One kind of unattributable target is NOT left at the
 * cwd context: a segment flagged `opaqueTarget` (task `cfb6b390`: a
 * backtick, an ANSI-C or locale quoted value, or an unattributable value
 * carrying a control character, in a `-C` / `--git-dir` / `env -C` value
 * or in an argument of a recognised `cd` / `pushd`, or inherited from one)
 * makes the whole policy fail closed (`{ kind: "opaque-target" }`), because the cwd context
 * would then stand in for a nested repository the command really runs in.
 *
 * Demanding cwd unconditionally makes the engine structurally immune to
 * misattribution of the foreign target: no gap in `command-normalize.ts`'s
 * static, string-only model of shell control flow (subshells, pipes,
 * `cd -`, a later `cd`, an unmodeled git flag composition) can ever make a
 * gate WEAKER than the shipped, cwd-only engine, because cwd's own demand
 * is never dropped — only added to. This replaces an earlier REPLACE-for-
 * own-target design (D-011) that trusted a statically extracted own
 * target as proof of "this one invocation operates there"; four
 * independent review passes each measured a live bypass of that
 * invariant against the shipped binary (a forged `.git/HEAD` directory
 * reached through, respectively, a non-persisting `cd`, `--work-tree`,
 * more than one repo-relocating flag, and a tilde-valued flag not counted
 * by the multi-flag guard) — see `03-decisions.md` D-011/D-017/D-018/
 * D-019/D-020/D-021 for the full history. The static-analysis-proves-it
 * invariant those bypasses each disproved is not carried forward here.
 * Cost accepted by the operator: a legitimate `git -C B` from cwd A now
 * demands BOTH A's and B's context, where the pre-D-021 engine demanded
 * only B's.
 *
 * One exception to "never dropped": when the working directory is outside
 * every git repository (a blank `${REPO}` for the policy, as the guard
 * sees it), its cwd context is not demanded next to a segment whose own
 * target resolved to a real repository (see the loop body). That
 * exception relies on two static models: the target attribution, whose
 * known misattribution (a `GIT_DIR=` prefix or a third repository reached
 * through another construct) exists for every cwd, and the check that the
 * cwd is outside every repository, which errs toward inside: it holds only
 * when neither the cwd nor any ancestor has an entry named `HEAD` or
 * `.git` (`mayBeInsideRepository`). A detached cwd and every other
 * non-blank cwd context are still never dropped.
 *
 * D-012: a target reached through a symlink resolves to its REAL
 * (realpath'd) repository identity, not the symlink's own lexical
 * basename — `resolveGitContext` derives `repo` from the basename of
 * wherever it's pointed, and never itself realpaths, so an agent could
 * otherwise pick the demanded repo identity by naming a symlink.
 *
 * D-013: distinct contexts are bounded at `MAX_ATTRIBUTED_CONTEXTS`; see
 * that constant's own comment.
 *
 * D-015: the cwd context is deduped by its OWN `[REPO, BRANCH, sha]`
 * signature (not the literal string `"cwd"`), so a foreign path that
 * resolves to the SAME repository identity as cwd (e.g. a subdirectory of
 * the cwd repo reached via an explicit `-C`) collapses into the cwd
 * context instead of producing a spurious duplicate decision/audit write.
 * `repoOverridden` / `branchOverridden` (from `InterceptOptions`, both
 * default `false`) keep an operator's `HARNESS_REPO`/`HARNESS_BRANCH`
 * override intact in an attributed foreign context instead of letting the
 * target repo's own identity silently overwrite it — independently per
 * field. `satisfying` is a `Set` (not `Array.includes` per segment) for
 * O(1) membership tests instead of O(n) per segment.
 *
 * A policy with no attributable foreign target (no `bash_match`, no
 * individually-matching segment, only an amp-arm-only match, an
 * unattributable composition, a target resolving to the SAME repository
 * identity as cwd, or a target outside any git repo — D-003) is evaluated
 * EXACTLY as it is today, with the EXACT SAME `options.builtins` object
 * reference (no clone) when nothing attributed, keeping that the
 * byte-identical common case.
 *
 * `resolveGitContextMemo` is a per-`intercept()`-call cache keyed by the
 * REALPATH'D absolute path (never module-level state — no cross-event
 * caching), so several policies (or several satisfying segments) naming
 * the same foreign path within one event pay the `fs` cost once, not
 * once per policy per segment. `mayBeInsideRepositoryMemo` is the same
 * kind of per-call cache for the cwd's own outside-every-repository
 * check, keyed by the cwd's real path, so that walk runs once per event.
 *
 * SHELL MODEL (task 7d4abf84, optional `shellModel`). The quote-aware
 * shell command model (`src/runtime/shell-command-model.ts`) is a second,
 * independent view of the same command, combined with the segment view by
 * UNION, so it cannot make a policy weaker than the segment view alone.
 * The union is structural, not a property of the two views agreeing: the
 * segment view runs first and fills `contexts` exactly as it does without
 * the model (its cwd-only verdict when no segment satisfies the trigger of
 * a policy one of its arms matched, its loop, its own fallback; a policy
 * only the model's arm matched, `segmentViewMatched === false`, never
 * matched the segment view, which then demands nothing), and only then
 * are the model's
 * trigger-satisfying commands (`attributeTriggerModelCommands`) read, each
 * possibility either appending a context or ending the call fail-closed
 * (`opaque-target` or `bounded`). Nothing in the model phase removes a
 * context, so every demand of the segment view survives, including the
 * cwd context of a working directory outside every repository (whose
 * exception in `addResolvedTarget` only decides whether a model target
 * brings the cwd context along). Any opaque possibility of a satisfying
 * model command makes the policy fail closed, checked before the segment
 * loop; every other possibility adds its context through the same rules as
 * a segment's `effectiveTarget` (cwd context, the outside-every-repository
 * exception, the D-015 dedup, the `MAX_ATTRIBUTED_CONTEXTS` bound). Unlike
 * the segment view, the model composes relative paths (`cd T && git -C
 * sub log` runs in `T/sub`): each step keeps its mode and is resolved
 * against the real filesystem by `modelPaths` (`shell-model-paths.ts`: a
 * logical step lexically against the previous directory, a physical one
 * through the real directory it starts from), one resolution per distinct
 * possibility per event, under a per-event work budget past which the
 * policy fails closed (`opaque-target`). Omitted, `modelPaths` is a fresh
 * resolver for the cwd. When the command could not be lexed
 * (`shellModel.commands === null`), the segment view decides alone, except
 * that a policy with a `bash_match` fails closed when the raw text holds a
 * directory-changing word (`shellModel.directoryChangeWord`). Omitted (a
 * non-Bash event, or a caller with no model), the result is the segment
 * view's alone.
 */
export function resolveAttributedContexts(
  policy: Policy,
  segments: readonly CommandSegment[],
  cwdBuiltins: ExtractBuiltins,
  cwdCurrentHeadSha: string | undefined,
  resolveGitContextMemo: Map<string, GitRepoContext>,
  mayBeInsideRepositoryMemo: Map<string, boolean>,
  repoOverridden: boolean,
  branchOverridden: boolean,
  extractContext: ExtractEventContext,
  shellModel?: ShellModelView,
  modelPaths?: ModelPathResolver,
  segmentViewMatched = true,
): AttributedContextsResult {
  const cwdContext: AttributedContext = { builtins: cwdBuiltins, currentHeadSha: cwdCurrentHeadSha };
  if (
    shellModel !== undefined &&
    shellModel.commands === null &&
    shellModel.directoryChangeWord &&
    policy.trigger.bash_match !== undefined
  ) {
    // The model could not read the command, and the raw text holds a
    // directory-changing word: the segment view alone may be reading a
    // nested repository's command as the cwd's, so fail closed.
    return { kind: "opaque-target" };
  }
  const modelSatisfying = shellModel === undefined ? [] : attributeTriggerModelCommands(policy, shellModel);
  if (modelSatisfying.some((c) => c.dirs.some((d) => d.kind === "opaque"))) return { kind: "opaque-target" };
  const satisfying = new Set(attributeTriggerSegments(policy, segments));
  if (satisfying.size === 0 && modelSatisfying.length === 0) return { kind: "contexts", contexts: [cwdContext] };

  const cwdSignature = [cwdBuiltins.REPO, cwdBuiltins.BRANCH, cwdCurrentHeadSha ?? ""].join("|");
  const seenSignatures = new Set<string>();
  const contexts: AttributedContext[] = [];
  const addCwdOnce = (): void => {
    if (seenSignatures.has(cwdSignature)) return;
    seenSignatures.add(cwdSignature);
    contexts.push(cwdContext);
  };
  const cwdReal = realpathOrSelf(cwdBuiltins.CWD);
  // Decided from the same values `evaluateOnePolicy` guards on: the
  // policy's own `trigger.extract` evaluated against the cwd builtins, so
  // an extract named `REPO` / `BRANCH` that shadows a builtin is honoured
  // here exactly as it is there.
  const cwdGuard = emptyIdentifierGuard(
    policy.requires?.ledger_tag ?? "",
    evaluateExtract(policy.trigger.extract ?? {}, extractContext, cwdBuiltins).values,
  );
  // "Outside every repository" is checked on the cwd's real path: the
  // builtins resolve the path as given, while git runs in the physical
  // directory, so a symlink into a repository is not outside it. An empty
  // CWD names no directory at all and never qualifies. The check is the
  // conservative `mayBeInsideRepository`, not the static
  // `resolveGitContext` the builtins come from: that resolver misses
  // repositories git still finds (see the helper's doc comment), and here
  // a miss would drop a demand. It runs only for a blank `${REPO}`, at
  // most once per event (`mayBeInsideRepositoryMemo`).
  const cwdOutsideEveryRepository =
    cwdGuard?.identifier === "REPO" &&
    cwdBuiltins.CWD.length > 0 &&
    !mayBeInsideRepositoryMemoised(cwdReal, mayBeInsideRepositoryMemo);

  // One resolved target directory, from a segment's `effectiveTarget` or a
  // shell model path: adds its context (or the cwd context) and returns
  // `null`, or returns the `bounded` result once the bound is exceeded.
  const addResolvedTarget = (resolved: string): AttributedContextsResult | null => {
    // D-021 (UNIVERSAL-ADDITIVE, operator decision after the four-pass
    // halt — see this function's own doc comment): the cwd context is
    // demanded UNCONDITIONALLY here, regardless of whether the target came
    // from the segment's own explicit flag or was inherited from a
    // preceding `cd`. `seg.ownTarget` is no longer read for this decision.
    // The one exception is `cwdOutsideEveryRepository` below: it is
    // decided after the target resolved, so the cwd context is added from
    // the branches of this function instead of up front, in the same
    // order as before.
    if (resolved === cwdReal) {
      addCwdOnce();
      return null;
    }

    let gitCtx = resolveGitContextMemo.get(resolved);
    if (gitCtx === undefined) {
      gitCtx = resolveGitContext(resolved);
      resolveGitContextMemo.set(resolved, gitCtx);
    }
    if (gitCtx.repo.length === 0) {
      // D-003: outside any repo → cwd fallback, not a distinct context.
      addCwdOnce();
      return null;
    }

    const signature = [gitCtx.repo, gitCtx.branch, gitCtx.sha].join("|");

    // Empty-identifier exception to the universal-additive rule, limited
    // to a working directory outside every git repository. That cwd
    // context has a blank `${REPO}` (the value the guard sees, after the
    // policy's own extract) and can never be satisfied: the
    // empty-identifier guard denies it without a ledger query. Demanding
    // it next to a target that resolved to a real repository would deny
    // the very remedy the guard's message names (`git -C <repo> ...`, or
    // `cd <repo> && ...` in one command). The skip applies only when the
    // cwd is outside every repository and this segment's own target
    // resolved to a real repository; the target's own context is still
    // demanded in full. It relies on two static models: the target
    // attribution, whose known misattribution (a `GIT_DIR=` prefix or a
    // third repository reached through another construct) exists for every
    // cwd, and the cwd resolution, which is conservative: the skip applies
    // only when neither the cwd's real path nor any ancestor up to the
    // filesystem root holds an entry named `HEAD` or `.git` (any type) and
    // no lookup failed other than with ENOENT (`mayBeInsideRepository`).
    // What remains outside both models: a third repository the command
    // really runs in (a `GIT_DIR=` prefix, or a `cd` into another
    // repository before the misattributed segment), state the command
    // itself creates while it runs (a `.git` it links or writes before the
    // git verb), and an ambient `GIT_DIR` / `GIT_COMMON_DIR` in the
    // environment git runs with. A
    // detached cwd (non-blank `${REPO}`, blank `${BRANCH}`) and
    // every non-blank cwd context keep the rule above unchanged: the
    // detached remedy (`git switch` in that repository) is establishable,
    // and dropping that context would let a misattributed push from the
    // detached HEAD pass on the target's evidence. A segment without a
    // resolved target (a bare `git status`) keeps its cwd context and
    // still denies with the hint.
    if (!cwdOutsideEveryRepository) addCwdOnce();

    if (signature === cwdSignature) {
      // D-015: a foreign target that resolves to cwd's own REAL identity
      // (e.g. a subdirectory of the cwd repo reached via `-C`, a
      // different literal path than `cwdBuiltins.CWD` itself but the SAME
      // `.git`) collapses into the cwd context regardless of segment
      // order — not just when a bare cwd-reading segment happened to add
      // it first.
      addCwdOnce();
      return null;
    }
    if (seenSignatures.has(signature)) return null;

    if (contexts.length >= MAX_ATTRIBUTED_CONTEXTS) {
      // D-013: fail CLOSED — do not evaluate any of them, name the
      // ambiguity instead. `contexts.length + 1` names "at least this
      // many distinct targets", the count observed before bailing, not
      // necessarily the final total (the loop stops here).
      return { kind: "bounded", distinctCount: contexts.length + 1 };
    }

    seenSignatures.add(signature);
    contexts.push({
      builtins: {
        ...cwdBuiltins,
        REPO: repoOverridden ? cwdBuiltins.REPO : gitCtx.repo,
        BRANCH: branchOverridden ? cwdBuiltins.BRANCH : gitCtx.branch,
      },
      currentHeadSha: gitCtx.sha.length > 0 ? gitCtx.sha : undefined,
      foreignTarget: { repo: gitCtx.repo, dir: resolved },
    });
    return null;
  };

  // SEGMENT VIEW FIRST, exactly as it decides without the shell model:
  // its own verdict for no satisfying segment (the cwd context alone), its
  // loop, and its own fallback for a loop that added nothing. Only then
  // does the model add to `contexts`. That order is what makes the union
  // structural: every context the segment view demands is in `contexts`
  // before the first model possibility is read, and the model phase below
  // can only append a context, or end in `opaque-target` / `bounded` (both
  // fail closed), never remove one. In particular the
  // outside-every-repository exception, applied to a model target inside
  // `addResolvedTarget`, decides only whether that model target brings the
  // cwd context along; a cwd context the segment view demanded is already
  // in `contexts` and stays there.
  if (satisfying.size === 0) {
    // The segment view's verdict without a satisfying segment: the cwd
    // context alone, for a policy one of its arms matched. A policy only
    // the model's arm matched never matched the segment view, which has
    // no demand of its own for it (the model phase decides alone, with
    // the same per-target rules).
    if (segmentViewMatched) addCwdOnce();
  }
  for (const seg of segments) {
    if (!satisfying.has(seg)) continue;

    if (seg.opaqueTarget === true) {
      // Task `cfb6b390`: the segment names (or inherits) a repository
      // directory through a value this module refuses to read, not just
      // one it cannot attribute. Reading that as "cwd only" would let the
      // outer repository's evidence stand in for a nested repository the
      // command really runs in, so the policy fails closed instead. Every
      // other unattributable form (a quoted path, a `~` prefix, a bare
      // substitution) keeps the cwd-only fallback below.
      return { kind: "opaque-target" };
    }

    if (seg.effectiveTarget === null) {
      // D-003: fully unattributable — cwd only, no foreign target to be
      // additive with.
      addCwdOnce();
      continue;
    }

    const bounded = addResolvedTarget(realpathOrSelf(path.resolve(cwdBuiltins.CWD, seg.effectiveTarget)));
    if (bounded !== null) return bounded;
  }

  // The segment view's own defensive fallback: every satisfying segment
  // existed but somehow none was added above (should not happen: every
  // branch above adds either the cwd context or a foreign one). Never
  // leave a matched, per-repo-builtins policy with zero contexts to
  // evaluate against.
  if (satisfying.size > 0 && contexts.length === 0) addCwdOnce();

  // MODEL VIEW: the shell model's trigger-satisfying commands (opaque ones
  // already returned above), appended to the segment view's contexts. A
  // possibility the command text does not name (`unknown`) or the working
  // directory itself keeps the cwd context; a path is resolved through
  // `modelPaths` and added like a segment's target. Each distinct
  // possibility is read once (thousands of commands after one long `cd`
  // chain share one), and the resolver memoises across policies and counts
  // its filesystem work: once the per-event budget is spent, the policy
  // fails closed (`opaque-target`) instead of resolving further.
  const paths = modelPaths ?? new ModelPathResolver(cwdBuiltins.CWD);
  const seenPossibilities = new Set<DirPossibility>();
  const seenKeys = new Set<string>();
  for (const command of modelSatisfying) {
    for (const dir of command.dirs) {
      if (seenPossibilities.has(dir)) continue;
      seenPossibilities.add(dir);
      if (dir.kind !== "path" || dir.steps.length === 0) {
        addCwdOnce();
        continue;
      }
      const key = dirPossibilityKey(dir);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const resolved = paths.resolve(dir);
      if (resolved === null) return { kind: "opaque-target" };
      if (resolved !== cwdReal && !resolveGitContextMemo.has(resolved) && !paths.chargeRepositoryLookup(resolved)) {
        return { kind: "opaque-target" };
      }
      const bounded = addResolvedTarget(resolved);
      if (bounded !== null) return bounded;
    }
  }

  // Defensive, as above: a matched policy never has zero contexts.
  return { kind: "contexts", contexts: contexts.length > 0 ? contexts : [cwdContext] };
}

/**
 * Could git find a repository from `dir`? Decided for the one place that
 * drops a demand on the answer (the cwd-outside-every-repository exception
 * in `resolveAttributedContexts`), so every doubt counts as inside. The
 * static `resolveGitContext` walk that resolves the `REPO` / `BRANCH`
 * builtins is left as it is for its other callers; it reports no
 * repository where git still finds one: a `.git` directory without `HEAD`
 * ends its walk (git skips it and walks on), its walk stops after 128
 * levels, and it never recognises a directory that is itself a git
 * directory (a bare repository, or one whose objects live elsewhere
 * through a `commondir` file).
 *
 * This walk does not list layouts. It uses the one structural fact every
 * git directory shares: git accepts a directory as a git directory only
 * when it holds an entry named `HEAD`, and it reaches a repository from a
 * working directory only through a `.git` entry (directory or `gitdir:`
 * file) or a git directory on the way up. So, from `dir` up to the
 * filesystem root with no depth bound:
 *
 * - an entry named `HEAD` or `.git`, of any type, valid or not, counts as
 *   inside (never followed, read or validated);
 * - an `lstat` error other than ENOENT counts as inside (the entry may
 *   exist).
 *
 * The cost is a conservative false inside: a directory that merely holds
 * an entry named `HEAD` (also `head` or `Head` on a case-insensitive
 * volume), or lies below one, keeps its cwd context and denies with the
 * no-repository hint (fail closed). An ambient `GIT_DIR` /
 * `GIT_COMMON_DIR` in git's environment is not visible here.
 */
function mayBeInsideRepository(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (entryMayExist(path.join(current, ".git"))) return true;
    if (entryMayExist(path.join(current, "HEAD"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * `false` only when `lstat` proves the entry absent (ENOENT, reported as
 * `undefined` without building an exception); every other error counts as
 * present.
 */
function entryMayExist(entryPath: string): boolean {
  try {
    return fs.lstatSync(entryPath, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * `mayBeInsideRepository(dir)`, computed at most once per `dir` within one
 * `intercept()` call. `memo` is that call's own map (never module-level
 * state), so no answer outlives the event it was computed for.
 */
function mayBeInsideRepositoryMemoised(dir: string, memo: Map<string, boolean>): boolean {
  const known = memo.get(dir);
  if (known !== undefined) return known;
  const inside = mayBeInsideRepository(dir);
  memo.set(dir, inside);
  return inside;
}

/**
 * Lazily resolve the event's per-segment view for attribution, computed
 * at most once per `intercept()` call (the caller, `intercept()` below,
 * memoises the RESULT in its own `segmentsForAttribution` local — this
 * function itself is called at most once per call already, but stays
 * side-effect-free so that remains true regardless of caller changes).
 * Prefers `options.commandSegmentsThunk` (D-015 fix round: the deferred,
 * compute-only-if-needed seam — see its own doc comment), then the eager
 * `options.commandSegments`, then falls back to computing it directly
 * from the event's own command for standalone callers/tests that inject
 * neither. `null` (truncated — see `segmentViewOf`) and "no Bash command
 * on this event" both collapse to `[]`, the same "nothing to attribute,
 * cwd builtins" shape as a policy with no `bash_match` at all.
 */
function resolveCommandSegments(options: InterceptOptions): CommandSegment[] {
  if (options.commandSegmentsThunk !== undefined) return options.commandSegmentsThunk() ?? [];
  if (options.commandSegments !== undefined) return options.commandSegments ?? [];
  const command = extractShellCommand(options.event);
  if (command === null) return [];
  return segmentViewOf(command) ?? [];
}

/**
 * The event's shell model (task 7d4abf84) for both of its readers in one
 * `intercept()` call, the fifth matching arm and attribution, so the two
 * read the same view: the injected `shellModelThunk`, else a memoised
 * thunk computing `shellModelViewOf` of the event's own command with
 * `modelPaths` as its directory oracle, else `undefined` (no Bash command
 * on this event: the segment view decides alone).
 */
function shellModelThunkFor(
  options: InterceptOptions,
  modelPaths: () => ModelPathResolver,
): (() => ShellModelView) | undefined {
  if (options.shellModelThunk !== undefined) return options.shellModelThunk;
  const command = extractShellCommand(options.event);
  if (command === null) return undefined;
  let cached: ShellModelView | undefined;
  return () => (cached ??= shellModelViewOf(command, modelPaths()));
}

/**
 * Synthesise the single decision `intercept()` records for a policy whose
 * distinct attributed contexts exceeded `MAX_ATTRIBUTED_CONTEXTS` (D-013).
 * Routes through `outcomeForFailedRequires` — the SAME enforcement-to-
 * outcome mapping every other "could not safely evaluate" branch in
 * `evaluateOnePolicy` uses — rather than a hardcoded outcome, so a
 * `block`-enforcement policy (the security-critical case: preflight/push/
 * merge gates) genuinely denies, while a `warn`-enforcement policy warns
 * instead of hard-blocking, consistent with how every other failed-
 * evaluation branch in this module already respects the policy's own
 * declared enforcement. No ledger query, no template substitution against
 * a resolved `ledger_tag` (there is no single context to substitute one
 * against) — `extractValues` is still computed from `trigger.extract`
 * against the CWD builtins (cheap, pure, matches the `operator_only`
 * short-circuit's own reasoning) so a `ux:`/`producers:` block on this
 * policy can still render.
 */
function boundedContextsDecision(
  policy: Policy,
  event: ToolEvent,
  distinctCount: number,
  cwdBuiltins: ExtractBuiltins,
  evaluatedAt: string,
): PolicyDecision {
  return failClosedContextsDecision(
    policy,
    event,
    cwdBuiltins,
    evaluatedAt,
    `ambiguous: this command names at least ${distinctCount} distinct repository targets for this policy, ` +
      `exceeding the ${MAX_ATTRIBUTED_CONTEXTS}-context bound — refusing to evaluate all of them`,
    "(bounded: too many distinct attributed targets — no context queried)",
  );
}

/**
 * The one decision shape `intercept()` records when it refuses to evaluate
 * a policy's attributed contexts (the bound above, an opaque target below):
 * no ledger query, the policy's own enforcement mapped through
 * `outcomeForFailedRequires`, and `extractValues` computed against the cwd
 * builtins so a `ux:` / `producers:` block still renders.
 */
function failClosedContextsDecision(
  policy: Policy,
  event: ToolEvent,
  cwdBuiltins: ExtractBuiltins,
  evaluatedAt: string,
  reason: string,
  ledgerTag: string,
): PolicyDecision {
  const extract = evaluateExtract(policy.trigger.extract ?? {}, buildEventContext(event), cwdBuiltins);
  return {
    policyName: policy.name,
    enforcement: policy.enforcement,
    outcome: outcomeForFailedRequires(policy.enforcement),
    reason,
    extractValues: extract.values,
    ledgerTag,
    evaluatedAt,
  };
}

/**
 * The ledger-tag text of the single decision `intercept()` records, through
 * `failClosedContextsDecision`, for a policy whose command names a
 * repository target `resolveAttributedContexts` refused to attribute (task
 * `cfb6b390`). Same shape and enforcement mapping as
 * `boundedContextsDecision`: no ledger query, `outcomeForFailedRequires` so
 * a `block` policy denies and a `warn` policy warns.
 */
const OPAQUE_TARGET_TAG = "(opaque target: not attributable to a repository, no context queried)";

export async function intercept(
  options: InterceptOptions,
): Promise<InterceptResult> {
  const { manifest, event } = options;

  // The Risk Gate is active only when some policy declares a `when:`
  // block. A manifest with none — every Phase 4 / 5 / 6 manifest — skips
  // envelope enrichment entirely: no `buildActionEnvelope`, no
  // classifier, no resolver, and decisions carry no `risk` / `environment`.
  // That keeps such manifests byte-for-byte identical to pre-Phase-7-#5.
  const riskGateActive = manifest.policies.some((p) => p.when !== undefined);
  const enriched: EnrichedEnvelope | undefined = riskGateActive
    ? enrichEnvelope(manifest, event, options.riskContext, options.now)
    : undefined;

  // A policy fires only when its `trigger:` matches AND — when declared
  // — every `when:` clause holds against the enriched envelope.
  //
  // For each matching when:-bearing policy we also record its
  // `unclassifiedFallback` flag so the decision record and deny message
  // can distinguish a genuine classification hit from a fail-closed
  // unclassified command (M7: runtime audit + block message). Policies
  // that have no `when:` block are not inserted into the map, so a
  // later `whenFallbackMap.get(name) === true` test is unambiguous.
  //
  // Explicit loop rather than Array.filter() so the map is built as a
  // first-class step: a filter predicate is expected to be pure, and a
  // future refactor that parallelises the filter would silently break the
  // audit flag if the mutation were still hiding inside the predicate.
  const whenFallbackMap = new Map<string, boolean>();
  const matching: Policy[] = [];
  // The shell model's path resolver (task 7d4abf84): one per event, shared
  // by the model's directory oracle and every policy's attribution, so a
  // path is resolved once and the work budget is per event. Created only
  // when the model is computed.
  let modelPathsCache: ModelPathResolver | undefined = options.modelPathResolver;
  const modelPaths = (): ModelPathResolver =>
    (modelPathsCache ??= new ModelPathResolver(options.builtins.CWD));
  const shellModelThunk = shellModelThunkFor(options, modelPaths);
  // Policies only the shell model's arm matched: the segment view has no
  // demand of its own for them (see `resolveAttributedContexts`).
  const matchedByModelOnly = new Set<Policy>();
  // Policies refused because the command could not be parsed (task
  // d11762ce, see `policyMatchArm`): one fail-closed decision each.
  const matchedUnparsed = new Set<Policy>();
  for (const p of manifest.policies) {
    const arm = policyMatchArm(
      p,
      event,
      options.normalizedCommand,
      options.ampNormalizedCommandThunk,
      options.quoteNormalizedCommandThunk,
      shellModelThunk,
    );
    if (arm === "none") continue;
    if (arm === "model") matchedByModelOnly.add(p);
    if (arm === "unparsed") matchedUnparsed.add(p);
    if (p.when === undefined) {
      matching.push(p);
      continue;
    }
    // `enriched` is defined here: a policy with `when:` set `riskGateActive`.
    const whenEval = evaluateWhen(p.when, enriched!);
    if (whenEval.matched) {
      whenFallbackMap.set(p.name, whenEval.unclassifiedFallback);
      matching.push(p);
    }
  }

  // Per-policy attribution (task `98ad072f`, T-003): `segmentsForAttribution`
  // is resolved at most once, lazily, only if some matching policy actually
  // uses `${REPO}`/`${BRANCH}`/`at_head` — a manifest with none of those
  // (every Phase 4/5/6-only manifest) never computes it.
  // `resolveGitContextMemo` is this call's own, non-module-level cache
  // (task constraint: no eager/global filesystem work) — see
  // `resolveAttributedContexts`'s own comment. `mayBeInsideRepositoryMemo`
  // is the same kind of per-call cache for the cwd walk.
  let segmentsForAttribution: CommandSegment[] | undefined;
  // The shell model view (task 7d4abf84), from the same memoised thunk the
  // matching loop used, at most once per event, for the per-repo policies
  // only.
  const shellModelOnce = (): ShellModelView | undefined => shellModelThunk?.();
  const resolveGitContextMemo = new Map<string, GitRepoContext>();
  const mayBeInsideRepositoryMemo = new Map<string, boolean>();

  const decisions: PolicyDecision[] = [];
  for (const policy of matching) {
    // A policy refused because the command could not be parsed (task
    // d11762ce) takes the fail-closed path below without attribution.
    const attributed: AttributedContextsResult | { kind: "unparsed" } = matchedUnparsed.has(policy)
      ? { kind: "unparsed" }
      : usesPerRepoBuiltins(policy)
      ? resolveAttributedContexts(
          policy,
          (segmentsForAttribution ??= resolveCommandSegments(options)),
          options.builtins,
          options.currentHeadSha,
          resolveGitContextMemo,
          mayBeInsideRepositoryMemo,
          options.repoOverridden === true,
          options.branchOverridden === true,
          buildEventContext(options.event),
          shellModelOnce(),
          shellModelThunk === undefined ? undefined : modelPaths(),
          !matchedByModelOnly.has(policy),
        )
      : { kind: "contexts", contexts: [{ builtins: options.builtins, currentHeadSha: options.currentHeadSha }] };

    if (attributed.kind !== "contexts") {
      // D-013: fail CLOSED without querying the ledger for any of the
      // (too many) distinct targets — one synthetic decision, one audit
      // write, then move on to the next policy. Ledger-query count for
      // THIS policy stays at zero regardless of how many distinct targets
      // the command actually names, instead of scaling with them. The
      // `opaque-target` result (task `cfb6b390`) and the unparsed refusal
      // (task d11762ce) take the same path: one synthetic decision, no
      // ledger query.
      const evaluatedAt = (options.now ?? new Date()).toISOString();
      const decision =
        attributed.kind === "bounded"
          ? boundedContextsDecision(
              policy,
              event,
              attributed.distinctCount,
              options.builtins,
              evaluatedAt,
            )
          : {
              ...failClosedContextsDecision(
                policy,
                event,
                options.builtins,
                evaluatedAt,
                attributed.kind === "unparsed" ? UNPARSED_COMMAND_REASON : OPAQUE_TARGET_REASON,
                attributed.kind === "unparsed" ? UNPARSED_COMMAND_TAG : OPAQUE_TARGET_TAG,
              ),
              refusal: attributed.kind,
            };
      decisions.push(decision);
      try {
        await options.ledger.record(decision, resolveSessionId(event.session_id));
      } catch (err) {
        (options.stderr ?? process.stderr).write(
          `harness runtime intercept: audit-write failed for ${decision.policyName}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      continue;
    }

    for (const context of attributed.contexts) {
      // Same object reference as `options` on the (overwhelmingly common)
      // single-cwd-context path — no clone, byte-identical to the
      // pre-attribution call shape. Only a genuinely foreign context
      // builds a shallow override.
      const contextOptions: InterceptOptions =
        context.builtins === options.builtins &&
        context.currentHeadSha === options.currentHeadSha
          ? options
          : { ...options, builtins: context.builtins, currentHeadSha: context.currentHeadSha };
      const base = await evaluateOnePolicy(policy, contextOptions);
      // Attach the per-event Risk Gate verdicts so `harness audit` /
      // `explain --trace` can replay the classification + environment
      // that the `when:` match was made against. Also carry the
      // unclassifiedFallback flag (M7) when the when: evaluation set it
      // to true; leave the field absent otherwise so decisions from
      // manifests without a `when:` policy stay byte-identical.
      const whenFallback = whenFallbackMap.get(policy.name);
      const decision: PolicyDecision = {
        ...(enriched
          ? {
              ...base,
              risk: enriched.risk,
              environment: enriched.environment,
              ...(whenFallback === true ? { whenUnclassifiedFallback: true } : {}),
            }
          : base),
        ...(context.foreignTarget !== undefined ? { foreignTarget: context.foreignTarget } : {}),
      };
      decisions.push(decision);
      try {
        await options.ledger.record(
          decision,
          resolveSessionId(event.session_id),
        );
      } catch (err) {
        // Audit-write failure must not block; the decision is still applied.
        // Surface the failure to stderr so a persistently-failing recorder
        // does not silently leave `harness audit` / `explain --trace` blind.
        // Goes to stderr to keep the stdout deny-JSON contract intact.
        (options.stderr ?? process.stderr).write(
          `harness runtime intercept: audit-write failed for ${decision.policyName}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  // First blocking decision wins the envelope. `deny` and
  // `require_approval` both abort (Phase 7 #6); the search order is the
  // manifest's policy order, same as Phase 4.
  const blocking = decisions.find(isBlockingDecision);
  if (blocking) {
    const sessionId = resolveSessionId(options.event.session_id);
    // Append the "to satisfy" hint so Claude Code's deny message tells
    // the operator (or the agent reading the same surface) what evidence
    // would unblock the gate, instead of just naming the missing tag.
    // The hint is content + window only; it does not prescribe a
    // recording verb so the deny path stays neutral on producer (see
    // agent-tasks/88ca4bb3 for why "use mcp__..." would be the wrong
    // suggestion when the engine is the source of that suggestion).
    //
    // It DOES name the sessionId namespace the entry must be written
    // under — this runtime session's id (the value shown), not the
    // agent-tasks task UUID. Naming an identity is not a producer
    // verb, so this stays compatible with the producer-neutrality above.
    // The two namespaces are a known production footgun: an entry written
    // under the agent-tasks task UUID never satisfies a harness runtime
    // gate, which keys off the runtime session id (2026-05-17 incident,
    // harness PRs #174/#175 — first attempt used the task UUID and was
    // rejected, second used the session id and passed).
    const hintSuffix = blocking.recordHint
      ? ` To satisfy: ${blocking.recordHint}, under this runtime session's id \`${sessionId}\` (not the agent-tasks task UUID).`
      : "";
    // Opt-in producer block: when the policy declares `producers:` in
    // the manifest, render the structured remediation list (bash / mcp
    // / ask recipes) with ${VAR} placeholders substituted against the
    // same extract.values the ledger_tag was resolved with. Schema
    // validation guarantees at least one `mcp` producer per declared
    // list, so an agent stuck in a Bash lockout always has an ungated
    // recovery path. Policies without `producers:` get the legacy
    // neutral deny envelope unchanged (agent-tasks/3804b785).
    const blockingPolicy = matching.find((p) => p.name === blocking.policyName);
    // When the policy declares `ux:`, the agent-facing surface
    // becomes the plain-language `{cannot, required, run}` shape
    // instead of the engine-vocabulary deny envelope. The internal
    // decision (reason, recordHint, requiresEval, ledgerTag) is
    // unchanged and still recorded to the audit ledger above. The
    // producers block is suppressed when ux is declared because
    // `run:` is the canonical remedy surface and rendering both would
    // give the agent two different command suggestions.
    let reasonText: string;
    if (blocking.outcome === "deny-degraded") {
      // Degraded-specific envelope (task f1aea826). Deliberately takes
      // precedence over the policy's `ux:` surface: the operator-curated
      // ux text describes the MISSING-evidence case ("run the producer,
      // then retry"), which is actively misleading here — the evidence
      // could not be READ, so producing the tag cannot unblock anything
      // until the ledger is reachable again. The envelope names the real
      // cause (the transport-level reason, sanitised — it embeds output
      // from the grounding-mcp subprocess) and the posture, so nobody
      // debugs a phantom missing tag.
      //
      // The `risk.degraded_fail_posture: fail_open` opt-out is
      // deliberately NOT named here (review 2026-08-08, high finding):
      // this text is fed back to the very agent that was just blocked,
      // and nothing prevents that agent from editing the manifest — a
      // deny that includes its own disable recipe is not a gate. The
      // opt-out lives on operator surfaces only: the stderr diagnostic
      // (`formatDecisionDiagnostic`), docs/risk-gate.md, and the OKF
      // fail-posture matrix. Same reasoning as the producer-neutrality
      // norm above and the operator-only framing of `harness pause`.
      reasonText =
        `${blocking.policyName}: required evidence could not be read ` +
        `(evidence ledger degraded: ${sanitizeEnvelopeReason(blocking.reason)}). ` +
        `This ${blocking.enforcement} policy fails closed while its evidence ` +
        `source is unreadable; producing the required tag will not unblock it ` +
        `until the ledger is reachable again. Ask your operator to check ` +
        `grounding-mcp (harness doctor), then retry. Session: ${sessionId}.`;
    } else if (blocking.emptyIdentifier !== undefined) {
      // Empty ${REPO} / ${BRANCH}: the decision's own reason names the
      // state the agent can establish (`cd` / `git -C` / `git switch`).
      // Takes precedence over `ux:` (whose `cannot:` text would render
      // the blank identifier, "You cannot push branch  yet.") and over
      // `producers:` / the record hint (both would send the agent to
      // produce a tag the gate will not read in this state). Names no
      // opt-out, same reasoning as the degraded envelope above.
      reasonText = `${blocking.policyName}: ${blocking.reason}`;
    } else if (blocking.refusal !== undefined) {
      // A refusal (task d11762ce): the command line could not be parsed,
      // or it names a repository target that cannot be attributed. Takes
      // precedence over `ux:`, `producers:` and the record hint, which all
      // name the policy's evidence as the remedy: recording it cannot
      // unblock a refusal, which never reads the ledger. One envelope names
      // the cause and its own remedy (fix the syntax or flatten the
      // nesting; name the repository with a plain path) and every policy
      // refused for the same cause, so the agent is not sent through the
      // policies one at a time.
      const refusedNames = decisions
        .filter((d) => d.refusal === blocking.refusal && isBlockingDecision(d))
        .map((d) => d.policyName);
      reasonText = `${refusedNames.join(", ")}: ${blocking.reason}.`;
    } else if (blockingPolicy?.ux) {
      // The ux surface is operator-curated plain language. Task
      // 2929c5b7: a ux-declared policy's `cannot:` text used to be
      // rendered unchanged even when the match was a fail-closed
      // unclassified hit, not a genuine classification — so
      // gate-prod-destructive's "You cannot run this critical
      // destructive action against production." was shown verbatim for
      // an unrecognized READ (e.g. `cat`/`sed -n`/`curl`) the moment the
      // environment resolved to production, which is exactly the false
      // positive this task exists to fix. When `whenUnclassifiedFallback`
      // is set, a fallback-specific sentence is PREPENDED naming the real
      // cause before the operator's own `cannot:` text, which is left
      // byte-for-byte intact (added to, never replaced): the operator
      // still chose that wording for the genuine-classification case,
      // which keeps rendering unchanged. See docs/risk-gate.md,
      // "Unclassified actions and the fail-close rule".
      const uxText = renderAgentFacing(blockingPolicy.ux, {
        ...blocking.extractValues,
        SESSION_ID: sessionId,
      });
      reasonText = blocking.whenUnclassifiedFallback
        ? `${unclassifiedFallbackPrefix(
            enriched?.environment.name,
            blockingPolicy.when?.["risk.severity_at_least"],
          )} ${uxText}`
        : uxText;
    } else {
      const producersBlock = renderProducers(
        blockingPolicy?.producers,
        blocking.extractValues,
      );
      // M7: when the policy matched only because the action was
      // unclassified (fail-closed), insert an operator-facing note so a
      // deny caused by an unknown command is distinguishable from a deny
      // caused by a genuine critical-severity classification. The note is
      // placed after the base reason but BEFORE hintSuffix so the cause
      // precedes the remedy ("why this fired" before "how to unblock").
      // Neutral deny envelope only (not the ux path above).
      const unclassifiedClause = blocking.whenUnclassifiedFallback
        ? " (matched via the fail-closed unclassified rule, not a real risk classification)"
        : "";
      reasonText = `${blocking.policyName}: ${blocking.reason}.${unclassifiedClause}${hintSuffix}${producersBlock}`;
    }
    // A decision made for a foreign attributed context (a nested or
    // vendored work tree named by the command) is explained by the
    // repository it resolved to: the producer the message points at runs
    // for the working directory, whose own evidence may already be on
    // record. Appended only for a missing-evidence block; the degraded and
    // empty-identifier envelopes above name their own cause and stay as
    // they are. Deliberately policy-neutral and names no opt-out.
    if (
      blocking.foreignTarget !== undefined &&
      blocking.outcome !== "deny-degraded" &&
      blocking.emptyIdentifier === undefined
    ) {
      reasonText += foreignTargetSentence(blocking.foreignTarget, blockingPolicy?.ux !== undefined);
    }
    const block: ClaudeDenyJson = {
      decision: "block",
      reason: reasonText,
    };
    // permissionDecision is documented for PreToolUse only; emitting the
    // envelope on other events would invent a shape Claude Code does not
    // define, so we restrict it strictly. Other event kinds still block
    // via the top-level `decision: "block"`.
    if (options.event.hook_event_name === "PreToolUse") {
      block.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        // Duplicates `reason` intentionally: legacy consumers read the
        // top-level field, modern PreToolUse consumers read this one.
        permissionDecisionReason: reasonText,
      };
    }
    return { decisions, blockJson: block };
  }
  return { decisions, blockJson: null };
}
