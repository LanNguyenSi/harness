// Shared types for the policy-pack expansion pipeline.
//
// A pack contribution is the data a builtin pack produces at apply time:
// a list of hooks to merge into the in-memory manifest before settings
// generation, plus a list of files to write under
// `harness.generated/policy-packs/<name>/`.
//
// The `Hook` shape mirrors the manifest's hooks[] entry exactly (so the
// existing generate-settings projection picks them up unchanged).

import type { Hook } from "../schema/index.js";

export interface PackContributionFile {
  /** Relative path under `harness.generated/`, including the policy-packs/ prefix. */
  relativePath: string;
  content: string;
}

/**
 * Phase 6 #5 — permissions contributed by a pack's selected
 * permission profile. Translated downstream into the Claude Code
 * settings.json `permissions` block.
 */
export interface PackPermissionsContribution {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface PackContribution {
  /** Hooks to merge into the manifest before settings.json generation. */
  hooks: Hook[];
  /** Files to write under `harness.generated/`. */
  files: PackContributionFile[];
  /** Optional permission contribution (Phase 6 #5). */
  permissions?: PackPermissionsContribution;
}

export interface PackExpansionResult {
  /** Combined hooks contributed by every enabled, resolvable pack. */
  hooks: Hook[];
  /** Combined files contributed by every enabled, resolvable pack. */
  files: PackContributionFile[];
  /**
   * Combined permissions contributed by every enabled, resolvable
   * pack (set-union per bucket; later contributions cannot relax a
   * deny from an earlier pack). undefined when no pack contributed
   * any permission entries.
   */
  permissions?: PackPermissionsContribution;
  /** Non-fatal expansion warnings (e.g. unknown source, unknown name on a non-strict path). */
  warnings: string[];
  /** Names of packs that were skipped because `enabled: false`. */
  skipped: string[];
}
