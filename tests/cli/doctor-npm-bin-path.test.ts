import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkNpmBinPath } from "../../src/cli/doctor/npm-bin-path.js";

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
