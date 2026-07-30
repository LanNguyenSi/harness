// Shared runtime constants + helpers for the `branch-protection` policy pack.
//
// The pack itself (`branch-protection.ts`) only emits hooks + the
// audit-copy instructions. The actual enforcement lives in two CLI verbs
// — `harness session-start branch-check` (producer) and `harness pack
// hook branch-protection` (blocker) — both under `src/cli/`. This module
// is the small shared surface they pull from: tag formats, default
// protected list, config parsing.

import type { PolicyPack } from "../../schema/index.js";
import {
  checkApprovalMarker,
  writeApprovalMarker,
  type ApprovalMarker,
  type CheckApprovalMarkerOptions,
  type MarkerCheck,
} from "./understanding-before-execution-runtime.js";

export const PACK_NAME = "branch-protection";

/**
 * Ledger tag written by the producer when the current branch is NOT in
 * the operator's protected list. The blocker substring-matches this
 * prefix; the trailing `:<branch>` is informational and keeps the
 * ledger row self-describing for auditors.
 */
export const NON_PROTECTED_TAG_PREFIX = "branch:non-protected";

/**
 * Operator escape-hatch tag, kept as a best-effort AUDIT echo only.
 *
 * SECURITY (audit finding #39): this tag is NO LONGER a trusted override
 * signal. The agent has direct `mcp__grounding-mcp__ledger_add` access,
 * so it could self-write `branch-protection-ack:<anything>` and bless its
 * own protected-branch edit — exactly the self-approval backdoor the
 * understanding gate closed in agent-tasks/88ca4bb3 by moving the
 * canonical approval to a filesystem marker. The blocker now consults the
 * operator-only marker file (see `checkBranchProtectionMarker` below); the
 * `harness approve branch-protection` verb still records this ledger tag
 * so `harness audit` / forensics keep a trail, but its presence alone
 * never satisfies the gate. The trailing `:<reason>` stays free-form.
 */
export const ACK_TAG_PREFIX = "branch-protection-ack";

/**
 * Marker-name namespace for an operator-written branch-protection
 * override. The marker lives in the shared `.approvals/` directory under
 * `harness.generated/` (the same directory the understanding gate uses),
 * prefixed so it can never be confused with an understanding-gate session
 * marker (`.approvals/<sessionId>`) or a task marker (`.approvals/task-<id>`):
 * Claude Code / Codex session ids are UUIDs and never start with this
 * literal, so the three namespaces stay disjoint.
 *
 * Why a marker and not the `branch-protection-ack` ledger tag: only a
 * process the operator launched (their `!`-shell or any un-hooked
 * terminal) can write under `harness.generated/` — Edit / Write / Bash
 * are all gated, and the configured MCP servers expose no filesystem
 * write. So the marker is the canonical override signal; the ledger row
 * is a best-effort audit echo only.
 */
export const BRANCH_PROTECTION_MARKER_PREFIX = "branch-protection-";

/** Marker filename (inside `.approvals/`) for a session's branch-protection override. */
export function branchProtectionMarkerName(sessionId: string): string {
  return `${BRANCH_PROTECTION_MARKER_PREFIX}${sessionId}`;
}

/**
 * Operator-side: write the canonical branch-protection override marker for
 * `sessionId`. Atomic (delegates to `writeApprovalMarker`). Caller is
 * `harness approve branch-protection`, run from the operator's un-hooked
 * shell; if the agent could reach this path the gate's value would
 * collapse, so it lives behind the approve CLI.
 */
export function writeBranchProtectionMarker(
  generatedDir: string,
  sessionId: string,
  marker: ApprovalMarker,
): string {
  return writeApprovalMarker(generatedDir, branchProtectionMarkerName(sessionId), marker);
}

/**
 * Gate-side: is the operator's branch-protection override marker present
 * for `sessionId`? Inherits `checkApprovalMarker`'s contract
 * (signature-verified, symlink rejection, optional freshness via
 * `maxAgeMs` — harness/f9485cc7 replaced the earlier existence-is-enough
 * behaviour with HMAC signature verification); only the namespaced
 * filename differs.
 */
export function checkBranchProtectionMarker(
  generatedDir: string,
  sessionId: string,
  opts: CheckApprovalMarkerOptions = {},
): MarkerCheck {
  return checkApprovalMarker(generatedDir, branchProtectionMarkerName(sessionId), opts);
}

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
