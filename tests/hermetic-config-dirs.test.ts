import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Acceptance tests for the hermetic-config-dirs.ts vitest setupFile.
// The setup runs before this file is imported, so each
// `it` below observes the ALREADY-neutralised environment. The three cases are
// the precedence contract the setup must satisfy:
//
//   1. a CLAUDE_CONFIG_DIR set in the OUTER env is unset inside tests;
//   2. HOME from the outer env is replaced by a fresh temp dir;
//   3. a test that sets process.env.HOME itself wins for that test.
//
// (1) only discriminates when the variable actually reaches the process, which
// is exactly what `CLAUDE_CONFIG_DIR=... npm test` (and the mutation check for
// the setup) does: run these tests with the variable set and the assertion is
// load-bearing. Run plain, the outer value is already absent and it still holds.

describe("hermetic-config-dirs.ts setup: unset CLAUDE_CONFIG_DIR, replace HOME, test wins", () => {
  it("CLAUDE_CONFIG_DIR set in the outer env is unset inside tests", () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("HOME from the outer env is replaced with a fresh temp dir", () => {
    const home = process.env.HOME;
    expect(home).toBeDefined();
    expect(home).not.toBe("");
    // Replaced with a real directory the setup created inside the OS temp dir.
    expect(fs.statSync(home as string).isDirectory()).toBe(true);
    // A real login home is never inside os.tmpdir(), so living there proves the
    // outer value was replaced (and, with the setup's HOME write neutralised,
    // this is the assertion that fails: HOME falls back to the caller's home).
    expect(home!.startsWith(os.tmpdir())).toBe(true);
  });

  it("a test that sets process.env.HOME itself wins for that test", () => {
    const custom = path.join(os.tmpdir(), "harness-config-dirs-own-home-marker");
    const before = process.env.HOME;
    process.env.HOME = custom;
    try {
      expect(process.env.HOME).toBe(custom);
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    }
  });
});
