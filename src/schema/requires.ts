import { z } from "zod";
import {
  InvalidDurationError,
  parseDurationSeconds,
} from "../policies/duration.js";

export const DurationSchema = z.string().min(1).superRefine((v, ctx) => {
  try {
    parseDurationSeconds(v);
  } catch (err) {
    if (err instanceof InvalidDurationError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
      return;
    }
    throw err;
  }
});

export const CountSchema = z
  .object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
    exact: z.number().int().positive().optional(),
  })
  .strict()
  .refine((c) => c.min !== undefined || c.max !== undefined || c.exact !== undefined, {
    message: "count must declare at least one of min, max, exact",
  })
  .refine(
    (c) => !(c.exact !== undefined && (c.min !== undefined || c.max !== undefined)),
    { message: "count.exact may not coexist with min or max" },
  )
  .refine(
    (c) => c.min === undefined || c.max === undefined || c.min <= c.max,
    { message: "count.min must be <= count.max" },
  )
  .refine((c) => c.min !== 0, {
    message: "count.min: 0 is a no-op; remove the field or use a different policy",
    path: ["min"],
  });

export const RequiresSchema = z
  .object({
    ledger_tag: z.string().min(1),
    within: DurationSchema.optional(),
    count: CountSchema.optional(),
  })
  .strict();

export type Requires = z.infer<typeof RequiresSchema>;

const BUILTIN_VARIABLES = new Set([
  "SESSION_ID",
  "REPO",
  "BRANCH",
  "TOOL_NAME",
  "CWD",
]);

const VAR_REF_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export function referencedVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_REF_RE)) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen];
}

export function isBuiltinVariable(name: string): boolean {
  return BUILTIN_VARIABLES.has(name);
}
