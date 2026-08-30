// Doctor finding for the Mac-mini incident shape (task 8f637efd,
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Amendment: install
// default"): a session ran under `bypassPermissions` (observed on the
// PreToolUse payload by the hook itself, see
// permission-mode-observations.ts) but `auto_approve` is missing, or
// present without covering `bypassPermissions` for `claude-code`. In
// that shape every gated call in the session falls through to the manual
// `harness approve understanding` prompt, which is exactly the gap the
// operator hit: the pack expects an unattended session under
// `bypassPermissions` to have opted in, and nothing said otherwise.
//
// This check reads ONLY the hook-written observation
// (`.permission-mode-observations/`), never the ledger and never the
// persisted report: both are agent-writable, and the evidence-ledger
// trust boundary this pack already enforces for approval
// (docs/okf/evidence-ledger-trust-boundary.md) applies to a doctor
// finding just as much as to a gate decision: a fact the AGENT can write
// must not be what tells the operator "you meant to opt in and didn't".
//
// Deliberately advisory (⚠), never an error: an operator who runs
// `bypassPermissions` sessions on the manual approval path on purpose
// (never wanting unattended auto-approval) is not misconfigured.
//
// THE OBSERVATION IS UNSIGNED (review round 3, F2). "Never the ledger,
// never the persisted report" above is about the WRITE PATH (this
// finding does not trust an agent-writable ledger row or report field),
// not a claim that the observation itself is tamper-proof: unlike the
// approval marker, `permission-mode-observations.ts`'s record carries no
// signature, so it is evidence that `harness pack hook pre-tool-use` was
// invoked with a given `session_id`/`permission_mode` on its stdin, not
// proof that a particular session actually ran under that mode: an
// already-approved session (or anything else able to invoke the hook
// binary directly) can write, or forge, one. That is exactly why this
// finding stays advisory-only and never feeds a gate or an approval: the
// operator who reads it decides what it means. A possible future
// hardening is signing the observation the way approval markers are
// signed.

import {
  CLAUDE_CODE_HARNESS,
  harnessAllowed,
  listPermissionModeObservations,
  parseAutoApprove,
  permissionModeAllowed,
  renderAutoApproveSnippet,
  sanitizeForDisplay,
} from "../../policy-packs/builtin/understanding-before-execution-runtime.js";
import type { Manifest } from "../../schema/index.js";
import { findEnabledUnderstandingPack } from "./understanding-mode-env.js";

/** The one payload literal this finding cares about (T1, see the ADR's signal table). */
const BYPASS_MODE = "bypassPermissions";

export interface BypassWithoutAutoApproveFinding {
  /** The newest observed session that tripped this finding. */
  sessionId: string;
  /** That observation's `observedAt` (ISO). */
  observedAt: string;
  /** Rendered as the `⚠` line itself. */
  message: string;
  /**
   * Indented detail lines rendered directly under {@link message},
   * mirroring the other advisory checks' idiom. Ends with the exact
   * `auto_approve` snippet (the same one `harness init` ships and
   * `harness pack upgrade understanding-before-execution` inserts, see
   * auto-approve-default.ts) and names the upgrade command.
   */
  detail: string[];
}

/**
 * Pure(-ish): manifest + `generatedDir` in, a finding out (or
 * `undefined` when there is nothing to flag). Only fires when:
 *   - the `understanding-before-execution` pack is declared AND enabled
 *     (mirrors every sibling advisory's gate: a pack that never runs
 *     has no auto-approve path to be missing);
 *   - at least one of the newest `recentSessions` hook-written
 *     observations records `permissionMode === "bypassPermissions"`;
 *   - `auto_approve` does NOT cover that combination today: either the
 *     block is absent/malformed (`parseAutoApprove` returns `null`), or
 *     `bypassPermissions` is not in `when`, or `claude-code` is not in
 *     `harnesses` (an operator who opted Codex in alone, dropping
 *     Claude Code, still has this exact gap on the Claude Code side).
 *
 * Reports the NEWEST qualifying observation only: this is a "you have
 * at least one gap" flag, not a per-session audit; `ugAutoApprovals`
 * already owns the full listing idiom for that.
 */
export function checkBypassWithoutAutoApprove(
  manifest: Manifest,
  generatedDir: string,
  opts: { recentSessions: number },
): BypassWithoutAutoApproveFinding | undefined {
  const pack = findEnabledUnderstandingPack(manifest);
  if (!pack) return undefined;

  const observations = listPermissionModeObservations(generatedDir, {
    windowSize: opts.recentSessions,
  });
  const bypassObserved = observations.entries.find((e) => e.permissionMode === BYPASS_MODE);
  if (!bypassObserved) return undefined;

  const autoApprove = parseAutoApprove(pack.config["auto_approve"]);
  const covered =
    permissionModeAllowed(autoApprove, BYPASS_MODE) &&
    harnessAllowed(autoApprove, CLAUDE_CODE_HARNESS);
  if (covered) return undefined;

  // Sanitise at the render boundary as well, not only in the reader
  // (mirrors persisted-reports.ts): both fields are payload-controlled.
  const sessionId = sanitizeForDisplay(bypassObserved.sessionId);
  const observedAt = sanitizeForDisplay(bypassObserved.observedAt);
  return {
    sessionId,
    observedAt,
    message: `bypassPermissions observed for session ${sessionId} (${observedAt}) but auto_approve does not cover it; every gated call in that session needed a manual approval`,
    detail: [
      "run `harness pack upgrade understanding-before-execution` to insert the block below, or add it by hand under policy_packs[understanding-before-execution].config:",
      ...renderAutoApproveSnippet(0).split("\n"),
    ],
  };
}
