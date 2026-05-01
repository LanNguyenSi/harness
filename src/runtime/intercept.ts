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
import type { Manifest, Policy } from "../schema/index.js";
import { resolveSessionId } from "./session-id.js";

export interface ToolEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

export type PolicyOutcome = "allow" | "deny" | "warn-degraded";

export interface PolicyDecision {
  policyName: string;
  enforcement: "block" | "warn";
  outcome: PolicyOutcome;
  reason: string;
  extractValues: Record<string, string>;
  ledgerTag: string;
  requiresEval?: { matchedCount: number; reason: string };
  evaluatedAt: string;
}

export interface ClaudeDenyJson {
  decision: "deny";
  reason: string;
}

export interface InterceptResult {
  decisions: PolicyDecision[];
  /** non-null iff at least one matching policy with enforcement=block denied. */
  blockJson: ClaudeDenyJson | null;
}

export interface LedgerClient {
  query(tag: string, sessionId: string, timeoutMs?: number): Promise<LedgerQueryResult>;
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
}

function policyMatchesEvent(policy: Policy, event: ToolEvent): boolean {
  if (policy.trigger.event !== event.hook_event_name) return false;
  if (policy.trigger.match !== undefined) {
    if (typeof event.tool_name !== "string") return false;
    if (!event.tool_name.includes(policy.trigger.match)) return false;
  }
  if (policy.trigger.bash_match !== undefined) {
    const args = event.tool_input as { command?: unknown } | undefined;
    if (!args || typeof args.command !== "string") return false;
    let re: RegExp;
    try {
      re = new RegExp(policy.trigger.bash_match);
    } catch {
      return false;
    }
    if (!re.test(args.command)) return false;
  }
  return true;
}

function buildEventContext(event: ToolEvent): ExtractEventContext {
  return {
    toolArgs: event.tool_input,
    event,
    session: { id: event.session_id ?? "" },
    git: {},
  };
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

  const evalOpts: EvaluateRequiresOptions = options.now ? { now: options.now } : {};
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

  const outcome: PolicyOutcome = evaluation.allowed ? "allow" : "deny";
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
    evaluatedAt,
  };
}

function filterEntriesByTag(entries: LedgerEntry[], tag: string): LedgerEntry[] {
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
      e.type !== "policy_decision" &&
      (e.content.includes(tag) || (e.source !== undefined && e.source.includes(tag))),
  );
}

export async function intercept(
  options: InterceptOptions,
): Promise<InterceptResult> {
  const matching = options.manifest.policies.filter((p) =>
    policyMatchesEvent(p, options.event),
  );
  const decisions: PolicyDecision[] = [];
  for (const policy of matching) {
    const decision = await evaluateOnePolicy(policy, options);
    decisions.push(decision);
    try {
      await options.ledger.record(decision, resolveSessionId(options.event.session_id));
    } catch {
      /* audit-write failure must not block; the decision is still applied. */
    }
  }

  const blocking = decisions.find(
    (d) => d.enforcement === "block" && d.outcome === "deny",
  );
  if (blocking) {
    return {
      decisions,
      blockJson: {
        decision: "deny",
        reason: `${blocking.policyName}: ${blocking.reason}`,
      },
    };
  }
  return { decisions, blockJson: null };
}
