// Shared runtime constants + helpers for the `branch-protection` policy pack.
//
// The pack itself (`branch-protection.ts`) only emits hooks + the
// audit-copy instructions. The actual enforcement lives in two CLI verbs
// — `harness session-start branch-check` (producer) and `harness pack
// hook branch-protection` (blocker) — both under `src/cli/`. This module
// is the small shared surface they pull from: tag formats, default
// protected list, config parsing.

import type { PolicyPack } from "../../schema/index.js";

export const PACK_NAME = "branch-protection";

/**
 * Ledger tag written by the producer when the current branch is NOT in
 * the operator's protected list. The blocker substring-matches this
 * prefix; the trailing `:<branch>` is informational and keeps the
 * ledger row self-describing for auditors.
 */
export const NON_PROTECTED_TAG_PREFIX = "branch:non-protected";

/**
 * Operator escape-hatch tag. Set via `mcp__agent-grounding__ledger_add`
 * (Bash is gated by this very pack, so a shell-based override would be
 * unreachable). The blocker substring-matches this prefix; the trailing
 * `:<reason>` is a free-form note the operator types so a later audit
 * can read WHY the override fired (e.g. `branch-protection-ack:hotfix
 * for prod`).
 */
export const ACK_TAG_PREFIX = "branch-protection-ack";

/**
 * Freshness window for the producer tag. Five minutes lets a single
 * branch-check satisfy a whole edit batch without re-running for every
 * Write; longer than that and a branch switch in the middle of a
 * session would silently keep the gate open against the new HEAD.
 */
export const PRODUCER_FRESHNESS_MS = 5 * 60 * 1000;

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
 * True when `branch` is in the protected list. Empty branch (detached
 * HEAD) is treated as protected, because we can't audit-by-name what
 * the agent is about to commit to.
 */
export function isProtectedBranch(branch: string, protectedList: readonly string[]): boolean {
  if (branch.length === 0) return true;
  return protectedList.includes(branch);
}
