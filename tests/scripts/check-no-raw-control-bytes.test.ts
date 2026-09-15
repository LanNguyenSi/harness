import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CONTROL_BYTE_FILES,
  evaluateFile,
  findControlByteOffsets,
  main,
} from "../../scripts/check-no-raw-control-bytes.mjs";

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
    // ü in UTF-8 is 0xC3 0xBC — nowhere near the 0xC2 0x80-0x9F class.
    const buffer = Buffer.from("ü", "utf8");
    expect(findControlByteOffsets(buffer)).toEqual([]);
  });
});

describe("evaluateFile", () => {
  const allowlist = new Map([["some/file.ts", { count: 1, reason: "test fixture" }]]);

  it("allowlisted file at the expected count passes (count-match)", () => {
    const result = evaluateFile("some/file.ts", [42], allowlist);
    expect(result.status).toBe("count-match");
  });

  it("one extra byte beyond the pinned count fails (count-mismatch)", () => {
    const result = evaluateFile("some/file.ts", [10, 42], allowlist);
    expect(result.status).toBe("count-mismatch");
    expect(result).toMatchObject({ expectedCount: 1, actualCount: 2 });
  });

  it("a file with no allowlist entry and no offsets is clean", () => {
    expect(evaluateFile("other/file.ts", [], allowlist).status).toBe("clean");
  });

  it("a file with no allowlist entry and offsets is an unlisted violation", () => {
    expect(evaluateFile("other/file.ts", [3], allowlist).status).toBe("unlisted-violation");
  });
});

describe("ALLOWED_CONTROL_BYTE_FILES", () => {
  it("pins the generate-settings.ts fingerprint delimiter to exactly 1 occurrence", () => {
    expect(ALLOWED_CONTROL_BYTE_FILES.get("src/cli/apply/generate-settings.ts")).toMatchObject({ count: 1 });
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
    dir = mkdtempSync(join(tmpdir(), "harness-check-no-raw-control-bytes-main-"));
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
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "clean.ts"), "export const x = 1;\t// tab\r\n");

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-no-raw-control-bytes: OK"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a raw BEL in a scratch src file fails", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "bad.ts"), Buffer.from([0x65, 0x78, 0x07, 0x3b])); // "ex" BEL ";"

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("check-no-raw-control-bytes: FAIL"));
  });

  it("the allowlisted generate-settings.ts path at its pinned count (1) passes", () => {
    mkdirSync(join(dir, "src", "cli", "apply"), { recursive: true });
    writeFileSync(join(dir, "src", "cli", "apply", "generate-settings.ts"), Buffer.from("cmd\x00timeout"));

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-no-raw-control-bytes: OK"));
  });

  it("two extra NULs added to the allowlisted generate-settings.ts path fail (count-mismatch, not silently passed)", () => {
    mkdirSync(join(dir, "src", "cli", "apply"), { recursive: true });
    writeFileSync(join(dir, "src", "cli", "apply", "generate-settings.ts"), Buffer.from("cmd\x00timeout\x00\x00"));

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected 1 allowlisted raw control byte(s), found 3"),
    );
  });

  it("scans docs/ and .github/ too, catching the round-2 .md/.yml incident class", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, "docs", "bad.md"), Buffer.from([0x23, 0x20, 0x07, 0x0a])); // "# " BEL "\n"
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(join("docs", "bad.md")));
  });

  it("scans root-level *.md/*.yml/*.json files but not other root directories", () => {
    writeFileSync(join(dir, "root.md"), Buffer.from([0x23, 0x07, 0x0a]));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "ignored.md"), Buffer.from([0x07]));

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("root.md"));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("node_modules"));
  });

  it("skips a binary-extension file even inside a scanned directory", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x07]));

    main(dir);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-no-raw-control-bytes: OK"));
  });
});
