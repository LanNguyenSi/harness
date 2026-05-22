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
// UNCLASSIFIED action satisfies every `risk.*` / `action.reversible`
// clause, so a risk-gating policy treats "we could not classify this"
// as risk-bearing rather than letting it slip the gate. A *classified*
// action is compared on its real values. `environment.name` needs no
// such rule: the resolver always returns a concrete environment, with
// `unknown` as the matchable no-resolver-fired case.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md
// (design phase D); the null-handling steer is the Phase 7 #3 review
// note on agent-tasks task harness-phase-7-5.

import type { PolicyWhen } from "../schema/index.js";
import { RiskSeveritySchema } from "../schema/index.js";
import type { EnvironmentResolution } from "./environment-resolver.js";
import type { RiskProfile } from "./risk-classifier.js";

// Ordered severity scale; an index is the comparison key for
// `severity_at_least`. Sourced from the schema enum so a reordering
// there flows through unchanged — same pattern as the Risk Classifier.
const SEVERITY_ORDER: readonly string[] = RiskSeveritySchema.options;

/** The enriched-envelope inputs a `when:` block is evaluated against. */
export interface WhenContext {
  risk: RiskProfile;
  environment: EnvironmentResolution;
}

/** The four `when:` clause keys, exactly as they appear in the manifest. */
export type WhenClauseKey =
  | "risk.severity_at_least"
  | "risk.category_in"
  | "environment.name"
  | "action.reversible";

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
  /** True when at least one clause matched only because the action was
   *  unclassified ("unknown is not safe"). Surfaced so `explain-policy`
   *  can tell an operator a match was fail-closed, not a real hit. */
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
 * false`) satisfies the three risk-derived clauses by the "unknown is
 * not safe" rule; `environment.name` is always a plain equality test.
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
      // severity is null — treat as risk-bearing: satisfies any threshold.
      matched = true;
      actual = "null (unclassified)";
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

  return {
    matched: clauses.every((c) => c.matched),
    clauses,
    unclassifiedFallback,
  };
}
