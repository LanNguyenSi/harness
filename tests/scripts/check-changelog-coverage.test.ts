import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKIPPED_TYPES,
  classifyCommits,
  commitType,
  extractUnreleased,
  linkTokens,
  main,
  parseCommits,
} from "../../scripts/check-changelog-coverage.mjs";

const US = "\u001f";
const RS = "\u001e";

function commit(over: Partial<{ sha: string; subject: string; message: string }> = {}) {
  const subject = over.subject ?? "feat(x): do the thing (#123)";
  return {
    sha: over.sha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    subject,
    message: over.message ?? subject,
  };
}

describe("extractUnreleased", () => {
  it("returns the section body between [Unreleased] and the next release heading", () => {
    const text = ["# Changelog", "", "## [Unreleased]", "", "### Fixed", "- entry (task `deadbee1`)", "", "## [0.1.0] - 2026-01-01", "- old"].join("\n");
    const section = extractUnreleased(text);
    expect(section).toContain("deadbee1");
    expect(section).not.toContain("old");
  });

  it("returns null (not empty string) when the [Unreleased] heading is missing", () => {
    expect(extractUnreleased("# Changelog\n\n## [0.1.0]\n- old\n")).toBeNull();
  });

  it("returns an empty-ish body for a present but empty section", () => {
    const section = extractUnreleased("## [Unreleased]\n\n## [0.1.0]\n- old\n");
    expect(section).not.toBeNull();
    expect((section ?? "x").trim()).toBe("");
  });
});

describe("parseCommits", () => {
  it("parses US/RS-separated git log output into records", () => {
    const raw = `sha1${US}fix: a (#1)${US}fix: a (#1)\n\nbody a${RS}\nsha2${US}feat: b (#2)${US}feat: b (#2)${RS}`;
    const commits = parseCommits(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ sha: "sha1", subject: "fix: a (#1)" });
    expect(commits[0]?.message).toContain("body a");
    expect(commits[1]?.sha).toBe("sha2");
  });

  it("returns [] for empty log output (no commits since the tag)", () => {
    expect(parseCommits("")).toHaveLength(0);
    expect(parseCommits("\n")).toHaveLength(0);
  });
});

describe("commitType", () => {
  it("parses plain, scoped, and breaking conventional prefixes", () => {
    expect(commitType("fix: x")).toBe("fix");
    expect(commitType("feat(risk-gate): x")).toBe("feat");
    expect(commitType("feat(api)!: x")).toBe("feat");
    expect(commitType("TEST(a): x")).toBe("test");
  });

  it("returns the literal prefix for unknown types and null without a prefix", () => {
    // "doctor:" is a real historical subject shape in this repo — it must
    // parse as type "doctor" (never in SKIPPED_TYPES), not crash or skip.
    expect(commitType("doctor: resolve the dead block (#423)")).toBe("doctor");
    expect(commitType("read-only-bash: recognize long options (#415)")).toBeNull();
    expect(commitType("no prefix at all")).toBeNull();
  });
});

describe("linkTokens", () => {
  it("extracts 8-hex task ids from subject and body, requiring a hex letter", () => {
    const t = linkTokens(commit({ subject: "fix: x (deadbee1) (#9)", message: "fix: x (deadbee1) (#9)\n\ncloses task cafe0012\nand 12345678 is a number" }));
    expect(t.taskIds).toContain("deadbee1");
    expect(t.taskIds).toContain("cafe0012");
    expect(t.taskIds).not.toContain("12345678");
  });

  it("does not shed 8-hex windows out of a longer hex run (embedded 40-hex SHA)", () => {
    const t = linkTokens(commit({ message: "reverts deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
    expect(t.taskIds).toHaveLength(0);
  });

  it("extracts PR numbers from the subject only, and GHSA ids from anywhere", () => {
    const t = linkTokens(
      commit({ subject: "fix(deps): close advisory (#374)", message: "fix(deps): close advisory (#374)\n\nGHSA-r28c-9q8g-f849, relates to #999" }),
    );
    expect(t.prNumbers).toEqual(["#374"]);
    expect(t.ghsaIds).toEqual(["GHSA-r28c-9q8g-f849"]);
  });
});

describe("classifyCommits", () => {
  const unreleased = "### Fixed\n- the thing (task `deadbee1`)\n- advisory GHSA-r28c-9q8g-f849 closed (#374)\n";

  it("skips every type in SKIPPED_TYPES without requiring coverage", () => {
    for (const type of SKIPPED_TYPES) {
      const { skipped, uncovered } = classifyCommits([commit({ subject: `${type}(x): whatever (#1)` })], unreleased);
      expect(skipped).toHaveLength(1);
      expect(uncovered).toHaveLength(0);
    }
  });

  it("covers a commit via task id, via PR number, via GHSA id, and via its own short SHA", () => {
    const byTaskId = commit({ subject: "fix: a (#77)", message: "fix: a (#77)\n\ntask deadbee1" });
    const byPr = commit({ subject: "fix(deps): b (#374)" });
    const byGhsa = commit({ subject: "fix(deps): c (#78)", message: "fix(deps): c (#78)\n\nGHSA-r28c-9q8g-f849" });
    const bySha = commit({ sha: "0123abc4567890000000000000000000000000ff", subject: "perf: d" });
    const text = `${unreleased}\n- direct cite of 0123abc\n`;
    const { covered, uncovered } = classifyCommits([byTaskId, byPr, byGhsa, bySha], text);
    expect(covered).toHaveLength(4);
    expect(uncovered).toHaveLength(0);
  });

  it("reports an unskipped, unlinked commit as uncovered, carrying its tokens", () => {
    const c = commit({ subject: "feat: brand new thing (#500)", message: "feat: brand new thing (#500)\n\ntask cafe0012" });
    const { uncovered } = classifyCommits([c], unreleased);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.tokens.taskIds).toContain("cafe0012");
    expect(uncovered[0]?.tokens.prNumbers).toContain("#500");
  });

  it("an unknown type (e.g. 'doctor:') is NOT skippable — it needs coverage", () => {
    const { uncovered } = classifyCommits([commit({ subject: "doctor: fix the block (#423)" })], unreleased);
    expect(uncovered).toHaveLength(1);
  });

  it("treats a null section (missing heading) as empty text", () => {
    const { uncovered } = classifyCommits([commit()], null);
    expect(uncovered).toHaveLength(1);
  });
});

// main() runs against small REAL fixture git repos (git is on the
// hermetic-spawn allowlist for exactly this fixture-building purpose) and
// inspects console output + process.exitCode, mirroring
// check-no-only.test.ts's main() suite.
describe("main", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function git(...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  }

  function initRepoWithTag(changelog: string): void {
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    // Hermetic against operator-global git config (hooks, signing).
    git("config", "core.hooksPath", "/dev/null");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(join(dir, "CHANGELOG.md"), changelog);
    git("add", "CHANGELOG.md");
    git("commit", "-q", "-m", "chore(release): v0.1.0");
    git("tag", "v0.1.0");
  }

  function addCommit(subject: string, body = ""): void {
    writeFileSync(join(dir, "file.txt"), `${subject}\n${body}\n`);
    git("add", "file.txt");
    git("commit", "-q", "-m", body ? `${subject}\n\n${body}` : subject);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-changelog-coverage-"));
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

  it("OK when every commit since the tag is covered or type-skipped", () => {
    initRepoWithTag("## [Unreleased]\n\n### Fixed\n- the thing (task `deadbee1`)\n\n## [0.1.0]\n- base\n");
    addCommit("fix: the thing (#7)", "task deadbee1");
    addCommit("test(x): only tests");

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-changelog-coverage: OK — 2 commit(s) since v0.1.0 (1 covered, 1 skipped by type)"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("OK with zero commits since the tag (fresh release state)", () => {
    initRepoWithTag("## [Unreleased]\n\n## [0.1.0]\n- base\n");

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("0 commit(s) since v0.1.0"));
  });

  it("FAIL listing the uncovered commit with the tokens it looked for", () => {
    initRepoWithTag("## [Unreleased]\n\n### Fixed\n- unrelated (task `deadbee1`)\n\n## [0.1.0]\n- base\n");
    addCommit("feat: uncovered thing (#42)", "task cafe0012");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-changelog-coverage: FAIL — 1 commit(s) since v0.1.0");
    expect(errorOutput).toContain("feat: uncovered thing (#42)");
    expect(errorOutput).toContain("cafe0012");
    expect(errorOutput).toContain("#42");
  });

  it("FAIL when commits exist but CHANGELOG.md has no [Unreleased] section", () => {
    initRepoWithTag("# Changelog\n\n## [0.1.0]\n- base\n");
    addCommit("feat: something (#9)");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("no '## [Unreleased]' section");
  });

  it("FAIL (never silently green) when no tag is reachable", () => {
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("config", "core.hooksPath", "/dev/null");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n");
    git("add", "CHANGELOG.md");
    git("commit", "-q", "-m", "feat: first");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("no tag reachable");
  });
});
