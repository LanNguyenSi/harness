import { z } from "zod";

const EXTRACT_ROOT_RE = /^(toolArgs|event|session|git)(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

export const ExtractExpressionSchema = z
  .string()
  .min(1)
  .refine((v) => EXTRACT_ROOT_RE.test(v), {
    message:
      "extract expression must be a dotted accessor rooted at one of toolArgs / event / session / git, e.g. \"toolArgs.prNumber\"",
  });

export type ExtractExpression = z.infer<typeof ExtractExpressionSchema>;

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export const ExtractMapSchema = z
  .record(ExtractExpressionSchema)
  .refine(
    (m) => Object.keys(m).every((k) => VAR_NAME_RE.test(k)),
    { message: "extract variable names must be SCREAMING_SNAKE_CASE" },
  );

export type ExtractMap = z.infer<typeof ExtractMapSchema>;
