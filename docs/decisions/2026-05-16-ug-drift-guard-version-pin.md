# UG drift-guard: pin upstream version vs always `@latest`

- **Date**: 2026-05-16
- **Status**: Accepted
- **Decision tracker**: agent-tasks/40452b01
- **Implementation context**: PR #153 (drift-guard introduction), PR #155 (drift-guard hardening bundle)

## Context

`scripts/check-ug-schema-drift.mjs` (added in PR #153) is a CI guard that detects when the `UNDERSTANDING_REPORT_REQUIRED_SECTIONS` mirror in `src/cli/pack/understanding-report-schema-hint.ts` drifts from the upstream parser's SECTIONS array in `@lannguyensi/understanding-gate`. On every CI run it `npm pack`s the upstream package and diffs section keys.

The script targets `@lannguyensi/understanding-gate@latest`. Two alternatives were considered:

- **Pin**: harness records a target upstream version in `package.json` (or a dedicated file). The drift script fetches the pinned version. Drift is only detected when a maintainer bumps the pin.
- **Mixed**: pin a baseline for PR-time CI + a separate scheduled cron job that runs drift against `@latest` and opens an issue or fails noisily on drift.

## Decision

Keep `@latest`. Do not adopt pinning or the mixed scheme.

## Rationale

1. **The gate hint is a contract surface, not a build dependency.** What harness renders to the agent in the PreToolUse block message must match what the upstream parser actually accepts. Pinning would mean an upstream parser change becomes invisible until someone manually bumps the pin, which is the silent-drift case the guard exists to prevent in the first place.
2. **Fail-loud on upstream breakage is the correct posture.** If upstream publishes a bad release, every harness PR fails fast. That is louder than silently misleading the agent until someone notices weeks later. Recovery is also fast: upstream re-publishes, or harness adapts the mirror in a focused PR.
3. **CI fragility from npm-registry transient blips is bounded.** A 5xx from `registry.npmjs.org` fails one CI step; rerunning fixes it. No state is corrupted, no data is lost. The implicit trade-off accepts the occasional registry-flake retry in exchange for permanent drift detection.
4. **The mixed option carries its own coordination cost.** A scheduled cron drift check would need a separate alert path (issue creation, on-call routing, or a dashboard) to be noticed at all. The current PR-blocking signal is already on the path of every shipping change, which is the right moment for the maintainer to learn about drift.

## Reopen criteria

Reconsider this decision if any of the following become true:

- Upstream cadence becomes much faster than harness cadence, so that every other harness PR is blocked on the latest upstream version having an as-yet-unmirrored section.
- Registry-flake noise during CI exceeds the value of drift detection (would need data: more than 1 false fail per week sustained).
- A similar drift-guard is added for an upstream that is less stable than `@lannguyensi/understanding-gate`, where pinning is justified on a per-guard basis. In that case this decision still stands for the UG guard.

## Consequences

- The current `scripts/check-ug-schema-drift.mjs:107` call to `npm pack @latest` stays as the canonical fetch path.
- New drift-guards for other upstreams should default to the same posture unless the upstream's release cadence or stability argues otherwise.
- This document is the canonical reference for the decision; the agent-tasks comment thread on 40452b01 is the longer-form discussion log.
