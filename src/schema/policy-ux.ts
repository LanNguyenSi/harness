import { z } from "zod";

// `ux:` is the agent-facing translation of a block, used by the builtin
// policy packs' `config.ux` (branch-protection). When declared, it replaces
// the agent-facing reason text with a structured, plain-language form: a
// `cannot` sentence, a `required:` list of human-readable preconditions, and
// a `run:` list of exact commands.
//
// All three fields are templates: `${VAR}` references are substituted by
// `substituteTemplate` (`src/runtime/agent-facing.ts`) from the values the
// caller supplies (the branch-protection hook passes `BRANCH`).
export const PolicyUxSchema = z
  .object({
    cannot: z.string().min(1),
    required: z.array(z.string().min(1)).min(1),
    run: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type PolicyUx = z.infer<typeof PolicyUxSchema>;
