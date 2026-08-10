import { describe, expect, it } from "vitest";
import { checkNpmBinPath } from "../../src/cli/doctor/npm-bin-path.js";
import {
  STUB_NPM_BIN_EXEC_UNKNOWN,
  STUB_NPM_BIN_EXEC_WARN,
} from "../_helpers/npm-bin-exec.js";

// Executable form of the status mapping documented in
// tests/_helpers/npm-bin-exec.ts. Dozens of callsites depend on these two
// stubs producing exactly these checkNpmBinPath statuses; without this
// guard the mapping lived only in a comment, and an edit to a stub's shape
// (or a prefix that happens to exist on a host) would shift every consumer
// silently.
describe("npm-bin-exec shared stub contract", () => {
  it("STUB_NPM_BIN_EXEC_UNKNOWN resolves to status unknown", async () => {
    const report = await checkNpmBinPath({ exec: STUB_NPM_BIN_EXEC_UNKNOWN });
    expect(report.status).toBe("unknown");
    expect(report.binDir).toBe("");
  });

  it("STUB_NPM_BIN_EXEC_WARN resolves to status warn with the nonexistent prefix's bin dir", async () => {
    const report = await checkNpmBinPath({
      exec: STUB_NPM_BIN_EXEC_WARN,
      pathEnv: "/usr/bin",
    });
    expect(report.status).toBe("warn");
    expect(report.binDir).toBe(
      "/nonexistent-npm-global-prefix-for-hermetic-tests/bin",
    );
  });
});
