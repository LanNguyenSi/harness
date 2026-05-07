import { z } from "zod";

// Pack `name` is consumed as a path component when `harness pack remove
// --force` cleans up `harness.generated/policy-packs/<name>/`, so it must
// not contain `/`, `..`, or anything else that would escape the policy-
// packs subtree. Constrain to alphanumeric + dash + underscore + dot,
// must start with an alphanumeric. This matches the canonical builtin
// (`understanding-before-execution`) and is friendly to future names like
// `safe-shell.v2`.
const PACK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const PolicyPackSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        PACK_NAME_RE,
        "policy_pack name must start with an alphanumeric and contain only [A-Za-z0-9._-]; path separators are rejected",
      ),
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
