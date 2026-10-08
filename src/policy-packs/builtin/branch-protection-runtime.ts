// Shared runtime constants + helpers for the `branch-protection` policy pack.
//
// The pack itself (`branch-protection.ts`) only emits its hook + the
// audit-copy instructions. The enforcement lives in `harness pack hook
// branch-protection` (src/cli/pack/hook-branch-protection.ts), which asks git
// for the branch through src/runtime/git-branch.ts. This module is the small
// shared surface both pull from: the pack name, the default protected list,
// config parsing and the branch-name comparison.

import type { PolicyPack } from "../../schema/index.js";

export const PACK_NAME = "branch-protection";

/** Branches gated by default when no `config.protected_branches` is set. */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = [
  "master",
  "main",
  "develop",
];

/**
 * Parse the pack's `config.protected_branches` list. Falls back to the
 * default allowlist when the operator hasn't customized it, OR when the
 * provided value isn't a non-empty string array (the warning surfaces
 * the type mismatch so the operator can fix it).
 *
 * Returns the resolved list plus a non-null warning message when the
 * raw config was ill-formed. Caller appends the warning to the pack's
 * `warnings` collection so it lands in apply output.
 */
export function resolveProtectedBranches(pack: PolicyPack): {
  branches: string[];
  warning: string | null;
} {
  const raw = pack.config["protected_branches"];
  if (raw === undefined) {
    return { branches: [...DEFAULT_PROTECTED_BRANCHES], warning: null };
  }
  if (!Array.isArray(raw)) {
    return {
      branches: [...DEFAULT_PROTECTED_BRANCHES],
      warning: `policy_packs[${pack.name}].config.protected_branches: expected an array of strings, got ${typeof raw}; falling back to defaults (${DEFAULT_PROTECTED_BRANCHES.join(", ")}).`,
    };
  }
  const ok: string[] = [];
  const bad: unknown[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) ok.push(entry);
    else bad.push(entry);
  }
  if (ok.length === 0) {
    return {
      branches: [...DEFAULT_PROTECTED_BRANCHES],
      warning: `policy_packs[${pack.name}].config.protected_branches: every entry was rejected (need non-empty strings); falling back to defaults (${DEFAULT_PROTECTED_BRANCHES.join(", ")}).`,
    };
  }
  if (bad.length > 0) {
    return {
      branches: ok,
      warning: `policy_packs[${pack.name}].config.protected_branches: skipped ${bad.length} non-string entr${bad.length === 1 ? "y" : "ies"}; using ${ok.length} valid one${ok.length === 1 ? "" : "s"} (${ok.join(", ")}).`,
    };
  }
  return { branches: ok, warning: null };
}

/**
 * True when `branch` (the name git reports, without `refs/heads/`) matches an
 * entry of the protected list, compared case-insensitively: `Master` and
 * `MAIN` are the same branch as far as this gate is concerned, since a
 * case-insensitive filesystem or a remote can fold them together.
 */
export function isProtectedBranch(branch: string, protectedList: readonly string[]): boolean {
  const folded = branch.toLowerCase();
  return protectedList.some((p) => p.toLowerCase() === folded);
}
