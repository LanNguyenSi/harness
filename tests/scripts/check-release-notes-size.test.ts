import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEILING, extractVersionSection, main } from "../../scripts/check-release-notes-size.mjs";

describe("extractVersionSection", () => {
  it("extracts the section body between the version's heading and the next heading", () => {
    const changelog = ["## [Unreleased]", "", "## [0.2.0]", "- entry a", "- entry b", "", "## [0.1.0]", "- old"].join("\n");
    const section = extractVersionSection(changelog, "0.2.0");
    expect(section).toContain("entry a");
    expect(section).toContain("entry b");
    expect(section).not.toContain("old");
    expect(section).not.toContain("[0.2.0]");
  });

  it("returns an empty string when the heading is not found (mirrors the awk step's own behavior)", () => {
    const changelog = ["## [Unreleased]", "", "## [0.1.0]", "- old"].join("\n");
    expect(extractVersionSection(changelog, "9.9.9")).toBe("");
  });

  it("extracts to end of file when there is no following heading", () => {
    const changelog = ["## [0.3.0]", "- last entry", "- another line"].join("\n");
    const section = extractVersionSection(changelog, "0.3.0");
    expect(section).toContain("last entry");
    expect(section).toContain("another line");
  });
});

// main() runs against small real fixture directories (CHANGELOG.md +
// package.json) and inspects console output + process.exitCode,
// mirroring check-changelog-coverage.test.ts's main() suite.
describe("main", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function writePkg(version: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }));
  }

  function writeChangelog(text: string): void {
    writeFileSync(join(dir, "CHANGELOG.md"), text);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-release-notes-size-"));
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

  it("OK when the version's section is under the ceiling", () => {
    writePkg("0.1.0");
    writeChangelog(["## [Unreleased]", "", "## [0.1.0]", "- a small entry", "", "## [0.0.1]", "- older"].join("\n"));

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-release-notes-size: OK"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("FAIL (over-ceiling fixture) when the version's section exceeds the ceiling", () => {
    writePkg("0.1.0");
    const oversized = "- ".padEnd(CEILING + 500, "x");
    writeChangelog(["## [Unreleased]", "", "## [0.1.0]", oversized, "", "## [0.0.1]", "- older"].join("\n"));

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-release-notes-size: FAIL");
    expect(errorOutput).toContain(String(CEILING));
    expect(errorOutput).toContain("0.1.0");
  });

  it("FAIL loud (not a raw stack) when package.json is missing", () => {
    writeChangelog("## [0.1.0]\n- entry");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-release-notes-size: FAIL");
    expect(errorOutput).toContain("package.json");
  });

  it("FAIL loud (not a raw stack) when CHANGELOG.md is missing", () => {
    writePkg("0.1.0");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-release-notes-size: FAIL");
    expect(errorOutput).toContain("CHANGELOG.md");
  });
});
