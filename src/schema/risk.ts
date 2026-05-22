import { z } from "zod";

// Risk Gate vocabulary — Phase 7 #1 anchor.
//
// STATUS: schema vocabulary only. `harness validate` parses and
// validates a `risk:` block, but no runtime surface reads it yet. The
// Risk Classifier that consumes `risk.classifiers[]` to assign an
// Action Envelope a severity + categories lands in Phase 7 #3 (see
// docs/ROADMAP.md and docs/risk-gate.md). Until then a `risk:` block is
// inert, validated config.
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

export const RiskSchema = z
  .object({
    classifiers: z.array(RiskClassifierSchema).default([]),
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

export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;
export type RiskCategory = z.infer<typeof RiskCategorySchema>;
export type RiskClassifier = z.infer<typeof RiskClassifierSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;
