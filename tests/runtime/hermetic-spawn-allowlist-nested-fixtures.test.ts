// Proofs that need to observe THIS SETUP FILE'S OWN teardown from
// OUTSIDE a single test file's lifecycle — task 052f9d5b review F1 and
// F9. Both spin up a nested `vitest run` (a real, separate node process,
// launched via the D6-allowlisted "node" INFRA entry) against tiny
// fixture test files whose OWN vitest.config.ts wires up the SAME real,
// current setup file (tests/_helpers/hermetic-spawn-allowlist.ts,
// referenced by absolute path — not a copy) as their setupFiles entry.
// This exercises the actual vitest hook lifecycle end to end, not a
// simulation of it.
//
// F1 (fixture-f1-swallow.test.ts, its own nested run): swallows a spawn
// violation in a deliberately broad catch — the exact danger pattern
// task 052f9d5b review F1 found at src/probes/mcp.ts:112-124 and five
// other call sites — and its own `it` passes regardless. The proof that
// swallowing didn't actually let the violation through unnoticed is that
// the nested `vitest run` AS A WHOLE still exits non-zero: that can only
// be the setup file's own `afterAll` (D8) failing the file at teardown.
//
// F9 (fixture-f9a-tag.test.ts + fixture-f9b-verify.test.ts, run
// sequentially in a single forced worker process): file A tags the
// specific FUNCTION OBJECT it sees as `cp.spawn` (a real property write
// on a real object — readable from any later code in the SAME os
// process, since the underlying `child_process` module is a Node core
// singleton, not reset by vitest's per-file module-registry isolation —
// see the "isolate:true coupling" note in the setup file). File B then
// asserts that tag is GONE from the (now current) `cp.spawn` — which can
// only be true if file A's afterAll really swapped it back to the true
// original (D8/F9's restore) AND file B's own setupFiles evaluation then
// wrapped a brand-new closure around it. (A `globalThis` channel does
// NOT work for this: probed empirically first — vitest gives each test
// file its own realm/global object even within one forced single OS
// process, so only truly process-level state, like a property on the
// shared core-module object itself, crosses the boundary.)
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveVitestEntry } from "../_helpers/nested-vitest.js";

interface NestedRunResult {
  status: number | null;
  output: string;
}

let f1Dir: string;
let f9Dir: string;
let f1Result: NestedRunResult;
let f9Result: NestedRunResult;

// G1 (task 052f9d5b review, second pass): proves the identity-based
// acknowledgeViolation fix against the reviewer's exact swallow-then-
// acknowledge attack sequence.
let g1Dir: string;
let g1Result: NestedRunResult;

// G5 (task 052f9d5b review, second pass): D7 escape hatch and F9's
// previouslyInstalled branch, both previously untested.
let d7Dir: string;
let d7Result: NestedRunResult;
let g5Dir: string;
let g5Result: NestedRunResult;

// H2 (task 052f9d5b review, third pass): a file whose tests are ALL
// skipped plus a swallowed module-top-level violation — proves whether
// the setup file's process.on("exit") fallback actually makes the nested
// run's exit code non-zero.
let h2Dir: string;
let h2Result: NestedRunResult;

// resolveVitestEntry is now shared via tests/_helpers/nested-vitest.ts
// (task 052f9d5b review H1) — also reused by
// tests/integration/operator-state-isolation.test.ts's own nested spawn.

/**
 * @param extraEnv G5: merged on TOP of the current process's env (not a
 *   replacement) — the nested vitest process still needs a normal PATH
 *   etc. to run at all; this only adds/overrides specific vars (e.g.
 *   HARNESS_ALLOW_REAL_SPAWN=1 for the D7 escape-hatch proof).
 */
function runNestedVitest(dir: string, extraEnv?: Record<string, string>): NestedRunResult {
  // process.execPath resolves to "node" — D6 INFRA-allowlisted by the
  // OUTER (currently active) hermetic-spawn-allowlist hook, same as
  // every other real subprocess smoke test in this suite.
  const result = spawnSync(process.execPath, [resolveVitestEntry(), "run"], {
    cwd: dir,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

beforeAll(() => {
  const helperAbsPath = path.resolve(process.cwd(), "tests/_helpers/hermetic-spawn-allowlist.ts");
  const configContent = (extra = "") =>
    `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["fixture-*.test.ts"],
    setupFiles: [${JSON.stringify(helperAbsPath)}],
    fileParallelism: false,
    ${extra}
  },
});
`;

  // G6 (task 052f9d5b review, second pass): every fixture dir below is
  // created under process.cwd() (the repo root), NOT os.tmpdir() — do
  // not "helpfully" move these to tmpdir. Two independent reasons: (1)
  // os.tmpdir() is the D3 EXEMPT path in this suite's own hermetic guard,
  // so anything placed there would be silently allowed through
  // regardless of what a given fixture is trying to prove, and (2) these
  // NESTED vitest runs need real node_modules resolution for
  // `vitest/config` (see the file header above) — an out-of-tree tmpdir
  // copy fails with UNRESOLVED_IMPORT (verified). Each is removed by
  // this file's own afterAll below; ignored via .gitignore's
  // `hermetic-*/` entry (not deleted on the next run) in case an aborted
  // run leaves one behind.

  // --- F1 fixture: one file, deliberately swallows a violation. ---
  f1Dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-nested-f1-"));
  fs.writeFileSync(path.join(f1Dir, "vitest.config.ts"), configContent());
  fs.writeFileSync(
    path.join(f1Dir, "fixture-f1-swallow.test.ts"),
    `import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";

it("deliberately swallows a spawn violation in a broad catch (F1 fixture)", () => {
  try {
    spawnSync("/bin/ls", ["-la"]);
  } catch {
    // Deliberately broad catch — mirrors the exact danger pattern task
    // 052f9d5b review F1 found in src/probes/mcp.ts and friends: swallow
    // ANY thrown error, including HermeticSpawnViolationError, as an
    // ordinary failure instead of re-throwing it.
  }
  expect(true).toBe(true); // this test itself passes; only afterAll should fail the file.
});
`,
  );

  // --- F9 fixture: two files, forced onto ONE worker process, run in
  // order (file A must fully complete — including its real afterAll —
  // before file B's setupFiles evaluate). No spawn is ever triggered
  // here, so no HermeticSpawnViolationError, so no interaction with
  // F1/D8's violation collection — this fixture is expected to pass
  // cleanly end to end. Each file also writes its own sentinel file on
  // success (G7, task 052f9d5b review second pass): the outer "both
  // files actually ran" check reads these instead of matching the
  // default reporter's human-readable summary text, which is not a
  // stability contract (it has changed shape across vitest majors).
  f9Dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-nested-f9-"));
  fs.writeFileSync(path.join(f9Dir, "vitest.config.ts"), configContent("forks: { singleFork: true },"));
  fs.writeFileSync(
    path.join(f9Dir, "fixture-f9a-tag.test.ts"),
    `import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { it, expect } from "vitest";

const cp = createRequire(import.meta.url)("node:child_process");

it("tags this file's own wrapped cp.spawn for the next file to check", () => {
  (cp.spawn as Record<string, unknown>)["__f9FixtureTag"] = "file-a-wrapped";
  expect((cp.spawn as Record<string, unknown>)["__f9FixtureTag"]).toBe("file-a-wrapped");
  fs.writeFileSync(path.join(process.cwd(), "f9a-ran.txt"), "ok");
});
`,
  );
  fs.writeFileSync(
    path.join(f9Dir, "fixture-f9b-verify.test.ts"),
    `import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { it, expect } from "vitest";

const cp = createRequire(import.meta.url)("node:child_process");

it("cp.spawn no longer carries fixture-f9a's tag — proves fixture-f9a's afterAll restored the true original, and this file's own setup wrapped a FRESH closure around it (F9)", () => {
  expect((cp.spawn as Record<string, unknown>)["__f9FixtureTag"]).toBeUndefined();
  fs.writeFileSync(path.join(process.cwd(), "f9b-ran.txt"), "ok");
});
`,
  );

  // --- G1 fixture (task 052f9d5b review, second pass): the reviewer's
  // exact swallow-then-acknowledge attack sequence — test 1 triggers and
  // swallows a REAL, hook-recorded violation in a broad catch (like F1's
  // fixture); test 2 catches a HermeticSpawnViolationError this hook
  // never recorded (assertNoRealSpawnInTests, a totally separate
  // mechanism) and tries to acknowledge it. Before the G1 fix, a
  // positional `violations.pop()` would silently delete test 1's real
  // violation here, and the file would pass (EXIT 0) despite the
  // swallow. After the fix, acknowledging test 2's unrecorded error
  // throws instead, test 1's violation survives untouched, and the
  // file's own afterAll (D8/F1) hard-fails it — this fixture proves that
  // end to end via a REAL nested vitest run.
  g1Dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-nested-g1-"));
  fs.writeFileSync(path.join(g1Dir, "vitest.config.ts"), configContent());
  fs.writeFileSync(
    path.join(g1Dir, "fixture-g1-attack.test.ts"),
    `import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { it, expect } from "vitest";
import { assertNoRealSpawnInTests, HermeticSpawnViolationError } from ${JSON.stringify(
      path.resolve(process.cwd(), "src/runtime/hermetic-spawn-guard.ts"),
    )};
import { __testOnly } from ${JSON.stringify(helperAbsPath)};

it("test 1: swallows a REAL, hook-recorded spawn violation in a broad catch, WITHOUT acknowledging it (G1 attack step a)", () => {
  try {
    spawnSync("/bin/ls", ["-la"]);
  } catch {
    // Deliberately broad catch, mirrors F1's own fixture — swallows the
    // real violation this hook threw and recorded, and does NOT call
    // __testOnly.acknowledgeViolation for it.
  }
  expect(true).toBe(true);
});

it("test 2: catches a HermeticSpawnViolationError this hook never recorded and tries to acknowledge it — must throw, not silently pop test 1's entry (G1 attack step b)", () => {
  let caught;
  try {
    assertNoRealSpawnInTests("g1-attack-probe", "test hint");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(HermeticSpawnViolationError);
  expect(() => __testOnly.acknowledgeViolation(caught)).toThrow(/never recorded by the hook/);
  // Only reached if BOTH expectations above passed — a sentinel file the
  // outer test can check instead of parsing reporter text (G7).
  fs.writeFileSync(path.join(process.cwd(), "test2-passed.txt"), "ok");
});
`,
  );

  // --- D7 fixture (task 052f9d5b review G5): the HARNESS_ALLOW_REAL_SPAWN=1
  // escape hatch, launched with that env var set for the nested process
  // (see runNestedVitest's extraEnv) — expected to pass cleanly, allow
  // real spawns through, and print the one-time stderr warning exactly
  // once even though two real spawns occur.
  d7Dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-nested-d7-"));
  fs.writeFileSync(path.join(d7Dir, "vitest.config.ts"), configContent());
  fs.writeFileSync(
    path.join(d7Dir, "fixture-d7-escape-hatch.test.ts"),
    `import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";

it("first real, non-allowlisted spawn is allowed under HARNESS_ALLOW_REAL_SPAWN=1", () => {
  const result = spawnSync("/bin/ls", ["-la"]);
  expect(result.status).toBe(0);
});

it("second real spawn is also allowed — same escape hatch, still active for the rest of this file", () => {
  const result = spawnSync("/bin/ls", ["-la"]);
  expect(result.status).toBe(0);
});
`,
  );

  // --- G5 fixture (task 052f9d5b review, second pass): F9's
  // previouslyInstalled branch, never exercised by the existing F9
  // fixture above (that one proves restore-then-rewrap ACROSS files,
  // i.e. the !previouslyInstalled path). This one imports the setup
  // file a SECOND time in the SAME process, via a distinct (query-
  // stringed) module specifier that Vite/vitest treats as a different
  // module id — forcing a second top-level evaluation while the FIRST
  // evaluation's afterAll has not fired yet (that only happens once this
  // file's own tests finish). Validated standalone before being wired in
  // here: the second evaluation's __testOnly.trueOriginals reuses the
  // exact same function objects as the marker the first evaluation
  // stored on the child_process singleton, and those are NOT the
  // currently-wrapped cp.spawn.
  g5Dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-nested-g5-"));
  fs.writeFileSync(path.join(g5Dir, "vitest.config.ts"), configContent());
  fs.writeFileSync(
    path.join(g5Dir, "fixture-g5-previously-installed.test.ts"),
    `import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { it, expect } from "vitest";
import * as first from ${JSON.stringify(helperAbsPath)};

const HELPER_ABS = ${JSON.stringify(helperAbsPath)};
const helperUrl = pathToFileURL(HELPER_ABS).href;
const second = await import(helperUrl + "?f9-second-import-probe=1");

const cp = createRequire(import.meta.url)("node:child_process");
const MARKER = Symbol.for("harness.hermeticSpawnAllowlist.trueOriginals");

it("a second same-process import reuses the FIRST import's true originals (F9 previouslyInstalled branch), not an already-wrapped function", () => {
  const markerOriginals = (cp as Record<symbol, { spawn: unknown }>)[MARKER];
  expect(markerOriginals).toBeDefined();
  expect(second.__testOnly.trueOriginals.spawn).toBe(first.__testOnly.trueOriginals.spawn);
  expect(second.__testOnly.trueOriginals.spawn).toBe(markerOriginals!.spawn);
  expect(second.__testOnly.trueOriginals.spawn).not.toBe(cp.spawn);
  fs.writeFileSync(path.join(process.cwd(), "g5-ran.txt"), "ok");
});
`,
  );

  // --- H2 fixture (task 052f9d5b review, third pass): a file whose
  // OWN tests are ALL `it.skip`, plus a spawn violation triggered and
  // swallowed at MODULE TOP LEVEL (collection time — runs regardless of
  // skip status). Proves the fix works end to end: the setup file's own
  // always-run `it(...)` check (added directly in
  // tests/_helpers/hermetic-spawn-allowlist.ts, replacing an earlier
  // process.on("exit") attempt that was measured and found ineffective —
  // see that file's own H2 comment for the measurement) is what makes
  // this violation actually fail the run, since the file's OWN tests
  // never execute and this setup file's `afterAll` therefore never fires
  // either.
  h2Dir = fs.mkdtempSync(path.join(process.cwd(), "hermetic-nested-h2-"));
  fs.writeFileSync(path.join(h2Dir, "vitest.config.ts"), configContent());
  fs.writeFileSync(
    path.join(h2Dir, "fixture-h2-all-skipped.test.ts"),
    `import { spawnSync } from "node:child_process";
import { it } from "vitest";

// Module-top-level (collection-time) swallowed violation — mirrors the
// exact shape task 052f9d5b review H2 found dangerous: it runs even
// though every test below is skipped, because collection always
// evaluates the module body.
try {
  spawnSync("/bin/ls", ["-la"]);
} catch {
  // Deliberately broad catch, same pattern as the F1/G1 fixtures above —
  // swallows the real, hook-recorded violation.
}

it.skip("this test never runs — the whole file is skipped (H2 fixture)", () => {});
it.skip("a second skipped test, so the file isn't a trivial single-test edge case", () => {});
`,
  );

  f1Result = runNestedVitest(f1Dir);
  f9Result = runNestedVitest(f9Dir);
  g1Result = runNestedVitest(g1Dir);
  d7Result = runNestedVitest(d7Dir, { HARNESS_ALLOW_REAL_SPAWN: "1" });
  g5Result = runNestedVitest(g5Dir);
  h2Result = runNestedVitest(h2Dir);
}, 60_000);

afterAll(() => {
  if (f1Dir) fs.rmSync(f1Dir, { recursive: true, force: true });
  if (f9Dir) fs.rmSync(f9Dir, { recursive: true, force: true });
  if (g1Dir) fs.rmSync(g1Dir, { recursive: true, force: true });
  if (d7Dir) fs.rmSync(d7Dir, { recursive: true, force: true });
  if (g5Dir) fs.rmSync(g5Dir, { recursive: true, force: true });
  if (h2Dir) fs.rmSync(h2Dir, { recursive: true, force: true });
});

describe("F1 (task 052f9d5b review): a violation thrown inside a broad catch still fails the FILE (afterAll's collected-violations check)", () => {
  it("the nested vitest run (whose fixture swallows the violation in its own catch) still exits non-zero", () => {
    expect(f1Result.status).not.toBe(0);
  });

  it("the failure is attributable to the swallowed violation, not some unrelated setup/config error", () => {
    expect(f1Result.output).toMatch(/spawn violation/i);
    expect(f1Result.output).toContain("fixture-f1-swallow.test.ts");
  });
});

describe("F9 (task 052f9d5b review): cp.spawn is restored to the pre-patch original after a file's afterAll teardown, before the next file re-wraps it", () => {
  it("the nested vitest run (two files, one forced worker, sequential) passes cleanly", () => {
    expect(f9Result.status).toBe(0);
  });

  it("both fixture files actually ran (sanity: not a false-pass from an empty/misconfigured run)", () => {
    // G7 (task 052f9d5b review, second pass): sentinel files, not the
    // default reporter's human-readable summary text. That text is not a
    // stability contract and has changed shape across vitest majors
    // (the previous version of this test matched
    // /Test Files\s+2 passed \(2\)/). Each fixture file writes its own
    // sentinel on successful completion (see the beforeAll above);
    // checking both files' existence proves both fixture files actually
    // executed, independent of reporter formatting.
    expect(fs.existsSync(path.join(f9Dir, "f9a-ran.txt"))).toBe(true);
    expect(fs.existsSync(path.join(f9Dir, "f9b-ran.txt"))).toBe(true);
  });
});

describe("G1 (task 052f9d5b review, second pass): identity-based acknowledgeViolation makes the reviewer's swallow-then-acknowledge attack fail LOUD instead of silently exiting 0", () => {
  it("the nested vitest run (test 1 swallows a real violation, test 2 tries to acknowledge an unrelated one) still exits non-zero", () => {
    expect(g1Result.status).not.toBe(0);
  });

  it("the failure is attributable to test 1's real, still-unacknowledged violation surviving to afterAll — the SAME D8/F1 mechanism F1's own proof above exercises — not to some unrelated setup/config error", () => {
    expect(g1Result.output).toMatch(/spawn violation/i);
    expect(g1Result.output).toContain("fixture-g1-attack.test.ts");
  });

  it("test 2's own assertions (both the instanceof check and the identity-based acknowledge-throws check) themselves passed — the file fails at the afterAll teardown (test 1's surviving violation), not because test 2 failed its own expectations", () => {
    // Sentinel file (G7 pattern), not reporter text: test 2's fixture
    // code only writes this AFTER both its expect() calls succeed.
    expect(fs.existsSync(path.join(g1Dir, "test2-passed.txt"))).toBe(true);
  });
});

describe("D7 (task 052f9d5b review G5): the HARNESS_ALLOW_REAL_SPAWN=1 escape hatch, previously untested", () => {
  it("the nested vitest run (env HARNESS_ALLOW_REAL_SPAWN=1) passes cleanly — real, non-allowlisted spawns are allowed through", () => {
    expect(d7Result.status).toBe(0);
  });

  it("no violation was collected (the escape hatch really disabled the guard, not just happened to not trip it)", () => {
    expect(d7Result.output).not.toMatch(/spawn violation/i);
  });

  it("the one-time stderr warning is printed", () => {
    expect(d7Result.output).toMatch(/DISABLED via HARNESS_ALLOW_REAL_SPAWN=1/);
  });

  it("the warning is printed exactly ONCE even though the fixture makes two real spawns (module-local one-shot flag)", () => {
    const matches = d7Result.output.match(/DISABLED via HARNESS_ALLOW_REAL_SPAWN=1/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("F9 previouslyInstalled (task 052f9d5b review G5): a second same-process import reuses the first import's true originals instead of capturing an already-wrapped function", () => {
  it("the nested vitest run (single file, second import via a distinct module specifier) passes cleanly", () => {
    expect(g5Result.status).toBe(0);
  });

  it("the fixture actually ran and reached its assertion (sentinel file, not reporter text — see G7)", () => {
    expect(fs.existsSync(path.join(g5Dir, "g5-ran.txt"))).toBe(true);
  });
});

describe(
  "H2 (task 052f9d5b review, third pass): a violation recorded while EVERY test the FIXTURE " +
    "FILE ITSELF defines is skipped still fails the run, via the setup file's own always-run " +
    "`it(...)` check (tests/_helpers/hermetic-spawn-allowlist.ts) — not the earlier " +
    "process.on(\"exit\") attempt, measured and found ineffective (see that file's own H2 " +
    "comment)",
  () => {
    it("the fixture's OWN two tests still show as skipped — the precondition H2 exists to handle (the file's own tests never execute) actually held, this isn't a misconfigured fixture", () => {
      expect(h2Result.output).toMatch(/2 skipped/);
    });

    it("the nested vitest run does NOT exit 0 — proves the setup file's own always-run it(...) check really does turn a collection-time violation into a genuine, reported test failure that propagates through vitest's normal pass/fail -> exit-code pipeline (not assumed, measured)", () => {
      expect(h2Result.status).not.toBe(0);
    });

    it("exactly one test FAILED (the injected check) alongside the fixture's own two skipped tests — three tests total, not some unrelated collection/config error", () => {
      expect(h2Result.output).toMatch(/1 failed/);
    });

    it("the failure is attributable to the injected check's own report, naming the swallowed violation, not some unrelated setup/config error", () => {
      expect(h2Result.output).toMatch(/no unacknowledged spawn violation/);
      expect(h2Result.output).toMatch(/spawn violation/i);
    });
  },
);
