import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectFiles, findPointerHit, main, resolveScannedFiles, run } from "../../scripts/check-shipped-unreleased-pointer.mjs";

// The repo root and this script's path, resolved the same way check-no-only's
// own tests would if it spawned - used only by the spawn smoke tests below.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check-shipped-unreleased-pointer.mjs");

describe("findPointerHit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-shipped-unreleased-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags the bracketed [Unreleased] literal", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// see CHANGELOG.md's [Unreleased] entry\n");
    expect(findPointerHit(file)).toBe(true);
  });

  it("flags the bracketless, capitalised Unreleased label", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// see the Unreleased section of CHANGELOG.md\n");
    expect(findPointerHit(file)).toBe(true);
  });

  it("does NOT flag a lowercase unreleased word", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// this feature is unreleased for now\n");
    expect(findPointerHit(file)).toBe(false);
  });

  it("does NOT flag a shift-proof CHANGELOG.md:#X.Y.Z anchor", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// see the `CHANGELOG.md:#0.49.0` entry for the fix\n");
    expect(findPointerHit(file)).toBe(false);
  });

  it("flags the GitHub slug anchor form CHANGELOG.md#unreleased", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// [CHANGELOG](CHANGELOG.md#unreleased)\n");
    expect(findPointerHit(file)).toBe(true);
  });

  it("flags the bare CHANGELOG#unreleased slug form (no .md)", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// see CHANGELOG#unreleased for details\n");
    expect(findPointerHit(file)).toBe(true);
  });

  it("flags the slug form case-insensitively (CHANGELOG.MD#UNRELEASED)", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// see CHANGELOG.MD#UNRELEASED for details\n");
    expect(findPointerHit(file)).toBe(true);
  });

  it("does NOT flag lowercase prose outside the slug form (unreleased section)", () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "// this feature is still in the unreleased section, informally\n");
    expect(findPointerHit(file)).toBe(false);
  });
});

describe("collectFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-shipped-unreleased-collect-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recurses into subdirectories and returns every file", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "top.ts"), "export {};");
    writeFileSync(join(dir, "nested", "inner.ts"), "export {};");

    const files = collectFiles(dir).sort();

    expect(files).toEqual([join(dir, "nested", "inner.ts"), join(dir, "top.ts")].sort());
  });
});

describe("resolveScannedFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-shipped-unreleased-resolve-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export {};");
    writeFileSync(join(dir, "README.md"), "# readme\n");
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\nin this same Unreleased batch\n");
    writeFileSync(join(dir, "scripts", "runtime-reality-docker-probe.mjs"), "export {};");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes every src/ file plus README.md and the shipped docker-probe script, but NOT CHANGELOG.md", () => {
    const files = resolveScannedFiles(dir).sort();
    expect(files).toEqual(
      [
        join(dir, "src", "a.ts"),
        join(dir, "README.md"),
        join(dir, "scripts", "runtime-reality-docker-probe.mjs"),
      ].sort(),
    );
  });
});

// CLI-level coverage of run(): calls it in-process against a temp fixture
// tree (mirrors tests/scripts/check-no-only.test.ts's main() coverage) and
// inspects the returned exit code + console output instead of shelling out
// to `node scripts/check-shipped-unreleased-pointer.mjs` a second time.
describe("run", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-shipped-unreleased-run-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "src", "clean.ts"), "// see the `CHANGELOG.md:#0.49.0` entry\n");
    writeFileSync(join(dir, "README.md"), "# readme\n");
    // CHANGELOG.md deliberately carries a live pointer here: it is excluded
    // from the scan (see the script's own header), so this must not fail
    // the clean-tree case below.
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\nin this same Unreleased batch\n",
    );
    writeFileSync(join(dir, "scripts", "runtime-reality-docker-probe.mjs"), "export {};");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("on a clean tree: returns 0 and logs an OK summary, even with a live pointer in the excluded CHANGELOG.md", () => {
    const exitCode = run(dir);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-shipped-unreleased-pointer: OK"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("on a seeded [Unreleased] pointer in src/: returns 1 and names the offending file", () => {
    writeFileSync(join(dir, "src", "bad.ts"), "// see CHANGELOG.md's [Unreleased] entry for the fix\n");

    const exitCode = run(dir);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("src/bad.ts"));
  });

  it("on a missing src/ directory: returns 2 (scope error, not a silent pass)", () => {
    rmSync(join(dir, "src"), { recursive: true, force: true });

    const exitCode = run(dir);

    expect(exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
  });
});

// CLI-entry coverage of main(): calls it in-process (mirrors
// tests/scripts/check-no-only.test.ts's main() coverage) and asserts on
// `process.exitCode` directly, so a mutant that stops main() from actually
// propagating run()'s result (e.g. `process.exitCode = 0; run();` instead
// of `process.exitCode = run();`) is caught here rather than only by the
// spawn smoke tests below.
describe("main", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-check-shipped-unreleased-cli-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# readme\n");
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    writeFileSync(join(dir, "scripts", "runtime-reality-docker-probe.mjs"), "export {};");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    // main() sets process.exitCode directly (not process.exit) precisely so
    // it stays testable in-process; reset it here so a failure-path test
    // does not leak a non-zero exit code into the real vitest process
    // running this suite.
    process.exitCode = undefined;
  });

  it("on a clean tree: sets process.exitCode to run()'s 0 and logs an OK summary", () => {
    writeFileSync(join(dir, "src", "clean.ts"), "// see the `CHANGELOG.md:#0.49.0` entry\n");

    main(dir);

    expect(process.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("check-shipped-unreleased-pointer: OK"));
  });

  it("on a seeded [Unreleased] pointer: sets process.exitCode to run()'s 1", () => {
    writeFileSync(join(dir, "src", "bad.ts"), "// see CHANGELOG.md's [Unreleased] entry for the fix\n");

    main(dir);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
  });
});

// Spawn smoke tests: actually exec `node scripts/check-shipped-unreleased-pointer.mjs`
// as a child process, the way CI's step really invokes it. Unlike the
// in-process `main()` coverage above (which cannot see the top-level
// `if (isDirectRun) { main(...); }` guard, since importing the module from
// a test never sets `isDirectRun` true), this is the only way to catch a
// mutant that breaks that guard (e.g. `if (isDirectRun)` -> `if (false)`),
// which would make the CLI silently exit 0 with no output even on a
// seeded pointer.
describe("CLI spawn smoke test", () => {
  it("on the real repo tree: exits 0 and prints the OK line on stdout", () => {
    const stdout = execFileSync("node", [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(stdout).toContain("check-shipped-unreleased-pointer: OK - scanned");
  });

  it("on a seeded temp tree passed as argv[2]: exits nonzero and names the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-check-shipped-unreleased-spawn-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "src", "bad.ts"), "// see CHANGELOG.md's [Unreleased] entry for the fix\n");
      writeFileSync(join(dir, "README.md"), "# readme\n");
      writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
      writeFileSync(join(dir, "scripts", "runtime-reality-docker-probe.mjs"), "export {};");

      let threw: { status: number | null; stdout: string; stderr: string } | undefined;
      try {
        execFileSync("node", [SCRIPT_PATH, dir], { cwd: REPO_ROOT, encoding: "utf8" });
      } catch (err) {
        const e = err as { status: number | null; stdout: string; stderr: string };
        threw = { status: e.status, stdout: e.stdout, stderr: e.stderr };
      }

      expect(threw).toBeDefined();
      expect(threw?.status).toBe(1);
      expect(threw?.stderr).toContain("src/bad.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
