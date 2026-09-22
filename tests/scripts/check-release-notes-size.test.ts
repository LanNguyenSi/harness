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

// Locale pin: release.yml's "Release-notes size ceiling" step's `wc -m`
// only counts CHARACTERS (matching this script's JS `.length` unit)
// under a UTF-8 locale - without one pinned, it silently falls back to
// counting BYTES, over-counting any multi-byte UTF-8 character. A
// mutant that drops the pin or weakens it (e.g. to plain "C") would
// reintroduce that byte-vs-character divergence unnoticed by any other
// test here. Matched WITH its trailing newline, not just the bare
// substring: the step's own explanatory comment quotes the same
// "LC_ALL: C.UTF-8" string in prose (backtick-fenced, no newline right
// after it), which a bare `toContain` would keep matching even after a
// mutant weakened the real `env:` value below - discriminating against
// exactly that false-pass.
it("release.yml pins LC_ALL to C.UTF-8 so wc -m counts characters, not bytes", () => {
  const releaseYml = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
  expect(releaseYml).toContain("LC_ALL: C.UTF-8\n");
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
// it): reads the real program text out of release.yml's own "Extract
// changelog for this version" step (no hand-restated copy of the
// program to drift out of sync with it) and runs THAT program, via
// child_process, against a fixture CHANGELOG - so a change to
// release.yml's awk program alone (not just this script) fails this
// test. `version` is substituted for the step's own
// `${{ steps.version.outputs.version }}` placeholder, the same
// substitution GitHub Actions performs at run time.
function readReleaseYmlAwkProgram(): string {
  const releaseYml = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
  const match = releaseYml.match(/awk '([^'\n]*)' CHANGELOG\.md/);
  const program = match?.[1];
  if (program === undefined) {
    throw new Error("could not find the awk extraction program in .github/workflows/release.yml's 'Extract changelog for this version' step");
  }
  return program;
}

// Real awk is spawned directly (INFRA-allowlisted in
// tests/_helpers/hermetic-spawn-allowlist.ts, the same real system tool
// git/patch/sh already are) rather than through a `sh -c` indirection:
// execFile* never invokes a shell, so the program text needs no quoting
// at all, and a direct child is what this suite's hermetic spawn guard
// is actually meant to see and allowlist.
function runReleaseYmlAwk(version: string, changelog: string): string {
  const program = readReleaseYmlAwkProgram().replace("${{ steps.version.outputs.version }}", version);
  return execFileSync("awk", [program], {
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

  // Newline-terminated EOF case (the round-3 fix for the phantom
  // trailing split element): the version's section runs to the very
  // end of a file that itself ends with "\n" (the ordinary case for a
  // real CHANGELOG.md, and the oldest section in it, with no closing
  // "## [" heading after it). Without the fix, `changelogText.split`'s
  // spurious trailing "" would be counted as one more matched line than
  // awk's real output has.
  it("matches awk's output when the section runs to end of a newline-terminated file", () => {
    const version = "0.1.0";
    const changelog = ["## [Unreleased]", "", "## [0.1.0]", "- last entry", "- another line"].join("\n") + "\n";
    const lines = extractVersionSectionLines(changelog, version);

    const awkOutput = runReleaseYmlAwk(version, changelog);

    expect(measureExtractedSize(lines)).toBe(Buffer.byteLength(awkOutput, "utf8"));
  });

  // Astral-plane relation: `wc -m` under release.yml's pinned C.UTF-8
  // locale counts Unicode CODE POINTS (one per character, matched here
  // by Array.from(...).length, which iterates by code point). This
  // script's `measureExtractedSize` is built from JS string `.length`,
  // which counts UTF-16 CODE UNITS - two for an astral-plane character
  // (code point above U+FFFF, e.g. an emoji: a surrogate pair) where a
  // code-point count sees one. So for astral-plane text this script's
  // pre-tag measurement is always >= wc -m's at-tag measurement, never
  // the looser of the two gates - it can only be equal to or stricter
  // than release.yml's own check for the same section.
  it("over-counts an astral-plane character relative to a code-point count (the pre-tag gate is never the looser one)", () => {
    const version = "0.4.0";
    const changelog = ["## [Unreleased]", "", "## [0.4.0]", "- celebrate \u{1F389} done", "", "## [0.1.0]", "- old"].join("\n");
    const lines = extractVersionSectionLines(changelog, version);

    const awkOutput = runReleaseYmlAwk(version, changelog);
    const codePointCount = Array.from(awkOutput).length;

    expect(measureExtractedSize(lines)).toBe(codePointCount + 1);
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
