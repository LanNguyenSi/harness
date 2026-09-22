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
// limit: the 0.57.0 section measured 110,879 characters at the time this
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
 * 110,879-character size measured for the 0.57.0 section when this gate
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
 */
export function extractVersionSection(changelogText, version) {
  const heading = new RegExp(`^## \\[${version}\\]`);
  const lines = changelogText.split("\n");
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
  return out.join("\n");
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

  const section = extractVersionSection(changelog, version);
  const size = section.length;

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
