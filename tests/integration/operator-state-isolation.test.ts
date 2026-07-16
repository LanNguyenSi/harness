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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentinelPath, writeSentinel } from "../../src/runtime/pause-sentinel.js";

const REAL_GENERATED_DIR = path.join(os.homedir(), ".claude", "harness.generated");
const SENTINEL_PATH = sentinelPath(REAL_GENERATED_DIR);

interface SentinelSnapshot {
  existed: boolean;
  content: string | null;
}

function snapshotSentinel(): SentinelSnapshot {
  try {
    return { existed: true, content: fs.readFileSync(SENTINEL_PATH, "utf8") };
  } catch {
    return { existed: false, content: null };
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
        "npx",
        [
          "vitest",
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
