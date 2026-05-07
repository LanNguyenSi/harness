// Phase 6 #5 — permission-profile schema.
//
// A permission profile is a named bundle of action-keyed permission rules
// that policy packs can declare. Action keys are abstract (read / edit /
// bash / commit / push / pr / deploy) so a single profile can target
// multiple agent runtimes; the runtime adapter translates them to the
// actual tool patterns at apply time.
//
// `requires:` on a profile action is reserved for future runtime-aware
// gating (Phase 6 #5 follow-up): when present, it composes with the
// existing `policies:` evaluator. v1 parses it through the schema
// without firing it at runtime; that wiring lands in a sister sub-task.

import { z } from "zod";
import { RequiresSchema } from "./requires.js";

export const PERMISSION_ACTION_KEYS = [
  "read",
  "edit",
  "bash",
  "commit",
  "push",
  "pr",
  "deploy",
] as const;
export type PermissionActionKey = (typeof PERMISSION_ACTION_KEYS)[number];

export const PermissionAllowSchema = z.enum([
  "true",
  "false",
  "ask",
  "limited",
  "ask_or_deny",
]);
export type PermissionAllow = z.infer<typeof PermissionAllowSchema>;

export const PermissionRuleSchema = z
  .object({
    allow: z.union([z.boolean(), PermissionAllowSchema]).transform((v) => {
      if (v === true) return "true" as PermissionAllow;
      if (v === false) return "false" as PermissionAllow;
      return v;
    }),
    mode: z.string().min(1).optional(),
    requires: RequiresSchema.optional(),
  })
  .strict();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

const ActionMap = z.object({
  read: PermissionRuleSchema.optional(),
  edit: PermissionRuleSchema.optional(),
  bash: PermissionRuleSchema.optional(),
  commit: PermissionRuleSchema.optional(),
  push: PermissionRuleSchema.optional(),
  pr: PermissionRuleSchema.optional(),
  deploy: PermissionRuleSchema.optional(),
}).strict();

export const PermissionProfileSchema = z
  .object({
    description: z.string().min(1).optional(),
    actions: ActionMap.default({}),
  })
  .strict();
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

export const PermissionProfilesSchema = z.record(
  z.string().min(1),
  PermissionProfileSchema,
);
export type PermissionProfiles = z.infer<typeof PermissionProfilesSchema>;
