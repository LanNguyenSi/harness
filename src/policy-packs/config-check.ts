// Per-pack `config:` shape check, used by both `harness validate` and
// `harness doctor`. The top-level `PolicyPackSchema` accepts
// `config: z.record(string, unknown)` — any key, any value — because
// each builtin pack owns its own config interpretation. That means a
// typo like `mode: "fastConfirm"` (camelCase instead of `fast_confirm`)
// or `permision_profile` (misspelled key) currently falls through to
// the runtime fallback and the operator only finds out when the hook
// finally fires. This helper consults the per-pack `configSchema`
// exported from each builtin module and surfaces every issue at
// lint-time.
//
// Order is deliberate: the source check (`checkPolicyPackSources`) runs
// first to catch unknown pack `source:` / `name:`; only packs that pass
// that gate carry a registered schema. Both helpers stay separate so
// validate can emit BOTH a "this pack does not resolve" diagnostic and
// the per-key config diagnostics for sibling packs in the same run.

import type { z } from "zod";
import { isBuiltinPackName, resolveBuiltinConfigSchema } from "./registry.js";
import type { Manifest } from "../schema/index.js";

export interface PolicyPackConfigIssue {
  packIndex: number;
  packName: string;
  /**
   * Dotted path inside `pack.config`, e.g. `mode`, `approval_lifecycle.mode`,
   * `permission_profile`. Empty string means the issue applies to the
   * config object itself (e.g. a wholly non-object value).
   */
  configPath: string;
  message: string;
  /**
   * Zod issue code preserved so downstream renderers can group by
   * kind (`invalid_enum_value`, `unrecognized_keys`, ...). Stable since
   * zod 3.x.
   */
  code: z.ZodIssueCode;
}

/**
 * Walks `manifest.policy_packs` in declared order. For each enabled
 * builtin pack with a registered `configSchema`, runs `safeParse` and
 * lifts every zod issue into a flat `PolicyPackConfigIssue`. Unknown
 * pack names are skipped (their resolution gap is the
 * `checkPolicyPackSources` helper's job); non-builtin sources are
 * skipped (no schema to consult in v1).
 *
 * Output order is stable: packs in manifest order, issues in zod's
 * native traversal order.
 */
export function checkPolicyPackConfigs(
  manifest: Manifest,
): PolicyPackConfigIssue[] {
  const issues: PolicyPackConfigIssue[] = [];
  manifest.policy_packs.forEach((pack, packIndex) => {
    if (!pack.enabled) return;
    if (!isBuiltinPackName(pack.name)) return;
    const schema = resolveBuiltinConfigSchema(pack.name);
    if (!schema) return;
    const parsed = schema.safeParse(pack.config);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      const configPath = issue.path
        .map((seg) => (typeof seg === "number" ? `[${seg}]` : String(seg)))
        .join(".")
        .replace(/\.\[/g, "[");
      issues.push({
        packIndex,
        packName: pack.name,
        configPath,
        message: issue.message,
        code: issue.code,
      });
    }
  });
  return issues;
}
