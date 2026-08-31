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
import { POLICY_DECISION_TYPE } from "../io/ledger-record.js";
import { classifyRisk, type RiskProfile } from "./risk-classifier.js";
import { resolveSessionId } from "./session-id.js";
import {
  expandToolNameAliases,
  extractShellCommand,
} from "./tool-name-aliases.js";
import { evaluateWhen } from "./when-eval.js";

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
   * True when the policy's `when:` block matched ONLY because the action
   * was unclassified (the "unknown is not safe" fail-close rule in
   * `when-eval.ts`). Absent when the policy has no `when:` block, when
   * the match was a genuine classification hit, or when `unclassifiedFallback`
   * was false. Present in the audit record and the non-ux block-time deny
   * message so an operator can distinguish a real critical-severity match
   * from a fail-closed unclassified command at a glance.
   */
  whenUnclassifiedFallback?: boolean;
  evaluatedAt: string;
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
 */
export function policyMatchesEvent(
  policy: Policy,
  event: ToolEvent,
  precomputedNormalizedCommand?: NormalizedCommand,
  ampNormalizedCommandThunk?: () => AmpAwareNormalizedCommand,
  quoteNormalizedCommandThunk?: () => QuoteAwareNormalizedCommand,
): boolean {
  if (policy.trigger.event !== event.hook_event_name) return false;
  if (policy.trigger.match !== undefined) {
    if (typeof event.tool_name !== "string") return false;
    const toolNames = expandToolNameAliases(event.tool_name);
    if (
      !toolNames.some((toolName) => toolName.includes(policy.trigger.match!))
    ) {
      return false;
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
      return false;
    }
  }
  if (policy.trigger.bash_match !== undefined) {
    const command = extractShellCommand(event);
    if (command === null) return false;
    let re: RegExp;
    try {
      re = new RegExp(policy.trigger.bash_match);
    } catch {
      return false;
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
          if (!re.test(quoted.normalized)) return false;
        }
      }
    }
  }
  return true;
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
  const stripped = reason.replace(ENVELOPE_CONTROL_CHARS, " ");
  return stripped.length > 200 ? `${stripped.slice(0, 200)}...` : stripped;
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
function usesPerRepoBuiltins(policy: Policy): boolean {
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
  | { kind: "bounded"; distinctCount: number };

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
 * be additive WITH.
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
 * once per policy per segment.
 */
function resolveAttributedContexts(
  policy: Policy,
  segments: readonly CommandSegment[],
  cwdBuiltins: ExtractBuiltins,
  cwdCurrentHeadSha: string | undefined,
  resolveGitContextMemo: Map<string, GitRepoContext>,
  repoOverridden: boolean,
  branchOverridden: boolean,
): AttributedContextsResult {
  const cwdContext: AttributedContext = { builtins: cwdBuiltins, currentHeadSha: cwdCurrentHeadSha };
  const satisfying = new Set(attributeTriggerSegments(policy, segments));
  if (satisfying.size === 0) return { kind: "contexts", contexts: [cwdContext] };

  const cwdSignature = [cwdBuiltins.REPO, cwdBuiltins.BRANCH, cwdCurrentHeadSha ?? ""].join("|");
  const seenSignatures = new Set<string>();
  const contexts: AttributedContext[] = [];
  const addCwdOnce = (): void => {
    if (seenSignatures.has(cwdSignature)) return;
    seenSignatures.add(cwdSignature);
    contexts.push(cwdContext);
  };
  const cwdReal = realpathOrSelf(cwdBuiltins.CWD);

  for (const seg of segments) {
    if (!satisfying.has(seg)) continue;

    if (seg.effectiveTarget === null) {
      // D-003: fully unattributable — cwd only, no foreign target to be
      // additive with.
      addCwdOnce();
      continue;
    }

    // D-021 (UNIVERSAL-ADDITIVE, operator decision after the four-pass
    // halt — see this function's own doc comment): the cwd context is
    // demanded UNCONDITIONALLY here, regardless of whether the target came
    // from the segment's own explicit flag or was inherited from a
    // preceding `cd`. `seg.ownTarget` is no longer read for this decision.
    addCwdOnce();

    const resolvedLexical = path.resolve(cwdBuiltins.CWD, seg.effectiveTarget);
    const resolved = realpathOrSelf(resolvedLexical);
    if (resolved === cwdReal) {
      addCwdOnce();
      continue;
    }

    let gitCtx = resolveGitContextMemo.get(resolved);
    if (gitCtx === undefined) {
      gitCtx = resolveGitContext(resolved);
      resolveGitContextMemo.set(resolved, gitCtx);
    }
    if (gitCtx.repo.length === 0) {
      // D-003: outside any repo → cwd fallback, not a distinct context.
      addCwdOnce();
      continue;
    }

    const signature = [gitCtx.repo, gitCtx.branch, gitCtx.sha].join("|");
    if (signature === cwdSignature) {
      // D-015: a foreign target that resolves to cwd's own REAL identity
      // (e.g. a subdirectory of the cwd repo reached via `-C`, a
      // different literal path than `cwdBuiltins.CWD` itself but the SAME
      // `.git`) collapses into the cwd context regardless of segment
      // order — not just when a bare cwd-reading segment happened to add
      // it first.
      addCwdOnce();
      continue;
    }
    if (seenSignatures.has(signature)) continue;

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
    });
  }

  // Defensive fallback: every satisfying segment existed but somehow none
  // was added above (should not happen — every branch above adds either
  // the cwd context or a foreign one). Never leave a matched, per-repo-
  // builtins policy with zero contexts to evaluate against.
  return { kind: "contexts", contexts: contexts.length > 0 ? contexts : [cwdContext] };
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
  const extract = evaluateExtract(policy.trigger.extract ?? {}, buildEventContext(event), cwdBuiltins);
  return {
    policyName: policy.name,
    enforcement: policy.enforcement,
    outcome: outcomeForFailedRequires(policy.enforcement),
    reason:
      `ambiguous: this command names at least ${distinctCount} distinct repository targets for this policy, ` +
      `exceeding the ${MAX_ATTRIBUTED_CONTEXTS}-context bound — refusing to evaluate all of them`,
    extractValues: extract.values,
    ledgerTag: "(bounded: too many distinct attributed targets — no context queried)",
    evaluatedAt,
  };
}

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
  for (const p of manifest.policies) {
    if (
      !policyMatchesEvent(
        p,
        event,
        options.normalizedCommand,
        options.ampNormalizedCommandThunk,
        options.quoteNormalizedCommandThunk,
      )
    ) {
      continue;
    }
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
  // `resolveAttributedContexts`'s own comment.
  let segmentsForAttribution: CommandSegment[] | undefined;
  const resolveGitContextMemo = new Map<string, GitRepoContext>();

  const decisions: PolicyDecision[] = [];
  for (const policy of matching) {
    const attributed: AttributedContextsResult = usesPerRepoBuiltins(policy)
      ? resolveAttributedContexts(
          policy,
          (segmentsForAttribution ??= resolveCommandSegments(options)),
          options.builtins,
          options.currentHeadSha,
          resolveGitContextMemo,
          options.repoOverridden === true,
          options.branchOverridden === true,
        )
      : { kind: "contexts", contexts: [{ builtins: options.builtins, currentHeadSha: options.currentHeadSha }] };

    if (attributed.kind === "bounded") {
      // D-013: fail CLOSED without querying the ledger for any of the
      // (too many) distinct targets — one synthetic decision, one audit
      // write, then move on to the next policy. Ledger-query count for
      // THIS policy stays at zero regardless of how many distinct targets
      // the command actually names, instead of scaling with them.
      const evaluatedAt = (options.now ?? new Date()).toISOString();
      const decision = boundedContextsDecision(
        policy,
        event,
        attributed.distinctCount,
        options.builtins,
        evaluatedAt,
      );
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
      const decision: PolicyDecision = enriched
        ? {
            ...base,
            risk: enriched.risk,
            environment: enriched.environment,
            ...(whenFallback === true ? { whenUnclassifiedFallback: true } : {}),
          }
        : base;
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
    } else if (blockingPolicy?.ux) {
      // The ux surface is operator-curated plain language. The
      // unclassifiedFallback flag rides the audit record (recorded above
      // and surfaced by `harness audit` and `explain --trace`) so operators
      // can identify a fail-closed match without altering the agent-facing
      // text the operator intentionally worded.
      reasonText = renderAgentFacing(blockingPolicy.ux, {
        ...blocking.extractValues,
        SESSION_ID: sessionId,
      });
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
