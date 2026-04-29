import { z } from "zod";

export const HookEventSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
]);

export const HookBlockingSchema = z.union([
  z.literal(false),
  z.literal("soft"),
  z.literal("hard"),
]);

export const HookSchema = z
  .object({
    name: z.string().min(1),
    event: HookEventSchema,
    command: z.string().min(1),
    match: z.string().min(1).optional(),
    path_match: z.string().min(1).optional(),
    bash_match: z.string().min(1).optional(),
    blocking: HookBlockingSchema,
    budget_ms: z.number().int().positive().default(30000),
    description: z.string().optional(),
  })
  .strict();

export const HooksSchema = z.array(HookSchema).superRefine((hooks, ctx) => {
  const seen = new Set<string>();
  hooks.forEach((h, i) => {
    if (seen.has(h.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "name"],
        message: `duplicate hook name: ${h.name}`,
      });
    }
    seen.add(h.name);
  });
});

export type Hook = z.infer<typeof HookSchema>;
