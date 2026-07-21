import { describe, expect, it } from "vitest";
import {
  probeAgentTasksAuth,
  runBridgeLogin,
} from "../../src/cli/init/agent-tasks-auth.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";

// Stderr discriminators pinned here so a future bridge that drifts its
// message text fails this file (loud, local) instead of the integration
// wizard test (which would still pass into the wrong dialog branch
// because every probe non-zero exit goes through SOMETHING).
describe("probeAgentTasksAuth", () => {
  it("exit 0 → ok", async () => {
    const result = await probeAgentTasksAuth({
      spawn: async () => ({ code: 0, stderr: "ok (store: keychain)\n" }),
    });
    expect(result).toEqual({ kind: "ok" });
  });

  it("exit 1 + 'No token stored' → no_token", async () => {
    const result = await probeAgentTasksAuth({
      spawn: async () => ({ code: 1, stderr: "No token stored (keychain). Run 'login' first.\n" }),
    });
    expect(result).toEqual({ kind: "no_token" });
  });

  it("exit 1 + 'Token present' + 'validation failed' → validation_failed with message", async () => {
    const stderr = "Token present (keychain) but validation failed: fetch failed\n";
    const result = await probeAgentTasksAuth({ spawn: async () => ({ code: 1, stderr }) });
    expect(result.kind).toBe("validation_failed");
    if (result.kind === "validation_failed") {
      expect(result.message).toContain("Token present");
      expect(result.message).toContain("validation failed");
    }
  });

  it("exit 127 + ENOENT-ish stderr → binary_missing", async () => {
    const result = await probeAgentTasksAuth({
      spawn: async () => ({ code: 127, stderr: "spawn failed: ENOENT" }),
    });
    expect(result).toEqual({ kind: "binary_missing" });
  });

  it("unrecognized non-zero exit → probe_error with message", async () => {
    const result = await probeAgentTasksAuth({
      spawn: async () => ({ code: 2, stderr: "weird unexpected output\n" }),
    });
    expect(result.kind).toBe("probe_error");
    if (result.kind === "probe_error") {
      expect(result.message).toBe("weird unexpected output");
    }
  });

  it("unrecognized non-zero exit + empty stderr → probe_error names the exit code", async () => {
    const result = await probeAgentTasksAuth({
      spawn: async () => ({ code: 7, stderr: "" }),
    });
    expect(result.kind).toBe("probe_error");
    if (result.kind === "probe_error") {
      expect(result.message).toContain("exit 7");
    }
  });
});

describe("runBridgeLogin", () => {
  it("login spawn exit 0 → ok:true", async () => {
    const result = await runBridgeLogin({ spawn: async () => ({ code: 0 }) });
    expect(result).toEqual({ ok: true });
  });

  it("login spawn exit non-zero → ok:false", async () => {
    const result = await runBridgeLogin({ spawn: async () => ({ code: 1 }) });
    expect(result).toEqual({ ok: false });
  });

  it("hermetic guard (task 54739002): NO injected spawn hits the real `agent-tasks-mcp-bridge login` runner, which must refuse under vitest", async () => {
    // Meta-test for the hermetic-spawn guard on realLoginSpawn
    // (src/cli/init/agent-tasks-auth.ts). No `spawn` in opts, so
    // `runBridgeLogin` falls back to `realLoginSpawn`, which must refuse
    // under vitest instead of actually running the bridge's interactive
    // login (which takes over the terminal and writes to the OS
    // keychain). Non-inert: remove the `assertNoRealSpawnInTests(...)`
    // call at the top of `realLoginSpawn` and this rejects on a real
    // spawn attempt (ENOENT on a machine without the bridge installed,
    // or a genuine keychain-touching login prompt on one that has it)
    // instead of the expected HermeticSpawnViolationError.
    await expect(runBridgeLogin({})).rejects.toThrow(HermeticSpawnViolationError);
  });
});
