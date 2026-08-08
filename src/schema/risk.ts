import { z } from "zod";

// Risk Gate vocabulary — Phase 7 #1 anchor.
//
// STATUS: LIVE (corrected 2026-07-02, task 50a94127; this header
// previously still said "no runtime surface reads it yet" long after
// that stopped being true). `risk.classifiers[]` is consumed by the
// Risk Classifier (`classifyRisk`, runtime/risk-classifier.ts) invoked
// from runtime/intercept.ts on every PreToolUse once the manifest
// declares at least one `when:`-bearing policy (the riskGateActive
// guard), and policies consume the classification through `when.risk.*`
// clauses evaluated in runtime/when-eval.ts (Phase 7 #5). A declared
// `risk:` block is enforced configuration, not decoration. See
// docs/risk-gate.md.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md.

// Severity is an ordered scale: a future `when.risk.severity_at_least:
// high` clause matches `high` and `critical`. The ordering is the enum
// declaration order — the Phase 7 #5 evaluator derives the comparison
// from `RiskSeveritySchema.options`. This anchor only fixes the set.
export const RiskSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

// Closed category vocabulary. Phase 7 #1 deliberately ships a fixed set
// rather than a free-form string: a typo (`data-loss` for `data_loss`)
// is then a validate-time error instead of a clause that silently never
// matches, and `when.risk.category_in` stays statically checkable. New
// categories are a schema addition, not operator config — see
// docs/risk-gate.md for the rationale and the v2 escape hatch.
export const RiskCategorySchema = z.enum([
  "destructive",
  "data_loss",
  "production_mutation",
  "credential_access",
  "secret_exfiltration",
  "network_exfiltration",
  "deployment_change",
  "infrastructure_change",
  "privilege_escalation",
  "irreversible_action",
  "mass_update",
]);

// One pattern → (categories, severity) assignment. `pattern` is a
// regular expression matched against the classified tool's raw input
// (the exact field and match semantics are the Phase 7 #3 classifier's
// concern; the anchor only stores and regex-validates the string).
const RiskPatternSchema = z
  .object({
    pattern: z.string().min(1),
    categories: z.array(RiskCategorySchema).min(1),
    severity: RiskSeveritySchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    try {
      new RegExp(rule.pattern);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: `invalid regex: ${(err as Error).message}`,
      });
    }
  });

export const RiskClassifierSchema = z
  .object({
    name: z.string().min(1),
    // The tool name whose input the classifier's patterns run against
    // (e.g. `Bash`). The matcher that binds a classifier to a live tool
    // event is Phase 7 #3; the anchor only records the binding.
    tool: z.string().min(1),
    patterns: z.array(RiskPatternSchema).min(1),
  })
  .strict();

// Fail posture of block/require_approval policies when their evidence
// source is DEGRADED (ledger timeout, spawn failure, unresolved template,
// invalid `within`, thrown evaluator) — i.e. the evaluator could not form
// a real verdict at all (task f1aea826).
//
//   preserve_enforcement (default) — a policy whose enforcement is
//     `block` or `require_approval` fails CLOSED (`deny-degraded`): the
//     gate exists to prevent a specific irreversible incident, so "could
//     not read the evidence" must not open it. `warn` policies keep the
//     availability-first `warn-degraded` (never blocks).
//   fail_open — the pre-0.45 behaviour: EVERY degraded evaluation maps
//     to the non-blocking `warn-degraded`, regardless of enforcement.
//     Explicit operator opt-out for availability-first setups.
//
// This knob covers only the policy engine's own degraded paths. The
// OUTER hook-budget layer (a hook that exceeds its budget is allow by
// harness contract) is a separate fail-open surface this schema cannot
// reach — see docs/okf/gate-fail-posture-matrix.md.
export const DegradedFailPostureSchema = z.enum([
  "preserve_enforcement",
  "fail_open",
]);

export const RiskSchema = z
  .object({
    classifiers: z.array(RiskClassifierSchema).default([]),
    degraded_fail_posture: DegradedFailPostureSchema.default(
      "preserve_enforcement",
    ),
  })
  .strict()
  .superRefine((risk, ctx) => {
    const seen = new Set<string>();
    risk.classifiers.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["classifiers", i, "name"],
          message: `duplicate risk classifier name: ${c.name}`,
        });
      }
      seen.add(c.name);
    });
  });

export type DegradedFailPosture = z.infer<typeof DegradedFailPostureSchema>;
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;
export type RiskCategory = z.infer<typeof RiskCategorySchema>;
export type RiskClassifier = z.infer<typeof RiskClassifierSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;
