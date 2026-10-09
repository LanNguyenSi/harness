import { z } from "zod";

import { NUMERIC_VERSION_MESSAGE, NUMERIC_VERSION_PATTERN } from "../io/version-compare.js";

// Pack `name` is consumed as a path component when `harness pack remove
// --force` cleans up `harness.generated/policy-packs/<name>/`, so it must
// not contain `/`, `..`, or anything else that would escape the policy-
// packs subtree. Constrain to alphanumeric + dash + underscore + dot,
// must start with an alphanumeric. This matches the canonical builtin
// (`branch-protection`) and is friendly to future names like
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
    // Optional declared version floor. Builtin packs ship inside harness
    // and have no package-side bin to probe, so the floor cannot be
    // enforced: `harness doctor` reports a declared value as a warning
    // (see src/policy-packs/version-check.ts). Optional: manifests
    // without the field stay silent.
    min_version: z
      .string()
      .min(1)
      .regex(NUMERIC_VERSION_PATTERN, NUMERIC_VERSION_MESSAGE)
      .optional(),
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
