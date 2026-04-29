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

export const PolicySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    trigger: PolicyTriggerSchema,
    requires: RequiresSchema,
    hook: z.string().min(1),
    enforcement: PolicyEnforcementSchema,
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
