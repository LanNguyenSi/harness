import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractReadmeVersion, main } from "../../scripts/check-readme-release-version.mjs";
import { spawnExpectingFailure } from "../_helpers/spawn-script.js";

// The repo root and this script's path, resolved the same way
// check-shipped-unreleased-pointer.test.ts does: used only by the spawn
// smoke tests below.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check-readme-release-version.mjs");

describe("extractReadmeVersion", () => {
  it("extracts the version from the release-headline sentence", () => {
    expect(extractReadmeVersion("Some prose.\n\nThe current release is `v0.57.0`.\n\nMore prose.")).toBe("0.57.0");
  });

  it("returns null when the sentence is missing", () => {
    expect(extractReadmeVersion("No release sentence here at all.")).toBeNull();
  });

  it("does not match a similar sentence missing the trailing period", () => {
    expect(extractReadmeVersion("The current release is `v0.57.0`")).toBeNull();
  });
});

// main() runs against small real fixture directories (README.md +
// package.json) and inspects console output + process.exitCode,
// mirroring check-changelog-coverage.test.ts's main() suite.
describe("main", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function writePkg(version: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }));
  }

  function writeReadme(text: string): void {
    writeFileSync(join(dir, "README.md"), text);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-readme-release-version-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    // main() communicates failure via process.exitCode (not process.exit)
    // precisely so it stays testable in-process; reset it here so a
    // failure-path test does not leak a non-zero exit code into the real
    // vitest process running this suite.
    process.exitCode = undefined;
  });

  it("OK (passing fixture) when README's sentence matches package.json's version", () => {
    writePkg("0.57.0");
    writeReadme("Intro.\n\nThe current release is `v0.57.0`.\n\nMore.");

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-readme-release-version: OK"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("0.57.0"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("FAIL (failing fixture) when README's version differs from package.json's version", () => {
    writePkg("0.58.0");
    writeReadme("Intro.\n\nThe current release is `v0.57.0`.\n\nMore.");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-readme-release-version: FAIL");
    expect(errorOutput).toContain("v0.57.0");
    expect(errorOutput).toContain("0.58.0");
  });

  it("FAIL when README has no release-headline sentence at all", () => {
    writePkg("0.57.0");
    writeReadme("Intro with no release sentence.");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("no");
    expect(errorOutput).toContain("current release is");
  });

  it("FAIL loud (not a raw stack) when package.json is missing", () => {
    writeReadme("The current release is `v0.57.0`.");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-readme-release-version: FAIL");
    expect(errorOutput).toContain("package.json");
  });

  it("FAIL loud (not a raw stack) when README.md is missing", () => {
    writePkg("0.57.0");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-readme-release-version: FAIL");
    expect(errorOutput).toContain("README.md");
  });
});

// Spawn smoke tests: actually exec
// `node scripts/check-readme-release-version.mjs` as a child process, the
// way CI's step really invokes it. Unlike the in-process `main()` coverage
// above (which cannot see the top-level `if (isDirectRun) { main(...); }`
// guard, since importing the module from a test never sets `isDirectRun`
// true), this is the only way to catch a mutant that breaks that guard
// (e.g. `if (isDirectRun)` -> `if (false)`), which would make the CLI
// silently exit 0 with no output even on a version mismatch.
describe("CLI spawn smoke test", () => {
  let dir: string;

  function writePkg(version: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }));
  }

  function writeReadme(text: string): void {
    writeFileSync(join(dir, "README.md"), text);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-readme-release-version-spawn-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("on a matching fixture (spawn argv[2]): exits 0 and prints the OK line on stdout", () => {
    writePkg("0.57.0");
    writeReadme("Intro.\n\nThe current release is `v0.57.0`.\n\nMore.");

    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(stdout).toContain("check-readme-release-version: OK");
  });

  it("on a mismatched fixture (spawn argv[2]): exits nonzero and names both versions", () => {
    writePkg("0.58.0");
    writeReadme("Intro.\n\nThe current release is `v0.57.0`.\n\nMore.");

    const threw = spawnExpectingFailure(process.execPath, [SCRIPT_PATH, dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(threw.status).toBe(1);
    expect(threw.stderr).toContain("v0.57.0");
    expect(threw.stderr).toContain("0.58.0");
    expect(threw.stderr).toContain("check-readme-release-version: FAIL");
  });
});
