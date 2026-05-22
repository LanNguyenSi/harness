import { z } from "zod";

// Environment-resolution vocabulary — Phase 7 #1 anchor.
//
// STATUS: schema vocabulary only. `harness validate` parses and
// validates an `environments:` block, but no runtime surface reads it
// yet. The Context Resolver that consumes `environments.resolvers[]` to
// classify an Action Envelope as production / staging / dev / local /
// unknown lands in Phase 7 #4 (see docs/ROADMAP.md and
// docs/risk-gate.md). Until then an `environments:` block is inert,
// validated config.
//
// "Unknown is not safe": when no resolver matches, the resolved
// environment is `unknown`. Policy `when.environment.name` clauses are
// expected to treat `unknown` as approval-worthy, not allow-by-default.
// That enforcement semantic lives with the Phase 7 #4/#5 runtime; the
// anchor only fixes the config shape.
//
// Design source: lava-ice-logs/2026-04-30/harness-risk-gate-extension.md.

// The environment names a resolver may assert. `unknown` is the
// implicit fallback when nothing matches and is deliberately NOT in
// this set: a resolver that "asserts unknown" is a contradiction.
export const EnvironmentNameSchema = z.enum([
  "production",
  "staging",
  "dev",
  "local",
]);

// The environment names a policy `when.environment.name` clause may
// test. Identical to the resolver set plus `unknown`, so a policy can
// gate the no-resolver-matched case ("unknown is not safe").
export const MatchableEnvironmentSchema = z.enum([
  "production",
  "staging",
  "dev",
  "local",
  "unknown",
]);

// A signal that fires when a named environment variable's value
// contains any of the listed substrings. Substring, not regex — kept
// deliberately blunt for v1; see docs/risk-gate.md.
const EnvVarSignalSchema = z
  .object({
    var: z.string().min(1),
    patterns: z.array(z.string().min(1)).min(1),
  })
  .strict();

// The four signal kinds a resolver can combine. Every field is
// optional, but at least one must be present — a resolver with no
// signals can never fire and is a config error. Pattern match
// semantics (glob vs substring vs regex per kind) are defined by the
// Phase 7 #4 resolver runtime and documented in docs/risk-gate.md; the
// anchor stores them as plain non-empty strings.
const EnvironmentSignalsSchema = z
  .object({
    branch_patterns: z.array(z.string().min(1)).min(1).optional(),
    env_var_patterns: z.array(EnvVarSignalSchema).min(1).optional(),
    kube_context_patterns: z.array(z.string().min(1)).min(1).optional(),
    kube_namespace_patterns: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((signals, ctx) => {
    const hasSignal =
      signals.branch_patterns !== undefined ||
      signals.env_var_patterns !== undefined ||
      signals.kube_context_patterns !== undefined ||
      signals.kube_namespace_patterns !== undefined;
    if (!hasSignal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          "resolver signals must declare at least one of: branch_patterns, env_var_patterns, kube_context_patterns, kube_namespace_patterns",
      });
    }
  });

export const EnvironmentResolverSchema = z
  .object({
    name: z.string().min(1),
    // The environment this resolver asserts when any of its signals
    // match.
    environment: EnvironmentNameSchema,
    signals: EnvironmentSignalsSchema,
  })
  .strict();

export const EnvironmentsSchema = z
  .object({
    resolvers: z.array(EnvironmentResolverSchema).default([]),
  })
  .strict()
  .superRefine((envs, ctx) => {
    const seen = new Set<string>();
    envs.resolvers.forEach((r, i) => {
      if (seen.has(r.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolvers", i, "name"],
          message: `duplicate environment resolver name: ${r.name}`,
        });
      }
      seen.add(r.name);
    });
  });

export type EnvironmentName = z.infer<typeof EnvironmentNameSchema>;
export type MatchableEnvironment = z.infer<typeof MatchableEnvironmentSchema>;
export type EnvironmentResolver = z.infer<typeof EnvironmentResolverSchema>;
export type EnvironmentsConfig = z.infer<typeof EnvironmentsSchema>;
