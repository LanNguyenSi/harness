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

// Safe-deletion-root allowlist (task d03af8f6). `src/runtime/
// deletion-target-resolve.ts` statically resolves the target(s) of a
// deletion-verb command (`rm -r*`/`-f*`, `find ... -delete`, `git clean
// -f*`) and treats a target as safe only when it is an ABSOLUTE path
// that lies inside one of these roots (a plain directory-prefix match:
// the target equals the root, or starts with `root + "/"`; an optional
// trailing `/**` or `/*` on an entry is stripped as documentation sugar
// before matching — it is not a real glob engine). A target the
// resolver cannot statically prove absolute and prefix-matched — an
// unexpanded `$VAR`/`${VAR}` reference, a `~`-relative path, a relative
// path, or a `..`-traversal that normalizes outside every root — is
// treated as UNRESOLVABLE, never guessed safe. The defaults cover the
// two spellings this harness's own scratchpad convention can use: a
// symlinked `/tmp` and its `/private/tmp` realpath (macOS); an operator
// who overrides this list REPLACES it, it does not merge with the
// default. See docs/risk-gate.md.
// Exported (not just used as the schema `.default()`) so runtime call
// sites can fall back to the same list for a hand-built `Manifest` that
// bypassed schema parsing entirely (every test fixture that constructs
// `{ risk: { classifiers: [...] } }` directly, without going through
// `RiskSchema.parse`) — see `src/runtime/intercept.ts` and
// `src/cli/explain-policy.ts`.
export const DEFAULT_SAFE_DELETION_ROOTS: string[] = ["/tmp", "/private/tmp"];

export const RiskSchema = z
  .object({
    classifiers: z.array(RiskClassifierSchema).default([]),
    degraded_fail_posture: DegradedFailPostureSchema.default(
      "preserve_enforcement",
    ),
    safe_deletion_roots: z
      .array(z.string().min(1))
      .default(DEFAULT_SAFE_DELETION_ROOTS),
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
    // A bare filesystem-root entry (task d03af8f6, review round 2, LOW
    // (a)) would match every absolute path as "inside" it via the
    // resolver's own `target.startsWith(root + "/")` prefix check —
    // silently defeating the entire point of an allowlist. Rejected at
    // parse time with a message rather than special-cased to "matches
    // everything" at runtime, since an operator who wrote "/" almost
    // certainly meant a specific subdirectory. Non-absolute entries and
    // ones containing `$`/`~` are a `harness validate` LINT instead (a
    // warning, not a parse-time error) — see
    // `checkSafeDeletionRootsSyntax` in `src/cli/validate/checks.ts`.
    risk.safe_deletion_roots.forEach((root, i) => {
      if (/^\/+$/.test(root.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["safe_deletion_roots", i],
          message:
            `risk.safe_deletion_roots entry "${root}" is the filesystem root itself: every ` +
            `absolute deletion target would match it as "inside," defeating the allowlist. ` +
            `Declare specific subdirectories instead (e.g. "/tmp").`,
        });
      }
    });
  });

export type DegradedFailPosture = z.infer<typeof DegradedFailPostureSchema>;
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;
export type RiskCategory = z.infer<typeof RiskCategorySchema>;
export type RiskClassifier = z.infer<typeof RiskClassifierSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;
