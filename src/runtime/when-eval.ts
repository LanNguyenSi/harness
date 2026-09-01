// Phase 7 #5 — `policy.when:` evaluator.
//
// A policy's `trigger:` decides WHICH tool calls it inspects; its
// optional `when:` block decides whether — given the enriched Action
// Envelope — the policy actually applies to this particular call. The
// runtime ANDs the two: a policy fires only when `trigger:` AND every
// declared `when:` clause hold.
//
// Pure: the risk profile (#3) + environment resolution (#4) come in, a
// match verdict with a per-clause breakdown comes out, no I/O. The
// breakdown is what `harness explain-policy` renders.
//
// "Unknown is not safe" — the load-bearing decision in this module.
// The Risk Classifier emits `severity: null` / `reversible: null` /
// `categories: []` for an action no pattern matched (`classified:
// false`). A null does not silently fail to satisfy a clause: an
// UNCLASSIFIED action satisfies every `risk.category_in` /
// `action.reversible` clause, so a risk-gating policy treats "we could
// not classify this" as risk-bearing rather than letting it slip the
// gate. A *classified* action is compared on its real values.
// `environment.name` needs no such rule: the resolver always returns a
// concrete environment, with `unknown` as the matchable no-resolver-
// fired case.
//
// `risk.severity_at_least` is the ONE exception to a blanket "satisfies
// every threshold". An unknown severity is risk-bearing: it still
// satisfies `low`/`medium`/`high`, so an approval-required gate on an
// unrecognized production command stays fail-closed, but it is not
// itself proof of the WORST tier: an unclassified profile is treated as
// sitting at the "high" rung, one below `critical`, for this one clause
// only, so it never triggers a hard, agent-unoverridable block on its
// own. A hard block deserves a real classification.
//
// The rule is deliberately paired with two things this module does NOT
// do: (1) it does not touch `risk.category_in` / `action.reversible`,
// which keep the full "satisfies everything" fallback; (2) it leans on
// the Risk Classifier's built-in floors (`read-only-bash.ts`'s
// read-only floors, `destructive-shell-floor.ts`'s mutating-head floor)
// and the manifest's `risk.classifiers[]` to make the common cases
// explicitly `low` or explicitly `high`/`critical`. The "treated as
// high" rung is a safety net for the genuinely unenumerable case, not a
// replacement for classification. There is no manifest opt-in to restore
// the blanket behavior. Rationale, the incident that motivated it, and
// the disclosed residual gaps: docs/risk-gate.md, "Unclassified actions
// and the fail-close rule"; the measurement is in the CHANGELOG entry
// for agent-tasks task 2929c5b7.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md
// (design phase D); the null-handling steer is the Phase 7 #3 review
// note on agent-tasks task harness-phase-7-5.

import type { PolicyWhen } from "../schema/index.js";
import { RiskSeveritySchema } from "../schema/index.js";
import type { DeletionTargetVerdict } from "./deletion-target-resolve.js";
import type { EnvironmentResolution } from "./environment-resolver.js";
import type { RiskProfile } from "./risk-classifier.js";

// Ordered severity scale; an index is the comparison key for
// `severity_at_least`. Sourced from the schema enum so a reordering
// there flows through unchanged — same pattern as the Risk Classifier.
const SEVERITY_ORDER: readonly string[] = RiskSeveritySchema.options;

// The rung an UNCLASSIFIED action is treated as sitting at for
// `risk.severity_at_least` comparisons only (see the module header):
// one below the top of `SEVERITY_ORDER` ("critical"), i.e. "high" on
// the shipped four-value scale. Derived from the scale's length rather
// than a literal "high" so a future scale reordering/extension still
// lands one rung below the top without a second hand-edit.
//
// That derivation has a precondition the schema must keep satisfying: a
// scale with fewer than two rungs has no "one below the top". Asserted
// at module load rather than left implicit, because a silently negative
// index would make EVERY threshold comparison fail and quietly disable
// the fail-close for unclassified actions.
if (SEVERITY_ORDER.length < 2) {
  throw new Error(
    `when-eval: the severity scale must have at least two rungs for the ` +
      `unclassified fallback to sit one below the top (got ${SEVERITY_ORDER.length})`,
  );
}
const UNCLASSIFIED_FALLBACK_SEVERITY_INDEX = SEVERITY_ORDER.length - 2;

/**
 * The severity NAME the unclassified fallback is treated as, for
 * surfaces that have to say it out loud (`intercept.ts`'s deny
 * envelope). Exported so no caller hard-codes "high" beside a constant
 * that is derived.
 */
export const UNCLASSIFIED_FALLBACK_SEVERITY: string =
  SEVERITY_ORDER[UNCLASSIFIED_FALLBACK_SEVERITY_INDEX]!;

/** The enriched-envelope inputs a `when:` block is evaluated against. */
export interface WhenContext {
  risk: RiskProfile;
  environment: EnvironmentResolution;
  /**
   * Static deletion-target verdict for this action (task d03af8f6), or
   * `null`/omitted when the command was not recognized as a deletion
   * verb at all — see `deletion-target-resolve.ts`. Optional so every
   * caller/fixture that predates this arm keeps compiling and behaving
   * exactly as before (treated the same as `null`).
   */
  deletionTarget?: DeletionTargetVerdict | null;
}

/** The five `when:` clause keys, exactly as they appear in the manifest. */
export type WhenClauseKey =
  | "risk.severity_at_least"
  | "risk.category_in"
  | "environment.name"
  | "action.reversible"
  | "action.deletion_target_unresolvable";

/** One declared clause's verdict, carried for explainability. */
export interface WhenClauseResult {
  clause: WhenClauseKey;
  /** Human-readable expected value, as written in the manifest. */
  expected: string;
  /** Human-readable observed value, from the enriched envelope. */
  actual: string;
  matched: boolean;
}

export interface WhenEvaluation {
  /** AND of every declared clause. A `when:` with no clauses cannot be
   *  constructed (the schema rejects `when: {}`), so an evaluated
   *  `when:` always has at least one clause. */
  matched: boolean;
  /** One entry per DECLARED clause, in manifest-key order. */
  clauses: WhenClauseResult[];
  /** True when at least one clause's outcome was decided by the
   *  unclassified fallback rather than a real classification ("unknown
   *  is not safe" for `risk.category_in` / `action.reversible`, or the
   *  "treated as high" rung for `risk.severity_at_least`) — true
   *  whether that fallback made the clause match or fail. Surfaced so
   *  `explain-policy` can tell an operator a clause outcome was
   *  fail-closed, not a real hit. */
  unclassifiedFallback: boolean;
}

function severityIndex(severity: string): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/**
 * Evaluate a policy's `when:` block against the enriched envelope.
 *
 * Every clause is optional; only declared clauses are evaluated, and
 * `matched` is their AND. An unclassified risk profile (`classified:
 * false`) satisfies `risk.category_in` / `action.reversible` by the
 * "unknown is not safe" rule, and satisfies `risk.severity_at_least`
 * up through `high` but never `critical` (see the module header);
 * `environment.name` is always a plain equality test.
 */
export function evaluateWhen(
  when: PolicyWhen,
  ctx: WhenContext,
): WhenEvaluation {
  const clauses: WhenClauseResult[] = [];
  let unclassifiedFallback = false;
  const unclassified = !ctx.risk.classified;

  const sevAtLeast = when["risk.severity_at_least"];
  if (sevAtLeast !== undefined) {
    let matched: boolean;
    let actual: string;
    if (unclassified) {
      // severity is null — treated as risk-bearing at the "high" rung
      // (SEVERITY_ORDER.length - 2), not at "critical": satisfies
      // low/medium/high thresholds, but never critical on its own. See
      // the module header for why (task 2929c5b7).
      matched = UNCLASSIFIED_FALLBACK_SEVERITY_INDEX >= severityIndex(sevAtLeast);
      actual = "null (unclassified, treated as high)";
      unclassifiedFallback = true;
    } else {
      matched =
        severityIndex(ctx.risk.severity!) >= severityIndex(sevAtLeast);
      actual = ctx.risk.severity!;
    }
    clauses.push({
      clause: "risk.severity_at_least",
      expected: `>= ${sevAtLeast}`,
      actual,
      matched,
    });
  }

  const categoryIn = when["risk.category_in"];
  if (categoryIn !== undefined) {
    let matched: boolean;
    let actual: string;
    if (unclassified) {
      // categories is [] — treat as risk-bearing, consistent with the
      // severity clause: an unclassified action satisfies every risk
      // clause so a multi-clause `when:` cannot be slipped by one
      // clause matching null while another fails an empty set.
      matched = true;
      actual = "[] (unclassified)";
      unclassifiedFallback = true;
    } else {
      matched = categoryIn.some((c) => ctx.risk.categories.includes(c));
      actual =
        ctx.risk.categories.length > 0
          ? `[${ctx.risk.categories.join(", ")}]`
          : "[]";
    }
    clauses.push({
      clause: "risk.category_in",
      expected: `any of [${categoryIn.join(", ")}]`,
      actual,
      matched,
    });
  }

  const envName = when["environment.name"];
  if (envName !== undefined) {
    clauses.push({
      clause: "environment.name",
      expected: envName,
      actual: ctx.environment.name,
      matched: ctx.environment.name === envName,
    });
  }

  const reversible = when["action.reversible"];
  if (reversible !== undefined) {
    let matched: boolean;
    let actual: string;
    if (unclassified) {
      // reversible is null — reversibility unknown. "Unknown is not
      // safe": the clause matches whichever value the policy gates on,
      // so an unclassified action never escapes a reversibility gate.
      matched = true;
      actual = "null (unclassified)";
      unclassifiedFallback = true;
    } else {
      matched = ctx.risk.reversible === reversible;
      actual = String(ctx.risk.reversible);
    }
    clauses.push({
      clause: "action.reversible",
      expected: String(reversible),
      actual,
      matched,
    });
  }

  // `action.deletion_target_unresolvable` (task d03af8f6) is deliberately
  // NOT wired through the `unclassified` fail-close path above: it reads
  // an entirely separate signal (`ctx.deletionTarget`, from
  // `deletion-target-resolve.ts`), not the Risk Classifier's
  // `classified`/`severity`/`categories` triad. An action the deletion
  // resolver does not recognize as a deletion verb (`deletionTarget ===
  // null`) simply does not satisfy `true` here — it never falls back to
  // matched=true the way the four clauses above do for an unclassified
  // risk profile. This is what lets a policy gate purely on this clause,
  // environment-independently, without becoming a blanket gate on every
  // unrelated unclassified Bash call (see this module's header and
  // docs/risk-gate.md).
  const deletionUnresolvable = when["action.deletion_target_unresolvable"];
  if (deletionUnresolvable !== undefined) {
    const verdict = ctx.deletionTarget ?? null;
    const actualUnresolvable = verdict?.unresolvable ?? false;
    clauses.push({
      clause: "action.deletion_target_unresolvable",
      expected: String(deletionUnresolvable),
      actual:
        verdict === null
          ? "false (not a recognized deletion-verb command)"
          : String(actualUnresolvable),
      matched: actualUnresolvable === deletionUnresolvable,
    });
  }

  return {
    matched: clauses.every((c) => c.matched),
    clauses,
    unclassifiedFallback,
  };
}
