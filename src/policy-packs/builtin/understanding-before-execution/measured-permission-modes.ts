// Registry of measured `permission_mode` literals for the
// `auto_approve.when` allowlist (docs/decisions/2026-08-27-ug-auto-mode-approval.md,
// Slice 2 AC 3, "Option A").
//
// RULE: an entry is added here ONLY together with a checked-in dogfood
// fixture (under `dogfood/ug-auto-mode-signals/payloads/`) that shows the
// named harness actually emitting that exact `permission_mode` string on a
// `PreToolUse` hook payload. `tests/policy-packs/measured-permission-modes-sync.test.ts`
// enforces both directions: every entry here must be backed by a fixture
// that carries the claimed value, and every `permission_mode` value found
// in any `*.PreToolUse.json` fixture must be registered for its harness.
// Do not add a literal "because it seems plausible" — capture a fixture
// first, then register it.
//
// `harness validate` runs in the OPERATOR's repo, which has no `dogfood/`
// directory, so this registry ships inside the package as a constant
// (`checkUnderstandingBeforeExecutionAutoApproveMeasured` in
// `src/cli/validate/checks.ts` consults it without touching the
// filesystem); the sync test above is what keeps it honest against the
// fixtures in THIS repo.

export type MeasuredHarness = "claude-code" | "codex";

export interface MeasuredPermissionMode {
  readonly harness: MeasuredHarness;
  readonly permissionMode: string;
  /** Repo-relative path under dogfood/ug-auto-mode-signals/payloads/. */
  readonly fixture: string;
}

const PAYLOADS_DIR = "dogfood/ug-auto-mode-signals/payloads";

export const MEASURED_PERMISSION_MODES: ReadonlyArray<MeasuredPermissionMode> = [
  {
    harness: "claude-code",
    permissionMode: "default",
    fixture: `${PAYLOADS_DIR}/claude-p-default.PreToolUse.json`,
  },
  {
    harness: "claude-code",
    permissionMode: "acceptEdits",
    fixture: `${PAYLOADS_DIR}/claude-p-acceptedits.PreToolUse.json`,
  },
  {
    harness: "claude-code",
    permissionMode: "bypassPermissions",
    fixture: `${PAYLOADS_DIR}/claude-p-bypass.PreToolUse.json`,
  },
  {
    harness: "codex",
    permissionMode: "bypassPermissions",
    fixture: `${PAYLOADS_DIR}/codex-exec-default.PreToolUse.json`,
  },
  {
    harness: "codex",
    permissionMode: "default",
    fixture: `${PAYLOADS_DIR}/codex-tui-default.PreToolUse.json`,
  },
];

/**
 * True when ANY harness has a measured fixture for this exact literal.
 * The `auto_approve.when` allowlist is shared across harnesses (the pack
 * config does not distinguish which harness produced the run), so a
 * literal counts as measured as soon as one harness has evidence for it.
 * Exact string equality: no case folding, no wildcards.
 */
export function isMeasuredPermissionMode(literal: string): boolean {
  return MEASURED_PERMISSION_MODES.some((entry) => entry.permissionMode === literal);
}

/** Sorted, de-duplicated list of every measured literal across harnesses. */
export function measuredPermissionModeLiterals(): string[] {
  return Array.from(new Set(MEASURED_PERMISSION_MODES.map((entry) => entry.permissionMode))).sort();
}
