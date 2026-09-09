// Meta-test for the suite-wide hermetic spawn allowlist (task 052f9d5b,
// tests/_helpers/hermetic-spawn-allowlist.ts, wired in via
// vitest.config.ts's setupFiles). Proves the deny-by-default hook
// actually fires for a REAL, non-allowlisted, EXISTING binary — a
// nonexistent binary is, by design (D2), allowed through, so every
// "should block" probe here uses a real one — and stays quiet for the
// allowed classes (D2 unresolvable, D3 a test's own os.tmpdir()
// fixture, D6 the infra allowlist).
//
// The fix-pass (task 052f9d5b review) added the blocks below the
// original describe: direct exec()/execFile() coverage, the remaining
// two INFRA entries (sh, patch), the D5 per-site-guard independence
// check, the D3 textual-prefix boundary, F5's cache-staleness probe,
// F6's two resolveAbsolute fixes, F2's fork coverage, and F4's
// fail-closed heuristic. F1's "swallowed violation still fails the file"
// and F9's "afterAll restores the true original" proofs live in
// tests/runtime/hermetic-spawn-allowlist-nested-fixtures.test.ts instead
// — both require observing this file's OWN teardown from outside it,
// which needs a nested vitest subprocess, not another `it` in this file.
//
// Known limit (task 9a4a417b): the F5/F6a/F6b probes below (search
// "FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION") each need a fixture location
// that is provably OUTSIDE the D3 os.tmpdir() exemption, so a real,
// non-exempt violation is still caught rather than silently allowed
// through. That precondition fails for ANY checkout whose own root
// resolves under os.tmpdir(), not only an agent-primitives isolation
// copy: a Linux `git worktree add /tmp/...`, or a CI checkout under
// $TMPDIR, skips these three probes under a plain `npm test` too,
// silently. `agent-primitives probe`'s default `-i worktree` isolation
// is simply the common way to hit that condition, since it places its
// worktree under `--log-dir`, which itself defaults to
// `$AGENT_PRIMITIVES_LOG_DIR`, or a fresh directory under the OS temp
// dir otherwise (see that package's README, Global options,
// `-l/--log-dir`); every path inside such a copy, including
// process.cwd(), is then also under os.tmpdir(), and there is no
// directory inside the copy that is both part of the checkout and
// outside that prefix. This cannot be fixed by deriving a different path
// from this file's cwd/realpath: it is a property of WHERE the checkout
// sits, not of this test file. The remedy for `agent-primitives probe`
// specifically: pass `-l/--log-dir` (or set `AGENT_PRIMITIVES_LOG_DIR`)
// pointing outside the OS temp directory, so the isolation copy's cwd
// stays outside os.tmpdir() and all three probes run; `-i inplace` also
// avoids the condition but mutates the real checkout in place instead of
// a copy, so `--log-dir` is the primary remedy. The three affected
// probes detect the missing precondition with the exact `isUnderTmp`
// helper the guard itself uses (not a re-implementation) and skip, with
// a named reason, instead of false-failing. Everywhere the precondition
// holds, in the real checkout, and in a plain `git worktree add
// --detach` copy, which does NOT nest under os.tmpdir(), they still run
// with the exact same assertions as before this task. Where the
// precondition does NOT hold, F5/F6a/F6b's underlying fixes still keep
// location-independent coverage: their resolver-level companion
// assertions below (search "resolveAbsolute" / "resolveCached" via
// __testOnly) call the fixed code directly on fixture paths, without
// spawning, so they never consult this exemption and keep running (and
// killing the same mutants) regardless of where the checkout sits.
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoRealSpawnInTests, HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";
import { __testOnly } from "../_helpers/hermetic-spawn-allowlist.js";
import { resolveVitestEntry } from "../_helpers/nested-vitest.js";

// A real, existing, harmless, read-only system binary deliberately NOT
// on the D6 infra allowlist (git/node/sh/patch) — the canonical "should
// be blocked" probe.
const REAL_NOT_ALLOWLISTED = "/bin/ls";

// Task 9a4a417b review round 2: the guard's own `safeRealpath` (exported
// through `__testOnly`, not a hand copy that could drift): a cwd that
// vanished or is a broken symlink must not crash the whole file at
// module load; it falls back to the raw (unresolved) cwd instead.
const safeRealpathForPrecondition = __testOnly.safeRealpath;

// Task 9a4a417b: the exact fixture-shaped path the F5/F6a/F6b probes
// below create (a named directory UNDER this file's cwd), not the bare
// cwd itself: `isUnderTmp` compares a resolved path against
// `os.tmpdir()` with a trailing separator, so checking the bare cwd
// would misclassify a checkout located AT os.tmpdir() exactly (no
// separator yet) as escaping the exemption. Joining a path segment onto
// it, as every real fixture below does, removes that edge case the same
// way the pinning assertion right below does.
const PRECONDITION_FIXTURE_PATH = path.join(safeRealpathForPrecondition(process.cwd()), "hermetic-precondition-probe");

// Task 9a4a417b: true when this file's own cwd (and therefore any
// fixture the F5/F6a/F6b probes below create under it) is OUTSIDE the
// D3 os.tmpdir() exemption those probes need to exercise their real
// assertion; see the file-header comment above for why this can be
// false inside an agent-primitives isolation copy. Computed via the
// SAME `isUnderTmp` helper the guard itself checks spawns against
// (imported below as `__testOnly.isUnderTmp`), so this tracks the real
// code path rather than a separate, possibly-drifting reimplementation.
const FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION = !__testOnly.isUnderTmp(PRECONDITION_FIXTURE_PATH);

// Task 9a4a417b review round 2 (MEDIUM: the skip predicate was
// unpinned: mutating the constant above to a hardcoded `false`
// reported `survived`). This assertion is NOT gated by `skipIf`, so it
// always runs, and it recomputes the right-hand side independently
// (its own `__testOnly.isUnderTmp` call on the same fixture-shaped
// path) rather than reading the constant back: a mutant that replaces
// the constant's own expression with a literal diverges from this
// independent recomputation and fails here. True in a normal checkout
// (the fixture path is not under os.tmpdir(), so both sides are
// `true`); also true, for the same reason, inside an isolation copy
// (both sides `false`), so this passes everywhere the constant is
// correct, and only there.
it("task 9a4a417b: FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION tracks isUnderTmp of the fixture path it names, not a hardcoded value", () => {
  expect(FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION).toBe(!__testOnly.isUnderTmp(PRECONDITION_FIXTURE_PATH));
  // Round-2 review closure: pin the SHAPE of the fixture path
  // independently of the constant, so reverting it to the bare cwd (the
  // exact-at-os.tmpdir() edge the path segment exists for) fails here
  // instead of mutating both sides of the assertion above.
  const resolvedCwd = __testOnly.safeRealpath(process.cwd());
  expect(path.dirname(PRECONDITION_FIXTURE_PATH)).toBe(resolvedCwd);
  expect(PRECONDITION_FIXTURE_PATH).not.toBe(resolvedCwd);
  // And the realpath fallback itself: an unresolvable path comes back
  // unchanged rather than throwing.
  const missing = path.join(resolvedCwd, "hermetic-precondition-does-not-exist");
  expect(__testOnly.safeRealpath(missing)).toBe(missing);
});

/**
 * Runs `fn`, returns the thrown value (or undefined if it didn't throw)
 * without letting it escape. When the caught value is a
 * HermeticSpawnViolationError, this is a DELIBERATE, verified trigger
 * (every call site immediately asserts `instanceof
 * HermeticSpawnViolationError` on the result) — the opposite of F1's
 * "swallowed" pattern — so it acknowledges the violation via
 * `__testOnly.acknowledgeViolation(err)` to avoid also tripping the setup
 * file's own D8/F1 same-file hard-fail check. G1 (task 052f9d5b review,
 * second pass): acknowledgement is now identity-based, so the exact
 * caught error object must be passed — this ONLY works for a violation
 * this hook's own `reportViolation` actually pushed (i.e. one produced by
 * a REAL spawn through the patched child_process entry points). It does
 * NOT work for a HermeticSpawnViolationError from an unrelated source
 * (e.g. `assertNoRealSpawnInTests`, which this hook never recorded) — see
 * the D5 test below, which deliberately does NOT go through this helper
 * for exactly that reason.
 */
function captureThrow(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof HermeticSpawnViolationError) {
      __testOnly.acknowledgeViolation(err);
    }
    return err;
  }
}

describe("hermetic spawn allowlist (suite-wide, tests/_helpers/hermetic-spawn-allowlist.ts)", () => {
  it("throws HermeticSpawnViolationError for a real, existing, non-allowlisted absolute path (spawnSync)", () => {
    const err = captureThrow(() => spawnSync(REAL_NOT_ALLOWLISTED, ["-la"]));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("throws for the same binary resolved via a bare command name through PATH (execFileSync) — proves D1's resolve-then-check", () => {
    const err = captureThrow(() => execFileSync("ls", ["-la"]));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("throws for a command STRING via execSync — proves D4's first-token extraction", () => {
    const err = captureThrow(() => execSync(`${REAL_NOT_ALLOWLISTED} -la`));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("throws synchronously for the async spawn() entry point too (hard fail, not a swallow-able 'error' event)", () => {
    const err = captureThrow(() => spawn(REAL_NOT_ALLOWLISTED, ["-la"]));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("throws synchronously for the async exec() entry point (callback style, not just execSync)", () => {
    const err = captureThrow(() => exec(REAL_NOT_ALLOWLISTED, () => {}));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("throws synchronously for the async execFile() entry point (callback style, not just execFileSync)", () => {
    const err = captureThrow(() => execFile(REAL_NOT_ALLOWLISTED, ["-la"], () => {}));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("the thrown error names the binary, its resolved path, and the offending test file", () => {
    const err = captureThrow(() => spawnSync(REAL_NOT_ALLOWLISTED, ["-la"]));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
    const message = (err as Error).message;
    expect(message).toContain(REAL_NOT_ALLOWLISTED);
    expect(message).toContain("resolved:");
    expect(message).toContain("hermetic-spawn-allowlist.test.ts");
    expect(message).toMatch(/inject a fake/i);
  });

  it("does NOT throw a violation for a command that resolves to nothing (D2: unresolvable is allowed)", () => {
    const err = captureThrow(() =>
      spawnSync("/definitely-not-a-real-binary-hermetic-allowlist-meta-probe", []),
    );
    expect(err).not.toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("does NOT throw for a binary the test itself wrote under os.tmpdir() (D3: temp fixtures)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-allowlist-meta-"));
    try {
      const fixture = path.join(dir, "fixture.sh");
      fs.writeFileSync(fixture, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const err = captureThrow(() => execFileSync(fixture, []));
      expect(err).not.toBeInstanceOf(HermeticSpawnViolationError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT throw for node itself (D6 infra allowlist) — the same runtime executing vitest", () => {
    const result = spawnSync(process.execPath, ["--version"]);
    expect(result.status).toBe(0);
  });

  it("does NOT throw for real git (D6 infra allowlist)", () => {
    const result = spawnSync("git", ["--version"]);
    expect(result.status).toBe(0);
  });

  it("does NOT throw for real sh (D6 infra allowlist)", () => {
    const result = spawnSync("sh", ["-c", "exit 0"]);
    expect(result.status).toBe(0);
  });

  it("does NOT throw for real patch (D6 infra allowlist)", () => {
    const result = spawnSync("patch", ["--version"]);
    expect(result.status).toBe(0);
  });

  it("D5: the per-site guard primitive (assertNoRealSpawnInTests) still throws on its own, independent of this hook's child_process patching", () => {
    // Deliberately NOT routed through captureThrow (task 052f9d5b review
    // G1): assertNoRealSpawnInTests throws HermeticSpawnViolationError
    // via its own, completely separate mechanism
    // (src/runtime/hermetic-spawn-guard.ts's process.env.VITEST check) —
    // it never calls this file's reportViolation, so this hook's
    // `violations` array never gets an entry for it. Calling
    // __testOnly.acknowledgeViolation on it would now (correctly) throw
    // "this error was never recorded by the hook" — see that export's
    // doc and the G1 nested-fixture proof in
    // hermetic-spawn-allowlist-nested-fixtures.test.ts. This test only
    // needs to prove the per-site guard still throws; it has nothing to
    // acknowledge here.
    let err: unknown;
    try {
      assertNoRealSpawnInTests("test-binary-label", "test hint");
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("F2: throws for cp.fork when options.execPath resolves to a real, non-allowlisted binary (fork is a 7th entry point)", () => {
    const err = captureThrow(() =>
      fork("/definitely/not/a/real/module-hermetic-fork-probe.js", [], { execPath: REAL_NOT_ALLOWLISTED }),
    );
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });
});

describe("D3 boundary: textual-prefix sibling of os.tmpdir() is NOT exempt (task 052f9d5b review, code comment ~line 186)", () => {
  it("a directory sharing the tmpdir path as a TEXTUAL prefix WITHOUT a separator is not treated as under tmp", () => {
    const tmp = os.tmpdir();
    const withoutTrailingSep = tmp.endsWith(path.sep) ? tmp.slice(0, -1) : tmp;
    const evilSibling = `${withoutTrailingSep}-evil${path.sep}fixture.sh`;
    expect(__testOnly.isUnderTmp(evilSibling)).toBe(false);
  });

  it("a real child of os.tmpdir() IS treated as under tmp (sanity check for the same helper)", () => {
    const legitChild = path.join(os.tmpdir(), "fixture.sh");
    expect(__testOnly.isUnderTmp(legitChild)).toBe(true);
  });
});

describe("F5: resolve cache only caches positive resolutions (task 052f9d5b review)", () => {
  // Task 9a4a417b: skipped, not false-failed, when this file's cwd
  // itself is under os.tmpdir() (agent-primitives isolation copy); see
  // FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION's doc above. F5's coverage
  // stays location-independent regardless, via the resolver-level
  // companion assertion right below (task 9a4a417b review round 2).
  it.skipIf(!FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION)(
    "does not permanently cache a null (unresolvable) resolution: a binary created later at the same resolved path is still checked",
    () => {
      // G6 (task 052f9d5b review, second pass): this fixture dir is
      // created under process.cwd() (the repo root), NOT os.tmpdir():
      // do not "helpfully" move it there. os.tmpdir() is the D3 EXEMPT
      // path in tests/_helpers/hermetic-spawn-allowlist.ts itself, so a
      // binary written there would be silently allowed through
      // regardless of what this test is trying to prove. Ignored via
      // .gitignore's `hermetic-*/` entry, not deleted on the next run,
      // in case an aborted run leaves one behind.
      const dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-f5-cache-probe-"));
      try {
        const target = path.join(dir, "not-yet-a-binary");
        // Nothing exists at `target` yet: D2 allows it (and, before the
        // F5 fix, would have cached this exact `null` forever for this
        // cwd/PATH/command key).
        const first = captureThrow(() => spawnSync(target, []));
        expect(first).toBeUndefined();

        // A real binary now appears at the EXACT same resolved path.
        fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

        // Same resolved path, second call: must now be caught as a
        // real, non-allowlisted, non-tmp spawn: proves the null wasn't
        // cached.
        const second = captureThrow(() => spawnSync(target, []));
        expect(second).toBeInstanceOf(HermeticSpawnViolationError);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // Task 9a4a417b review round 2 (MEDIUM: residual coverage loss under
  // the default isolation copy). Calls `resolveCached` directly via
  // `__testOnly`, WITHOUT spawning, so it never reaches the guard's
  // D3 `isUnderTmp` exemption check at all, and runs (and kills the same
  // mutant) everywhere, including inside an agent-primitives isolation
  // copy where the spawn-level test above must skip. Fixture placement
  // under os.tmpdir() is fine here specifically because nothing is
  // spawned: D3 is a property of the spawn-interception layer, not of
  // this resolver function.
  it("resolveCached companion (location-independent): a null (unresolvable) resolution is not cached", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-f5-cache-companion-"));
    try {
      const target = path.join(dir, "not-yet-a-binary");
      const first = __testOnly.resolveCached(target, dir, undefined);
      expect(first).toBeNull();

      fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const second = __testOnly.resolveCached(target, dir, undefined);
      expect(second).toBe(fs.realpathSync(target));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F6: resolveAbsolute approximates execvp search semantics more closely (task 052f9d5b review)", () => {
  // Task 9a4a417b: skipped, not false-failed, when this file's cwd
  // itself is under os.tmpdir() (agent-primitives isolation copy); see
  // FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION's doc above. F6a's coverage
  // stays location-independent regardless, via the resolver-level
  // companion assertion right below (task 9a4a417b review round 2).
  it.skipIf(!FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION)(
    "F6a: PATH=\":/usr/bin\" resolves the leading empty entry to cwd (POSIX execvp), not \"skip\"",
    () => {
      // G6: process.cwd(), not os.tmpdir(); see the F5 test above for why.
      const dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-f6a-empty-path-probe-"));
      try {
        const binName = "hermetic-f6a-fixture-binary";
        const fixture = path.join(dir, binName);
        fs.writeFileSync(fixture, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const err = captureThrow(() =>
          execFileSync(binName, [], { cwd: dir, env: { PATH: ":/usr/bin" } }),
        );
        expect(err).toBeInstanceOf(HermeticSpawnViolationError);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // Task 9a4a417b review round 2 (MEDIUM: residual coverage loss under
  // the default isolation copy). Calls `resolveAbsolute` directly via
  // `__testOnly`, WITHOUT spawning; see the F5 companion above for why
  // this is location-independent.
  it("resolveAbsolute companion (location-independent): an empty PATH entry resolves to cwd, not \"skip\"", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-f6a-companion-"));
    try {
      const binName = "hermetic-f6a-fixture-binary-companion";
      const fixture = path.join(dir, binName);
      fs.writeFileSync(fixture, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const resolved = __testOnly.resolveAbsolute(binName, dir, ":/usr/bin");
      expect(resolved).toBe(fs.realpathSync(fixture));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task 9a4a417b: skipped, not false-failed, when this file's cwd
  // itself is under os.tmpdir() (agent-primitives isolation copy); see
  // FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION's doc above. F6b's coverage
  // stays location-independent regardless, via the resolver-level
  // companion assertion right below (task 9a4a417b review round 2).
  it.skipIf(!FIXTURE_LOCATION_ESCAPES_TMP_EXEMPTION)(
    "F6b: skips a resolved-but-non-executable candidate and keeps searching PATH (mirrors execvp's EACCES fallthrough)",
    () => {
      // G6: process.cwd(), not os.tmpdir(); see the F5 test above for why.
      const base = fs.mkdtempSync(path.join(process.cwd(), "hermetic-f6b-exec-bit-probe-"));
      try {
        const dir1 = path.join(base, "dir1");
        const dir2 = path.join(base, "dir2");
        fs.mkdirSync(dir1);
        fs.mkdirSync(dir2);
        const nonExec = path.join(dir1, "toolx");
        const realExec = path.join(dir2, "toolx");
        fs.writeFileSync(nonExec, "not executable", { mode: 0o644 });
        fs.writeFileSync(realExec, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

        const err = captureThrow(() =>
          execFileSync("toolx", [], { cwd: base, env: { PATH: `${dir1}${path.delimiter}${dir2}` } }),
        );
        expect(err).toBeInstanceOf(HermeticSpawnViolationError);
        const message = (err as Error).message;
        expect(message).toContain(fs.realpathSync(realExec));
        expect(message).not.toContain(nonExec);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  // Task 9a4a417b review round 2 (MEDIUM: residual coverage loss under
  // the default isolation copy). Calls `resolveAbsolute` directly via
  // `__testOnly`, WITHOUT spawning; see the F5 companion above for why
  // this is location-independent.
  it("resolveAbsolute companion (location-independent): a non-executable candidate is skipped in favor of the next PATH entry", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-f6b-companion-"));
    try {
      const dir1 = path.join(base, "dir1");
      const dir2 = path.join(base, "dir2");
      fs.mkdirSync(dir1);
      fs.mkdirSync(dir2);
      const nonExec = path.join(dir1, "toolx");
      const realExec = path.join(dir2, "toolx");
      fs.writeFileSync(nonExec, "not executable", { mode: 0o644 });
      fs.writeFileSync(realExec, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      const resolved = __testOnly.resolveAbsolute("toolx", base, `${dir1}${path.delimiter}${dir2}`);
      expect(resolved).toBe(fs.realpathSync(realExec));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("D4 fail-closed heuristic (task 052f9d5b review F4): exec/execSync block shell idioms the first-token heuristic can't safely resolve", () => {
  const unsafeCommands: readonly string[] = [
    "cd /tmp && npm install",
    "VAR=1 npm install",
    "export X=1; npm i",
    "(npm install)",
    "$(which npm) install",
    "'unterminated npm install",
  ];

  it.each(unsafeCommands)("fails closed for: %s", (cmdStr: string) => {
    const err = captureThrow(() => execSync(cmdStr));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
    expect((err as Error).message).toMatch(/argv-based/i);
  });

  it("does not fail-closed on an ordinary single-word command (no metacharacters/env-assign/builtin)", () => {
    const err = captureThrow(() => execSync("definitely-not-a-real-binary-hermetic-f4-probe --version"));
    // D2: unresolvable is allowed to reach the REAL execSync — which then
    // throws its own ordinary ENOENT (a ChildProcess error, not a guard
    // violation) since the command doesn't exist. The property under
    // test is narrower: this must NOT have been blocked by the
    // fail-closed check itself (no false positive).
    expect(err).not.toBeInstanceOf(HermeticSpawnViolationError);
  });
});

describe("G1 (task 052f9d5b review, second pass): acknowledgeViolation is identity-based, not positional", () => {
  it("throws when acknowledging a HermeticSpawnViolationError this hook never recorded", () => {
    const foreign = new HermeticSpawnViolationError("foreign-binary", "not produced by this hook's reportViolation");
    expect(() => __testOnly.acknowledgeViolation(foreign)).toThrow(/never recorded by the hook/);
  });

  it("acknowledging the same violation twice fails the second time — proves the first acknowledgement really removed it", () => {
    const err = captureThrow(() => spawnSync(REAL_NOT_ALLOWLISTED, ["-la"]));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
    // captureThrow already acknowledged `err` once. A positional
    // `violations.pop()` would happily "acknowledge" almost anything a
    // second time (as long as SOME entry is still on the stack); the
    // identity-based version must refuse, because `err` itself is no
    // longer in the array.
    expect(() => __testOnly.acknowledgeViolation(err)).toThrow(/never recorded by the hook/);
  });
});

describe("G2 (task 052f9d5b review, second pass): shell:true reclassifies an argv-style call as a string-style call (D9)", () => {
  it('blocks spawnSync("/bin/ls -la /", { shell: true }) — the exact G2 reproduction', () => {
    const err = captureThrow(() => spawnSync(`${REAL_NOT_ALLOWLISTED} -la /`, { shell: true }));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("blocks spawn(..., { shell: true }) the same way", () => {
    const err = captureThrow(() => spawn(`${REAL_NOT_ALLOWLISTED} -la /`, { shell: true }));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("blocks execFileSync(..., [], { shell: true }) the same way", () => {
    const err = captureThrow(() => execFileSync(`${REAL_NOT_ALLOWLISTED} -la /`, [], { shell: true }));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("blocks execFile(..., [], { shell: true }, cb) the same way", () => {
    const err = captureThrow(() => execFile(`${REAL_NOT_ALLOWLISTED} -la /`, [], { shell: true }, () => {}));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it("the D4/F4/G3 fail-closed metacharacter check also applies through the shell:true path", () => {
    const err = captureThrow(() => spawnSync("touch /tmp/hermetic-g2-probe; echo done", { shell: true }));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
    expect((err as Error).message).toMatch(/argv-based/i);
  });
});

describe("G3 (task 052f9d5b review, second pass): D4's metacharacter check scans the WHOLE command string, with an expanded character class", () => {
  it('blocks a glob-wildcard command ("/bin/l? /") that would otherwise expand via the real shell', () => {
    const err = captureThrow(() => execSync("/bin/l? /"));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
    expect((err as Error).message).toMatch(/argv-based/i);
  });

  it('blocks a tilde-expansion command ("~/../../bin/ls /")', () => {
    const err = captureThrow(() => execSync("~/../../bin/ls /"));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it('blocks a metacharacter that appears AFTER an otherwise infra-allowed first token ("git --version | /usr/bin/wc -c")', () => {
    const err = captureThrow(() => execSync("git --version | /usr/bin/wc -c"));
    expect(err).toBeInstanceOf(HermeticSpawnViolationError);
  });

  it.each(["*", "?", "[", "]", "~", "!"] as const)(
    "blocks a command string containing the G3-added metacharacter: %s",
    (ch) => {
      const err = captureThrow(() => execSync(`echo${ch}foo bar`));
      expect(err).toBeInstanceOf(HermeticSpawnViolationError);
    },
  );

  it("does not false-positive on the repo's one real execSync call site's command shape (patch -p0 -i <path>)", () => {
    const err = captureThrow(() => execSync("patch -p0 -i /tmp/hermetic-g3-nonexistent-probe.patch"));
    // "patch" is INFRA-allowed and this command contains none of the
    // (expanded) metacharacters — it must NOT be blocked by the
    // fail-closed check itself. The real `patch` binary then runs for
    // real against a nonexistent input file and fails on its own merits
    // (ordinary nonzero-exit ChildProcess error) — that failure is
    // expected and irrelevant to what this test checks.
    expect(err).not.toBeInstanceOf(HermeticSpawnViolationError);
  });

  it(
    "G3 boundary regression (task 052f9d5b review, third pass): an argv-style call WITHOUT " +
      "shell:true is NOT scanned for shell metacharacters in its ARGUMENTS — only the string-" +
      "style/shell:true path (guardShellStyle) runs the D4/F4/G3 heuristic. This pins the " +
      "current, verified-correct boundary so a future change that widens the G3 scan to argv " +
      "arguments cannot silently start blocking huge swaths of the suite's ordinary git/npm-" +
      "style calls (commit messages, format strings, path globs — all routinely contain " +
      "characters from the G3 metacharacter class with zero shell ever involved).",
    () => {
      // "git" (D6 INFRA-allowed) with an ARGUMENT containing several G3
      // metacharacters (; | * ~ ! $). If a future change mistakenly widened
      // the metacharacter scan to argv arguments, this call would start
      // throwing HermeticSpawnViolationError — that is exactly the
      // regression this test exists to catch.
      const err = captureThrow(() =>
        spawnSync("git", ["log", "--format=%s; rm -rf / | echo $HOME ~ !"], { encoding: "utf8" }),
      );
      expect(err).toBeUndefined();
    },
  );
});

describe(
  "H1 (task 052f9d5b review, third pass): the exact spawn shape " +
    "tests/integration/operator-state-isolation.test.ts now uses (process.execPath + " +
    "resolveVitestEntry(), replacing the CI-breaking npx-based spawn) is allowed under the " +
    "ACTIVE hook",
  () => {
    it("spawnSync(process.execPath, [resolveVitestEntry(), \"--version\"]) is not blocked and actually runs real vitest", () => {
      const result = spawnSync(process.execPath, [resolveVitestEntry(), "--version"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });
  },
);
