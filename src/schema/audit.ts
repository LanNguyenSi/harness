import { z } from "zod";

const RegexRedactRuleSchema = z
  .object({
    regex: z.string().min(1),
    replacement: z.string().default("<REDACTED>"),
  })
  .strict()
  .superRefine((rule, ctx) => {
    try {
      new RegExp(rule.regex);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regex"],
        message: `invalid regex: ${(err as Error).message}`,
      });
    }
  });

const EnvVarRedactRuleSchema = z
  .object({
    env_var: z.string().min(1),
    replacement: z.string().default("<REDACTED>"),
  })
  .strict();

export const RedactRuleSchema = z.union([RegexRedactRuleSchema, EnvVarRedactRuleSchema]);

export const AuditSchema = z
  .object({
    redact: z.array(RedactRuleSchema).default([]),
  })
  .strict();

export type RedactRule = z.infer<typeof RedactRuleSchema>;
export type AuditConfig = z.infer<typeof AuditSchema>;
