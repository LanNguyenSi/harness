import { describe, expect, it } from "vitest";
import { compareVersionFloor, parseProbedVersion } from "../../src/io/version-compare.js";

// Direct unit coverage for the shared pair every `min_version` floor
// check in this codebase now uses (task db44ab46,
// docs/decisions/2026-09-08-preflight-floors.md). Review round 1
// (D-021) flagged that these two functions had no unit test of their
// own, only indirect coverage through five surface-level test files.

describe("parseProbedVersion", () => {
  it("parses a dotted prerelease suffix", () => {
    expect(parseProbedVersion("true 1.2.3-rc.1\n")).toEqual({
      version: "1.2.3",
      isPrerelease: true,
      raw: "1.2.3-rc.1",
      token: "1.2.3-rc.1",
    });
  });

  it("parses a dotless prerelease suffix", () => {
    expect(parseProbedVersion("true 1.2.3-beta\n")).toEqual({
      version: "1.2.3",
      isPrerelease: true,
      raw: "1.2.3-beta",
      token: "1.2.3-beta",
    });
  });

  it("truncates a git-describe suffix's second hyphen in `raw`, but not in `token`", () => {
    const parsed = parseProbedVersion("true 0.6.0-4-gabc123\n");
    expect(parsed).not.toBeNull();
    expect(parsed?.isPrerelease).toBe(true);
    expect(parsed?.version).toBe("0.6.0");
    // raw's suffix class ([0-9A-Za-z.]) excludes '-', so the match
    // stops at the second hyphen.
    expect(parsed?.raw).toBe("0.6.0-4");
    // token has no character-class restriction: it runs to the next
    // whitespace, so it reports exactly what the probe printed.
    expect(parsed?.token).toBe("0.6.0-4-gabc123");
  });

  it("truncates a platform suffix's second hyphen in `raw`, but not in `token`", () => {
    const parsed = parseProbedVersion("true 0.6.0-linux-x64\n");
    expect(parsed).not.toBeNull();
    expect(parsed?.isPrerelease).toBe(true);
    expect(parsed?.version).toBe("0.6.0");
    expect(parsed?.raw).toBe("0.6.0-linux");
    expect(parsed?.token).toBe("0.6.0-linux-x64");
  });

  it("does not treat a `+build` metadata suffix as a prerelease", () => {
    const parsed = parseProbedVersion("true 1.2.3+build.5\n");
    expect(parsed).not.toBeNull();
    expect(parsed?.isPrerelease).toBe(false);
    expect(parsed?.version).toBe("1.2.3");
    expect(parsed?.raw).toBe("1.2.3");
    // token still reports the full printed token, metadata included.
    expect(parsed?.token).toBe("1.2.3+build.5");
  });

  it("returns null when no numeric run is found", () => {
    expect(parseProbedVersion("command not found\n")).toBeNull();
  });
});

describe("compareVersionFloor", () => {
  it("returns the numeric comparison when actual is genuinely below the floor", () => {
    expect(compareVersionFloor("1.2.2", false, "1.2.3")).toBe(-1);
  });

  it("treats a prerelease actual as below an equal-numeric floor (tie-prerelease)", () => {
    expect(compareVersionFloor("1.2.3", true, "1.2.3")).toBe(-1);
  });

  it("treats a non-prerelease actual as meeting an equal-numeric floor (tie-release)", () => {
    expect(compareVersionFloor("1.2.3", false, "1.2.3")).toBe(0);
  });

  it("does not penalise a prerelease when the numeric comparison is not a tie (above-prerelease)", () => {
    expect(compareVersionFloor("1.2.4", true, "1.2.3")).toBe(1);
  });
});
