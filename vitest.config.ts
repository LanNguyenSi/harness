import { defineConfig } from "vitest/config";

// A small family of files (tests/policies/ledger-client.test.ts,
// tests/probes/mcp.test.ts, tests/runtime/ledger-add.test.ts,
// tests/runtime/ledger-record.test.ts, tests/cli/doctor-codex.test.ts)
// spawns real child processes (execa) and races their own
// spawn/init/exit/IPC latency against a fixed local test-timeout budget
// (250-2000ms). With no pool/concurrency limits, vitest's default pool
// ("forks") runs up to `cpus-1` file-workers concurrently; on a 12-core
// local dev machine that is 11 concurrent forked workers, each of which
// can ALSO spawn its own real child process when running one of the
// family files. That oversubscribes the machine's cores just often
// enough to intermittently blow the family's tight local budget, even
// though the same suite is consistently green in CI (ubuntu-latest,
// ~4 vCPUs → default maxWorkers ~3, already far below any cap set here).
// See .ai/runs/2026-07-18-harness-subprocess-test-deflake/ for the full
// diagnosis and history (a prior timeout-only bump, commit 2246458, did
// not fix this).
//
// Mechanism chosen: cap the whole suite's `maxWorkers` at 6 (half of this
// machine's 12 cores) instead of the default `cpus-1` (11). This throttles
// the CPU pressure the family experiences while it runs, without touching
// production code, test assertions, or test timeouts.
//
// A vitest "projects" split was tried first (subprocess family in its own
// project with `sequence.groupOrder` set higher, so it runs in a fully
// separate, non-overlapping scheduling phase after the rest of the suite,
// with its own reduced `maxWorkers`). That gives *perfect* isolation
// (zero concurrent contention) and was empirically verified to keep the
// family reliably green, but vitest runs groupOrder phases strictly
// sequentially, so the family's own phase (bound by its slowest file,
// ~13-17s even at full internal parallelism) is pure added wall time on
// top of the rest of the suite: measured local wall time went from a
// 33.68s baseline to a consistent ~50s (+~48%), well over the +25% wall
// time budget for this task. Vitest has no built-in way to give one
// subset of files a lower concurrency cap than the rest of the suite
// *while still running them concurrently* (per-group `maxWorkers` is
// shared by every project in that group; see groupSpecs()/executeTests()
// in vitest's core), so partial, still-overlapping throttling isn't
// natively expressible without a custom scheduler. A single global
// `maxWorkers` cap was chosen instead as the mechanism that fits the
// wall-time budget: it reduces the peak concurrent CPU pressure the
// family is exposed to (fewer competing file-workers, hence fewer
// concurrent real subprocess spawns from other family members) while
// only modestly slowing down the rest of the suite, since 6 workers is
// still generous parallelism for 148 mostly-fast unit test files.
//
// Verified empirically at maxWorkers=6: 7 consecutive `npx vitest run`
// runs all green (exit 0), local wall time 37.1s-41.2s (avg ~38.4s,
// +10-22% vs the 33.68s baseline, within the +25% budget); `npm run
// test:cov` green once with all coverage thresholds passing.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
