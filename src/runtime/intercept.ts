// Phase 4 #5 — runtime hook interceptor + policy_decision audit log.
//
// Pure orchestration: takes a parsed event + a ledger client + the manifest,
// runs every matching policy through the Phase 4 #1/#2/#3 pipeline, returns
// the decisions and the Claude Code deny-JSON (or null when all allow).
// Side effects (stdin, stdout, ledger I/O) live in the thin CLI entrypoint
// that wraps this.

import * as path from "node:path";
import {
  evaluateExtract,
  evaluateRequires,
  parseDurationSeconds,
  substituteTemplate,
  type EvaluateRequiresOptions,
  type ExtractBuiltins,
  type ExtractEventContext,
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
  segmentViewOf,
  type AmpAwareNormalizedCommand,
  type CommandSegment,
  type NormalizedCommand,
} from "./command-normalize.js";
import {
  resolveEnvironment,
  type EnvironmentResolution,
} from "./environment-resolver.js";
import { resolveGitContext, type GitRepoContext } from "./git-context.js";
import { POLICY_DECISION_TYPE } from "./ledger-record.js";
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
export type PolicyOutcome =
  | "allow"
  | "warn"
  | "require_approval"
  | "deny"
  | "warn-degraded";

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
   * Precomputed per-segment view (`command-normalize.ts`'s
   * `segmentViewOf`) of a Bash event's `tool_input.command`, threaded in
   * by `runInterceptCli` the same resolved-by-the-wrapper pattern as
   * `normalizedCommand` above (task `98ad072f`, T-003) — computed ONCE
   * per event from the SAME `bashCommand` `normalizedCommand` already
   * uses, and reused by `intercept()`'s per-policy attribution below
   * instead of every per-repo-builtins policy recomputing it. `null`
   * mirrors `segmentViewOf`'s own contract: the command exceeded
   * `MAX_NORMALIZE_LENGTH`, so no segment view exists (treated as `[]` —
   * unattributable, cwd builtins, identical to a command with no
   * `bash_match` trigger at all). Optional: omitted by non-Bash events
   * and by callers/tests that don't supply one, in which case
   * `intercept()` computes it lazily itself, once per call, ONLY if some
   * matching policy actually needs it (see `usesPerRepoBuiltins` below) —
   * so a manifest with no `${REPO}`/`${BRANCH}`/`at_head` policy never
   * pays this cost even when uninjected.
   *
   * SAME INVARIANT as `normalizedCommand` / `ampNormalizedCommandThunk`
   * above: not checked against `event` at runtime; the one production
   * caller derives it from the identical event, same as those two.
   */
  commandSegments?: CommandSegment[] | null;
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
  return { risk, environment };
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
 */
export function policyMatchesEvent(
  policy: Policy,
  event: ToolEvent,
  precomputedNormalizedCommand?: NormalizedCommand,
  ampNormalizedCommandThunk?: () => AmpAwareNormalizedCommand,
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
  if (policy.trigger.bash_match !== undefined) {
    const command = extractShellCommand(event);
    if (command === null) return false;
    let re: RegExp;
    try {
      re = new RegExp(policy.trigger.bash_match);
    } catch {
      return false;
    }
    // Raw-OR-normalised-OR-amp-normalised (D-003, run 2026-07-27-gate-
    // target-repo-resolution; third arm added task aabbad63): test the
    // RAW command first — cheap, and byte-identical to the pre-fix
    // behaviour — then, only if that fails, the primary NORMALISED
    // command (wrapper prefixes peeled, git global options dropped,
    // whitespace collapsed, BOUNDARY_RE segmentation) — then, only if
    // THAT also fails, the ampersand-aware second pass (AMP_BOUNDARY_RE
    // segmentation, closing the bare-`&` family BOUNDARY_RE cannot see:
    // `A=x&env -C /tmp git status`, `echo hi & nice git status`).
    // Strictly additive at every step: a command that matched today
    // keeps matching via the raw test alone; the primary normalised form
    // can only ADD a match (env/nice/command wrappers, extra git global
    // options, doubled whitespace); the amp-aware form can only add a
    // FURTHER match on top of those two, never remove one either of them
    // already found. Replacing the matcher input instead of OR-ing it in
    // risks silently REMOVING an existing match if some pass ever
    // mangles a shape — the fail-open direction for a gate — so this
    // stays additive rather than a substitution at every arm.
    if (!re.test(command)) {
      const { normalized } = precomputedNormalizedCommand ?? normalizeCommand(command);
      if (!re.test(normalized)) {
        const amp = ampNormalizedCommandThunk
          ? ampNormalizedCommandThunk()
          : normalizeCommandAmpAware(command);
        if (!re.test(amp.normalized)) return false;
      }
    }
  }
  return true;
}

function buildEventContext(event: ToolEvent): ExtractEventContext {
  return {
    toolArgs: event.tool_input ?? event.raw_input ?? event.input,
    event,
    session: { id: event.session_id ?? "" },
    git: {},
  };
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
 *   - `allow` / `warn` / `warn-degraded` never abort.
 */
function isBlockingDecision(d: PolicyDecision): boolean {
  if (d.outcome === "deny") return d.enforcement === "block";
  return d.outcome === "require_approval";
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
    // Deliberately `warn-degraded`, not `deny`: this is the SAME "could
    // not decide" fail-open family as the other `warn-degraded` returns
    // in this function (unresolved template variables, a degraded
    // ledger query, an invalid `within`, a throwing `evaluateRequires`)
    // — the contract for all of them is "the evaluator could not form a
    // real verdict, so it never blocks and never silently allows either;
    // it is loud instead" (recorded to the audit ledger and returned as
    // a non-`allow`, non-`deny` outcome). Failing this branch `deny`
    // would treat an internal schema-invariant violation as if it were a
    // deliberate `operator_only: true` policy authored by the operator,
    // which it is not — the two must stay observably distinct.
    return {
      policyName: policy.name,
      enforcement: policy.enforcement,
      outcome: "warn-degraded",
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
      outcome: "warn-degraded",
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
      outcome: "warn-degraded",
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
        outcome: "warn-degraded",
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
      outcome: "warn-degraded",
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
 * Resolve the distinct `${REPO}`/`${BRANCH}`/`currentHeadSha` contexts a
 * `usesPerRepoBuiltins` policy must be evaluated against (task `98ad072f`,
 * T-003, `01-plan.md` Proposed Approach items 2-4). The engine trusts a
 * trigger-satisfying segment's `effectiveTarget` UNIFORMLY — no special
 * case for whether the target came from the segment's own explicit `-C`/
 * `--work-tree`/`--git-dir`/`env -C`, or was inherited from a preceding
 * `cd`: `CommandSegment.effectiveTarget` already IS the directory that
 * segment's own invocation genuinely runs in (bash semantics), and a
 * `cd <B> && <verb>` chain really does run `<verb>` inside B regardless
 * of what else appears between the `cd` and it (orchestrator decision
 * D-010, 2026-08-02: an earlier revision of this function additionally
 * distrusted an inherited target whenever a DIFFERENT invocation
 * intervened between the `cd` and the satisfying segment — REJECTED:
 * that coupling has no basis in bash's own semantics, is dodgeable by
 * inserting any harmless read between the `cd` and the gated verb, and
 * carried its own unverified `cd`-recognition gap. The `cd <B> && git
 * log && git push` shape this was meant to guard is not a regression at
 * all under this design — `git push` genuinely runs inside B — see
 * `tests/runtime/intercept-cli.test.ts`'s "leading-cd is now a
 * deliverable" block).
 *
 * Always returns at least one entry — the event's own cwd builtins/
 * `currentHeadSha`, unchanged — so a policy with no attributable foreign
 * target (no `bash_match`, no individually-matching segment, only an
 * amp-arm-only match, an unattributable composition, a target resolving
 * to the SAME directory as cwd, or a target outside any git repo — D-003)
 * is evaluated EXACTLY as it is today, with the EXACT SAME
 * `options.builtins` object reference (no clone), keeping that the
 * byte-identical common case. Returns more than one entry only when
 * D-004 applies: several of the policy's own trigger-satisfying segments
 * resolve to genuinely different repositories (deduped by resolved
 * `{repo, branch, sha}` identity, not by path string, so two spellings of
 * the same repo are one context, not two).
 *
 * `resolveGitContextMemo` is a per-`intercept()`-call cache keyed by the
 * RESOLVED absolute path (never module-level state — no cross-event
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
): AttributedContext[] {
  const cwdContext: AttributedContext = { builtins: cwdBuiltins, currentHeadSha: cwdCurrentHeadSha };
  const satisfying = attributeTriggerSegments(policy, segments);
  if (satisfying.length === 0) return [cwdContext];

  const seenSignatures = new Set<string>();
  const contexts: AttributedContext[] = [];
  const addCwdOnce = (): void => {
    if (seenSignatures.has("cwd")) return;
    seenSignatures.add("cwd");
    contexts.push(cwdContext);
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!satisfying.includes(seg)) continue;
    if (seg.effectiveTarget === null) {
      addCwdOnce();
      continue;
    }

    const resolved = path.resolve(cwdBuiltins.CWD, seg.effectiveTarget);
    if (resolved === cwdBuiltins.CWD) {
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
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    contexts.push({
      builtins: { ...cwdBuiltins, REPO: gitCtx.repo, BRANCH: gitCtx.branch },
      currentHeadSha: gitCtx.sha.length > 0 ? gitCtx.sha : undefined,
    });
  }

  // Defensive fallback: every satisfying segment existed but somehow none
  // was added above (should not happen — every branch above adds either
  // the cwd context or a foreign one). Never leave a matched, per-repo-
  // builtins policy with zero contexts to evaluate against.
  return contexts.length > 0 ? contexts : [cwdContext];
}

/**
 * Lazily resolve the event's per-segment view for attribution, computed
 * at most once per `intercept()` call. Prefers the caller-supplied
 * `options.commandSegments` (the resolved-by-the-wrapper pattern
 * `normalizedCommand` already uses); falls back to computing it directly
 * from the event's own command for standalone callers/tests that don't
 * inject one. `null` (truncated — see `segmentViewOf`) and "no Bash
 * command on this event" both collapse to `[]`, the same "nothing to
 * attribute, cwd builtins" shape as a policy with no `bash_match` at all.
 */
function resolveCommandSegments(options: InterceptOptions): CommandSegment[] {
  if (options.commandSegments !== undefined) return options.commandSegments ?? [];
  const command = extractShellCommand(options.event);
  if (command === null) return [];
  return segmentViewOf(command) ?? [];
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
    const contexts: AttributedContext[] = usesPerRepoBuiltins(policy)
      ? resolveAttributedContexts(
          policy,
          (segmentsForAttribution ??= resolveCommandSegments(options)),
          options.builtins,
          options.currentHeadSha,
          resolveGitContextMemo,
        )
      : [{ builtins: options.builtins, currentHeadSha: options.currentHeadSha }];

    for (const context of contexts) {
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
    if (blockingPolicy?.ux) {
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
