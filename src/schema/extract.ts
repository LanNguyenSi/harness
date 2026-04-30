import { z } from "zod";
import {
  ExtractGrammarError,
  validateExtractGrammar,
} from "../policies/extract.js";

export const ExtractExpressionSchema = z.string().min(1).superRefine((v, ctx) => {
  try {
    validateExtractGrammar(v);
  } catch (err) {
    if (err instanceof ExtractGrammarError) {
      // Strip the leading `extract expression "<expr>": ` prefix so the
      // message reads naturally next to the zod path. The path already
      // points at the offending field.
      const msg = err.message.replace(/^extract expression "[^"]*": /, "");
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
      return;
    }
    throw err;
  }
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
