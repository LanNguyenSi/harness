import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CEILING,
  extractVersionSection,
  extractVersionSectionLines,
  main,
  measureExtractedSize,
} from "../../scripts/check-release-notes-size.mjs";

// Pinned, not just "some number below GitHub's limit": a bump to CEILING
// must be a deliberate CHANGELOG-recorded decision (module header), not a
// silent widening that slips through review. Also guards against a
// mutant that raises the constant to make the over-ceiling test below
// pass for the wrong reason.
it("CEILING is pinned to 115000", () => {
  expect(CEILING).toBe(115000);
});

// Drift guard: .github/workflows/release.yml re-measures the SAME
// ceiling directly (no node/npm setup in that job, so it can't import
// this module - see release.yml's "Release-notes size ceiling" step
// comment). If CEILING moves here without the workflow's literal
// `ceiling=<n>` moving with it, the two diverge silently; this test
// reads the workflow file itself (idiom: tests/cli/init-full-template-pins.test.ts's
// drift checks) so a change to either side alone fails it.
it("release.yml's ceiling literal stays pinned to CEILING", () => {
  const releaseYml = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
  expect(releaseYml).toContain(`ceiling=${CEILING}`);
});

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

// Parity with release.yml's ACTUAL awk step (not a re-implementation of
// it): runs the same `awk '/^## \[V\]/{found=1; next} /^## \[/{found=0}
// found'` program release.yml's "Extract changelog for this version"
// step uses, via child_process, against a fixture CHANGELOG, and checks
// that measureExtractedSize's byte count over the SAME extraction
// (extractVersionSectionLines) equals the byte length of awk's real
// stdout. This is the round-2 fix for the finding that the check
// script's own .length measurement (no trailing newline) undercounted
// release.yml's true release_notes.md size by exactly one newline.
// Real awk is spawned through `sh -c` (INFRA-allowlisted in
// tests/_helpers/hermetic-spawn-allowlist.ts, the same real system shell
// several existing tests already invoke directly) rather than as a
// direct `awk` child: this suite's suite-wide hermetic spawn guard
// refuses a direct spawn of a non-allowlisted binary, and that guard
// file is out of this task's scope.
function runReleaseYmlAwk(version: string, changelog: string): string {
  const program = `/^## \\[${version}\\]/{found=1; next} /^## \\[/{found=0} found`;
  return execFileSync("sh", ["-c", "awk \"$1\"", "--", program], {
    input: changelog,
    encoding: "utf8",
  });
}

describe("measureExtractedSize matches the real awk step's output size", () => {
  it("equals the byte length of release.yml's own awk program's stdout", () => {
    const version = "0.2.0";
    const changelog = ["## [Unreleased]", "", "## [0.2.0]", "- entry a", "- entry b", "", "## [0.1.0]", "- old"].join("\n");
    const lines = extractVersionSectionLines(changelog, version);

    const awkOutput = runReleaseYmlAwk(version, changelog);

    expect(measureExtractedSize(lines)).toBe(Buffer.byteLength(awkOutput, "utf8"));
  });

  it("is 0 for both sides when the heading is not found", () => {
    const changelog = ["## [Unreleased]", "", "## [0.1.0]", "- old"].join("\n");
    const lines = extractVersionSectionLines(changelog, "9.9.9");

    const awkOutput = runReleaseYmlAwk("9.9.9", changelog);

    expect(measureExtractedSize(lines)).toBe(0);
    expect(awkOutput).toBe("");
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

  // Boundary at the ceiling itself: a single-line section (measured as
  // `line.length + 1`, the awk-parity trailing newline) that lands
  // EXACTLY at CEILING passes, and one character over fails. This pins
  // the `> CEILING` comparison (not `>=`) and the "+1" trailing-newline
  // term together, so a mutant that drops the "+1" (making CEILING - 1
  // the effective pass boundary) or flips the comparison is caught here.
  // Fixture has no blank separator line before the next heading, so the
  // section is exactly one matched line: measureExtractedSize is
  // `line.length + 1` (the parity-fixed trailing-newline term), pinned
  // against CEILING directly rather than against a hand-derived length.
  it("passes at exactly CEILING bytes (parity-measured)", () => {
    writePkg("0.1.0");
    const line = "x".repeat(CEILING - 1);
    writeChangelog(["## [Unreleased]", "", "## [0.1.0]", line, "## [0.0.1]", "- older"].join("\n"));
    expect(measureExtractedSize(extractVersionSectionLines(["## [0.1.0]", line, "## [0.0.1]"].join("\n"), "0.1.0"))).toBe(CEILING);

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-release-notes-size: OK"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fails at CEILING + 1 bytes (parity-measured)", () => {
    writePkg("0.1.0");
    const line = "x".repeat(CEILING);
    writeChangelog(["## [Unreleased]", "", "## [0.1.0]", line, "## [0.0.1]", "- older"].join("\n"));
    expect(measureExtractedSize(extractVersionSectionLines(["## [0.1.0]", line, "## [0.0.1]"].join("\n"), "0.1.0"))).toBe(CEILING + 1);

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-release-notes-size: FAIL");
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
