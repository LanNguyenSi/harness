import { defineConfig } from "vitest/config";

// A small family of files (tests/policies/ledger-client.test.ts,
// tests/probes/mcp.test.ts, tests/runtime/ledger-add.test.ts,
// tests/io/ledger-record.test.ts, tests/cli/doctor-codex.test.ts)
// spawns real child processes (execa) and races their own
// spawn/init/exit/IPC latency against a fixed local test-timeout budget
// (250-2000ms). With no pool/concurrency limits, vitest's default pool
// ("forks") runs up to `cpus-1` file-workers concurrently; on a 12-core
// local dev machine that is 11 concurrent forked workers, each of which
// can ALSO spawn its own real child process when running one of the
// family files. That oversubscribes the machine's cores just often
// enough to intermittently blow the family's tight local budget, even
// though the same suite is consistently green in CI (ubuntu-latest,
// ~4 vCPUs → default maxWorkers ~3, already below the cap set here — see
// caveat below). See .ai/runs/2026-07-18-harness-subprocess-test-deflake/
// for the full diagnosis and history (a prior timeout-only bump, commit
// 2246458, did not fix this on its own either).
//
// This is a PROBABILISTIC mitigation, not a structural guarantee: this
// file caps concurrency (attacks the "many competing workers" side of the
// race); tests/policies/ledger-client.test.ts, tests/probes/mcp.test.ts,
// tests/runtime/ledger-add.test.ts and tests/io/ledger-record.test.ts
// separately raise the family's own success-path timeout budgets (attacks
// the "budget too tight for cold-spawn latency" side — see the per-test
// comments in those files, task T-002). A first pass shipping maxWorkers=6
// alone looked green across 8 local runs, but an independent reviewer
// re-validation (6 strictly sequential full-suite runs) still hit 2 red
// runs with the original flake signatures — maxWorkers alone did not
// measurably move the failure rate. Combining both levers is expected to
// be materially more reliable (fewer competing workers *and* more
// headroom per family test) but full elimination on a loaded machine
// cannot be proven from a finite number of green local runs; see the
// T-002 implementer report for the actual validation run count and any
// residual risk notes.
//
// A vitest "projects" split was also tried (subprocess family in its own
// project with `sequence.groupOrder` set higher, so it runs in a fully
// separate, non-overlapping scheduling phase after the rest of the
// suite, with its own reduced `maxWorkers`). That gives *perfect*
// isolation (zero concurrent contention) for however long that phase
// runs, but vitest runs groupOrder phases strictly sequentially, so the
// family's own phase (bound by its slowest file, ~13-17s even at full
// internal parallelism) is pure added wall time on top of the rest of
// the suite: measured local wall time went from a 33.68s baseline to a
// consistent ~50s (+~48%), well over the +25% wall-time budget for this
// task. Vitest has no built-in way to give one subset of files a lower
// concurrency cap than the rest of the suite *while still running them
// concurrently* (per-group `maxWorkers` is shared by every project in
// that group; see groupSpecs()/executeTests() in vitest's core), so
// partial, still-overlapping throttling isn't natively expressible
// without a custom scheduler. A global `maxWorkers` cap was chosen
// instead as the mechanism that fits the wall-time budget.
//
// CI caveat: `maxWorkers` is a root-level (not per-project) option, so it
// also applies when `npm run test:cov` runs in CI. Today that's a no-op
// because ubuntu-latest's own default (`cpus-1`, ~3 on a 4-vCPU runner)
// already resolves below this cap — but if GitHub ever raises the
// runner's core count to 7+, this cap would start silently constraining
// CI concurrency too, unlike a per-project scoped setting would.
//
// Combined validation (maxWorkers=6 + the raised success-path budgets):
// 10/10 consecutive `npx vitest run` runs green (exit 0), wall time
// 37.6s-40.4s (avg ~38.8s, +12-20% vs the 33.68s baseline, within the
// +25% budget); one green `npm run test:cov` run (43.2s) with coverage
// thresholds intact. See the T-002 implementer report (this branch) for
// full detail and the residual-risk assessment (10 green runs narrows
// but does not eliminate the probabilistic risk noted above).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Suite-wide deny-by-default spawn allowlist (task 052f9d5b): patches
    // all seven node:child_process launch points so a FUTURE real spawn
    // of a non-allowlisted binary — at the point THIS process actually
    // launches it — fails hard, instead of only after someone measures
    // it. This does not cover what an allowlisted interpreter (sh/node)
    // or a forked child, in turn, spawns on its own — see that file's
    // "Residual exposure" note. Full rationale, the
    // seven-vs-four-entry-point finding, and the allowlist itself live in
    // the setup file.
    // scrub-ambient-env.ts (task 5d73d78d review MEDIUM-5): deletes
    // UNDERSTANDING_GATE_MODE before every test so the suite's pass/fail
    // does not depend on whether the operator/CI shell happens to have
    // it exported — see that file's own doc comment.
    setupFiles: [
      "./tests/_helpers/hermetic-spawn-allowlist.ts",
      "./tests/_helpers/scrub-ambient-env.ts",
    ],
    maxWorkers: 6,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/**/types.ts", "src/cli/main.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 75,
      },
    },
  },
});
