#!/usr/bin/env node
// CI gate against a committed NUL byte (0x00) under src/ or tests/ (task
// b5e6ccb0, round 2 review). A NUL byte inside a regex character class
// literal (e.g. `/[\x00-\x1f]/` typed as a raw byte instead of the escaped
// backslash-u-0000 escape sequence) makes most tools stop seeing the file as source at all: git
// reports it as binary (`git diff --numstat` prints `-\t-` instead of a
// line count), `rg`/`grep` pattern matches against the file's own exported
// symbols silently return nothing, and the byte round-trips unnoticed into
// the built `dist/` output. None of the other checks in this file's CI job
// (typecheck, build, test) reject it: TypeScript compiles a raw NUL inside
// a regex literal without complaint, and a test asserting the resulting
// regex's *behavior* can pass even though the byte itself is a
// maintainability and reviewability defect (unreadable in a diff, invisible
// to a codebase search). This script closes that gap directly: it reads
// each file as raw bytes (not through any text-decoding path that might
// itself alter or hide a NUL) and fails on the first one found.
//
// Runs in a single source-scan pass, no second suite run: reading every
// file under src/ and tests/ as a Buffer is a sub-second operation for
// this repo's size.

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, sep as pathSep } from "node:path";
import { pathToFileURL } from "node:url";

const SCAN_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

// Pre-existing, intentional NUL bytes, grandfathered rather than fixed by
// this gate (task b5e6ccb0; out of that task's file scope). Each entry
// names the file (forward-slash, relative to the repo root) and the
// reason a NUL byte is deliberate there. Adding an entry here is a
// conscious exception, not a fix: a fingerprint delimiter that can't
// appear in either joined value works, but it also makes the file
// unsearchable by `grep`/`rg` and shows as binary in `git diff`, the same
// cost this gate exists to catch elsewhere — see the follow-up noted in
// this task's CHANGELOG entry.
const ALLOWED_NUL_FILES = new Map([
  [
    "src/cli/apply/generate-settings.ts",
    "template-literal fingerprint delimiter (`${cmd.command}\\x00${cmd.timeout ?? \"\"}`), " +
      "PR #438; a NUL can't appear in either joined value, so it's collision-proof as a separator",
  ],
]);

/** Recursively collects source file paths under `dir` matching SCAN_EXTENSIONS. */
export function collectScanFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectScanFiles(full, out);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns every 0-based byte offset of a NUL (0x00) byte in `buffer`.
 * Operates on the raw Buffer, never a decoded string, so the check itself
 * cannot be fooled by a decoding step that drops or transforms the byte.
 */
export function findNulByteOffsets(buffer) {
  const offsets = [];
  let idx = buffer.indexOf(0x00);
  while (idx !== -1) {
    offsets.push(idx);
    idx = buffer.indexOf(0x00, idx + 1);
  }
  return offsets;
}

export function main(dirs) {
  const failures = [];
  let scanned = 0;
  let allowed = 0;
  for (const dir of dirs) {
    let files;
    try {
      files = collectScanFiles(dir);
    } catch {
      continue; // directory doesn't exist in this checkout; nothing to scan
    }
    for (const file of files) {
      scanned += 1;
      const buffer = readFileSync(file);
      const offsets = findNulByteOffsets(buffer);
      if (offsets.length === 0) continue;
      const relFile = file.split(pathSep).join("/");
      if (ALLOWED_NUL_FILES.has(relFile)) {
        allowed += 1;
        continue;
      }
      for (const offset of offsets) {
        failures.push(`${file}: NUL byte at offset ${offset}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`check-no-nul-bytes: FAIL — ${failures.length} NUL byte(s) found:`);
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    console.error(
      "check-no-nul-bytes: a raw NUL byte in a source file (often typed by hand inside a regex " +
        "character class instead of an escaped \\u0000) makes git treat the file as binary and " +
        "defeats text search against it. Use the escaped form instead.",
    );
    process.exitCode = 1;
    return;
  }
  const allowedNote = allowed > 0 ? `, ${allowed} pre-existing allowlisted` : "";
  console.log(
    `check-no-nul-bytes: OK — scanned ${scanned} file(s) under ${dirs.join(", ")}, no unallowlisted NUL bytes${allowedNote}`,
  );
}

// Only auto-run when invoked directly (not when imported by tests) — same
// guard as scripts/check-no-only.mjs.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main(["src", "tests"]);
}
