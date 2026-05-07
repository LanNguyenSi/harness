// Phase 6 #5 — built-in permission profiles bundled with the
// `understanding-before-execution` pack.
//
// Three profiles, each documented in
// `docs/policy-packs/understanding-before-execution.md`. The pack's
// `config.permission_profile` selects which profile is active; the
// pack contributes the resolved profile's permission entries to the
// generated `settings.json` at apply time.
//
// Profile actions translate to Claude Code's permissions block via
// `profileToSettingsPermissions()` below. The mapping is intentionally
// conservative: `limited` and `ask_or_deny` collapse to `ask` for v1
// (Claude Code does not distinguish these natively); fine-grained
// shaping is a Phase 6 #5 follow-up.

import type { PermissionProfile } from "../../schema/permission-profiles.js";

export const PROFILE_SAFE_START = "safe-start";
export const PROFILE_IMPLEMENTATION_AFTER_APPROVAL = "implementation-after-approval";
export const PROFILE_HIGH_RISK_GRILL_ME = "high-risk-grill-me";

export const KNOWN_PROFILE_NAMES = [
  PROFILE_SAFE_START,
  PROFILE_IMPLEMENTATION_AFTER_APPROVAL,
  PROFILE_HIGH_RISK_GRILL_ME,
] as const;
export type KnownProfileName = (typeof KNOWN_PROFILE_NAMES)[number];

export function isKnownProfileName(name: string): name is KnownProfileName {
  return (KNOWN_PROFILE_NAMES as readonly string[]).includes(name);
}

export const SAFE_START: PermissionProfile = {
  description:
    "Pre-approval default. Read-only path is open; everything write-capable is denied (commit/push/pr/deploy) or asks (edit/bash). Pair with `harness pack hook pre-tool-use` for the conditional unlock.",
  actions: {
    read: { allow: "true" },
    edit: { allow: "ask" },
    bash: { allow: "ask" },
    commit: { allow: "false" },
    push: { allow: "false" },
    pr: { allow: "false" },
    deploy: { allow: "false" },
  },
};

export const IMPLEMENTATION_AFTER_APPROVAL: PermissionProfile = {
  description:
    "Post-approval working profile. Edit/Bash flow without prompts; commit/push/pr ask. Activate after the operator has approved the Understanding Report (run `harness apply` again with this profile selected).",
  actions: {
    read: { allow: "true" },
    edit: { allow: "true" },
    bash: { allow: "ask" },
    commit: { allow: "ask" },
    push: { allow: "ask" },
    pr: { allow: "ask" },
    deploy: { allow: "false" },
  },
};

export const HIGH_RISK_GRILL_ME: PermissionProfile = {
  description:
    "High-friction profile for risky surfaces. Asks per-Edit and per-Bash even after approval; refuses commit/deploy outright. Use when the task touches security, infrastructure, or destructive writes.",
  actions: {
    read: { allow: "true" },
    edit: { allow: "ask" },
    bash: { allow: "ask" },
    commit: { allow: "false" },
    push: { allow: "false" },
    pr: { allow: "ask" },
    deploy: { allow: "false" },
  },
};

export function resolveProfile(name: string): PermissionProfile | null {
  if (!isKnownProfileName(name)) return null;
  switch (name) {
    case PROFILE_SAFE_START:
      return SAFE_START;
    case PROFILE_IMPLEMENTATION_AFTER_APPROVAL:
      return IMPLEMENTATION_AFTER_APPROVAL;
    case PROFILE_HIGH_RISK_GRILL_ME:
      return HIGH_RISK_GRILL_ME;
  }
}
