#!/usr/bin/env node
// CI gate: README.md's release-headline sentence, "The current release is
// `vX.Y.Z`.", must name the SAME version as package.json's "version" field.
// Same idiom as scripts/check-changelog-coverage.mjs (exported pure
// functions + a `main(repoDir)` entry point that communicates failure via
// `process.exitCode`, guarded by an `isDirectRun` check so tests can
// import without triggering a real run).
//
// Why: the README's own prose is the most-read "what version is this"
// signal for a human landing on the repo, and it is hand-edited (part of
// the release-prep steps in CONTRIBUTING.md's Releasing section), so it
// can drift from package.json's version silently - nothing else in CI
// compared the two before this gate. Fails fast in CI, next to
// check:changelog-coverage, rather than being discovered by a reader
// after the fact.
//
// Scope: this gate checks only the one release-headline sentence. It does
// not touch README's milestone list or any other README content.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Matches "The current release is `vX.Y.Z`." and captures the version
// (without the leading "v"). The backtick-quoted `vX.Y.Z` form and the
// trailing period are both part of the sentence this gate pins.
const RELEASE_SENTENCE_PATTERN = /The current release is `v([^`]+)`\./;

/**
 * Extracts the version named by README's release-headline sentence, or
 * null when the sentence itself is not present (distinguished from a
 * present-but-different version so the caller can report each case with
 * its own message).
 */
export function extractReadmeVersion(readmeText) {
  const m = RELEASE_SENTENCE_PATTERN.exec(readmeText);
  return m ? m[1] : null;
}

export function main(repoDir = process.cwd()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  } catch (err) {
    console.error(`check-readme-release-version: FAIL - could not read/parse package.json (${err instanceof Error ? err.message : String(err)}).`);
    process.exitCode = 1;
    return;
  }
  const pkgVersion = typeof pkg.version === "string" ? pkg.version : null;
  if (pkgVersion === null) {
    console.error('check-readme-release-version: FAIL - package.json has no string "version" field.');
    process.exitCode = 1;
    return;
  }

  let readme;
  try {
    readme = readFileSync(join(repoDir, "README.md"), "utf8");
  } catch (err) {
    console.error(`check-readme-release-version: FAIL - could not read README.md (${err instanceof Error ? err.message : String(err)}).`);
    process.exitCode = 1;
    return;
  }

  const readmeVersion = extractReadmeVersion(readme);
  if (readmeVersion === null) {
    console.error(
      "check-readme-release-version: FAIL - README.md has no " +
        '"The current release is `vX.Y.Z`." sentence to check against ' +
        `package.json's version (${pkgVersion}).`,
    );
    process.exitCode = 1;
    return;
  }

  if (readmeVersion !== pkgVersion) {
    console.error(
      "check-readme-release-version: FAIL - README.md says " +
        `"The current release is \`v${readmeVersion}\`." but package.json's ` +
        `version is "${pkgVersion}". Update the README sentence as part of ` +
        "the release-prep steps (see CONTRIBUTING.md's Releasing section).",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`check-readme-release-version: OK - README.md's release sentence matches package.json's version (${pkgVersion}).`);
}

// Only auto-run when invoked directly (not when imported by tests) - same
// guard as scripts/check-changelog-coverage.mjs. Optional argv[2] = repo
// dir.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main(process.argv[2] ?? process.cwd());
}
