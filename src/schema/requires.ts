import { z } from "zod";
import {
  InvalidDurationError,
  parseDurationSeconds,
} from "../io/duration.js";

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
    /**
     * When true, a tag-matching ledger entry whose `head:<sha>` token
     * equals the runtime-resolved current HEAD sha satisfies the gate
     * regardless of `within`. Falls through to the time-window check
     * when no entry head-matches (entry predates the head shift,
     * operator switched branches, producer ran on a different HEAD,
     * runtime could not resolve the current HEAD). The producer must
     * emit `head:<sha>` into the entry content for this to bite; the
     * standard `harness session-start preflight` producer does so as
     * of the `at_head` rollout. Designed for `preflight-before-push`
     * to eliminate per-commit re-preflight churn while keeping the
     * time-window as a freshness ceiling for the head-mismatch case.
     */
    at_head: z.boolean().optional(),
  })
  .strict();

export type Requires = z.infer<typeof RequiresSchema>;

// The five built-ins ship resolved by the runtime, so policies may
// reference them in `requires.ledger_tag` without declaring a matching
// `trigger.extract` entry. The schema check in `PolicySchema.superRefine`
// skips them via `isBuiltinVariable`.
//
// Resolution sources (all live as of Phase 5, see ARCHITECTURE §6):
//   - SESSION_ID — `src/runtime/session-id.ts:resolveSessionId`, fed from
//     the hook event's `session_id` or `$CLAUDE_SESSION_ID`. End-to-end
//     coverage in `tests/runtime/intercept.test.ts` (the `dogfood:${SESSION_ID}`
//     fixture).
//   - REPO / BRANCH / CWD — populated by the runtime from git + process state
//     before `evaluateExtract` runs (`src/io/extract.ts:ExtractBuiltins`).
//   - TOOL_NAME — taken from the hook event payload.
//
// Adding a new variable here is a spec change: update ARCHITECTURE §6, wire
// the runtime source, and add `isBuiltinVariable` test coverage in the same
// PR.
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
