import type { Requires } from "../schema/requires.js";
import { POLICY_DECISION_TYPE } from "../io/ledger-record.js";
import { InvalidDurationError, parseDurationSeconds } from "../io/duration.js";
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
  /**
   * One-line "to satisfy" hint describing what evidence-ledger entry
   * would unblock the gate, derived from the policy's `requires` spec
   * with no runtime context. Names the content to log and (if a
   * `within` window is declared) the freshness bound. Always omits the
   * "how": the policy gate accepts ledger entries from any producer,
   * and naming a specific recording verb in the deny path would
   * advertise a self-service path to an agent that the operator may
   * not want it to take (see agent-tasks/88ca4bb3). Set on both allow
   * and deny so consumers can show the same satisfaction contract
   * uniformly (e.g. `harness explain <policy>` displaying it on a
   * green-path policy).
   */
  recordHint: string;
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
  /**
   * Current git HEAD sha (40 lowercase hex chars). Consulted only when
   * `requires.at_head === true`: an entry containing `head:<sha>`
   * equal to this value satisfies the gate regardless of `within`.
   * Pass `undefined` (or omit) on non-git events; the at_head branch
   * then falls through to the standard time-window check.
   */
  currentHeadSha?: string;
}

const HEAD_TOKEN_RE = /(?:^|\s)head:([0-9a-f]{40})(?:\s|$)/;

function entryHeadSha(entry: LedgerEntry): string | null {
  const match = HEAD_TOKEN_RE.exec(entry.content);
  return match ? match[1]! : null;
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
  if (entry.content.startsWith(`${POLICY_DECISION_TYPE}:`)) return false;
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

/**
 * Build a one-line "to satisfy" hint from a `requires` spec. Exported so
 * `harness explain <policy>` can show the same hint that `evaluateRequires`
 * surfaces in its deny path, without having to fire an actual evaluation.
 * `tag` is normally `requires.ledger_tag` after `${VAR}` substitution; the
 * caller may also pass the un-substituted template (explain non-trace path)
 * so the hint reads as a contract instead of a per-event message.
 */
export function buildRecordHint(requires: Requires, tag: string): string {
  const count = requires.count;
  // count.max-only is a "too many" shape: the satisfying action is not
  // recording but keeping the count at or below the bound. Recording
  // more entries would deny harder, so the "record N entries..."
  // phrasing the other shapes use is exactly wrong here. Branch to a
  // bound-phrased hint (agent-tasks/aee9c085).
  const onlyMax =
    count?.max !== undefined && count.min === undefined && count.exact === undefined;
  if (onlyMax) {
    const windowPhrase = requires.within !== undefined ? ` within ${requires.within}` : "";
    return `keep evidence-ledger entries containing \`${tag}\` at or below ${count.max}${windowPhrase}`;
  }
  let countPhrase: string;
  if (count?.exact !== undefined) {
    countPhrase = `${count.exact} evidence-ledger entr${count.exact === 1 ? "y" : "ies"}`;
  } else if (count?.min !== undefined) {
    countPhrase = `${count.min} evidence-ledger entr${count.min === 1 ? "y" : "ies"}`;
  } else {
    countPhrase = "an evidence-ledger entry";
  }
  const windowPhrase = requires.within !== undefined ? ` within ${requires.within}` : "";
  return `record ${countPhrase} containing \`${tag}\`${windowPhrase}`;
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

  // at_head bypass: when the policy opts in and the runtime resolved a
  // current HEAD, an entry whose `head:<sha>` token equals it satisfies
  // regardless of the time-window. Bypass returns the head-matched
  // subset as `windowMatched` so the rest of the evaluator (count
  // check, allowed/reason summary) flows unchanged; falls through to
  // the standard window check when there is no head match (entry
  // predates the head shift, operator switched branches, producer
  // ran on a different HEAD, runtime could not resolve a sha).
  let headMatched: LedgerEntry[] | null = null;
  if (
    requires.at_head === true &&
    typeof options.currentHeadSha === "string" &&
    options.currentHeadSha.length > 0
  ) {
    const current = options.currentHeadSha;
    headMatched = tagMatched.filter((e) => entryHeadSha(e) === current);
  }

  let windowMatched: LedgerEntry[];
  if (headMatched && headMatched.length > 0) {
    windowMatched = headMatched;
  } else if (windowSeconds !== null) {
    const cutoff = now.getTime() - windowSeconds * 1000;
    windowMatched = tagMatched.filter((e) => entryTime(e) >= cutoff);
  } else {
    windowMatched = tagMatched;
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
  const recordHint = buildRecordHint(requires, tag);

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
        recordHint,
      };
    }
    return {
      allowed: true,
      reason: `${matchedCount} entries matched (count bound: ${describeBound(c)})`,
      matchedCount,
      traceData: trace,
      recordHint,
    };
  }

  if (matchedCount === 0) {
    // at_head opt-in but no head match: name the drift explicitly so
    // the operator sees WHY a recent-looking preflight didn't satisfy.
    // Quotes the latest head: token from the tag-matched entries (the
    // last preflight ran on that sha) and the current sha for contrast.
    if (
      headMatched !== null &&
      typeof options.currentHeadSha === "string" &&
      options.currentHeadSha.length > 0 &&
      tagMatched.length > 0
    ) {
      const latestRecordedHead = entryHeadSha(tagMatched[tagMatched.length - 1]!);
      const current = options.currentHeadSha;
      const driftSuffix =
        latestRecordedHead !== null
          ? ` (HEAD drift: last preflight at ${latestRecordedHead.slice(0, 7)}, current ${current.slice(0, 7)})`
          : ` (HEAD drift: current ${current.slice(0, 7)} has no preflight)`;
      const base =
        windowSeconds !== null
          ? `no matching entry within ${requires.within}`
          : `no matching ledger entry for tag \`${tag}\``;
      return {
        allowed: false,
        reason: `${base}${driftSuffix}`,
        matchedCount,
        traceData: trace,
        recordHint,
      };
    }
    if (windowSeconds !== null && tagMatched.length > 0) {
      return {
        allowed: false,
        reason: `no matching entry within ${requires.within}`,
        matchedCount,
        traceData: trace,
        recordHint,
      };
    }
    return {
      allowed: false,
      reason: `no matching ledger entry for tag \`${tag}\``,
      matchedCount,
      traceData: trace,
      recordHint,
    };
  }

  const headSatisfied = headMatched !== null && headMatched.length > 0;
  const baseAllowReason = `${matchedCount} matching ledger entr${matchedCount === 1 ? "y" : "ies"} for tag \`${tag}\``;
  return {
    allowed: true,
    reason: headSatisfied
      ? `${baseAllowReason} (HEAD ${options.currentHeadSha!.slice(0, 7)})`
      : baseAllowReason,
    matchedCount,
    traceData: trace,
    recordHint,
  };
}
