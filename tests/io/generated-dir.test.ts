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

// The real cwd this test file runs from (before any process.chdir()).
// `getOrCreateSigningKey` on the failure path (normalization dropped or
// broken) writes a real key file under `<cwd>/~/...` when a caller passes
// it a raw, un-normalized tilde path (review round R1 caught exactly this
// leftover directory in the repo). Every tilde-bearing test below chdirs
// into an isolated tmp dir before calling it, and this guard confirms the
// pollution stays contained there instead of leaking into the repo cwd.
const REAL_CWD = process.cwd();

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
  expect(fs.existsSync(path.join(REAL_CWD, "~"))).toBe(false);
});

describe("resolveGeneratedDir normalization", () => {
  it("expands a literal-tilde homeDir against userHome and resolves to an absolute path", () => {
    // Simulates HARNESS_HOME='~/.harness' passed through unexpanded by a
    // docker/systemd env where the shell never expands it (resolveHomeDir,
    // runtime/home-dir.ts, passes such a value through verbatim).
    const result = resolveGeneratedDir({
      homeDir: "~/.harness",
      manifestPath: "/elsewhere/harness.yaml",
      userHome: tmp,
    });
    expect(result).toBe(path.join(tmp, ".harness", GENERATED_DIRNAME));
    expect(result.startsWith("~")).toBe(false);
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("expands a literal-tilde manifestPath's directory against userHome", () => {
    const result = resolveGeneratedDir({
      manifestPath: "~/h/harness.yaml",
      userHome: tmp,
    });
    expect(result).toBe(path.join(tmp, "h", GENERATED_DIRNAME));
    expect(result.startsWith("~")).toBe(false);
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("defaults to the process home when userHome is omitted (isolated via chdir + HOME override)", () => {
    const cwdBefore = process.cwd();
    process.chdir(tmp);
    process.env["HOME"] = tmp;
    try {
      const result = resolveGeneratedDir({
        homeDir: "~/.harness",
        manifestPath: "/elsewhere/harness.yaml",
      });
      expect(result).toBe(path.join(tmp, ".harness", GENERATED_DIRNAME));
    } finally {
      process.chdir(cwdBefore);
    }
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

  it("is a fixed point: re-normalizing an already-normalized homeDir is a no-op", () => {
    // Pins the property the module header relies on: "every caller ...
    // sees the identical, already-real path — no per-consumer
    // re-normalization needed or wanted." `first`'s directory (already
    // absolute, no tilde) fed back in as `homeDir` must resolve to the
    // exact same generatedDir.
    const first = resolveGeneratedDir({
      homeDir: "~/.harness",
      manifestPath: "/elsewhere/harness.yaml",
      userHome: tmp,
    });
    const alreadyNormalizedHome = path.dirname(first);
    const second = resolveGeneratedDir({
      homeDir: alreadyNormalizedHome,
      manifestPath: "/elsewhere/harness.yaml",
    });
    expect(second).toBe(first);
    expect(signingKeyEnvValue(second)).toBe(signingKeyEnvValue(first));
  });
});

describe("round-trip: projected env value matches the real key-file location", () => {
  it("'~/x' homeDir: signingKeyEnvValue and the real writer agree", () => {
    const cwdBefore = process.cwd();
    process.chdir(tmp);
    try {
      const generatedDir = resolveGeneratedDir({
        homeDir: "~/x",
        manifestPath: "/elsewhere/harness.yaml",
        userHome: tmp,
      });
      const projectedEnvPath = signingKeyEnvValue(generatedDir);
      const handle = getOrCreateSigningKey(generatedDir);
      expect(handle.filePath).toBe(projectedEnvPath);
      expect(fs.existsSync(projectedEnvPath)).toBe(true);
    } finally {
      process.chdir(cwdBefore);
    }
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

  it("fixed-point generatedDir: re-normalizing yields the same real key-file path", () => {
    const cwdBefore = process.cwd();
    process.chdir(tmp);
    try {
      const first = resolveGeneratedDir({
        homeDir: "~/x",
        manifestPath: "/elsewhere/harness.yaml",
        userHome: tmp,
      });
      const renormalizedHome = path.dirname(first);
      const second = resolveGeneratedDir({
        homeDir: renormalizedHome,
        manifestPath: "/elsewhere/harness.yaml",
      });
      expect(second).toBe(first);
      const handle = getOrCreateSigningKey(second);
      expect(signingKeyEnvValue(second)).toBe(handle.filePath);
    } finally {
      process.chdir(cwdBefore);
    }
  });
});
