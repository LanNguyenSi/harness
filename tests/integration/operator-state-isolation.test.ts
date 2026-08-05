// Integration pin for the operator-state-isolation acceptance smoke.
//
// PR #199 introduced the `HARNESS_ALLOW_REAL_GENERATED_DIR` env-var guard
// in `resolvePaths` and verified the acceptance criterion ("vitest suite
// passes even when the operator has a real `harness pause` sentinel in
// `~/.claude/harness.generated/.harness-paused`") MANUALLY. This test
// encodes that smoke as a vitest case so a future regression that only
// manifests under non-empty operator state cannot slip past the unit-tier
// pin in `tests/cli/loader-isolation.test.ts`.
//
// Env-leak sibling (task 6ffa5672): the same failure class is reachable
// WITHOUT a missing guard when a parent process leaks
// HARNESS_ALLOW_REAL_GENERATED_DIR=1 into a vitest child, which is what
// `harness preflight`'s spawned npm-test check did (the launcher sets the
// flag for the real binary). That vector is closed at the spawn site
// (spawnPreflight passes preflightChildEnv(), parent env minus the flag)
// and pinned by the real-spawn regression in
// tests/cli/session-start/preflight.test.ts; this file deliberately keeps
// covering the no-flag hermetic baseline only.
//
// Why opt-in (HARNESS_INTEGRATION_TESTS=1): the test spawns a full
// `vitest run` subprocess (~3-5s) and mutates the operator's real
// `~/.claude/` for the duration of the run. Restoring state is wrapped
// in try/finally so a crash never leaves a phantom sentinel behind, but
// the test should still not be on the default CI hot path.
//
// Why spawn (not in-process): running vitest INSIDE a vitest test would
// self-contaminate (the inner run discovers the outer's test files and
// runs them again, plus the planted sentinel would be visible to both
// runs). The subprocess gets a clean module state.
//
// Why `process.execPath` + resolveVitestEntry(), not `npx vitest` (task
// 052f9d5b review H1): this file's suite runs under the SAME
// vitest.config.ts as everything else, so the suite-wide hermetic spawn
// allowlist (tests/_helpers/hermetic-spawn-allowlist.ts) is active here
// too. `npx` resolves to a real, non-fixture, non-INFRA binary, so a
// `spawnSync("npx", [...])` here is a genuine, correctly-blocked
// violation under that guard — and CI (.github/workflows/ci.yml) runs
// `npm run test:integration` unconditionally on every push/PR, so this
// broke CI outright, not just a local opt-in run (the default `npm test`
// skips this describe entirely via `describe.skipIf` below, which is
// exactly why the earlier `npx`-based version's own suite runs never
// caught it). `process.execPath` is D6-INFRA-allowlisted; pairing it with
// vitest's own resolved CLI entry (not a shell command string) is the
// same pattern this repo's other nested-`vitest run` proofs already use
// — see tests/_helpers/nested-vitest.ts and
// tests/runtime/hermetic-spawn-allowlist-nested-fixtures.test.ts.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentinelPath, writeSentinel } from "../../src/runtime/pause-sentinel.js";
import { resolveVitestEntry } from "../_helpers/nested-vitest.js";

const REAL_GENERATED_DIR = path.join(os.homedir(), ".claude", "harness.generated");
const SENTINEL_PATH = sentinelPath(REAL_GENERATED_DIR);

interface SentinelSnapshot {
  existed: boolean;
  content: string | null;
  // Whether REAL_GENERATED_DIR itself was already on disk before this test
  // ran. beforeEach's `fs.mkdirSync(REAL_GENERATED_DIR, { recursive: true })`
  // creates that directory on any machine where the operator has never run
  // the real harness CLI (nothing else in this repo's default test run
  // touches it, guarded by HARNESS_ALLOW_REAL_GENERATED_DIR in loader.ts).
  // Only the sentinel FILE inside it was being torn down below, leaving an
  // empty `harness.generated` directory behind in the operator's real home
  // after every `npm run test:integration` run. Tracking this here lets
  // restoreSentinel remove exactly what beforeEach created, mirroring the
  // sentinel-file restore instead of adding a separate cleanup step.
  generatedDirExisted: boolean;
}

function snapshotSentinel(): SentinelSnapshot {
  const generatedDirExisted = fs.existsSync(REAL_GENERATED_DIR);
  try {
    return { existed: true, content: fs.readFileSync(SENTINEL_PATH, "utf8"), generatedDirExisted };
  } catch {
    return { existed: false, content: null, generatedDirExisted };
  }
}

function restoreSentinel(snap: SentinelSnapshot): void {
  try {
    if (snap.existed && snap.content !== null) {
      fs.writeFileSync(SENTINEL_PATH, snap.content);
    } else {
      // Was absent before the test; remove our planted file. rmSync with
      // force:true is idempotent so a missing file is a no-op (e.g. if
      // an inner vitest run already auto-resumed the expired sentinel).
      fs.rmSync(SENTINEL_PATH, { force: true });
    }
  } catch {
    /* best-effort; the operator can manually clean up if this fails */
  }
  if (!snap.generatedDirExisted) {
    // Undo beforeEach's mkdirSync so the directory does not outlive the
    // test the same way the sentinel file above does not. rmdirSync is
    // non-recursive and only succeeds on an empty directory, so if
    // anything besides our sentinel landed inside during the run, it is
    // left alone rather than force-deleted.
    try {
      fs.rmdirSync(REAL_GENERATED_DIR);
    } catch {
      /* not empty, already gone, or other benign race; best-effort */
    }
  }
}

// Whole describe is skipped unless the operator explicitly opts in.
// Default `npm test` discovers the file (vitest.config.ts include glob
// matches), prints "1 skipped" in the per-file summary, and moves on.
describe.skipIf(!process.env["HARNESS_INTEGRATION_TESTS"])(
  "operator-state-isolation: full suite passes with a planted pause sentinel (PR #201)",
  () => {
    let snap: SentinelSnapshot;
    // Process-level safety net: vitest's afterEach does not fire on
    // SIGINT / SIGTERM / uncaughtException, so a ctrl-C or OOM mid-spawn
    // would leave the operator's runtime paused for 1h. Register a
    // handler in beforeEach + remove in afterEach so the window of risk
    // is exactly the duration of this test.
    let onExit: (() => void) | null = null;

    beforeEach(() => {
      snap = snapshotSentinel();
      fs.mkdirSync(REAL_GENERATED_DIR, { recursive: true });
      writeSentinel(REAL_GENERATED_DIR, {
        pausedAt: new Date().toISOString(),
        // 1h from now: long enough that the planted sentinel stays
        // "active" across the spawned vitest run, short enough that an
        // accidental orphan won't outlive an operator's normal day.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: "integration test (operator-state-isolation)",
        pausedBy: `vitest-integration@${os.userInfo().username}`,
      });
      onExit = (): void => restoreSentinel(snap);
      process.on("exit", onExit);
      process.on("SIGINT", onExit);
      process.on("SIGTERM", onExit);
    });

    afterEach(() => {
      restoreSentinel(snap);
      if (onExit !== null) {
        process.off("exit", onExit);
        process.off("SIGINT", onExit);
        process.off("SIGTERM", onExit);
        onExit = null;
      }
    });

    it("spawned `vitest run` returns exit 0 despite operator paused-sentinel", () => {
      // Pre-flight: confirm the planted sentinel is actually on disk.
      // Without this, a test that silently failed to write would assert
      // a vacuous green.
      expect(fs.existsSync(SENTINEL_PATH)).toBe(true);

      // Strip HARNESS_INTEGRATION_TESTS from the spawned env so the
      // subprocess does NOT re-run this same test (would recurse, plus
      // would re-snapshot the already-planted sentinel and corrupt
      // the restore).
      const childEnv = { ...process.env };
      delete childEnv["HARNESS_INTEGRATION_TESTS"];

      const result = spawnSync(
        process.execPath,
        [
          resolveVitestEntry(),
          "run",
          "--silent",
          // Excluding tests/integration/** is also a defence against
          // recursion, in case a future contributor wires another
          // integration test that watches env independently.
          "--exclude",
          "tests/integration/**",
        ],
        {
          cwd: path.resolve(__dirname, "..", ".."),
          env: childEnv,
          encoding: "utf8",
          timeout: 5 * 60 * 1000, // 5 min; full suite is ~4s on a warm cache, generous slack for CI.
        },
      );

      if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        throw new Error(
          [
            `spawned vitest exceeded its 5-minute timeout (full suite normally ~4s).`,
            "Likely causes: a real hang in the suite, the spawn-vitest binary itself",
            "going interactive, or CI-load resource starvation.",
            "--- stdout (truncated by timeout) ---",
            result.stdout ?? "",
            "--- stderr (truncated by timeout) ---",
            result.stderr ?? "",
          ].join("\n"),
        );
      }
      if (result.status !== 0) {
        // Surface the subprocess output so a regression is debuggable
        // without re-running by hand.
        throw new Error(
          [
            `spawned vitest exit ${result.status}; suite did NOT pass with planted sentinel.`,
            "--- stdout ---",
            result.stdout,
            "--- stderr ---",
            result.stderr,
          ].join("\n"),
        );
      }

      // Sanity: the sentinel should still be on disk after the spawn
      // (no inner test should have deleted it; auto-resume only fires
      // for an EXPIRED sentinel, and we set 1h out).
      expect(fs.existsSync(SENTINEL_PATH)).toBe(true);
    }, 6 * 60 * 1000); // vitest's per-test timeout, slightly above the spawn timeout
  },
);
