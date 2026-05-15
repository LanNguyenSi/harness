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
    // Optional `min_version` runs `version_command` via `harness doctor` and
    // emits a `warn` line when the parsed version is below this floor. Both
    // fields must be present together: hook commands are arbitrary shell
    // strings (e.g. `harness session-start preflight`,
    // `~/.claude/hooks/foo.sh`), so there is no useful default for
    // `version_command` and a min_version-without-command is treated as a
    // config error.
    min_version: z.string().min(1).optional(),
    version_command: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(
    (h) => h.min_version === undefined || h.version_command !== undefined,
    {
      message: "hooks[].min_version requires hooks[].version_command",
      path: ["version_command"],
    },
  );

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
