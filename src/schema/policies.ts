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

// How a policy acts when its `requires:` evidence is absent:
//   block            — deny the tool call.
//   warn             — let the call proceed, record + surface a warning.
//   require_approval  — Phase 7 #5. The evaluator returns a first-class
//                       `require_approval` outcome, distinct from `deny`
//                       and `warn`; Phase 7 #6 makes it actually block
//                       until matching approval evidence exists in the
//                       ledger. A `block` / `warn` policy is unchanged.
export const PolicyEnforcementSchema = z.enum([
  "block",
  "warn",
  "require_approval",
]);

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

// `when:` — the risk/environment-aware match layer.
//
// STATUS: live as of Phase 7 #5. `harness policy intercept` ANDs a
// declared `when:` onto the policy's `trigger:` match, evaluating it
// against the Action Envelope enriched by the Risk Classifier (#3) and
// Context Resolver (#4). A policy with no `when:` matches on `trigger:`
// alone, exactly as in Phase 4. See src/runtime/when-eval.ts for the
// evaluator and docs/risk-gate.md for the clause semantics.
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
//   action.deletion_target_unresolvable — a deletion-verb command (`rm
//                            -r*`/`-f*`, `find ... -delete`, `git clean
//                            -f*`) whose target(s) could not be
//                            statically proven inside a declared
//                            `risk.safe_deletion_roots` entry. UNLIKE the
//                            four clauses above, this one is NEVER
//                            subject to the "unknown is not safe"
//                            fail-close: an action the deletion resolver
//                            does not recognize as a deletion verb at
//                            all does not satisfy this clause, so a
//                            policy gated purely on it does not need an
//                            `environment.name` scope to avoid firing on
//                            every unrelated unclassified command — see
//                            src/runtime/when-eval.ts and
//                            src/runtime/deletion-target-resolve.ts.
// An empty `when: {}` is rejected: it would be a silent no-op.
export const PolicyWhenSchema = z
  .object({
    "risk.severity_at_least": RiskSeveritySchema.optional(),
    "risk.category_in": z.array(RiskCategorySchema).min(1).optional(),
    "environment.name": MatchableEnvironmentSchema.optional(),
    "action.reversible": z.boolean().optional(),
    "action.deletion_target_unresolvable": z.boolean().optional(),
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

// `operator_only: true` — the unconditional operator-only deny (task
// 2cc73f55). Every other `block` policy names `requires.ledger_tag`
// evidence, but the only satisfaction primitives the engine has —
// a ledger tag (writable in-session via
// `mcp__grounding-mcp__ledger_add`) or a filesystem marker (operator-
// only only while a gate already locks Bash/Write down, circular on a
// default install) — are agent-satisfiable. That leaves no honest way to
// express "the agent may NEVER do this, and cannot self-satisfy it this
// session" — see the three `deny-*` kill-switch policies in
// `src/cli/init/templates.ts`, which had to ship with permanent
// self-attestation warnings for exactly this reason.
//
// `operator_only: true` closes that gap by omission rather than by
// naming a fake evidence source: the policy declares NO `requires:` at
// all, and `intercept()` (`src/runtime/intercept.ts`) short-circuits
// before the `requires` pipeline entirely — no ledger query, no
// template substitution, no `evaluateRequires` call — so there is
// nothing an in-session actor (ledger write, marker file, env flag) can
// ever produce that flips the outcome to allow. Restricted to
// `enforcement: block`: `warn` and `require_approval` already have
// their own always-evaluated evidence paths, and require_approval's
// canonical unblock is the `harness approve risk` operator verb, not a
// requires-satisfaction story this marker would replace.
//
// Mutually exclusive with `requires:` AND `producers:` by construction
// (both enforced below): declaring `requires:` alongside it would be
// self-contradictory — an unconditional deny that also names an
// in-session-satisfiable evidence tag nobody will ever evaluate.
// `producers:` is the same class of contradiction one level up: it
// describes a documented way to PRODUCE the evidence that unblocks the
// gate ("here is a legitimate way to satisfy this"), but `operator_only:
// true` never evaluates any evidence at all, so a declared producer
// would misrepresent the gate as satisfiable when it structurally is
// not. `checkPolicySelfAttestation` (`src/cli/validate/checks.ts`)
// treats `operator_only: true` as correct-by-construction and emits
// neither the "declares no producers" warning nor a --strict error for
// it, since there is no undocumented evidence source to flag.
export const PolicySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    trigger: PolicyTriggerSchema,
    requires: RequiresSchema.optional(),
    hook: z.string().min(1),
    enforcement: PolicyEnforcementSchema,
    operator_only: z.boolean().optional(),
    producers: z.array(ProducerSchema).min(1).optional(),
    ux: PolicyUxSchema.optional(),
    when: PolicyWhenSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.operator_only === true) {
      if (policy.enforcement !== "block") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operator_only"],
          message:
            "operator_only: true is only meaningful for enforcement: block (an unconditional operator-only deny); warn / require_approval already have their own always-evaluated evidence paths",
        });
      }
      if (policy.requires !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires"],
          message:
            "operator_only: true policies must not also declare requires: — an unconditional deny that also names in-session-satisfiable evidence is self-contradictory; drop requires: (the policy never evaluates it)",
        });
      }
      if (policy.producers !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["producers"],
          message:
            "operator_only: true policies must not also declare producers: — producers describe a documented way to satisfy the gate, but an unconditional deny never evaluates any evidence, so a declared producer would misrepresent it as satisfiable; drop producers: (or drop operator_only: true if you actually want a satisfiable requires: gate)",
        });
      }
    } else if (policy.requires === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requires"],
        message:
          "requires is mandatory unless the policy declares operator_only: true (an unconditional operator-only deny)",
      });
    }

    if (policy.requires !== undefined) {
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
