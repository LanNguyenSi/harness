// Advisory check (task 24abdecb): warn (never error) when the operator's
// process environment carries `UNDERSTANDING_GATE_MODE` and it diverges
// from `policy_packs[understanding-before-execution].config.mode`.
//
// Context (Batch 11 verification round, reviewer finding on task
// 5d73d78d): after that fix, `resolveModeFromConfig` (config-only, no env
// read) drives every GENERATION-path artefact — `harness apply`'s
// settings.json / instructions.md, and `resolveBuiltinDefaultConfig` in
// `../../policy-packs/registry.ts` (consumed by this doctor's own
// UX-drift comparison). Only the LIVE runtime path — `resolveMode` in
// `approve/understanding.ts`'s stdin-report gap-fill, and the Codex
// `UserPromptSubmit` injector — still reads `UNDERSTANDING_GATE_MODE`
// (Env > config.mode > default), by design: it is the documented one-off
// override mechanism, mirroring `@lannguyensi/understanding-gate`'s own
// "env wins because operators set it consciously" rule (see `MODE_ENV`'s
// doc comment in `understanding-before-execution.ts`).
//
// The gap this check closes: an operator who carries the variable in
// their shell profile (rather than a one-off inline override) silently
// downgrades enforcement relative to what `harness.yaml` declares, with
// no signal anywhere that generation and the live path have diverged.
// Live-verified: `harness approve understanding` accepted a
// `fast_confirm`-shaped report against a `grill_me`-configured manifest
// with no warning. The divergence is agent-unreachable (it only bites at
// approve time, run from the operator's own shell), so `harness doctor`
// — which already reads `process.env` for env-dependent checks, e.g.
// `checkNpmBinPath` (`npm-bin-path.ts`) and the dead-settings.json-block
// lookup (`claude-mcp.ts`) — is the right place to surface it.
//
// Deliberately advisory, never an error: the env override is a
// legitimate, documented escape hatch, not a misconfiguration. The gap is
// visibility (the operator may not remember the variable is still
// exported), not validity.

import {
  isMode,
  MODE_ENV,
  PACK_NAME as UNDERSTANDING_PACK_NAME,
  resolveModeFromConfig,
  type Mode,
} from "../../policy-packs/builtin/understanding-before-execution.js";
import type { Manifest } from "../../schema/index.js";
import type { PolicyPack } from "../../schema/policy-packs.js";

export interface UnderstandingModeEnvDivergence {
  /** `UNDERSTANDING_GATE_MODE`, normalised (trim + lowercase, mirrors `resolveMode`'s own normalisation). */
  envMode: Mode;
  /** `policy_packs[understanding-before-execution].config.mode`, resolved via the config-only (GENERATION-path) resolver. */
  configMode: Mode;
  /**
   * Short headline, rendered as the `⚠` line itself. Mirrors the
   * npm-global-bin-off-PATH advisory's rendering idiom (`format.ts`'s
   * Environment section): a one-line headline plus indented {@link detail}
   * lines underneath, instead of one long sentence crammed onto the `⚠`
   * line.
   */
  message: string;
  /**
   * 2-3 indented lines rendered directly under {@link message} by
   * `format.ts`. Carries the explanation and remediation the old
   * single-line `message` used to carry inline.
   */
  detail: string[];
}

/**
 * Pure: manifest + env in, a divergence report out (or `undefined` when
 * there is nothing to flag). Only fires when:
 *   - the `understanding-before-execution` pack is declared AND enabled
 *     (a pack that never runs has no live mode for the env to diverge
 *     from — mirrors the enabled-gate other doctor sections use, e.g.
 *     `buildGrounding`'s `groundingServer` lookup in `index.ts`);
 *   - `UNDERSTANDING_GATE_MODE` is set to a non-empty value AND, once
 *     trimmed/lower-cased the same way `resolveMode` normalises it,
 *     resolves to a recognised {@link Mode}. An env value the live
 *     runtime would itself reject (unset, empty, or unrecognised) cannot
 *     diverge from anything — the live resolver falls back to
 *     `config.mode` in that case too, so there is no enforcement gap to
 *     warn about.
 *   - the normalised env mode differs from the resolved `config.mode`.
 */
/**
 * Shared gate for the understanding-gate doctor sub-checks that only
 * make sense when the pack is actually live: this divergence advisory,
 * and (ADR docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1,
 * agent-tasks 74b4b17d) the auto-approval listing and settings-drift
 * checks. Declared-but-disabled counts as not enabled, mirroring the
 * `p.enabled !== false` gate `checkUnderstandingModeEnvDivergence` uses
 * inline below.
 */
export function findEnabledUnderstandingPack(manifest: Manifest): PolicyPack | undefined {
  return manifest.policy_packs.find(
    (p) => p.name === UNDERSTANDING_PACK_NAME && p.enabled !== false,
  );
}

export function isUnderstandingPackEnabled(manifest: Manifest): boolean {
  return findEnabledUnderstandingPack(manifest) !== undefined;
}

export function checkUnderstandingModeEnvDivergence(
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): UnderstandingModeEnvDivergence | undefined {
  const pack = findEnabledUnderstandingPack(manifest);
  if (!pack) return undefined;

  const envRaw = env[MODE_ENV];
  if (envRaw === undefined || envRaw === "") return undefined;
  const normalizedEnv = envRaw.trim().toLowerCase();
  if (!isMode(normalizedEnv)) return undefined;

  const { mode: configMode, warning: configWarning } = resolveModeFromConfig(pack);
  if (normalizedEnv === configMode) return undefined;

  // `configMode` is the RESOLVED (effective) value, not necessarily what's
  // literally written in harness.yaml: when `resolveModeFromConfig` itself
  // had to fall back (an unset or unrecognised `config.mode`, signalled by
  // a non-null `configWarning`), attributing it to "(from harness.yaml)"
  // would be a false verbatim claim. Drop the parenthetical in that case;
  // the value is still the correct effective mode, just not YAML-sourced.
  const attribution = configWarning ? "" : " (from harness.yaml)";

  return {
    envMode: normalizedEnv,
    configMode,
    message: `${MODE_ENV}=${normalizedEnv} diverges from config.mode=${configMode}`,
    detail: [
      "live runtime consumers (`harness approve understanding`'s stdin-report gap-fill, the " +
        `Codex UserPromptSubmit injector) read the env, so enforcement is effectively "${normalizedEnv}"`,
      `effective config.mode=${configMode}${attribution}`,
      `if this is not a deliberate one-off override, unset ${MODE_ENV} in your shell profile`,
    ],
  };
}
