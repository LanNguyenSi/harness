// Hermetic-spawn guard (task 54739002). Small, reusable primitive for
// "real spawn" implementations that back a test-injectable runner (e.g.
// `owInitSpawn` in src/cli/init/interactive.ts, and the sibling
// `realClaudeMcpExec` guard planned in task 0d80e969 for
// src/io/claude-mcp.ts).
//
// Incident this guards against: PR #359 found a confirm-queue in
// tests/cli/init-interactive.test.ts that fell through the trailing
// orchestrator-workflow co-install prompt (no queued answer + no
// injected `owInitSpawn`), which let a test silently run a REAL `npx
// orchestrator-workflow init` against the checkout. The bug itself is
// already fixed (the mock confirm queue now auto-declines on an
// exhausted queue); this guard is defense-in-depth so any FUTURE gap of
// the same shape (a new call site, a reordered prompt, a queue typo)
// fails the test loudly instead of quietly spawning a real process. A
// follow-up review (same task) found the same "injectable runner + real
// default" shape unguarded at three more call sites — see the guard
// call sites listed at each `real*Spawn`/`real*Exec` function using this
// primitive for the up-to-date list.
//
// Env signal: `process.env.VITEST`, checked for a truthy, non-"false"/
// "0" value (vitest itself only ever sets it to the string "true", but
// we don't want an errant `VITEST=false` or `VITEST=0` in some outer
// environment to misfire the guard). Vitest sets this on every worker
// it runs (documented at https://vitest.dev/config/ under the `env`/
// `VITEST_*` variables it exposes to test code) and nothing else in
// this repo's runtime or CI sets it deliberately. That makes it safe to
// gate on for THIS repo's own `harness init`/`harness doctor` runs: a
// real, standalone invocation will never have VITEST set.
//
// Caveat (precision, not a promise): `process.env` is inherited by
// child processes, so this guard only detects "a vitest process is
// somewhere in the current process's inheritance chain" — e.g. if some
// OTHER project's vitest run were to shell out to `harness init` as a
// subprocess, that subprocess would inherit VITEST=true and this guard
// would (correctly, for ITS OWN purpose) fire there too. That is a
// deliberately conservative false-positive, not a gap: it never
// misfires in the other direction (a real, non-test-nested `harness
// init` run never sees VITEST set), which is the property that matters
// — the guard must never break a genuine production run.
//
// Deliberately NOT `NODE_ENV === "test"`: that var is set broadly by
// other tooling (bundlers, some CI steps) for reasons unrelated to "am I
// inside vitest right now", so it would risk misfiring outside of tests
// and breaking real `harness init` runs — the one thing this guard must
// never do.
//
// Escape hatch: `HARNESS_ALLOW_REAL_SPAWN=1` disables the guard even
// under vitest. This exists for a test that deliberately wants to
// exercise the REAL spawn path end-to-end (e.g. a manual, opt-in
// integration check) — it must not be set in normal test runs, CI, or
// production, and no test in this repo sets it today. Because this is a
// SILENT global kill-switch for all four guarded call sites, activating
// it under vitest prints a one-time stderr warning (module-local flag,
// not per-call) so an accidentally-set env var is visible in test output
// instead of quietly disabling every tripwire in this file.
//
// Call this at the very top of a "real spawn" function (the one a
// caller falls back to via `opts.someSpawn ?? realSomeSpawn`), BEFORE
// touching `child_process`. It throws instead of returning so a caller
// whose surrounding try/catch degrades ordinary spawn failures to a
// warning (e.g. "OW is optional, warn and continue") does not
// accidentally swallow a hermetic violation too — callers must
// re-throw `HermeticSpawnViolationError` past any such catch (see
// offerOrchestratorWorkflow in src/cli/init/interactive.ts for the
// pattern).

/**
 * Thrown by {@link assertNoRealSpawnInTests} when a real-spawn code path
 * runs under vitest without a test-injected fake. Callers whose
 * surrounding try/catch degrades ordinary runner failures to a warning
 * MUST re-throw instances of this class past that catch — never let it
 * be treated as an ordinary (optional, warn-and-continue) failure.
 */
export class HermeticSpawnViolationError extends Error {
  constructor(binaryLabel: string, hint: string) {
    super(
      `Refusing to spawn a REAL "${binaryLabel}" process while running under vitest ` +
        `(process.env.VITEST is set). ${hint}`,
    );
    this.name = "HermeticSpawnViolationError";
  }
}

/** True when `process.env.VITEST` is set to a truthy, non-"false"/"0" value. */
function vitestEnvIsActive(): boolean {
  const v = process.env.VITEST;
  return !!v && v !== "false" && v !== "0";
}

// Module-local, one-shot: printed at most once per process, the first
// time the escape hatch is observed active under vitest. Not reset
// between calls — "one-time" means one time for the life of the
// process, not once per call site.
let printedAllowRealSpawnWarning = false;

/**
 * Guard for a "real spawn" implementation: throws
 * {@link HermeticSpawnViolationError} when called under vitest, so an
 * accidental real spawn in a test fails hard instead of silently
 * running. No-op outside of vitest (production behavior is unchanged),
 * and no-op when `HARNESS_ALLOW_REAL_SPAWN=1` is set (see module doc) —
 * the first such no-op under vitest prints a one-time stderr warning so
 * the disabled guard is visible rather than silent.
 *
 * @param binaryLabel human-readable name of what would be spawned (e.g.
 *   `"npx orchestrator-workflow init"`), used in the error message.
 * @param hint one line telling the test author what to do instead (e.g.
 *   "inject a fake `owInitSpawn` runner").
 */
export function assertNoRealSpawnInTests(binaryLabel: string, hint: string): void {
  if (process.env.HARNESS_ALLOW_REAL_SPAWN === "1") {
    if (vitestEnvIsActive() && !printedAllowRealSpawnWarning) {
      printedAllowRealSpawnWarning = true;
      process.stderr.write(
        "⚠ hermetic spawn guard DISABLED via HARNESS_ALLOW_REAL_SPAWN=1 — real spawns are allowed under vitest.\n",
      );
    }
    return;
  }
  if (vitestEnvIsActive()) {
    throw new HermeticSpawnViolationError(binaryLabel, hint);
  }
}
