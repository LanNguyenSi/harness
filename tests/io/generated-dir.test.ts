import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_DIRNAME, resolveGeneratedDir } from "../../src/io/generated-dir.js";
import { signingKeyEnvValue } from "../../src/cli/apply/generate-settings.js";
import { getOrCreateSigningKey } from "../../src/runtime/approval-signing.js";

// Task 8254e357: resolveGeneratedDir normalizes exactly once (expandHome +
// path.resolve) so every consumer (apply's mkdirSync, approval-signing's
// key writer, adopt, doctor, the signing-key env projection) agrees on the
// same real path for a non-absolute or tilde `generatedDir`.

let tmp: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "generated-dir-"));
  savedHome = process.env["HOME"];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
});

describe("resolveGeneratedDir normalization", () => {
  it("expands a literal-tilde homeDir against $HOME and resolves to an absolute path", () => {
    // Simulates HARNESS_HOME='~/.harness' passed through unexpanded by a
    // docker/systemd env where the shell never expands it (resolveHomeDir,
    // runtime/home-dir.ts, passes such a value through verbatim).
    process.env["HOME"] = tmp;
    const result = resolveGeneratedDir({
      homeDir: "~/.harness",
      manifestPath: "/elsewhere/harness.yaml",
    });
    expect(result).toBe(path.join(tmp, ".harness", GENERATED_DIRNAME));
    expect(result.startsWith("~")).toBe(false);
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("resolves a relative homeDir against cwd (matches signingKeyEnvValue's own base)", () => {
    const relative = "rel/x";
    const result = resolveGeneratedDir({ homeDir: relative, manifestPath: "/elsewhere/harness.yaml" });
    expect(result).toBe(path.resolve(relative, GENERATED_DIRNAME));
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("leaves an already-absolute homeDir untouched (idempotent)", () => {
    const result = resolveGeneratedDir({ homeDir: "/tmp/h", manifestPath: "/elsewhere/harness.yaml" });
    expect(result).toBe(path.join("/tmp/h", GENERATED_DIRNAME));
  });
});

describe("round-trip: projected env value matches the real key-file location", () => {
  it("'~/x' homeDir: signingKeyEnvValue and the real writer agree", () => {
    process.env["HOME"] = tmp;
    const generatedDir = resolveGeneratedDir({
      homeDir: "~/x",
      manifestPath: "/elsewhere/harness.yaml",
    });
    const projectedEnvPath = signingKeyEnvValue(generatedDir);
    const handle = getOrCreateSigningKey(generatedDir);
    expect(handle.filePath).toBe(projectedEnvPath);
    expect(fs.existsSync(projectedEnvPath)).toBe(true);
  });

  it("'rel/x' homeDir: signingKeyEnvValue and the real writer agree", () => {
    const cwdBefore = process.cwd();
    process.chdir(tmp);
    try {
      const generatedDir = resolveGeneratedDir({
        homeDir: "rel/x",
        manifestPath: "/elsewhere/harness.yaml",
      });
      const projectedEnvPath = signingKeyEnvValue(generatedDir);
      const handle = getOrCreateSigningKey(generatedDir);
      expect(handle.filePath).toBe(projectedEnvPath);
      expect(fs.existsSync(projectedEnvPath)).toBe(true);
    } finally {
      process.chdir(cwdBefore);
    }
  });
});
