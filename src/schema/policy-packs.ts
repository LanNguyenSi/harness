import { z } from "zod";

export const PolicyPackSchema = z
  .object({
    name: z.string().min(1),
    source: z.string().min(1).default("builtin"),
    enabled: z.boolean().default(true),
    description: z.string().min(1).optional(),
    config: z.record(z.string().min(1), z.unknown()).default({}),
  })
  .strict();

export const PolicyPacksSchema = z.array(PolicyPackSchema).superRefine((packs, ctx) => {
  const seen = new Set<string>();
  packs.forEach((pack, i) => {
    if (seen.has(pack.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "name"],
        message: `duplicate policy_pack name: ${pack.name}`,
      });
    }
    seen.add(pack.name);
  });
});

export type PolicyPack = z.infer<typeof PolicyPackSchema>;
