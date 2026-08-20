import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKIPPED_TYPES,
  classifyCommits,
  commitType,
  extractCoverageText,
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

describe("extractCoverageText", () => {
  // Regression pin for the HIGH review finding: a release-prep roll-up
  // commit renames/duplicates [Unreleased] into a not-yet-tagged
  // `## [X.Y.Z]` heading while `git describe` still resolves the PRIOR
  // tag. The coverage text must span both sections, not just Unreleased.
  it("spans [Unreleased] plus any not-yet-tagged rolled-up section above the last tag's heading", () => {
    const text = [
      "## [Unreleased]",
      "",
      "## [0.2.0] - 2026-08-16",
      "- rolled up entry (task `deadbee1`)",
      "",
      "## [0.1.0] - 2026-01-01",
      "- old, already-tagged entry",
    ].join("\n");
    const coverage = extractCoverageText(text, "v0.1.0");
    expect(coverage).toContain("deadbee1");
    expect(coverage).not.toContain("old, already-tagged entry");
  });

  it("strips a leading 'v' from the tag before matching the version heading", () => {
    const text = "## [Unreleased]\n- x\n\n## [1.2.3]\n- old\n";
    expect(extractCoverageText(text, "v1.2.3")).not.toContain("old");
  });

  it("falls back to the whole file when the last tag's version heading is not found", () => {
    const text = "## [Unreleased]\n- entry (task `deadbee1`)\n";
    expect(extractCoverageText(text, "v9.9.9")).toBe(text);
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

  // Regression pin for the real Batch 19 / PR #437 gap: agent-tasks issues
  // purely-numeric ids too, and the pre-fix code dropped every 8-digit
  // window with no hex letter, so a commit citing one went uncovered with
  // no obvious cause even though its changelog entry named the id.
  it("accepts a purely numeric 8-digit id when a task/commit keyword sits right next to it", () => {
    const before = linkTokens(commit({ message: "fix: x (#1)\n\ntask 13919613" }));
    expect(before.taskIds).toContain("13919613");

    const backticked = linkTokens(commit({ message: "fix: x (#1)\n\ncloses task `13919613`" }));
    expect(backticked.taskIds).toContain("13919613");

    const commitKeyword = linkTokens(commit({ message: "fix: x (#1)\n\nsee commit 20261234 for context" }));
    expect(commitKeyword.taskIds).toContain("20261234");
  });

  it("does NOT accept a bare numeric 8-digit run with no adjacent task/commit keyword (no false coverage)", () => {
    // A version number, an issue count, or any other incidental 8-digit
    // run must stay uncovered-eligible: it must not silently satisfy the
    // gate just because it happens to be 8 digits long.
    const t = linkTokens(commit({ message: "fix: x (#1)\n\nsee 13919613 for context, version 20261234 shipped" }));
    expect(t.taskIds).not.toContain("13919613");
    expect(t.taskIds).not.toContain("20261234");
  });

  it("does NOT treat a keyword that only appears AFTER the digits as adjacency (the after side was dropped: zero corpus support, widest false-positive surface)", () => {
    const t = linkTokens(commit({ message: "fix: x (#1)\n\nreleased on 20260820, task 41f7eca5" }));
    expect(t.taskIds).not.toContain("20260820");
    // The hex-lettered id right next to "task" still counts unconditionally.
    expect(t.taskIds).toContain("41f7eca5");
  });

  it("does NOT treat a keyword separated by a lettered word as adjacency ('task id' / 'task number' near-misses)", () => {
    expect(linkTokens(commit({ message: "fix: x (#1)\n\ntask id 13919613" })).taskIds).not.toContain("13919613");
    expect(linkTokens(commit({ message: "fix: x (#1)\n\ntask number 13919613" })).taskIds).not.toContain("13919613");
  });

  it("requires a real word boundary before the keyword, not a substring match ('subtask' / 'committed')", () => {
    expect(linkTokens(commit({ message: "fix: x (#1)\n\nsubtask 13919613" })).taskIds).not.toContain("13919613");
    expect(linkTokens(commit({ message: "fix: x (#1)\n\ncommitted 13919613" })).taskIds).not.toContain("13919613");
  });

  it("does NOT reach across a separation wider than NUMERIC_ID_KEYWORD_GAP", () => {
    // "task" (4 chars) + 9 spaces = 13 chars, one past the 12-char gap.
    const wide = `task${" ".repeat(9)}13919613`;
    expect(linkTokens(commit({ message: `fix: x (#1)\n\n${wide}` })).taskIds).not.toContain("13919613");
  });

  it("does NOT treat a keyword embedded earlier in a longer word as adjacency, even when the fixed-width lookup window happens to start mid-word ('retask')", () => {
    // Regression pin for the slicing artifact: the 12-char window can be
    // truncated to start exactly at "task" inside "retask", making a
    // `\b`-anchored regex on just that slice see an artificial
    // start-of-string boundary as if it were a real word boundary.
    const sliced = `retask${" ".repeat(8)}13919613`;
    expect(linkTokens(commit({ message: sliced })).taskIds).not.toContain("13919613");
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

  it("SKIPPED_TYPES is exactly the closed list documented in the module header", () => {
    // Not tautological with the loop test below: this pins the actual
    // membership, so silently dropping (or adding) a type is caught even
    // though the loop test below would happily adapt to either.
    expect([...SKIPPED_TYPES].sort()).toEqual(["chore", "ci", "docs", "refactor", "style", "test"]);
  });

  it("skips every type in SKIPPED_TYPES without requiring coverage", () => {
    for (const type of SKIPPED_TYPES) {
      const { skipped, uncovered } = classifyCommits([commit({ subject: `${type}(x): whatever (#1)` })], unreleased);
      expect(skipped).toHaveLength(1);
      expect(uncovered).toHaveLength(0);
    }
  });

  it("does not match a shorter PR number when only a longer one containing it as a prefix is present", () => {
    const c = commit({ subject: "fix: x (#42)", message: "fix: x (#42)" });
    const { uncovered } = classifyCommits([c], "- unrelated entry mentions #423 elsewhere\n");
    expect(uncovered).toHaveLength(1);
  });

  it("does not match an 8-hex task id embedded inside a longer hex run in the coverage text", () => {
    const c = commit({ subject: "fix: x", message: "fix: x\n\ntask deadbee1" });
    const { uncovered } = classifyCommits([c], "- unrelated deadbee1234567 hex blob\n");
    expect(uncovered).toHaveLength(1);
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

  it("covers a commit via a purely numeric task id cited next to 'task' in the changelog", () => {
    const c = commit({ subject: "fix: x (#1)", message: "fix: x (#1)\n\ntask 13919613" });
    const { covered, uncovered } = classifyCommits([c], "- entry (task `13919613`)\n");
    expect(covered).toHaveLength(1);
    expect(uncovered).toHaveLength(0);
  });

  it("does NOT cover a commit whose only token is a bare numeric id with no keyword adjacency, even if the same digits appear in the coverage text (no false coverage)", () => {
    const c = commit({ subject: "fix: x (#1)", message: "fix: x (#1)\n\nsee 13919613 for context" });
    const { uncovered } = classifyCommits([c], "- unrelated entry mentions 13919613 as a version number\n");
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

  it("FAIL guidance ties the numeric-id adjacency rule to the commit message, not the changelog entry (message-shape pin)", () => {
    initRepoWithTag("## [Unreleased]\n\n### Fixed\n- unrelated (task `deadbee1`)\n\n## [0.1.0]\n- base\n");
    addCommit("feat: uncovered thing (#42)", "see 13919613 for context");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("is only recognized as a link token when the");
    expect(errorOutput).toContain("in the commit message itself");
    expect(errorOutput).toContain("not of the changelog entry's wording");
    expect(errorOutput).toContain("cite the commit's own SHA or the PR number (#NNN) in the changelog entry instead");
  });

  it("FAIL when commits exist but CHANGELOG.md has no [Unreleased] section", () => {
    initRepoWithTag("# Changelog\n\n## [0.1.0]\n- base\n");
    addCommit("feat: something (#9)");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("no '## [Unreleased]' section");
  });

  it("OK when [Unreleased] entries have been rolled up into a not-yet-tagged version section (release-prep shape)", () => {
    // Regression pin for the HIGH review finding: a release-prep roll-up
    // moves entries from [Unreleased] into a new `## [X.Y.Z]` heading
    // before the tag exists, so `git describe` still resolves the PRIOR
    // tag. Under the pre-fix code (coverage text = Unreleased section
    // only) this whole cycle would go uncovered.
    initRepoWithTag("## [Unreleased]\n\n## [0.1.0]\n- base\n");
    addCommit("fix: the thing (#7)", "task deadbee1");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "## [Unreleased]\n\n## [0.2.0] - 2026-08-16\n\n### Fixed\n- the thing (task `deadbee1`) (#7)\n\n## [0.1.0]\n- base\n",
    );
    git("add", "CHANGELOG.md");
    git("commit", "-q", "-m", "chore(release): v0.2.0");

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2 commit(s) since v0.1.0 (1 covered, 1 skipped by type)"));
  });

  it("excludes merge commits via --no-merges (pins the flag)", () => {
    initRepoWithTag("## [Unreleased]\n\n## [0.1.0]\n- base\n");
    git("checkout", "-q", "-b", "feature");
    addCommit("test(x): only tests"); // skipped type — safe to reach via the branch
    git("checkout", "-q", "master");
    // A merge commit's own subject ("Merge branch...") has no conventional
    // type and no link token — if it were ever included by the git log
    // range, it alone would flip this fixture to FAIL.
    git("merge", "-q", "--no-ff", "-m", "Merge branch 'feature'", "feature");

    main(dir);

    expect(process.exitCode).toBeUndefined();
  });

  it("FAIL loud (not a raw stack) when CHANGELOG.md is missing", () => {
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("config", "core.hooksPath", "/dev/null");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(join(dir, "placeholder.txt"), "x");
    git("add", "placeholder.txt");
    git("commit", "-q", "-m", "chore: init");
    git("tag", "v0.1.0");

    main(dir);

    expect(process.exitCode).toBe(1);
    const errorOutput = errorSpy.mock.calls.map((callArgs: unknown[]) => callArgs.join(" ")).join("\n");
    expect(errorOutput).toContain("check-changelog-coverage: FAIL");
    expect(errorOutput).toContain("CHANGELOG.md");
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
