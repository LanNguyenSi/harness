#!/usr/bin/env node
// Shipped `[Unreleased]` pointer check.
//
// A release cut moves CHANGELOG.md's `## [Unreleased]` notes under a new
// dated heading and leaves `## [Unreleased]` empty. A shipped file that
// still says "see CHANGELOG [Unreleased]" then points at nothing; four
// comments (`src/cli/policy/intercept.ts`, `src/runtime/kubectl-target-parse.ts`,
// `src/cli/doctor/types.ts`, `src/cli/validate/checks.ts`) did exactly this
// and were re-pointed to the shift-proof `CHANGELOG.md:#X.Y.Z` anchor form
// (see `rg 'CHANGELOG.md:#' src` for the existing convention this repo
// already uses elsewhere, e.g. `src/cli/approve/understanding.ts`). This
// gate keeps it that way, unconditionally: a source comment should always
// cite the version anchor that shipped an entry, never the transient
// `[Unreleased]` label, so no scanned file has a legitimate reason to
// contain that label. Unlike a check gated on "is the section currently
// empty," this fires even while `[Unreleased]` happens to have fresh
// content, since the pointer is wrong the moment the next release cut
// empties it, not only after.
//
// SCOPE: mirrors package.json's `files` field (`dist`, `README.md`,
// `CHANGELOG.md`, `LICENSE`, `scripts/runtime-reality-docker-probe.mjs`),
// with two deliberate departures:
//   - `dist` is swapped for its SOURCE (`src/`): `tsconfig.json` does not
//     set `removeComments`, so a comment in `src/**/*.ts` reaches
//     `dist/**/*.js` and `dist/**/*.d.ts` unchanged, and scanning the
//     source instead means this gate needs no `npm run build` first and
//     catches the defect earlier (this step runs before Build in
//     `.github/workflows/ci.yml`, the same slot as
//     `check:no-only`/`check:changelog-coverage`).
//   - `CHANGELOG.md` itself is NOT scanned, unlike agent-grounding's prior
//     art (see below): measured against this repo's own CHANGELOG.md, its
//     historical dated sections legitimately narrate past `[Unreleased]`
//     states in prose ("before this entry ever left `[Unreleased]`", "in
//     this same Unreleased batch", the changelog-coverage feature's own
//     entry describing what a missing `[Unreleased]` entry means) - none
//     of those is a dangling pointer, they are history, and a heading- and
//     link-reference-only exemption (agent-grounding's approach) does not
//     reach them. CHANGELOG.md is also the one file a reader holding it
//     cannot be misdirected by: there is no "elsewhere" to point at that
//     isn't the same file. `LICENSE` and `package.json` are excluded too:
//     neither carries prose that could cite a CHANGELOG section.
//
// Prior art: agent-grounding's `scripts/check-shipped-unreleased-pointer.js`
// (a multi-package `npm pack --dry-run` scan, gated on the Unreleased
// section being effectively empty, that DOES scan CHANGELOG.md with a
// heading/link-reference exemption). This repo is a single package, so the
// workspace-loop and pack-listing machinery there does not apply, and the
// CHANGELOG.md exclusion above is a deliberate, measured departure - see
// the SCOPE note.
//
// A hit is either the capitalised, word-bounded label `Unreleased` (e.g.
// "[Unreleased]", "(Unreleased)", "see the Unreleased section" - the
// bracketed form is a subset of this one, see the regex comment below)
// or the GitHub-rendered anchor slug `CHANGELOG(.md)#unreleased` in any
// case (e.g. a markdown link target), which the bareword pattern alone
// would miss since the slug is lowercase.
//
// Exit codes: 0 = clean. 1 = at least one dangling pointer found. 2 = a
// scope error (the scan produced zero files, or a scanned path could not
// be read) - never silently "nothing to check".

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The repo root, resolved from this file's own location (scripts/ is one
// level below it), never from process.cwd().
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The bracketed literal `[Unreleased]` is deliberately NOT a separate
// pattern: it is a strict subset of BAREWORD_POINTER_RE below (a `[`
// still counts as a non-word boundary before capitalised `Unreleased`),
// so a bracketed-only regex would always be an equivalent mutant of the
// bareword one. Keeping just the bareword form covers both.
const BAREWORD_POINTER_RE = /\bUnreleased\b/;
// The GitHub-rendered anchor slug for the `[Unreleased]` heading, as it
// appears in a markdown link target (e.g. `CHANGELOG.md#unreleased`,
// `[CHANGELOG](CHANGELOG.md#unreleased)`, or the bare `CHANGELOG#unreleased`
// form). Case-insensitive for THIS slug form only: GitHub lowercases
// heading anchors, so `#unreleased` is the only spelling a real link ever
// uses, but lowercase prose elsewhere (e.g. "this feature is unreleased")
// stays exempt, matching BAREWORD_POINTER_RE's capitalised-only rule.
const SLUG_POINTER_RE = /CHANGELOG(\.md)?#unreleased\b/i;

/**
 * Recursively collects file paths under `dir`. Deliberately NOT wrapped
 * in a try/catch: a missing or unreadable directory is a scope error the
 * caller surfaces as exit 2, never a silently empty result.
 */
export function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The scanned file set: every file under `src/` (recursive; source of
 * the shipped `dist/`), plus `README.md` and
 * `scripts/runtime-reality-docker-probe.mjs` (the other shipped, scannable
 * `package.json` `files` entries - see the module header for why
 * `CHANGELOG.md` itself is deliberately excluded).
 */
export function resolveScannedFiles(rootDir = REPO_ROOT) {
  const files = collectFiles(join(rootDir, "src"));
  files.push(join(rootDir, "README.md"));
  files.push(join(rootDir, "scripts", "runtime-reality-docker-probe.mjs"));
  return files;
}

/**
 * True when `absPath`'s text contains a dangling `[Unreleased]`/`Unreleased`
 * pointer.
 */
export function findPointerHit(absPath) {
  const text = readFileSync(absPath, "utf8");
  return BAREWORD_POINTER_RE.test(text) || SLUG_POINTER_RE.test(text);
}

export function run(rootDir = REPO_ROOT) {
  let files;
  try {
    files = resolveScannedFiles(rootDir);
  } catch (err) {
    console.error(
      `check-shipped-unreleased-pointer: FAIL - could not resolve the scanned file set (${err instanceof Error ? err.message : String(err)}).`,
    );
    return 2;
  }
  if (files.length === 0) {
    console.error(
      "check-shipped-unreleased-pointer: FAIL - resolved 0 files to scan; expected at least src/ and README.md.",
    );
    return 2;
  }

  const violations = [];
  for (const absPath of files) {
    let hit;
    try {
      hit = findPointerHit(absPath);
    } catch (err) {
      console.error(
        `check-shipped-unreleased-pointer: FAIL - could not read ${relative(rootDir, absPath)} (${err instanceof Error ? err.message : String(err)}).`,
      );
      return 2;
    }
    if (hit) violations.push(relative(rootDir, absPath));
  }

  if (violations.length > 0) {
    console.error(`check-shipped-unreleased-pointer: FAIL - ${violations.length} shipped file(s) point at CHANGELOG.md's [Unreleased] section:`);
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    console.error(
      "\nCite the shift-proof `CHANGELOG.md:#X.Y.Z` anchor of the version that actually shipped the entry instead " +
        "(see `rg 'CHANGELOG.md:#' src` for the existing convention), or remove the pointer.",
    );
    return 1;
  }

  console.log(
    `check-shipped-unreleased-pointer: OK - scanned ${files.length} file(s); no shipped file points at CHANGELOG.md's [Unreleased] section.`,
  );
  return 0;
}

// Exported (not just called at the bottom of this file) so a test can
// invoke it in-process and assert on `process.exitCode` directly - same
// shape as tests/scripts/check-no-only.test.ts's `main()` coverage. An
// optional `rootDir` (the CLI's argv[2], when given) lets a spawned
// smoke test point this at a seeded temp tree instead of REPO_ROOT.
export function main(rootDir) {
  process.exitCode = run(rootDir);
}

// Only auto-run when invoked directly (not when imported by tests) - same
// guard as scripts/check-no-only.mjs.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main(process.argv[2]);
}
