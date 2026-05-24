import { z } from "zod";

import { NUMERIC_VERSION_MESSAGE, NUMERIC_VERSION_PATTERN } from "../io/version-compare.js";

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
    // Optional version floor on the pack's canonical package-side bin.
    // The hook-level `min_version` (carried by each pack-emitted Hook
    // entry) covers each individual hook command; this pack-level floor
    // catches a config-schema mismatch between the harness-side pack
    // definition and the package-side runtime: e.g. a `config:` key
    // that only the newer release honours. `harness doctor` probes the
    // version command registered per builtin in the policy-pack
    // registry and warns when the installed binary is below this floor.
    // The pack still functions in degraded mode; only features gated on
    // the newer version are lost. Optional: legacy manifests without
    // the field stay silent.
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
