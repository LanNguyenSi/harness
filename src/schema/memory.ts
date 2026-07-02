import { z } from "zod";

import { NUMERIC_VERSION_MESSAGE, NUMERIC_VERSION_PATTERN } from "../io/version-compare.js";

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
    min_version: z
      .string()
      .min(1)
      .regex(NUMERIC_VERSION_PATTERN, NUMERIC_VERSION_MESSAGE)
      .optional(),
    version_command: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const MemoryRetentionSchema = z
  .object({
    staleness_days: z.number().int().positive().default(180),
    // STATUS: INERT (disclosed per task 50a94127). Validated but read by
    // no consumer: probes/memory.ts scans only `staleness_days`. A
    // broken-`[[ref]]` scan honoring warn/error/ignore is future work;
    // until it lands, setting this key changes nothing at runtime.
    broken_refs: z.enum(["warn", "error", "ignore"]).default("warn"),
  })
  .strict();

// STATUS: INERT (disclosed per task 50a94127). `memory.scopes` is
// validated (including the default-in-allowed refinement below) but no
// runtime, probe, or apply surface reads it; the per-directory `scope`
// field on `memory.directories[]` is what consumers use. Declaring
// scopes today changes nothing at runtime.
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
