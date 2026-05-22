// Phase 4 #5 — runtime hook interceptor + policy_decision audit log.
//
// Pure orchestration: takes a parsed event + a ledger client + the manifest,
// runs every matching policy through the Phase 4 #1/#2/#3 pipeline, returns
// the decisions and the Claude Code deny-JSON (or null when all allow).
// Side effects (stdin, stdout, ledger I/O) live in the thin CLI entrypoint
// that wraps this.

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
  resolveEnvironment,
  type EnvironmentResolution,
} from "./environment-resolver.js";
import type { GitRepoContext } from "./git-context.js";
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
 */
export function policyMatchesEvent(policy: Policy, event: ToolEvent): boolean {
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
    if (!re.test(command)) return false;
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
  const missingExtracts = extract.traceData
    .filter((t) => t.source === "missing")
    .map((t) => t.var);
  const sub = substituteTemplate(policy.requires.ledger_tag, extract.values);
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
  if (policy.requires.within !== undefined) {
    try {
      parseDurationSeconds(policy.requires.within);
    } catch {
      return {
        policyName: policy.name,
        enforcement: policy.enforcement,
        outcome: "warn-degraded",
        reason: `invalid within: ${policy.requires.within}`,
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
      { ...policy.requires, ledger_tag: ledgerTag },
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
  const matching = manifest.policies.filter((p) => {
    if (!policyMatchesEvent(p, event)) return false;
    if (p.when === undefined) return true;
    // `enriched` is defined here: a policy with `when:` set `riskGateActive`.
    return evaluateWhen(p.when, enriched!).matched;
  });

  const decisions: PolicyDecision[] = [];
  for (const policy of matching) {
    const base = await evaluateOnePolicy(policy, options);
    // Attach the per-event Risk Gate verdicts so `harness audit` /
    // `explain --trace` can replay the classification + environment
    // that the `when:` match was made against.
    const decision: PolicyDecision = enriched
      ? { ...base, risk: enriched.risk, environment: enriched.environment }
      : base;
    decisions.push(decision);
    try {
      await options.ledger.record(
        decision,
        resolveSessionId(event.session_id),
      );
    } catch {
      /* audit-write failure must not block; the decision is still applied. */
    }
  }

  const blocking = decisions.find(
    (d) => d.enforcement === "block" && d.outcome === "deny",
  );
  if (blocking) {
    const sessionId = resolveSessionId(options.event.session_id);
    // Append the "to satisfy" hint so Claude Code's deny message tells
    // the operator (or the agent reading the same surface) what evidence
    // would unblock the gate, instead of just naming the missing tag.
    // The hint is content + window only; it does not prescribe a
    // recording verb so the deny path stays neutral on producer (see
    // agent-tasks/88ca4bb3 for why "use mcp__..." would be the wrong
    // suggestion when the engine is the source of that suggestion).
    const hintSuffix = blocking.recordHint
      ? ` To satisfy: ${blocking.recordHint} (session \`${sessionId}\`).`
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
      reasonText = renderAgentFacing(blockingPolicy.ux, {
        ...blocking.extractValues,
        SESSION_ID: sessionId,
      });
    } else {
      const producersBlock = renderProducers(
        blockingPolicy?.producers,
        blocking.extractValues,
      );
      reasonText = `${blocking.policyName}: ${blocking.reason}.${hintSuffix}${producersBlock}`;
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
