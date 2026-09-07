import { z } from "zod";

// `session_start_preflight` (task 30183330) — optional, default-OFF
// config block for `harness session-start preflight` (and its
// top-level alias `harness preflight`). The producer itself lives in
// src/cli/session-start/index.ts; this schema only carries the
// manifest-declared knob it reads.
//
// `setup` gates whether the companion passes `--setup` through to the
// `preflight run --json <cwd>` invocation it spawns. Defaults to
// `false`: an ABSENT `session_start_preflight:` block and a
// PRESENT-but-`setup: false` block behave identically (both invoke
// `preflight run` with no `--setup`), matching every sibling
// SessionStart companion's opt-in convention (see ./toolchain-parity.ts,
// ./stale-base-check.ts) — existing manifests parse unchanged and this
// knob never surprises an operator with new install/build work inside a
// SessionStart hook until they explicitly ask for it.
//
// `--setup` runs a dependency install and, on the agent-preflight build
// this schema was authored against, a conditional `npm run build` when
// the target repo's own `.github/workflows/ci.yml` shows a build step
// before the test step (agent-preflight PR #72; released as of
// agent-preflight 0.5.0, `--setup` there is install-only, no build
// step). Either way, the whole `preflight run` child is still bounded
// by the SAME `--timeout` / `preflightTimeoutMs` that already bounds
// the companion's subprocess (`DEFAULT_PREFLIGHT_TIMEOUT_MS`,
// src/cli/session-start/index.ts) — enabling `setup` on a workspaces
// monorepo whose install+build routinely runs long should come with an
// explicit `--timeout` raise; neither this schema nor the producer ever
// raises it automatically.
export const SessionStartPreflightSchema = z
  .object({
    setup: z.boolean().default(false),
  })
  .strict();

export type SessionStartPreflightConfig = z.infer<typeof SessionStartPreflightSchema>;
