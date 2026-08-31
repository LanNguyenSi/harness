import { z } from "zod";
import {
  ExtractGrammarError,
  parseExtractExpression,
  validateExtractGrammar,
} from "../io/extract.js";

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

// ---------------------------------------------------------------------------
// trigger.input_match (task 2699b476)
// ---------------------------------------------------------------------------
//
// Same expression grammar as `trigger.extract`, but restricted to the
// `toolArgs.` namespace: the predicate answers "did THIS tool call carry
// this argument value?", and `event` / `session` / `git` are not tool
// arguments. Rejecting the other three namespaces here (rather than
// silently never matching them at runtime) is what makes a typo like
// `event.autoMerge` a loud `harness validate` error instead of a gate
// that quietly never fires.
//
// This is the same layer `bash_match` and `path_match` are declared at
// (`PolicyTriggerSchema`), so every consumer that parses a manifest,
// `harness validate`, `apply`, `doctor`, `loadManifest`, the intercept
// entrypoint, refuses the bad shape, not just the two report verbs.
export const ToolArgsExtractExpressionSchema = z
  .string()
  .min(1)
  .superRefine((v, ctx) => {
    let parsed;
    try {
      parsed = parseExtractExpression(v);
    } catch (err) {
      if (err instanceof ExtractGrammarError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err.message.replace(/^extract expression "[^"]*": /, ""),
        });
        return;
      }
      throw err;
    }
    if (parsed.namespace !== "toolArgs") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `input_match keys must read from the toolArgs namespace ` +
          `(the tool call's own arguments); "${v}" reads from ${parsed.namespace}`,
      });
    }
  });

export const InputMatchLiteralSchema = z.union([z.string(), z.number(), z.boolean()]);

export const InputMatchMapSchema = z
  .record(InputMatchLiteralSchema)
  .superRefine((map, ctx) => {
    const keys = Object.keys(map);
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger.input_match must declare at least one entry; an empty map is a silent no-op",
      });
      return;
    }
    for (const key of keys) {
      const result = ToolArgsExtractExpressionSchema.safeParse(key);
      if (result.success) continue;
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: issue.message });
      }
    }
  });

export type InputMatchMap = z.infer<typeof InputMatchMapSchema>;
