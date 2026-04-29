import { z } from "zod";

const SHORTHAND_DURATION_RE = /^[0-9]+(?:s|m|h|d)$/;
const ISO_DURATION_RE = /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

export const DurationSchema = z
  .string()
  .min(1)
  .refine((v) => SHORTHAND_DURATION_RE.test(v) || ISO_DURATION_RE.test(v), {
    message:
      "duration must be a shorthand like \"24h\" / \"30m\" / \"7d\" / \"60s\" or an ISO-8601 duration like \"PT1H\" / \"P1D\"",
  });

export const CountSchema = z
  .object({
    min: z.number().int().positive().optional(),
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
  );

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
