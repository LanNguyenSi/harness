import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkNpmBinPath } from "../../src/cli/doctor/npm-bin-path.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";

describe("checkNpmBinPath", () => {
  it("returns ok when npm prefix's bin dir is on PATH", async () => {
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 0, stdout: "/usr/local\n", stderr: "" }),
      pathEnv: ["/usr/bin", "/usr/local/bin", "/bin"].join(path.delimiter),
    });
    expect(result.status).toBe("ok");
    expect(result.binDir).toBe("/usr/local/bin");
    expect(result.pathPatchSuggestion).toBe("");
    expect(result.reason).toBe("");
  });

  it("returns warn with a PATH-patch suggestion when the bin dir is NOT on PATH", async () => {
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 0, stdout: "/home/lan/.nvm/versions/node/v22.22.0\n", stderr: "" }),
      pathEnv: ["/usr/bin", "/bin"].join(path.delimiter),
    });
    expect(result.status).toBe("warn");
    expect(result.binDir).toBe("/home/lan/.nvm/versions/node/v22.22.0/bin");
    expect(result.pathPatchSuggestion).toBe(
      `export PATH="/home/lan/.nvm/versions/node/v22.22.0/bin:$PATH"`,
    );
    expect(result.reason).toBe("");
  });

  it("returns unknown when npm prefix exits non-zero (npm itself broken / missing)", async () => {
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 127, stdout: "", stderr: "npm: command not found" }),
      pathEnv: "/usr/bin",
    });
    expect(result.status).toBe("unknown");
    expect(result.binDir).toBe("");
    expect(result.pathPatchSuggestion).toBe("");
    expect(result.reason).toBe("npm: command not found");
  });

  it("returns unknown when npm prefix returns empty stdout", async () => {
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 0, stdout: "   \n", stderr: "" }),
      pathEnv: "/usr/bin",
    });
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("empty output");
  });

  it("trims trailing whitespace and newlines from npm prefix output", async () => {
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 0, stdout: "/usr/local  \n\n", stderr: "" }),
      pathEnv: "/usr/local/bin",
    });
    expect(result.status).toBe("ok");
    expect(result.binDir).toBe("/usr/local/bin");
  });

  it("treats an empty PATH segment as not-present (no vacuous match)", async () => {
    // PATH like "/usr/bin::/bin" has an empty middle segment; an
    // includes-check against the unfiltered split would compare against
    // "" which never equals a real bin dir, but we explicitly filter
    // empty segments out so the warn branch fires cleanly.
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 0, stdout: "/opt/node\n", stderr: "" }),
      pathEnv: `/usr/bin${path.delimiter}${path.delimiter}/bin`,
    });
    expect(result.status).toBe("warn");
    expect(result.binDir).toBe("/opt/node/bin");
  });
});

describe("realNpmExec hermetic spawn guard (task 325ace29 review finding F1)", () => {
  // Direct test on the primitive application: `checkNpmBinPath` defaults
  // `opts.exec` to the module-private `realNpmExec` (src/cli/doctor/
  // npm-bin-path.ts), which calls `assertNoRealSpawnInTests` before
  // touching `child_process`. This is the sixth guarded real*Exec/Spawn
  // function (see src/runtime/hermetic-spawn-guard.ts) and, until this
  // task, the only one of the six with no direct regression test of its
  // own — every other guarded function has a sibling meta-test like this
  // one (tests/io/claude-mcp.test.ts, tests/cli/init-dependencies.test.ts,
  // tests/cli/init-interactive.test.ts, tests/cli/uninstall/uninstall.test.ts,
  // tests/cli/init-agent-tasks-auth.test.ts).
  it("checkNpmBinPath() with no injected exec refuses instead of spawning the real npm CLI", async () => {
    // Non-inert: remove the `assertNoRealSpawnInTests(...)` call at the
    // top of `realNpmExec` and this rejects on a real `spawn("npm",
    // ["prefix", "-g"])` attempt instead (ENOENT on a machine without
    // npm on PATH, or an actual `npm prefix -g` call against the real
    // environment on one that has it).
    await expect(checkNpmBinPath()).rejects.toThrow(HermeticSpawnViolationError);
    await expect(checkNpmBinPath()).rejects.toThrow(/Refusing to spawn a REAL "npm prefix -g"/);
  });

  it("checkNpmBinPath({ exec }) with an injected exec does NOT throw (counter-proof: the guard only fires on the real spawn path)", async () => {
    const result = await checkNpmBinPath({
      exec: async () => ({ code: 0, stdout: "/usr/local\n", stderr: "" }),
    });
    expect(result.status).toBe("ok");
  });
});
