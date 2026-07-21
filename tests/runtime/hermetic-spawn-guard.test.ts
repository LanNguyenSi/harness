import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoRealSpawnInTests,
  HermeticSpawnViolationError,
} from "../../src/runtime/hermetic-spawn-guard.js";

describe("assertNoRealSpawnInTests", () => {
  const originalVitest = process.env.VITEST;
  const originalAllowRealSpawn = process.env.HARNESS_ALLOW_REAL_SPAWN;

  afterEach(() => {
    // Restore whatever vitest itself set, so later tests in this file
    // (and the rest of the suite) keep seeing the real signal.
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    if (originalAllowRealSpawn === undefined) {
      delete process.env.HARNESS_ALLOW_REAL_SPAWN;
    } else {
      process.env.HARNESS_ALLOW_REAL_SPAWN = originalAllowRealSpawn;
    }
  });

  it("throws HermeticSpawnViolationError when VITEST is set", () => {
    process.env.VITEST = "true";
    expect(() => assertNoRealSpawnInTests("the-real-thing", "Inject a fake runner instead.")).toThrow(
      HermeticSpawnViolationError,
    );
  });

  it("the thrown error names the binary and includes the caller's hint", () => {
    process.env.VITEST = "true";
    try {
      assertNoRealSpawnInTests("npx orchestrator-workflow init", "Inject a fake `owInitSpawn` runner.");
      throw new Error("expected assertNoRealSpawnInTests to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HermeticSpawnViolationError);
      expect((err as Error).message).toContain('"npx orchestrator-workflow init"');
      expect((err as Error).message).toContain("Inject a fake `owInitSpawn` runner.");
    }
  });

  it("is a no-op when VITEST is NOT set (production behavior)", () => {
    delete process.env.VITEST;
    expect(() => assertNoRealSpawnInTests("the-real-thing", "Inject a fake runner instead.")).not.toThrow();
  });

  it.each(["false", "0"])("is a no-op when VITEST=%s (guards against a stray falsy-string env)", (falsy) => {
    process.env.VITEST = falsy;
    expect(() => assertNoRealSpawnInTests("the-real-thing", "Inject a fake runner instead.")).not.toThrow();
  });

  it("is a no-op when HARNESS_ALLOW_REAL_SPAWN=1, even under VITEST (explicit escape hatch), and warns once on stderr", () => {
    // Combined into one test (rather than a separate no-op test + a
    // separate warning test) because the stderr warning is a
    // module-local ONE-TIME flag: whichever test activates the escape
    // hatch first is the only one that will ever observe the write, so
    // asserting "warns" needs to happen at the same activation this test
    // already exercises rather than in an ordering-dependent second test.
    //
    // The escape hatch is a SILENT global kill-switch for all four
    // guarded call sites; this pins that activating it is at least
    // visible in test output rather than quietly disabling every
    // tripwire.
    process.env.VITEST = "true";
    process.env.HARNESS_ALLOW_REAL_SPAWN = "1";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => assertNoRealSpawnInTests("the-real-thing", "Inject a fake runner instead.")).not.toThrow();
      const wrote = spy.mock.calls.some((call) => String(call[0]).includes("HARNESS_ALLOW_REAL_SPAWN"));
      expect(wrote).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
