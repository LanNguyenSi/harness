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
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionStartPreflight } from "../../src/cli/session-start/index.js";
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

// ── Fail-log seam repo-wide hardening (task 80f49922) ──────────────────
//
// PR/task a48b9729 protected the session-start preflight not-ready
// fail-log seam ONLY inside tests/cli/session-start/preflight.test.ts, via
// a suite-local `vi.mock("node:os")` pin. That pin does nothing for any
// OTHER test, or a child process, that calls `runSessionStartPreflight`
// without injecting `logDir`. Task 80f49922 routes the seam's default
// through `resolvePaths()` instead, so it now inherits the SAME
// throw-on-real-home-dir guard (loader.ts:45-64) already pinned above —
// repo-wide, not suite-local. Every test below runs on the default `npm
// test` hot path (no HARNESS_INTEGRATION_TESTS opt-in, no subprocess
// spawn) and exercises the public `runSessionStartPreflight` surface
// directly. Most of them deliberately do NOT mock `os`, so a regression
// that reverts to `os.homedir()` would be caught by writing into this
// process's REAL `os.homedir()`-based `~/.harness/logs/` — the exact
// leak this task closes; those tests snapshot that real directory
// before and assert it is unchanged after, plus sweep it in `finally` as
// a defensive cleanup in case a regression DOES write there. The one
// exception is the legacy-fallback test near the bottom, which mocks
// `node:os` (scoped to that single test via `vi.doMock` + a dynamic
// re-import) because the legacy ~/.claude/ precedence tier can only be
// reached by controlling what `os.homedir()` itself returns — see that
// test's comment for why.
describe("session-start fail-log dir resolution (task 80f49922)", () => {
  /** Minimal `.git/HEAD`-only fixture — same shape resolveGitContext reads
   * in tests/cli/session-start/preflight.test.ts's makeRepoFixture. */
  function makeRepoFixture(root: string, name: string): string {
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  function captureStderr(): { stream: NodeJS.WritableStream; output: () => string } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString("utf8"));
        cb();
      },
    });
    return { stream, output: () => chunks.join("") };
  }

  const notReady = async (): Promise<{ ok: true; json: { ready: boolean; confidence: number; checks: Array<{ name: string; status: string }> } }> => ({
    ok: true,
    json: { ready: false, confidence: 0.2, checks: [{ name: "x", status: "fail" }] },
  });

  /**
   * Real `<os.homedir()>/.harness/logs/` directory, snapshotted so a
   * test can assert it is byte-for-byte unchanged afterward. Shared by
   * every test below that deliberately omits `homeDir`/`configPath` (and
   * therefore needs `HARNESS_ALLOW_REAL_GENERATED_DIR=1` to get past the
   * guard) — those are the only cases where a regression could plausibly
   * fall through to the operator's real home dir.
   */
  function snapshotRealFailLogDir(): { dir: string; before: string[] | null } {
    const dir = path.join(os.homedir(), ".harness", "logs");
    const before = fs.existsSync(dir) ? fs.readdirSync(dir) : null;
    return { dir, before };
  }

  function assertRealFailLogDirUnchanged(snap: { dir: string; before: string[] | null }): void {
    const after = fs.existsSync(snap.dir) ? fs.readdirSync(snap.dir) : null;
    expect(after).toEqual(snap.before);
  }

  /** Best-effort sweep: only removes entries a given probe could plausibly
   * have written (sanitizeForFilename keeps the repo name as a literal
   * filename prefix), never touches pre-existing operator files. */
  function sweepRealFailLogDir(dir: string, filenamePrefix: string): void {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(filenamePrefix)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* best-effort */
        }
      }
    }
  }

  it("blocks the not-ready fail-log write instead of falling back to the real home dir when homeDir/configPath are not injected", async () => {
    const realSnap = snapshotRealFailLogDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-osi-guard-"));
    try {
      const repo = makeRepoFixture(root, "guard-probe-repo");
      const { stream: stderr, output: errOut } = captureStderr();

      const result = await runSessionStartPreflight({
        stdin: Readable.from([JSON.stringify({ session_id: "s", cwd: repo })]),
        stderr,
        runPreflight: notReady,
        writeLedger: async () => ({ ok: true }),
        // Deliberately no homeDir / configPath / logDir — the exact
        // caller mistake the guard exists to catch.
      });

      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      expect(errOut()).toContain("preflight fail-log write failed");
      expect(errOut()).toContain("resolvePaths refused to fall back");
      assertRealFailLogDirUnchanged(realSnap);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      sweepRealFailLogDir(realSnap.dir, "preflight-guard-probe-repo-");
    }
  });

  it("resolves the not-ready fail-log dir under an injected homeDir with no logDir given (hermetic — no real-home dependency, no ALLOW_REAL flag needed)", async () => {
    // Unlike the tests below, this one injects opts.homeDir directly, so
    // resolveHomeDir() short-circuits at its "explicit" precedence tier
    // and never calls os.homedir() at all (see runtime/home-dir.ts). That
    // means (1) it needs no HARNESS_ALLOW_REAL_GENERATED_DIR=1 escape
    // hatch — the resolvePaths() guard only fires when BOTH homeDir and
    // configPath are omitted — and (2) it cannot leak into the real home
    // by construction, so no snapshot/sweep is needed either. It still
    // kills the same os.homedir()-hardcoding mutant as the real-home
    // tests: if defaultFailLogDir() reverted to
    // `path.join(os.homedir(), ".harness", "logs")` instead of routing
    // through `resolvePaths(opts)`, the log file would land under this
    // process's actual home dir instead of the injected tmp `homeDir`,
    // and the assertion below would fail.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-osi-guard-homedir-"));
    const injectedHome = path.join(root, "injected-home");
    fs.mkdirSync(injectedHome, { recursive: true });
    const repo = makeRepoFixture(root, "homedir-repo");
    try {
      const { stream: stderr } = captureStderr();
      const result = await runSessionStartPreflight({
        stdin: Readable.from([JSON.stringify({ session_id: "s", cwd: repo })]),
        stderr,
        runPreflight: notReady,
        writeLedger: async () => ({ ok: true }),
        homeDir: injectedHome,
      });

      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      const expectedLogDir = path.join(injectedHome, "logs");
      expect(fs.existsSync(expectedLogDir)).toBe(true);
      const files = fs
        .readdirSync(expectedLogDir)
        .filter((name) => name.startsWith("preflight-homedir-repo-"));
      expect(files).toHaveLength(1);
      expect(result.reason).toContain(`; log: ${path.join(expectedLogDir, files[0]!)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the not-ready fail-log dir under an injected configPath with no homeDir/logDir given (--config divergence, task 80f49922 finding 2)", async () => {
    // `resolvePaths()` (loader.ts) sets `base = opts.configPath ??
    // path.join(home, DEFAULT_BASENAME)` — when configPath is injected,
    // it becomes the manifest path VERBATIM and does not route through
    // home-dir resolution at all. defaultFailLogDir() derives the log
    // dir from `path.dirname(resolvePaths(opts).base)`, so injecting
    // configPath alone (no homeDir) should land the fail-log under
    // `dirname(configPath)/logs`, which can diverge from `<home>/logs`
    // whenever configPath does not live inside the harness home dir —
    // e.g. `harness --config ./local.harness.yaml`. Hermetic like the
    // homeDir test above: configPath bypasses the resolvePaths() guard
    // (it only requires ONE of homeDir/configPath), so no ALLOW_REAL
    // flag or real-home snapshot is needed.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-osi-guard-configpath-"));
    const configPath = path.join(root, "custom-config-dir", "harness.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "schemaVersion: 1\n");
    const repo = makeRepoFixture(root, "configpath-repo");
    try {
      const { stream: stderr } = captureStderr();
      const result = await runSessionStartPreflight({
        stdin: Readable.from([JSON.stringify({ session_id: "s", cwd: repo })]),
        stderr,
        runPreflight: notReady,
        writeLedger: async () => ({ ok: true }),
        configPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      const expectedLogDir = path.join(path.dirname(configPath), "logs");
      expect(fs.existsSync(expectedLogDir)).toBe(true);
      const files = fs
        .readdirSync(expectedLogDir)
        .filter((name) => name.startsWith("preflight-configpath-repo-"));
      expect(files).toHaveLength(1);
      expect(result.reason).toContain(`; log: ${path.join(expectedLogDir, files[0]!)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the not-ready fail-log dir via $HARNESS_HOME instead of hardcoding ~/.harness", async () => {
    // Why this test still needs HARNESS_ALLOW_REAL_GENERATED_DIR=1 even
    // after the hermetic homeDir-injection test above exists: that test
    // covers resolveHomeDir()'s "explicit" precedence tier, but proving
    // $HARNESS_HOME itself is honored requires exercising the "env" tier
    // specifically, which only fires when opts.homeDir is undefined. An
    // undefined homeDir + undefined configPath is exactly what trips the
    // resolvePaths() guard, so the ALLOW_REAL escape hatch is the only
    // way to reach this tier at all. Secured the same way the
    // no-injection test above is: real-home snapshot before, asserted
    // unchanged after, defensive sweep in `finally` — a regression in
    // $HARNESS_HOME handling could otherwise fall through to the
    // operator's actual home dir.
    const realSnap = snapshotRealFailLogDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-osi-guard-envhome-"));
    const customHome = path.join(root, "custom-harness-home");
    fs.mkdirSync(customHome, { recursive: true });
    const repo = makeRepoFixture(root, "envhome-repo");

    const priorHarnessHome = process.env["HARNESS_HOME"];
    const priorAllowReal = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
    process.env["HARNESS_HOME"] = customHome;
    // Mirrors what the real CLI binary (src/cli/main.ts) always sets
    // before any resolvePaths() call. Needed here because this test
    // deliberately does NOT inject opts.homeDir/opts.configPath, so it
    // can exercise resolveHomeDir()'s $HARNESS_HOME env-var precedence
    // tier the same way an operator who exports $HARNESS_HOME would in
    // production.
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
    try {
      const { stream: stderr } = captureStderr();
      const result = await runSessionStartPreflight({
        stdin: Readable.from([JSON.stringify({ session_id: "s", cwd: repo })]),
        stderr,
        runPreflight: notReady,
        writeLedger: async () => ({ ok: true }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      const expectedLogDir = path.join(customHome, "logs");
      expect(fs.existsSync(expectedLogDir)).toBe(true);
      const files = fs
        .readdirSync(expectedLogDir)
        .filter((name) => name.startsWith("preflight-envhome-repo-"));
      expect(files).toHaveLength(1);
      expect(result.reason).toContain(`; log: ${path.join(expectedLogDir, files[0]!)}`);
      assertRealFailLogDirUnchanged(realSnap);
    } finally {
      if (priorHarnessHome === undefined) delete process.env["HARNESS_HOME"];
      else process.env["HARNESS_HOME"] = priorHarnessHome;
      if (priorAllowReal === undefined) delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
      else process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = priorAllowReal;
      fs.rmSync(root, { recursive: true, force: true });
      sweepRealFailLogDir(realSnap.dir, "preflight-envhome-repo-");
    }
  });

  it("resolves the not-ready fail-log dir via the legacy ~/.claude/ fallback when neither $HARNESS_HOME nor ~/.harness exist", async () => {
    // The legacy-fallback precedence tier lives in resolveHomeDir()
    // (runtime/home-dir.ts) and reads os.homedir() DIRECTLY — the
    // LoaderOptions surface (`opts.homeDir`) has no way to inject a fake
    // *user* home for this check, only an explicit *harness* home dir,
    // which would short-circuit past this tier entirely (see the
    // hermetic homeDir test above). vi.spyOn(os, "homedir") cannot
    // substitute for this either — Node ESM module namespaces are not
    // configurable, so spyOn throws "Cannot redefine property: homedir"
    // (verified against this repo's actual vitest/Node versions). The
    // only working substitute is mocking the "node:os" module itself.
    // Doing that with the suite-wide `vi.mock` this file's sibling
    // sentinel tests rely on (top of file) would break THEM, since they
    // depend on the REAL operator os.homedir() to find/restore the real
    // pause sentinel. So this test scopes the mock to itself: `vi.doMock`
    // (not the hoisted `vi.mock`) + `vi.resetModules()` + a dynamic
    // `import()` of session-start/index.js AFTER registering the mock,
    // so only this test's freshly-loaded copy of the module graph (and
    // its `resolveHomeDir` -> `node:os` dependency) sees the fake
    // os.homedir(); the file's static top-level `runSessionStartPreflight`
    // import, and every other test's use of the real `os` import, are
    // unaffected (verified with a standalone probe before writing this
    // test: a later test using the static import still observed the
    // real os.homedir()). `vi.doUnmock` + a second `resetModules()` in
    // `finally` restore the registry so no later test in this file (or
    // worker) inherits the mock.
    const realSnap = snapshotRealFailLogDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-osi-guard-legacy-"));
    const fakeUserHome = path.join(root, "fake-user-home");
    const legacyDir = path.join(fakeUserHome, ".claude");
    // legacyHasHarnessState() (runtime/home-dir.ts) only checks for
    // EXISTENCE of harness.yaml or harness.generated/, never parses it.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "harness.yaml"), "schemaVersion: 1\n");
    const repo = makeRepoFixture(root, "legacy-repo");

    const priorHarnessHome = process.env["HARNESS_HOME"];
    const priorAllowReal = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
    // Must be unset: a real $HARNESS_HOME would win the "env" tier before
    // resolveHomeDir() ever reaches the legacy disk check this test
    // targets.
    delete process.env["HARNESS_HOME"];
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";

    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      const homedir = (): string => fakeUserHome;
      return { ...actual, homedir, default: { ...actual, homedir } };
    });

    try {
      const dynamicModule = await import("../../src/cli/session-start/index.js");
      const { stream: stderr } = captureStderr();
      const result = await dynamicModule.runSessionStartPreflight({
        stdin: Readable.from([JSON.stringify({ session_id: "s", cwd: repo })]),
        stderr,
        runPreflight: notReady,
        writeLedger: async () => ({ ok: true }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      const expectedLogDir = path.join(legacyDir, "logs");
      expect(fs.existsSync(expectedLogDir)).toBe(true);
      const files = fs
        .readdirSync(expectedLogDir)
        .filter((name) => name.startsWith("preflight-legacy-repo-"));
      expect(files).toHaveLength(1);
      expect(result.reason).toContain(`; log: ${path.join(expectedLogDir, files[0]!)}`);
      // Defensive: the mock is scoped to this test's own dynamic import,
      // so a working mock should never have touched the real home either.
      assertRealFailLogDirUnchanged(realSnap);
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
      if (priorHarnessHome === undefined) delete process.env["HARNESS_HOME"];
      else process.env["HARNESS_HOME"] = priorHarnessHome;
      if (priorAllowReal === undefined) delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
      else process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = priorAllowReal;
      fs.rmSync(root, { recursive: true, force: true });
      sweepRealFailLogDir(realSnap.dir, "preflight-legacy-repo-");
    }
  });
});
