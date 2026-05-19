// Pin the test-isolation guard in `resolvePaths` (PR #199).
//
// Background: two prior incidents (v0.21.1 preflight stage, v0.22.0
// approveUnderstanding marker) silently wrote into the operator's real
// `~/.claude/harness.generated/` because tests forgot to inject
// `homeDir` / `configPath`, and `resolvePaths` fell back to `os.homedir()`.
// PR #199 added an env-var guard: `resolvePaths` throws unless one of
// `homeDir`, `configPath`, or `HARNESS_ALLOW_REAL_GENERATED_DIR=1` is
// set. The harness binary sets the env var in `src/cli/main.ts` before
// `run()`; tests don't. A future test author who forgets injection now
// trips this throw at assertion time instead of mutating operator state.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/cli/loader.js";

let tmpHome: string;
let priorEnv: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loader-iso-"));
  priorEnv = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (priorEnv === undefined) {
    delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
  } else {
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = priorEnv;
  }
});

describe("resolvePaths isolation guard (PR #199)", () => {
  it("throws when neither homeDir nor configPath is supplied and the env opt-in is unset", () => {
    expect(() => resolvePaths({})).toThrow(
      /refused to fall back to the real harness home dir.*HARNESS_ALLOW_REAL_GENERATED_DIR/,
    );
  });

  it("allows the implicit homedir fallback when HARNESS_ALLOW_REAL_GENERATED_DIR=1 (binary opt-in)", () => {
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
    const resolved = resolvePaths({});
    // The v0.24.0 resolver returns ~/.harness/harness.yaml on a clean
    // system and ~/.claude/harness.yaml when the legacy fallback kicks
    // in (existing harness state in the legacy root). Either ending is
    // acceptable proof that the env opt-in unlocked the real-homedir
    // resolution. CI containers are clean and will land on the new
    // path; an operator with v0.23.x state pre-migration lands on the
    // legacy path.
    expect(
      resolved.base.endsWith(".harness/harness.yaml") ||
        resolved.base.endsWith(".claude/harness.yaml"),
    ).toBe(true);
  });

  it("works without env opt-in when homeDir is supplied", () => {
    const resolved = resolvePaths({ homeDir: tmpHome });
    expect(resolved.base).toBe(path.join(tmpHome, "harness.yaml"));
  });

  it("works without env opt-in when configPath is supplied", () => {
    const explicit = path.join(tmpHome, "manifest.yaml");
    const resolved = resolvePaths({ configPath: explicit });
    expect(resolved.base).toBe(explicit);
  });

  it("does not leak into the operator's real ~/.claude when called from a test that injects homeDir", () => {
    // The pin: even if the guard later regressed (e.g. someone added an
    // additional fallback), the resolved path under an explicit homeDir
    // must stay under tmpHome. listing the real ~/.claude before/after
    // would also catch any side-effect write — but resolvePaths is a
    // pure function, so the .base assertion is sufficient.
    const resolved = resolvePaths({ homeDir: tmpHome });
    expect(resolved.base.startsWith(tmpHome)).toBe(true);
    expect(resolved.base.startsWith(path.join(os.homedir(), ".claude"))).toBe(false);
  });
});
