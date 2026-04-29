import { z } from "zod";

export const MemoryScopeSchema = z.enum(["project", "user"]);

export const MemoryDirectorySchema = z
  .object({
    path: z.string().min(1),
    scope: MemoryScopeSchema,
  })
  .strict();

export const MemoryRouterSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    enabled: z.boolean().default(true),
  })
  .strict();

export const MemoryRetentionSchema = z
  .object({
    staleness_days: z.number().int().positive().default(180),
    broken_refs: z.enum(["warn", "error", "ignore"]).default("warn"),
  })
  .strict();

export const MemoryScopesSchema = z
  .object({
    default: MemoryScopeSchema.default("project"),
    allowed: z.array(MemoryScopeSchema).min(1).default(["project"]),
  })
  .strict()
  .refine((s) => s.allowed.includes(s.default), {
    message: "memory.scopes.default must appear in memory.scopes.allowed",
  });

export const MemorySchema = z
  .object({
    directories: z.array(MemoryDirectorySchema).default([]),
    router: MemoryRouterSchema.optional(),
    retention: MemoryRetentionSchema.default({}),
    scopes: MemoryScopesSchema.default({}),
  })
  .strict();

export type Memory = z.infer<typeof MemorySchema>;
