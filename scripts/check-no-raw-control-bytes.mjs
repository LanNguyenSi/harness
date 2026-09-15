#!/usr/bin/env node
// CI gate against a committed raw C0/C1/DEL control byte (task b5e6ccb0;
// widened from a NUL-only gate after a raw BEL (0x07)
// turned up in a test literal the NUL-only version could not see). A
// control byte typed raw inside a regex character class or a string
// literal (e.g. a character class meant as the escaped backslash-u-0000
// form, typed as the literal byte instead) makes most tools stop seeing
// the file as source at all: git reports it as binary (`git diff
// --numstat` prints a dash pair instead of a line count), `rg`/`grep`
// pattern matches against the file's own exported symbols silently
// return nothing, and the byte round-trips unnoticed into the built
// `dist/` output. None of the other checks in this file's CI job
// (typecheck, build, test) reject it: TypeScript compiles a raw control
// byte inside a regex or string literal without complaint, and a test
// asserting the resulting value's *behavior* can pass even though the
// byte itself is a maintainability and reviewability defect (unreadable
// in a diff, invisible to a codebase search). This script closes that
// gap directly: it reads each file as raw bytes (never through a
// text-decoding path that might itself alter or hide the byte) and
// reports every unallowlisted one it finds.
//
// BYTE CLASS. Flags: C0 controls 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F; DEL
// 0x7F; and the C1 controls U+0080-U+009F as their UTF-8 encoding (the
// two-byte sequence 0xC2 0x80 through 0xC2 0x9F). Allows: tab 0x09, LF
// 0x0A, CR 0x0D, the three C0 bytes every text file in this repo
// legitimately carries.
//
// SCOPE. Recursively scans the SCAN_DIRS trees (src/, tests/, scripts/,
// docs/, .github/), skipping any directory whose own name is in
// SKIPPED_DIRECTORY_NAMES at ANY depth, plus the repo root's own files
// whose extension is in ROOT_FILE_EXTENSIONS (root only, never
// recursive). A file whose extension is in BINARY_EXTENSIONS is skipped
// regardless of directory, so a future binary asset (an image, a font)
// dropped under docs/ or .github/ is not scanned as text; this repo
// carries no such file today. Widened past src/+tests/ in round 3
// because the round-2 incident (a raw control byte landing in a
// CHANGELOG/ci.yml edit) sat outside the original scope. Round 3's own
// header claimed the scan "never descends into
// node_modules/dist/coverage"; that held only for the root sweep, which
// was never recursive to begin with, while a NESTED one inside a scanned
// tree (a `tests/<fixture>/node_modules/` fixture) was still walked and
// flagged. SKIPPED_DIRECTORY_NAMES, applied at every depth, is what
// makes the sentence true.
//
// OUT OF SCOPE, deliberately. These are not
// oversights; each would produce a false positive or scan something this
// gate has no claim over:
//   - `dogfood/`: captured terminal transcripts and their evidence files
//     carry REAL control bytes (ANSI escapes from the captured session).
//     They are recordings of terminal output, not hand-written source,
//     so a raw ESC there is the data, not a defect.
//   - `.ai/`: orchestrator run state. `.ai/runs/` and the `.ai/run`
//     pointer are gitignored and never reviewed. What IS tracked under
//     `.ai/` (`.ai/workflow/`'s kit-installed templates and manifest,
//     `.ai/solution-acceptance.json`) is workflow state installed from a
//     kit rather than source this repo hand-edits, so a control byte
//     there would arrive from the kit, not from an edit under review.
//   - `node_modules/`, `dist/`, `coverage/`: third-party or generated
//     output. This gate's subject is what a human typed into a file
//     under review; regenerating `dist/` is the fix for a byte there,
//     and the source it came from IS scanned.
//   - Symlinks INSIDE a scanned tree are never followed: `Dirent.isFile()`
//     and `Dirent.isDirectory()` are both false for a symlink, so a
//     symlinked FILE is never collected and a symlinked DIRECTORY is never
//     descended into. A SCAN_DIRS entry that is itself a symlink is still
//     resolved by statSync/readdirSync (the pre-check only requires a
//     directory), so the scan roots are trusted as checked in.
//
// ROOT RESOLUTION. The repo root is resolved from THIS FILE's own
// location (`fileURLToPath(import.meta.url)`, one directory up from
// `scripts/`), never from `process.cwd()`, so the direct run scans the
// same tree no matter which directory it is invoked from. `main()` still
// takes an explicit root so tests can point it at a fixture tree.
//
// EXIT CODES. 0 = clean. 1 = at least one unallowlisted raw control byte,
// or an allowlist count mismatch. 2 = an IO or scope error: a SCAN_DIRS
// entry that is missing or is not a directory, an unreadable directory,
// or an unreadable file, each reported with its path. Exit 2 exists
// because round 3 wrapped `readdirSync` in a try/catch that returned an
// empty list, so a missing scan directory (a rename, a wrong cwd, a
// partial checkout) printed "OK, scanned 0 file(s)" and exited 0: a
// green gate that had checked nothing.
// Nothing in this script is caught silently.
//
// ALLOWLIST. `ALLOWED_CONTROL_BYTE_FILES` pins both the file and the
// exact occurrence COUNT expected there; the check fails if the actual
// count differs in either direction, not only when it is nonzero. A
// membership-only allowlist (matching the file, ignoring how many raw
// bytes it holds) would silently pass an entry gaining MORE undocumented
// raw bytes than the one it was written for; pinning the count closes
// that gap the same way a coverage-gate or duplication-count pin does
// elsewhere in this repo's scripts/. The FEWER direction matters too: an
// entry whose byte is gone is a stale allowlist entry to delete, not a
// pass.
//
// Runs in a single source-scan pass, no second suite run: reading every
// scanned file as a Buffer is a sub-second operation for this repo's size.

import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep as pathSep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The repo root, resolved from this file's own location (scripts/ is one
// level below it), never from process.cwd(). See ROOT RESOLUTION above.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Directories recursively scanned, relative to the repo root.
export const SCAN_DIRS = ["src", "tests", "scripts", "docs", ".github"];

// Directory names never descended into, at any depth inside a scanned
// tree. See OUT OF SCOPE above for why each one is here.
export const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
]);

// Extensions of root-level files scanned (non-recursive: only files
// directly in the repo root). Covers the repo's own root docs and config,
// including the root *.ts/*.cjs/*.mjs files (vitest.config.ts,
// .dependency-cruiser.cjs today) that the round-3 set missed.
export const ROOT_FILE_EXTENSIONS = new Set([
  ".md",
  ".yml",
  ".yaml",
  ".json",
  ".ts",
  ".cjs",
  ".mjs",
]);

// Denylist: files under a scanned directory whose extension marks them as
// binary are skipped even though they sit inside a scanned tree. Small
// and generic on purpose, this is a text-file gate, not a media scanner.
export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".mov",
  ".wasm",
  ".class",
  ".jar",
  ".sqlite",
  ".db",
]);

// Exit code for at least one unallowlisted raw control byte or a count
// mismatch, and for an IO/scope error. See EXIT CODES above.
export const EXIT_VIOLATION = 1;
export const EXIT_IO_ERROR = 2;

// Pre-existing, intentional raw control bytes, grandfathered rather than
// fixed by this gate (task b5e6ccb0; out of that task's file scope). Each
// entry names the file (forward-slash, relative to the repo root), the
// exact occurrence count expected there, and the reason. Adding an entry
// here, or changing its count, is a conscious edit, never a side effect:
// a fingerprint delimiter that can't appear in either joined value works,
// but it also makes the file unsearchable by `grep`/`rg` and shows as
// binary in `git diff`, the same cost this gate exists to catch
// elsewhere. Replacing that delimiter with an escape-safe form, which
// would drop this entry entirely, is harness task
// 0b747433-c697-48bc-adc4-f3a24cc4fa37, filed and not yet done; changing
// the delimiter is out of scope for task b5e6ccb0.
export const ALLOWED_CONTROL_BYTE_FILES = new Map([
  [
    "src/cli/apply/generate-settings.ts",
    {
      count: 1,
      reason:
        'template-literal fingerprint delimiter (`${cmd.command}\\x00${cmd.timeout ?? ""}`), ' +
        "PR #438; a NUL can't appear in either joined value, so it's collision-proof as a separator",
    },
  ],
]);

/**
 * Recursively collects file paths under `dir`, skipping
 * SKIPPED_DIRECTORY_NAMES at any depth and BINARY_EXTENSIONS files.
 *
 * Deliberately NOT wrapped in a try/catch: a missing or unreadable
 * directory is an IO error the caller surfaces as exit 2, never a
 * silently empty result. `readdirSync`'s own
 * error carries the offending path in `err.path`.
 */
export function collectScanFiles(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      collectScanFiles(full, out);
    } else if (entry.isFile() && !BINARY_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collects root-level files (one directory deep) matching
 * ROOT_FILE_EXTENSIONS. Same no-silent-catch rule as collectScanFiles.
 */
export function collectRootFiles(rootDir) {
  const out = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!ROOT_FILE_EXTENSIONS.has(extname(entry.name))) continue;
    out.push(join(rootDir, entry.name));
  }
  return out;
}

/**
 * Returns every 0-based byte offset of a raw control byte (the BYTE CLASS
 * described above) in `buffer`. Operates on the raw Buffer, never a
 * decoded string, so the check itself cannot be fooled by a decoding
 * step that drops or transforms the byte. A C1 control matches its
 * two-byte UTF-8 encoding (0xC2 0x80-0x9F); the offset reported is the
 * leading 0xC2 byte.
 */
export function findControlByteOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    const isC0 =
      byte <= 0x08 ||
      byte === 0x0b ||
      byte === 0x0c ||
      (byte >= 0x0e && byte <= 0x1f);
    if (isC0 || byte === 0x7f) {
      offsets.push(i);
      continue;
    }
    if (byte === 0xc2 && i + 1 < buffer.length) {
      const next = buffer[i + 1];
      if (next >= 0x80 && next <= 0x9f) {
        offsets.push(i);
        i += 1; // consume the two-byte sequence so it isn't double-counted
      }
    }
  }
  return offsets;
}

/**
 * Evaluates one file's control-byte offsets against the allowlist.
 * Returns a status object rather than throwing, so `main` can aggregate
 * failures across every scanned file before reporting.
 *
 * - "clean": not in the allowlist, and no control bytes found.
 * - "unlisted-violation": control bytes found, file not in the allowlist.
 * - "count-mismatch": file is in the allowlist, but the actual count
 *   differs from the pinned `count` (in either direction: MORE bytes than
 *   documented, or a stale entry whose byte is gone).
 * - "count-match": file is in the allowlist and the actual count equals
 *   the pinned `count`.
 */
export function evaluateFile(
  relPath,
  offsets,
  allowlist = ALLOWED_CONTROL_BYTE_FILES,
) {
  const entry = allowlist.get(relPath);
  if (!entry) {
    return offsets.length === 0
      ? { status: "clean", offsets }
      : { status: "unlisted-violation", offsets };
  }
  if (offsets.length !== entry.count) {
    return {
      status: "count-mismatch",
      offsets,
      expectedCount: entry.count,
      actualCount: offsets.length,
    };
  }
  return {
    status: "count-match",
    offsets,
    expectedCount: entry.count,
    actualCount: offsets.length,
  };
}

export function main(rootDir = REPO_ROOT) {
  // Scope check BEFORE scanning: every SCAN_DIRS entry must exist and be
  // a directory. Without this, a rename or a partial checkout reports a
  // clean scan of whatever is left, which is the failure mode exit 2
  // exists for.
  let missing;
  try {
    missing = SCAN_DIRS.map((d) => ({ d, full: join(rootDir, d) })).filter(
      ({ full }) => !statSync(full, { throwIfNoEntry: false })?.isDirectory(),
    );
  } catch (error) {
    console.error(
      `check-no-raw-control-bytes: IO ERROR (exit ${EXIT_IO_ERROR}): cannot stat a scan ` +
        `directory: ${error?.path ?? "?"}: ${error?.code ?? error?.message ?? String(error)}`,
    );
    process.exitCode = EXIT_IO_ERROR;
    return;
  }
  if (missing.length > 0) {
    console.error(
      `check-no-raw-control-bytes: IO ERROR (exit ${EXIT_IO_ERROR}): scan ` +
        `director${missing.length === 1 ? "y" : "ies"} missing or not a directory: ` +
        `${missing.map(({ d, full }) => `${d} (${full})`).join(", ")}. Every SCAN_DIRS entry ` +
        `must exist under the scanned root; refusing to report OK on a partial scan.`,
    );
    process.exitCode = EXIT_IO_ERROR;
    return;
  }

  let files;
  try {
    files = [
      ...SCAN_DIRS.flatMap((d) => collectScanFiles(join(rootDir, d))),
      ...collectRootFiles(rootDir),
    ];
  } catch (error) {
    console.error(
      `check-no-raw-control-bytes: IO ERROR (exit ${EXIT_IO_ERROR}): cannot list ` +
        `${error?.path ?? "(path not reported by the error)"}: ${error?.message ?? String(error)}`,
    );
    process.exitCode = EXIT_IO_ERROR;
    return;
  }

  const failures = [];
  let scanned = 0;
  let allowedCount = 0;
  const scannedPaths = new Set();

  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch (error) {
      console.error(
        `check-no-raw-control-bytes: IO ERROR (exit ${EXIT_IO_ERROR}): cannot read ` +
          `${file}: ${error?.message ?? String(error)}`,
      );
      process.exitCode = EXIT_IO_ERROR;
      return;
    }
    scanned += 1;
    const offsets = findControlByteOffsets(buffer);
    const relToRoot = relative(rootDir, file).split(pathSep).join("/");
    scannedPaths.add(relToRoot);
    const evaluated = evaluateFile(relToRoot, offsets);
    if (evaluated.status === "clean") continue;
    if (evaluated.status === "count-match") {
      allowedCount += 1;
      continue;
    }
    if (evaluated.status === "unlisted-violation") {
      for (const offset of offsets) {
        failures.push(`${file}: raw control byte at offset ${offset}`);
      }
      continue;
    }
    // count-mismatch
    failures.push(
      `${file}: expected ${evaluated.expectedCount} allowlisted raw control byte(s), found ${evaluated.actualCount} ` +
        `(update ALLOWED_CONTROL_BYTE_FILES in scripts/check-no-raw-control-bytes.mjs if this is intentional)`,
    );
  }

  for (const listed of ALLOWED_CONTROL_BYTE_FILES.keys()) {
    if (!scannedPaths.has(listed)) {
      failures.push(
        `stale allowlist entry: ${listed} is not a scanned file (deleted, renamed, moved under a ` +
          `skipped directory, or given a binary extension); delete the entry from ` +
          `ALLOWED_CONTROL_BYTE_FILES in scripts/check-no-raw-control-bytes.mjs`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      `check-no-raw-control-bytes: FAIL: ${failures.length} finding(s):`,
    );
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    console.error(
      "check-no-raw-control-bytes: a raw C0/C1/DEL control byte in a source or docs file (often " +
        "typed by hand inside a regex character class or a string literal instead of an escaped " +
        "\\u0000-\\u001f / \\u007f / \\u0080-\\u009f form) makes git treat the file as binary and " +
        "defeats text search against it. Use the escaped form instead.",
    );
    process.exitCode = EXIT_VIOLATION;
    return;
  }
  const allowedNote =
    allowedCount > 0 ? `, ${allowedCount} pre-existing allowlisted` : "";
  const rootGlobs = [...ROOT_FILE_EXTENSIONS].map((ext) => `*${ext}`).join("/");
  console.log(
    `check-no-raw-control-bytes: OK: scanned ${scanned} file(s) under ${SCAN_DIRS.join(", ")} ` +
      `plus root ${rootGlobs}, no unallowlisted raw control bytes${allowedNote}`,
  );
}

// Only auto-run when invoked directly (not when imported by tests), same
// guard as scripts/check-no-only.mjs. The root is this file's own repo
// root, not the cwd.
const isDirectRun =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main(REPO_ROOT);
}
