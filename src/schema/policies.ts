import { z } from "zod";
import { MatchableEnvironmentSchema } from "./environments.js";
import { ExtractMapSchema } from "./extract.js";
import { HookEventSchema } from "./hooks.js";
import { RequiresSchema, isBuiltinVariable, referencedVariables } from "./requires.js";
import { RiskCategorySchema, RiskSeveritySchema } from "./risk.js";

export const PolicyTriggerSchema = z
  .object({
    event: HookEventSchema,
    match: z.string().min(1).optional(),
    path_match: z.string().min(1).optional(),
    bash_match: z.string().min(1).optional(),
    extract: ExtractMapSchema.optional(),
  })
  .strict();

export const PolicyEnforcementSchema = z.enum(["block", "warn"]);

// `producers:` is the structured remediation hint the policy engine
// appends to the deny envelope. Each entry tells the agent ONE concrete
// way to produce the ledger evidence that would unblock the gate.
// Three kinds today:
//   bash — shell command the agent can run (gated by the Bash hook).
//   mcp  — MCP tool call (NOT gated by the Bash hook; the ungated
//          recovery path for lockout scenarios — see [[feedback_understanding_gate_lockout_recovery]]).
//   ask  — bare bash command the harness pre-tool-use hook escapes
//          via ask-path semantics (e.g. `harness approve understanding`).
//          Operator's "go" on the prompt IS the approval.
//
// At least one `mcp` producer is required when the field is set, so an
// agent that gets blocked by an unrelated gate (e.g. understanding-gate
// has Bash locked down entirely) still has an ungated recovery path
// (PR agent-tasks/3804b785).
export const ProducerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bash"),
      command: z.string().min(1),
      description: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mcp"),
      verb: z.string().min(1),
      example: z.string().min(1),
      description: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ask"),
      command: z.string().min(1),
      description: z.string().min(1),
    })
    .strict(),
]);

// `ux:` is the agent-facing translation of an engine-internal block.
//
// When a policy denies a tool call, the engine has two readers: the
// audit ledger (which wants every internal detail: tag, hint,
// matchedCount, session) and the agent (which only needs to know what
// it cannot do, what condition is missing, and which command satisfies
// it). The legacy deny envelope leaks engine vocabulary
// ("no matching ledger entry for tag preflight:harness") to both.
//
// `ux:`, when declared, replaces the agent-facing reason text with a
// structured, plain-language form: a `cannot` sentence, a `required:`
// list of human-readable preconditions, and a `run:` list of exact
// commands. The internal decision (PolicyDecision.reason, recordHint,
// matchedCount) is unchanged and still written to the audit ledger.
//
// All three fields are templates: `${VAR}` references resolve against
// the same extract.values map the ledger_tag was substituted with, so
// the rendered text reflects the exact context the agent just hit at
// block time.
// Builtins (SESSION_ID / REPO / BRANCH / TOOL_NAME / CWD) are
// available even when the policy declares no `trigger.extract` map.
export const PolicyUxSchema = z
  .object({
    cannot: z.string().min(1),
    required: z.array(z.string().min(1)).min(1),
    run: z.array(z.string().min(1)).min(1),
  })
  .strict();

// `when:` — Phase 7 #1 anchor. The risk/environment-aware match layer.
//
// STATUS: schema vocabulary only. `harness policy intercept` does NOT
// evaluate `when:` yet — a policy's `trigger:` remains the sole match
// surface at runtime. The Phase 7 #5 evaluator will AND a declared
// `when:` onto the trigger match, reading the enriched Action Envelope
// (see docs/ROADMAP.md and docs/risk-gate.md). A `when:` block today is
// parsed, validated, and otherwise inert.
//
// Each clause is optional and keyed by the envelope path it tests:
//   risk.severity_at_least — envelope risk severity at or above this
//                            rung of the ordered scale.
//   risk.category_in       — envelope risk carries any of these
//                            categories.
//   environment.name       — resolved environment equals this name
//                            (`unknown` is matchable: unknown is not
//                            safe).
//   action.reversible      — envelope action reversibility flag.
// An empty `when: {}` is rejected: it would be a silent no-op.
export const PolicyWhenSchema = z
  .object({
    "risk.severity_at_least": RiskSeveritySchema.optional(),
    "risk.category_in": z.array(RiskCategorySchema).min(1).optional(),
    "environment.name": MatchableEnvironmentSchema.optional(),
    "action.reversible": z.boolean().optional(),
  })
  .strict()
  .superRefine((when, ctx) => {
    if (Object.keys(when).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          "policy.when must declare at least one clause; an empty when: {} is a silent no-op",
      });
    }
  });

export const PolicySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    trigger: PolicyTriggerSchema,
    requires: RequiresSchema,
    hook: z.string().min(1),
    enforcement: PolicyEnforcementSchema,
    producers: z.array(ProducerSchema).min(1).optional(),
    ux: PolicyUxSchema.optional(),
    when: PolicyWhenSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const refs = referencedVariables(policy.requires.ledger_tag);
    const declared = new Set(Object.keys(policy.trigger.extract ?? {}));
    for (const v of refs) {
      if (isBuiltinVariable(v)) continue;
      if (!declared.has(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires", "ledger_tag"],
          message: `requires.ledger_tag references \${${v}} but no matching trigger.extract entry was declared`,
        });
      }
    }
    if (policy.producers !== undefined) {
      const hasMcp = policy.producers.some((p) => p.kind === "mcp");
      if (!hasMcp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["producers"],
          message:
            "at least one producer with kind:mcp is required so agents have an ungated recovery path when the Bash hook is locked down",
        });
      }
    }
  });

export const PoliciesSchema = z.array(PolicySchema).superRefine((policies, ctx) => {
  const seen = new Set<string>();
  policies.forEach((p, i) => {
    if (seen.has(p.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "name"],
        message: `duplicate policy name: ${p.name}`,
      });
    }
    seen.add(p.name);
  });
});

export type Policy = z.infer<typeof PolicySchema>;
export type Producer = z.infer<typeof ProducerSchema>;
export type PolicyUx = z.infer<typeof PolicyUxSchema>;
export type PolicyWhen = z.infer<typeof PolicyWhenSchema>;
