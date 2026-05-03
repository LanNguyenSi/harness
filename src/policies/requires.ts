import type { Requires } from "../schema/requires.js";
import { POLICY_DECISION_TYPE } from "../runtime/ledger-record.js";
import { InvalidDurationError, parseDurationSeconds } from "./duration.js";
import { parseLedgerTimestamp } from "./timestamp.js";

export interface LedgerEntry {
  id: string;
  content: string;
  source?: string;
  createdAt: string | Date;
  /**
   * Phase 5 #4 — the wire bucket the entry came from. `flattenSummary`
   * populates this from the `entries.<bucket>` key in the ledger_summary
   * payload, mapping bucket names back to evidence-ledger types
   * (`facts` → `fact`, `policyDecisions` → `policy_decision`, etc.).
   *
   * The requires evaluator uses this to skip `policy_decision` rows so
   * past audit-log entries don't substring-match the tag they're about
   * (the substring-pollution bug from PR #39's dogfood).
   */
  type?: string;
}

export interface RequiresEvaluation {
  allowed: boolean;
  reason: string;
  matchedCount: number;
  traceData: RequiresTrace;
}

export interface RequiresTrace {
  ledgerTag: string;
  windowSeconds: number | null;
  totalEntries: number;
  matchedEntryIds: string[];
  countBound: { min?: number; max?: number; exact?: number } | null;
  evaluatedAt: string;
}

export interface EvaluateRequiresOptions {
  /** Override "now" for deterministic testing. */
  now?: Date;
}

export class RequiresEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequiresEvaluationError";
  }
}

// Matches against `content` and `source` per ARCHITECTURE.md §6
// ("substring/regex match against ledger entries' content/source columns").
// v1 is substring-only; regex is a v2 deferral.
function entryMatches(entry: LedgerEntry, tag: string): boolean {
  // Phase 5 #4 — `policy_decision` rows are audit records, not
  // evidence. Their serialised payload incidentally contains the tag
  // they're about ("ledgerTag":"review:42"), which under the old
  // substring filter inflated matchedCount on the same tag the
  // decision was about. Skip them at the matcher.
  if (entry.type === POLICY_DECISION_TYPE) return false;
  // Legacy backstop: pre-Phase-5-#4 audit rows were written with
  // type='fact' + a `policy_decision:` content prefix. They land in
  // the `facts` bucket and would otherwise sneak past the type guard.
  // The content-prefix check is exact and cheap, so a user upgrading
  // harness without flushing their dev ledger doesn't keep paying the
  // pollution tax until the rows age out.
  if (entry.content.startsWith("policy_decision:")) return false;
  if (entry.content.includes(tag)) return true;
  if (entry.source && entry.source.includes(tag)) return true;
  return false;
}

function entryTime(entry: LedgerEntry): number {
  const v = entry.createdAt;
  const ms = v instanceof Date ? v.getTime() : parseLedgerTimestamp(v);
  if (Number.isNaN(ms)) {
    throw new RequiresEvaluationError(
      `ledger entry ${entry.id} has unparseable createdAt: ${String(v)}`,
    );
  }
  return ms;
}

function describeBound(c: NonNullable<Requires["count"]>): string {
  if (c.exact !== undefined) return String(c.exact);
  if (c.min !== undefined && c.max !== undefined) return `${c.min}..${c.max}`;
  if (c.min !== undefined) return String(c.min);
  if (c.max !== undefined) return `≤${c.max}`;
  return "?";
}

export function evaluateRequires(
  requires: Requires,
  ledgerEntries: LedgerEntry[],
  options: EvaluateRequiresOptions = {},
): RequiresEvaluation {
  const now = options.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const tag = requires.ledger_tag;

  let windowSeconds: number | null = null;
  if (requires.within !== undefined) {
    try {
      windowSeconds = parseDurationSeconds(requires.within);
    } catch (err) {
      if (err instanceof InvalidDurationError) {
        throw new RequiresEvaluationError(err.message);
      }
      throw err;
    }
  }

  if (requires.count?.min !== undefined && requires.count.min === 0) {
    throw new RequiresEvaluationError(
      "requires.count.min must be > 0 (count.min:0 is a no-op)",
    );
  }

  const tagMatched = ledgerEntries.filter((e) => entryMatches(e, tag));

  let windowMatched = tagMatched;
  if (windowSeconds !== null) {
    const cutoff = now.getTime() - windowSeconds * 1000;
    windowMatched = tagMatched.filter((e) => entryTime(e) >= cutoff);
  }

  const matchedCount = windowMatched.length;
  const matchedEntryIds = windowMatched.map((e) => e.id);
  const countBound = requires.count
    ? {
        ...(requires.count.min !== undefined && { min: requires.count.min }),
        ...(requires.count.max !== undefined && { max: requires.count.max }),
        ...(requires.count.exact !== undefined && { exact: requires.count.exact }),
      }
    : null;

  const trace: RequiresTrace = {
    ledgerTag: tag,
    windowSeconds,
    totalEntries: ledgerEntries.length,
    matchedEntryIds,
    countBound,
    evaluatedAt,
  };

  if (requires.count !== undefined) {
    const c = requires.count;
    const failsMin = c.min !== undefined && matchedCount < c.min;
    const failsMax = c.max !== undefined && matchedCount > c.max;
    const failsExact = c.exact !== undefined && matchedCount !== c.exact;
    if (failsMin || failsMax || failsExact) {
      let reason: string;
      if (failsMax) {
        reason = `${matchedCount} matching entries exceeds count.max ${c.max}`;
      } else {
        const required = failsExact ? c.exact! : c.min!;
        reason = `${matchedCount} of required ${required} entries found`;
      }
      return {
        allowed: false,
        reason,
        matchedCount,
        traceData: trace,
      };
    }
    return {
      allowed: true,
      reason: `${matchedCount} entries matched (count bound: ${describeBound(c)})`,
      matchedCount,
      traceData: trace,
    };
  }

  if (matchedCount === 0) {
    if (windowSeconds !== null && tagMatched.length > 0) {
      return {
        allowed: false,
        reason: `no matching entry within ${requires.within}`,
        matchedCount,
        traceData: trace,
      };
    }
    return {
      allowed: false,
      reason: `no matching ledger entry for tag \`${tag}\``,
      matchedCount,
      traceData: trace,
    };
  }

  return {
    allowed: true,
    reason: `${matchedCount} matching ledger entr${matchedCount === 1 ? "y" : "ies"} for tag \`${tag}\``,
    matchedCount,
    traceData: trace,
  };
}
