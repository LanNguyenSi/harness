// A full nested suite must stay isolated from active operator pause state.
// Each test owns a scratch user home; a child preload redirects os.homedir
// before harness modules load, so interruption cannot leave live state paused.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionStartPreflight } from "../../src/cli/session-start/index.js";
import { readSentinel, sentinelPath } from "../../src/runtime/pause-sentinel.js";
import { resolveVitestEntry } from "../_helpers/nested-vitest.js";
import { createOperatorStateFixture, operatorStateChildEnv, type OperatorStateFixture } from "../_helpers/operator-state-isolation-runner.js";

describe.skipIf(!process.env["HARNESS_INTEGRATION_TESTS"])(
  "operator-state-isolation: full suite passes with a planted pause sentinel",
  () => {
    let fixture: OperatorStateFixture;
    beforeEach(() => { fixture = createOperatorStateFixture(); });
    afterEach(() => { if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true }); });

    it("spawned full suite stays isolated while the fixture sentinel remains active", () => {
      const sentinel = sentinelPath(fixture.generatedDir);
      const before = fs.readFileSync(sentinel, "utf8");
      expect(readSentinel(fixture.generatedDir).kind).toBe("active");
      const result = spawnSync(process.execPath, [
        resolveVitestEntry(), "run", "--silent", "--exclude", "tests/integration/**",
      ], {
        cwd: path.resolve(__dirname, "..", ".."),
        env: operatorStateChildEnv(fixture),
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
      });
      // Child startup must have observed both the fake user home and pause;
      // a missing preload or failed fixture setup cannot produce a vacuous pass.
      const proof = JSON.parse(fs.readFileSync(path.join(fixture.proofDir, `${result.pid}.json`), "utf8"));
      expect(proof).toMatchObject({ pid: result.pid, userHome: fixture.userHome, sentinel, active: true });
      if (result.error || result.status !== 0) {
        throw new Error([
          `spawned vitest did not pass with active fixture sentinel (exit ${result.status}, signal ${result.signal}): ${result.error?.message ?? ""}`,
          "--- stdout ---", result.stdout, "--- stderr ---", result.stderr,
        ].join("\n"));
      }
      expect(fs.readFileSync(sentinel, "utf8")).toBe(before);
      expect(readSentinel(fixture.generatedDir).kind).toBe("active");
    }, 6 * 60 * 1000);
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
   * filename prefix) AND that were absent from the pre-test snapshot, so
   * this literally never touches pre-existing operator files (a
   * prefix-only match could otherwise delete a real operator file that
   * happens to share the prefix, e.g. from a previous manual run under
   * the same repo name). Takes the snapshot itself, not just its `dir`,
   * so the before-list is available for the diff. */
  function sweepRealFailLogDir(snap: { dir: string; before: string[] | null }, filenamePrefix: string): void {
    if (!fs.existsSync(snap.dir)) return;
    const before = new Set(snap.before ?? []);
    for (const name of fs.readdirSync(snap.dir)) {
      if (name.startsWith(filenamePrefix) && !before.has(name)) {
        try {
          fs.unlinkSync(path.join(snap.dir, name));
        } catch {
          /* best-effort */
        }
      }
    }
  }

  it("sweepRealFailLogDir only removes prefix-matching entries absent from the snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-osi-sweep-unit-"));
    try {
      const preexisting = "preflight-sweep-unit-repo-preexisting.json";
      const unrelated = "preflight-other-repo-unrelated.json";
      fs.writeFileSync(path.join(dir, preexisting), "{}");
      fs.writeFileSync(path.join(dir, unrelated), "{}");
      const snap = { dir, before: fs.readdirSync(dir) };

      const fresh = "preflight-sweep-unit-repo-fresh.json";
      fs.writeFileSync(path.join(dir, fresh), "{}");

      sweepRealFailLogDir(snap, "preflight-sweep-unit-repo-");

      expect(fs.readdirSync(dir).sort()).toEqual([preexisting, unrelated].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
      sweepRealFailLogDir(realSnap, "preflight-guard-probe-repo-");
    }
  });

  it("resolves the not-ready fail-log dir under an injected homeDir with no logDir given (hermetic — no real-home dependency, no ALLOW_REAL flag needed)", async () => {
    // Unlike the tests below, this one injects opts.homeDir directly, so
    // resolveHomeDir() short-circuits at its "explicit" precedence tier
    // and never calls os.homedir() at all (see runtime/home-dir.ts). That
    // means it needs no HARNESS_ALLOW_REAL_GENERATED_DIR=1 escape hatch —
    // the resolvePaths() guard only fires when BOTH homeDir and configPath
    // are omitted. It still kills the same os.homedir()-hardcoding mutant
    // as the real-home tests: if defaultFailLogDir() reverted to
    // `path.join(os.homedir(), ".harness", "logs")` instead of routing
    // through `resolvePaths(opts)`, the log file would land under this
    // process's actual home dir instead of the injected tmp `homeDir`, and
    // the assertion below would fail. The real-fail-log-dir snapshot/sweep
    // below is not redundant with that: it is the regression-case
    // backstop for exactly that mutant, not insurance the current code
    // needs (the current code cannot leak into the real home by
    // construction) — it is what makes the assertion above meaningful,
    // by proving nothing landed in the real dir either.
    const realSnap = snapshotRealFailLogDir();
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
      assertRealFailLogDirUnchanged(realSnap);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      sweepRealFailLogDir(realSnap, "preflight-homedir-repo-");
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
    // (it only requires ONE of homeDir/configPath), so no ALLOW_REAL flag
    // is needed. The real-fail-log-dir snapshot/sweep below is not
    // redundant with that: it is the regression-case backstop for a
    // reverted defaultFailLogDir() (see the homeDir test's comment above
    // for the mutant this guards against), not insurance the current
    // hermetic path needs.
    const realSnap = snapshotRealFailLogDir();
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
      assertRealFailLogDirUnchanged(realSnap);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      sweepRealFailLogDir(realSnap, "preflight-configpath-repo-");
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
      sweepRealFailLogDir(realSnap, "preflight-envhome-repo-");
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
    // Registering this with the hoisted `vi.mock` form would apply
    // suite-wide and affect unrelated home-resolution cases. This test
    // scopes the mock to itself: `vi.doMock`
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

    try {
      // Must be unset: a real $HARNESS_HOME would win the "env" tier
      // before resolveHomeDir() ever reaches the legacy disk check this
      // test targets. These writes (and the mock registration below) are
      // first statements INSIDE this try block, not before it, so the
      // `finally` below unconditionally undoes them even if one of these
      // setup calls itself were to throw.
      delete process.env["HARNESS_HOME"];
      process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";

      vi.resetModules();
      vi.doMock("node:os", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:os")>();
        const homedir = (): string => fakeUserHome;
        return { ...actual, homedir, default: { ...actual, homedir } };
      });

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
      sweepRealFailLogDir(realSnap, "preflight-legacy-repo-");
    }
  });
});
