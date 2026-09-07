import { z } from "zod";

// `session_start_preflight` (task 30183330): optional, default-OFF
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
// ./stale-base-check.ts); existing manifests parse unchanged and this
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
// src/cli/session-start/index.ts); enabling `setup` on a workspaces
// monorepo whose install+build routinely runs long should come with an
// explicit `--timeout` raise; neither this schema nor the producer ever
// raises it automatically. agent-preflight's own build step gets a
// SEPARATE, larger budget (`DEFAULT_SETUP_BUILD_TIMEOUT_MS`, 300000ms,
// agent-preflight's `src/checks/shared.ts`) than this producer's default
// `--timeout` (60000ms), and `execFile`'s timeout only kills the
// `preflight` process itself, not its process group: an `npm ci` /
// build still in flight when that kill lands keeps writing into the
// target repo after this hook has already exited 0. Raise `--timeout`
// (or the target repo's own `.preflight.json` `setup.buildTimeoutMs`)
// together when enabling `setup` on a slow workspace.
//
// SECURITY: `--setup` is not inert on untrusted repository content. Its
// dependency install runs `npm ci`, which executes that repo's package
// lifecycle scripts, and its conditional build decision is read out of
// the TARGET repo's own `.github/workflows/ci.yml` `run:` lines; both
// are attacker-controlled if the repo is not already trusted (mirrors
// agent-preflight's own README warning around its MCP server's `--setup`
// / `setup.enabled` section: "a `run:` line in the target repo's own
// `.github/workflows/ci.yml` ... decides whether that repo's `build`
// script is executed on your machine ... `--setup` belongs only on
// repositories you already trust to run"). Enable this knob only for
// repositories you already trust to run their own install/build.
//
// SCOPE: a HOST-WIDE on/off switch; no per-repo scoping exists today (the
// generated hook passes no `--project`, so no project layer is consulted).
// The full scope, degradation, timeout and version notes live in ONE place,
// docs/CLI.md under `session_start_preflight.setup`, pinned by the tests
// named there; this header deliberately does not repeat them.
//
// VERSION CAVEAT (task 6993d9b5): agent-preflight 0.5.0's `--setup` was
// install-only (no conditional build, see the prose above). The build
// step described above shipped in agent-preflight 0.6.0 (tag v0.6.0,
// merge commit 2062831). `SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION`
// below is the ONE floor both `harness doctor`
// (src/cli/doctor/session-start-preflight-setup-version.ts) and the
// `init` template's `git-preflight` hook `min_version`
// (src/cli/init/templates.ts) read, so the two cannot drift apart.
export const SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION = "0.6.0";

export const SessionStartPreflightSchema = z
  .object({
    setup: z.boolean().default(false),
  })
  .strict();

export type SessionStartPreflightConfig = z.infer<typeof SessionStartPreflightSchema>;
