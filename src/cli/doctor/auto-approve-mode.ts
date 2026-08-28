// Doctor advisory (agent-tasks abfad738, follow-up of ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1): warn when
// an operator has opted into the hook-written signed auto-marker path
// (`policy_packs[understanding-before-execution].config.auto_approve`)
// without also pairing it with `mode: grill_me`.
//
// Why this matters: the auto-approval path's report precondition reuses
// `validatePersistedReport` (`src/cli/approve/understanding.ts`), which
// only enforces the report's `mode` field when it is `grill_me`.
// Outside that mode, report validation is structural only (the report
// exists and belongs to the session, not that its contents reflect any
// real understanding exchange). Both the ADR (recommendation 4) and the
// pack doc recommend pairing `auto_approve` with `grill_me` for exactly
// this reason. Nothing surfaced the gap before this check: an operator
// who opts a non-grill_me mode into `auto_approve` gets no signal that
// the auto path's report gate has degraded to a near-no-op.
//
// Deliberately advisory, never an error: `auto_approve` outside
// `grill_me` is a real, if weaker, gate (the permission-mode allowlist
// and the signed marker still apply), not a misconfiguration.
//
// This check reads `resolveModeFromConfig(pack).mode`, the same
// GENERATION-path resolver `checkUnderstandingModeEnvDivergence` and
// `resolveBuiltinDefaultConfig` use, NOT `pack.config.mode` verbatim.
// A missing `config.mode` resolves to `DEFAULT_MODE` (`grill_me`), and
// that resolved value is what the generated Stop-hook command actually
// passes as `UNDERSTANDING_GATE_MODE`, so a report written under an
// unset `mode` genuinely carries `grill_me` and IS the strict check;
// there is no gap to warn about. An unrecognised `config.mode` literal
// also resolves to `grill_me` this same way, with its own warning
// already surfaced elsewhere (`resolveModeFromConfig`'s `warning`
// return, consumed by `harness validate` / other doctor checks); this
// check does not duplicate that.
//
// A session-level `UNDERSTANDING_GATE_MODE` env override that diverges
// from the resolved `config.mode` is a SEPARATE gap, already covered by
// `checkUnderstandingModeEnvDivergence` (`understanding-mode-env.ts`)'s
// own advisory line, this check only ever reads the manifest, never
// `process.env`.

import { resolveModeFromConfig } from "../../policy-packs/builtin/understanding-before-execution.js";
import { parseAutoApprove } from "../../policy-packs/builtin/understanding-before-execution/index.js";
import type { Manifest } from "../../schema/index.js";
import { findEnabledUnderstandingPack } from "./understanding-mode-env.js";

export interface AutoApproveModeWarning {
  /**
   * The RESOLVED effective mode (`resolveModeFromConfig(pack).mode`);
   * never the literal `pack.config.mode` value. Always a recognised
   * Mode literal (the resolver always returns one, defaulting to
   * `grill_me` when `config.mode` is absent or unrecognised).
   */
  mode: string;
  /** Rendered as the `⚠` line itself. */
  message: string;
  /**
   * Indented detail lines rendered directly under {@link message} by
   * `format.ts`, mirroring `understandingModeEnv`'s detail-line idiom.
   */
  detail: string[];
}

/**
 * Pure: manifest in, a warning out (or `undefined` when there is nothing
 * to flag). Only fires when:
 *   - the `understanding-before-execution` pack is declared AND enabled
 *     (a pack that never runs has no live auto-approve path to warn
 *     about, mirrors the enabled-gate `understanding-mode-env.ts` and
 *     `ug-auto-approvals.ts` use);
 *   - `config.auto_approve` parses as a valid opt-in block (schema
 *     validation already rejects a malformed block at lint time, so a
 *     manifest that reaches doctor with an unparseable block has
 *     already failed loud elsewhere; this mirrors that same fail-closed
 *     "not opted in" reading rather than re-deriving a second opinion);
 *   - the RESOLVED effective mode (`resolveModeFromConfig(pack).mode`)
 *     is not `"grill_me"`. An absent or unrecognised `config.mode`
 *     resolves to `grill_me` (`DEFAULT_MODE`) and therefore never fires
 *     this warning, see the module header for why that resolved value,
 *     not the literal config key, is what the auto path's report
 *     actually carries.
 */
export function checkAutoApproveMode(manifest: Manifest): AutoApproveModeWarning | undefined {
  const pack = findEnabledUnderstandingPack(manifest);
  if (!pack) return undefined;

  const autoApprove = parseAutoApprove(pack.config["auto_approve"]);
  if (autoApprove === null) return undefined;

  const { mode } = resolveModeFromConfig(pack);
  if (mode === "grill_me") return undefined;

  return {
    mode,
    message: `auto_approve is configured with mode ${mode} (policy_packs[understanding-before-execution].config.mode); report validation is structural only outside grill_me`,
    detail: [
      "set config.mode: grill_me, or accept the weaker report gate; see docs/policy-packs/understanding-before-execution.md",
    ],
  };
}
