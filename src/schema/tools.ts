import { z } from "zod";

const CommandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const McpHealthSchema = z
  .object({
    verb: z.string().min(1),
    timeout_ms: z.number().int().positive().default(5000),
  })
  .strict();

export const McpServerSchema = z
  .object({
    name: z.string().min(1),
    command: CommandSchema,
    env: z.record(z.string()).optional(),
    health: McpHealthSchema.optional(),
    enabled: z.boolean().default(true),
    min_version: z.string().min(1).optional(),
    version_command: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const CliToolSchema = z
  .object({
    name: z.string().min(1),
    binary: z.string().min(1),
    min_version: z.string().min(1).optional(),
    version_command: z.array(z.string().min(1)).min(1).optional(),
    required: z.boolean().default(false),
  })
  .strict();

export const SkillsSchema = z
  .object({
    enabled: z.array(z.string().min(1)).default([]),
    required: z.array(z.string().min(1)).optional(),
    source_dirs: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine(
    (s) => !s.required || s.required.every((r) => s.enabled.includes(r)),
    { message: "tools.skills.required must be a subset of tools.skills.enabled" },
  );

export const BuiltinSchema = z
  .object({
    known: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const ToolsSchema = z
  .object({
    mcp: z.array(McpServerSchema).default([]),
    cli: z.array(CliToolSchema).default([]),
    skills: SkillsSchema.default({}),
    builtin: BuiltinSchema.default({}),
  })
  .strict()
  .superRefine((t, ctx) => {
    for (const list of [
      { key: "mcp", entries: t.mcp },
      { key: "cli", entries: t.cli },
    ] as const) {
      const seen = new Set<string>();
      list.entries.forEach((e, i) => {
        if (seen.has(e.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [list.key, i, "name"],
            message: `duplicate ${list.key} entry name: ${e.name}`,
          });
        }
        seen.add(e.name);
      });
    }
  });

export type Tools = z.infer<typeof ToolsSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type CliTool = z.infer<typeof CliToolSchema>;
export type Skills = z.infer<typeof SkillsSchema>;
