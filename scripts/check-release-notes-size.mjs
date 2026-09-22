#!/usr/bin/env node
// CI gate: the CHANGELOG.md section for package.json's current version
// must not exceed a size ceiling comfortably under GitHub's release/tag
// body limit. Same idiom as scripts/check-changelog-coverage.mjs
// (exported pure functions + a `main(repoDir)` entry point that
// communicates failure via `process.exitCode`, guarded by an
// `isDirectRun` check so tests can import without triggering a real
// run).
//
// Why: `.github/workflows/release.yml`'s "Extract changelog for this
// version" step awk-extracts the tagged version's CHANGELOG.md section
// and posts it as the GitHub Release body via
// `softprops/action-gh-release`. GitHub's release/tag body has a
// documented size limit around 125,000 characters; a section that grows
// past it would fail (or get silently truncated, depending on the
// action's own handling) only at TAG time, after the version bump,
// CHANGELOG heading insertion and PR have already merged - the most
// expensive point to discover it. This gate runs the SAME extraction
// (mirroring release.yml's awk pattern, see `extractVersionSection`
// below) against package.json's version in CI, before the tag exists, so
// a runaway section is caught during the PR instead.
//
// The ceiling below is deliberately well under GitHub's ~125,000-char
// limit: the 0.57.0 section measured 110,880 characters at the time this
// gate was written (close to the limit already, from long entries
// documenting a heavily-reviewed change), and the ceiling leaves enough
// headroom to still flag runaway growth on the NEXT release cycle without
// tripping on ordinary entries.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Ceiling in characters. Chosen below GitHub's documented release/tag
 * body limit (roughly 125,000 characters) with headroom above the
 * 110,880-character size measured for the 0.57.0 section when this gate
 * was written - see the module header for the reasoning. Move this
 * deliberately, never as an automatic reaction to one failing run;
 * record the change in CHANGELOG.md.
 */
export const CEILING = 115000;

/**
 * Mirrors `.github/workflows/release.yml`'s extraction awk script,
 * `awk '/^## \[VERSION\]/{found=1; next} /^## \[/{found=0} found'`: the
 * section body between the version's own `## [VERSION]` heading line
 * (excluded) and the next `## [` heading (excluded). Empty string when
 * the heading is not found - same "extracts nothing, not an error"
 * behavior as the awk step, whose own "Fail on empty release notes" step
 * is release.yml's separate guard, not this function's job.
 *
 * `version` is spliced into a regular expression the same way the awk
 * script splices it into an ERE (an unescaped `.` in the version matches
 * any character there too) - deliberately the same extraction, not a
 * stricter one, so this gate measures exactly what release.yml will
 * ship.
 *
 * Returns the matched lines as an array (not yet joined) so callers can
 * measure the size the way release.yml's awk step actually produces it -
 * see `measureExtractedSize` below, which accounts for the trailing
 * newline `array.join("\n")` alone would drop.
 */
export function extractVersionSectionLines(changelogText, version) {
  const heading = new RegExp(`^## \\[${version}\\]`);
  // A file that ends with a newline (the ordinary case) splits into one
  // MORE element than awk ever sees: "a\n".split("\n") is ["a", ""],
  // while awk's own newline-delimited records are just ["a"] - it does
  // not emit a phantom empty record for a trailing newline. Left in,
  // that phantom "" becomes a spurious matched line whenever a
  // version's section runs all the way to end of file (the oldest
  // CHANGELOG section, with no closing "## [" heading after it),
  // over-counting measureExtractedSize's result by one (its own
  // trailing-newline "+1" term charges for a line that was never
  // really there).
  const rawLines = changelogText.split("\n");
  const lines = changelogText.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
  let found = false;
  const out = [];
  for (const line of lines) {
    if (heading.test(line)) {
      found = true;
      continue;
    }
    if (found && /^## \[/.test(line)) {
      found = false;
      continue;
    }
    if (found) out.push(line);
  }
  return out;
}

/**
 * Same extraction as `extractVersionSectionLines`, joined into a single
 * string with no trailing newline. Kept for callers (and existing tests)
 * that only need the section's text, not its release.yml-accurate byte
 * size - see `measureExtractedSize` for that.
 */
export function extractVersionSection(changelogText, version) {
  return extractVersionSectionLines(changelogText, version).join("\n");
}

/**
 * The size release.yml's awk step actually produces in release_notes.md,
 * measured over the SAME matched `lines` array `extractVersionSectionLines`
 * returns. Awk's default print action emits each matched line followed by
 * its own ORS (`\n`), including the last one - so the file's true length
 * is `sum(line.length) + lines.length`, one MORE than
 * `lines.join("\n").length` (which has only `lines.length - 1`
 * separators) whenever at least one line matched. Zero matched lines
 * produces zero bytes on both sides, matching the awk step's own
 * "heading not found" behavior.
 */
export function measureExtractedSize(lines) {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + line.length, lines.length);
}

export function main(repoDir = process.cwd()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  } catch (err) {
    console.error(`check-release-notes-size: FAIL - could not read/parse package.json (${err instanceof Error ? err.message : String(err)}).`);
    process.exitCode = 1;
    return;
  }
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (version === null) {
    console.error('check-release-notes-size: FAIL - package.json has no string "version" field.');
    process.exitCode = 1;
    return;
  }

  let changelog;
  try {
    changelog = readFileSync(join(repoDir, "CHANGELOG.md"), "utf8");
  } catch (err) {
    console.error(`check-release-notes-size: FAIL - could not read CHANGELOG.md (${err instanceof Error ? err.message : String(err)}).`);
    process.exitCode = 1;
    return;
  }

  const lines = extractVersionSectionLines(changelog, version);
  const size = measureExtractedSize(lines);

  if (size > CEILING) {
    console.error(
      `check-release-notes-size: FAIL - the CHANGELOG.md section for version ${version} is ${size} characters, ` +
        `above the ${CEILING}-character ceiling (GitHub's release/tag body limit is roughly 125,000 characters; ` +
        "this ceiling leaves headroom below it). Trim the section, or split the release, before tagging.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`check-release-notes-size: OK - the CHANGELOG.md section for version ${version} is ${size} characters (ceiling ${CEILING}).`);
}

// Only auto-run when invoked directly (not when imported by tests) - same
// guard as scripts/check-changelog-coverage.mjs. Optional argv[2] = repo
// dir.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main(process.argv[2] ?? process.cwd());
}
