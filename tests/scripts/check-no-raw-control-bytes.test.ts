import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CONTROL_BYTE_FILES,
  EXIT_IO_ERROR,
  SCAN_DIRS,
  evaluateFile,
  findControlByteOffsets,
  main,
} from "../../scripts/check-no-raw-control-bytes.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/check-no-raw-control-bytes.mjs", import.meta.url),
);

describe("findControlByteOffsets", () => {
  it("passes tab, LF and CR through unflagged", () => {
    expect(findControlByteOffsets(Buffer.from("a\tb\nc\rd"))).toEqual([]);
  });

  it("flags a raw BEL (0x07)", () => {
    const buffer = Buffer.from([0x61, 0x07, 0x62]); // "a" BEL "b"
    expect(findControlByteOffsets(buffer)).toEqual([1]);
  });

  it("flags a C1 control byte encoded as UTF-8 (0xC2 0x9B, U+009B)", () => {
    const buffer = Buffer.from([0x61, 0xc2, 0x9b, 0x62]); // "a" U+009B "b"
    expect(findControlByteOffsets(buffer)).toEqual([1]);
  });

  it("flags DEL (0x7F)", () => {
    const buffer = Buffer.from([0x61, 0x7f, 0x62]);
    expect(findControlByteOffsets(buffer)).toEqual([1]);
  });

  it("does not flag a 0xC2 byte followed by a non-C1 continuation (e.g. 'ä' = 0xC3 0xA4 is unaffected, and a bare ü = 0xC3 0xBC is unaffected)", () => {
    // ü in UTF-8 is 0xC3 0xBC, nowhere near the 0xC2 0x80-0x9F class.
    const buffer = Buffer.from("ü", "utf8");
    expect(findControlByteOffsets(buffer)).toEqual([]);
  });
});

describe("evaluateFile", () => {
  const allowlist = new Map([
    ["some/file.ts", { count: 1, reason: "test fixture" }],
  ]);

  it("allowlisted file at the expected count passes (count-match)", () => {
    const result = evaluateFile("some/file.ts", [42], allowlist);
    expect(result.status).toBe("count-match");
  });

  it("one extra byte beyond the pinned count fails (count-mismatch)", () => {
    const result = evaluateFile("some/file.ts", [10, 42], allowlist);
    expect(result.status).toBe("count-mismatch");
    expect(result).toMatchObject({ expectedCount: 1, actualCount: 2 });
  });

  // The FEWER direction: a stale allowlist entry (its documented byte is
  // gone) must fail too, so the entry gets deleted rather than left
  // standing as a licence for a future byte in that file. A `>` comparison
  // instead of `!==` would pass this silently.
  it("an allowlisted file whose pinned byte is gone fails (count-mismatch, not a pass)", () => {
    const result = evaluateFile("some/file.ts", [], allowlist);
    expect(result.status).toBe("count-mismatch");
    expect(result).toMatchObject({ expectedCount: 1, actualCount: 0 });
  });

  it("a file with no allowlist entry and no offsets is clean", () => {
    expect(evaluateFile("other/file.ts", [], allowlist).status).toBe("clean");
  });

  it("a file with no allowlist entry and offsets is an unlisted violation", () => {
    expect(evaluateFile("other/file.ts", [3], allowlist).status).toBe(
      "unlisted-violation",
    );
  });
});

describe("ALLOWED_CONTROL_BYTE_FILES", () => {
  it("pins the generate-settings.ts fingerprint delimiter to exactly 1 occurrence", () => {
    expect(
      ALLOWED_CONTROL_BYTE_FILES.get("src/cli/apply/generate-settings.ts"),
    ).toMatchObject({ count: 1 });
  });
});

// CLI-level coverage of main(): calls it in-process against a temp fixture
// directory (mirroring src/tests/scripts/docs/.github plus root files) and
// inspects console output + process.exitCode instead of shelling out to
// `node scripts/check-no-raw-control-bytes.mjs` a second time.
describe("main", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(
      join(tmpdir(), "harness-check-no-raw-control-bytes-main-"),
    );
    // Every SCAN_DIRS entry must exist, or main() refuses to scan at all
    // (exit 2, see the missing-directory case below); the fixture tree
    // therefore mirrors the real repo's scan scope.
    for (const scanDir of SCAN_DIRS)
      mkdirSync(join(dir, scanDir), { recursive: true });
    // The allowlisted file must exist at its pinned count too: an
    // allowlist entry whose file is not scanned is a stale entry and fails
    // (see the stale-entry case below), so the fixture mirrors that as well.
    mkdirSync(join(dir, "src", "cli", "apply"), { recursive: true });
    writeFileSync(
      join(dir, "src", "cli", "apply", "generate-settings.ts"),
      Buffer.from("cmd\x00timeout"),
    );
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

  it("on a clean tree (tab/LF/CR only): does not set exitCode and logs an OK summary", () => {
    writeFileSync(
      join(dir, "src", "clean.ts"),
      "export const x = 1;\t// tab\r\n",
    );

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("check-no-raw-control-bytes: OK"),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a raw BEL in a scratch src file fails", () => {
    writeFileSync(
      join(dir, "src", "bad.ts"),
      Buffer.from([0x65, 0x78, 0x07, 0x3b]),
    ); // "ex" BEL ";"

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check-no-raw-control-bytes: FAIL"),
    );
  });

  it("the allowlisted generate-settings.ts path at its pinned count (1) passes", () => {
    mkdirSync(join(dir, "src", "cli", "apply"), { recursive: true });
    writeFileSync(
      join(dir, "src", "cli", "apply", "generate-settings.ts"),
      Buffer.from("cmd\x00timeout"),
    );

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("check-no-raw-control-bytes: OK"),
    );
  });

  it("two extra NULs added to the allowlisted generate-settings.ts path fail (count-mismatch, not silently passed)", () => {
    mkdirSync(join(dir, "src", "cli", "apply"), { recursive: true });
    writeFileSync(
      join(dir, "src", "cli", "apply", "generate-settings.ts"),
      Buffer.from("cmd\x00timeout\x00\x00"),
    );

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "expected 1 allowlisted raw control byte(s), found 3",
      ),
    );
  });

  // The FEWER direction, end to end: the allowlisted file no longer holds
  // the documented delimiter (someone replaced it with an escape-safe
  // form, task 0b747433-c697-48bc-adc4-f3a24cc4fa37), that must fail as a
  // stale allowlist entry to delete, not pass because "at most the pinned
  // count" was satisfied.
  it("the allowlisted generate-settings.ts path with its pinned NUL removed fails (expected 1, found 0)", () => {
    mkdirSync(join(dir, "src", "cli", "apply"), { recursive: true });
    writeFileSync(
      join(dir, "src", "cli", "apply", "generate-settings.ts"),
      Buffer.from("cmd|timeout"),
    );

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "expected 1 allowlisted raw control byte(s), found 0",
      ),
    );
  });

  it("scans docs/ and .github/ too, catching the round-2 .md/.yml incident class", () => {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "bad.md"),
      Buffer.from([0x23, 0x20, 0x07, 0x0a]),
    ); // "# " BEL "\n"
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(join("docs", "bad.md")),
    );
  });

  it("scans root-level *.md/*.yml/*.json files but not other root directories", () => {
    writeFileSync(join(dir, "root.md"), Buffer.from([0x23, 0x07, 0x0a]));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "ignored.md"), Buffer.from([0x07]));

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("root.md"));
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("node_modules"),
    );
  });

  // Round 4 review, LOW 2: the root sweep skipped *.ts/*.cjs/*.mjs, so a
  // control byte appended to the repo's own root vitest.config.ts or
  // .dependency-cruiser.cjs passed the gate.
  it("scans root-level *.ts/*.cjs/*.mjs files too (a BEL in a root .ts fails)", () => {
    writeFileSync(
      join(dir, "vitest.config.ts"),
      Buffer.from([0x2f, 0x2f, 0x07, 0x0a]),
    ); // "//" BEL "\n"

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("vitest.config.ts"),
    );
  });

  // Round 4 review, LOW 1: the header claimed the scan never descends into
  // node_modules/dist/coverage, but that held only for the (non-recursive)
  // root sweep: a NESTED one inside a scanned tree was walked and flagged.
  it("never descends into a nested node_modules/dist/coverage inside a scanned tree", () => {
    for (const skipped of ["node_modules", "dist", "coverage"]) {
      mkdirSync(join(dir, "tests", "probe-nm", skipped), { recursive: true });
      writeFileSync(
        join(dir, "tests", "probe-nm", skipped, "bad.md"),
        Buffer.from([0x23, 0x07, 0x0a]),
      );
    }

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("check-no-raw-control-bytes: OK"),
    );
  });

  it("skips a binary-extension file even inside a scanned directory", () => {
    writeFileSync(
      join(dir, "docs", "image.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x07]),
    );

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("check-no-raw-control-bytes: OK"),
    );
  });

  // Round 4 review, MEDIUM 1: round 3 returned an empty list from a silent
  // catch, so a missing scan directory reported a clean, zero-file scan
  // and exited 0: a green gate that had checked nothing.
  it("an allowlist entry whose file is not scanned is a stale entry and fails, not a pass", () => {
    rmSync(join(dir, "src", "cli", "apply", "generate-settings.ts"));

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "stale allowlist entry: src/cli/apply/generate-settings.ts",
      ),
    );
  });

  it("a scan directory whose stat fails for a reason other than absence is an IO error (exit 2), not a violation", () => {
    const looped = join(dir, SCAN_DIRS[SCAN_DIRS.length - 1] as string);
    rmSync(looped, { recursive: true, force: true });
    symlinkSync(looped, looped);

    main(dir);

    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot stat a scan directory"),
    );
  });

  it("a missing scan directory is an IO error (exit 2 naming it), not an OK scan of what is left", () => {
    writeFileSync(join(dir, "src", "clean.ts"), "export const x = 1;\n");
    rmSync(join(dir, "docs"), { recursive: true, force: true });

    main(dir);

    expect(process.exitCode).toBe(EXIT_IO_ERROR);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check-no-raw-control-bytes: IO ERROR"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("docs"));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("a scan directory that exists but is a FILE is the same IO error (exit 2 naming it)", () => {
    rmSync(join(dir, "scripts"), { recursive: true, force: true });
    writeFileSync(join(dir, "scripts"), "not a directory\n");

    main(dir);

    expect(process.exitCode).toBe(EXIT_IO_ERROR);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("scripts"));
  });

  // The no-silent-catch rule below the top-level scope check: an
  // unreadable directory INSIDE a scanned tree must surface as exit 2
  // naming it, never as a quietly shorter file list. Skipped as root,
  // where mode 000 does not deny the owner.
  it.skipIf(process.getuid?.() === 0)(
    "an unreadable directory inside a scanned tree is an IO error (exit 2 naming it), not a silently shorter scan",
    () => {
      const locked = join(dir, "src", "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, "hidden.ts"), "export const x = 1;\n");
      chmodSync(locked, 0o000);

      try {
        main(dir);

        expect(process.exitCode).toBe(EXIT_IO_ERROR);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("IO ERROR"),
        );
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(locked));
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

// The direct run resolves the repo root from the script's own location,
// not from process.cwd(), so `node scripts/check-no-raw-control-bytes.mjs`
// scans the same tree from anywhere. Two real runs, one from the repo root
// and one from an unrelated cwd, must agree on the scanned file count; a
// cwd-relative root would instead scan nothing (and, under the scope check,
// exit 2) from the unrelated cwd.
describe("direct run (cwd independence)", () => {
  const scannedCount = (output: string): number => {
    const match = output.match(/scanned (\d+) file\(s\)/);
    expect(match, `no "scanned N file(s)" line in: ${output}`).not.toBeNull();
    return Number(match![1]);
  };

  it("scans the same repo tree from an unrelated cwd as from the repo root", () => {
    const fromRepoRoot = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
    });
    const fromElsewhere = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: mkdtempSync(
        join(tmpdir(), "harness-check-no-raw-control-bytes-cwd-"),
      ),
      encoding: "utf8",
    });

    expect(scannedCount(fromElsewhere)).toBe(scannedCount(fromRepoRoot));
    expect(scannedCount(fromElsewhere)).toBeGreaterThan(0);
    expect(fromElsewhere).toContain("check-no-raw-control-bytes: OK");
  });
});
