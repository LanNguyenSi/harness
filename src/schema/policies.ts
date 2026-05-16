import { z } from "zod";
import { ExtractMapSchema } from "./extract.js";
import { HookEventSchema } from "./hooks.js";
import { RequiresSchema, isBuiltinVariable, referencedVariables } from "./requires.js";

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

export const PolicySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    trigger: PolicyTriggerSchema,
    requires: RequiresSchema,
    hook: z.string().min(1),
    enforcement: PolicyEnforcementSchema,
    producers: z.array(ProducerSchema).min(1).optional(),
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
