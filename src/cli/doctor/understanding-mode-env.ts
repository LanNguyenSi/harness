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

export interface UnderstandingModeEnvDivergence {
  /** `UNDERSTANDING_GATE_MODE`, normalised (trim + lowercase, mirrors `resolveMode`'s own normalisation). */
  envMode: Mode;
  /** `policy_packs[understanding-before-execution].config.mode`, resolved via the config-only (GENERATION-path) resolver. */
  configMode: Mode;
  message: string;
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
export function checkUnderstandingModeEnvDivergence(
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): UnderstandingModeEnvDivergence | undefined {
  const pack = manifest.policy_packs.find(
    (p) => p.name === UNDERSTANDING_PACK_NAME && p.enabled !== false,
  );
  if (!pack) return undefined;

  const envRaw = env[MODE_ENV];
  if (envRaw === undefined || envRaw === "") return undefined;
  const normalizedEnv = envRaw.trim().toLowerCase();
  if (!isMode(normalizedEnv)) return undefined;

  const { mode: configMode } = resolveModeFromConfig(pack);
  if (normalizedEnv === configMode) return undefined;

  return {
    envMode: normalizedEnv,
    configMode,
    message:
      `${MODE_ENV}=${normalizedEnv} is set in the operator environment and diverges from ` +
      `policy_packs[${UNDERSTANDING_PACK_NAME}].config.mode=${configMode} (harness.yaml). ` +
      "The env value wins for live runtime consumers (\`harness approve understanding\`'s " +
      "stdin-report gap-fill, the Codex UserPromptSubmit injector), so enforcement is " +
      `effectively "${normalizedEnv}", not the "${configMode}" harness.yaml declares. If this ` +
      `is not a deliberate one-off override, unset ${MODE_ENV} in your shell profile.`,
  };
}
