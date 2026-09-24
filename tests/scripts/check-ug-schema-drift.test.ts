import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffKeys,
  extractUpstreamSectionKeys,
  labelToCamelKey,
  loadHarnessMirror,
} from "../../scripts/check-ug-schema-drift.mjs";

// The repo root and this script's path, resolved the same way
// check-shipped-unreleased-pointer.test.ts does: used only by the spawn
// smoke tests below.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check-ug-schema-drift.mjs");

describe("labelToCamelKey", () => {
  it("strips a trailing (kind) hint and camel-cases the rest", () => {
    expect(labelToCamelKey("Current Understanding (paragraph)")).toBe("currentUnderstanding");
    expect(labelToCamelKey("Verification Plan (list)")).toBe("verificationPlan");
    expect(labelToCamelKey("Out Of Scope (list)")).toBe("outOfScope");
  });

  it("handles labels without a kind annotation", () => {
    expect(labelToCamelKey("Assumptions")).toBe("assumptions");
    expect(labelToCamelKey("Open Questions")).toBe("openQuestions");
  });
});

describe("extractUpstreamSectionKeys", () => {
  it("returns the keys inside `const SECTIONS = [...]` in declaration order", () => {
    const fixture = `
const SECTIONS = [
  { key: "currentUnderstanding", kind: "paragraph", aliases: ["my current understanding"] },
  { key: "intendedOutcome", kind: "paragraph", aliases: ["intended outcome"] },
  { key: "derivedTodos", kind: "list", aliases: ["todos"] },
];
const BULLET_TABLE = [
  { prefix: /^x/, key: "shouldBeIgnored" },
];
`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual([
      "currentUnderstanding",
      "intendedOutcome",
      "derivedTodos",
    ]);
  });

  it("does NOT pick up `key: \"...\"` matches outside the SECTIONS array", () => {
    // The real parser.js has a fast_confirm bullet-prefix table further
    // down the file with its own `key: "..."` entries. Without bracket-
    // balanced slicing the extractor would over-count.
    const fixture = `
const SECTIONS = [
  { key: "currentUnderstanding", kind: "paragraph" },
];
const FAST_CONFIRM_PREFIXES = [
  { prefix: /^a/, key: "extraKey1" },
  { prefix: /^b/, key: "extraKey2" },
];
`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["currentUnderstanding"]);
  });

  it("throws when SECTIONS declaration is missing (layout drift signal)", () => {
    expect(() => extractUpstreamSectionKeys("// no SECTIONS here")).toThrow(/parser.js layout changed/);
  });

  it("handles nested arrays inside SECTIONS entries (aliases: [...])", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["x", "y"] },
  { key: "b", aliases: ["z"] },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT truncate on a `]` inside a string literal (task 6f9c56b3)", () => {
    // Subagent on PR #153 reproduced this case: a SECTIONS alias
    // containing `]` made the naive bracket walker close the array
    // early, producing false-positive drift. The string-aware walker
    // skips brackets inside string literals.
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["foo ] bar"] },
  { key: "b", aliases: ["clean"] },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("honors `\\` escapes inside string literals so an escaped quote does not exit string mode", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["foo \\"] still string"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("treats a doubled backslash as an escaped backslash, so the next quote closes the string", () => {
    // "trailing \\" — the `\\` is an escaped backslash, NOT an escape of
    // the following quote, so the string closes and `]` outside it is
    // honored as the array terminator.
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["trailing \\\\"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("throws (does not loop) when an unclosed string runs to end-of-source", () => {
    // Defensive: if upstream parser.js is truncated mid-string, the
    // walker must exit cleanly with the "SECTIONS array not closed"
    // signal rather than spin forever.
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ["unterminated
];`;
    expect(() => extractUpstreamSectionKeys(fixture)).toThrow(/SECTIONS array not closed/);
  });

  it("handles all three string-delimiter styles (single, double, template)", () => {
    const fixture = `const SECTIONS = [
  { key: "a", aliases: ['single ] quote'] },
  { key: "b", aliases: [\`template ] backtick\`] },
  { key: "c" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b", "c"]);
  });

  it("does NOT mistake an apostrophe in a // line comment for a string opener (task 798d7173)", () => {
    // Regression: the published 0.4.0 parser.js carries a JSDoc-ish //
    // comment inside the SECTIONS slice with the apostrophe in "Section
    // 10's numbering". A walker that did not honor JS comments treated
    // the apostrophe as a single-quoted string opener, swallowed the
    // closing `]`, and reported a false "layout changed" error,
    // blocking the harness-side bump PR until the walker was fixed.
    const fixture = `const SECTIONS = [
  // Section 10's numbering aligns with the prompt's structure.
  { key: "a", aliases: ["foo"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT mistake a backtick in a // line comment for a template-literal opener", () => {
    // Companion to the apostrophe case: the upstream comment also uses
    // backticks around code spans (e.g. `# Understanding Report`). Same
    // class of failure as the apostrophe case.
    const fixture = `const SECTIONS = [
  // The \`# Understanding Report\` heading is required.
  { key: "a" },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT mistake a quote in a /* block comment */ for a string opener", () => {
    const fixture = `const SECTIONS = [
  /* The agent's report should be precise. */
  { key: "a" },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT treat a `]` inside a // line comment as the array closer", () => {
    // Generalised bug class: a walker-significant token (`]`) inside a
    // comment must be opaque. The apostrophe / backtick cases above pin
    // the string-opener side; this pins the bracket-depth side.
    const fixture = `const SECTIONS = [
  // aliases would close here: ] (but they shouldn't)
  { key: "a", aliases: ["foo"] },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });

  it("does NOT treat a `]` inside a /* block comment */ as the array closer", () => {
    const fixture = `const SECTIONS = [
  /* a stray ] in here would be ignored */
  { key: "a" },
  { key: "b" },
];`;
    expect(extractUpstreamSectionKeys(fixture)).toEqual(["a", "b"]);
  });
});

describe("diffKeys", () => {
  it("returns null on identical lists in identical order", () => {
    expect(diffKeys(["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });

  it("flags an order mismatch when sets are equal but sequence differs", () => {
    const diff = diffKeys(["a", "b", "c"], ["c", "b", "a"]);
    expect(diff).not.toBeNull();
    expect(diff!.orderMismatch).toBe(true);
    expect(diff!.onlyLocal).toEqual([]);
    expect(diff!.onlyUpstream).toEqual([]);
  });

  it("reports upstream additions (local missing)", () => {
    const diff = diffKeys(["a", "b"], ["a", "b", "c"]);
    expect(diff!.onlyUpstream).toEqual(["c"]);
    expect(diff!.onlyLocal).toEqual([]);
    expect(diff!.orderMismatch).toBe(false);
  });

  it("reports upstream removals (local stale)", () => {
    const diff = diffKeys(["a", "b", "x"], ["a", "b"]);
    expect(diff!.onlyLocal).toEqual(["x"]);
    expect(diff!.onlyUpstream).toEqual([]);
    expect(diff!.orderMismatch).toBe(false);
  });

  it("reports both additions and removals in the same drift", () => {
    const diff = diffKeys(["a", "stale"], ["a", "new"]);
    expect(diff!.onlyLocal).toEqual(["stale"]);
    expect(diff!.onlyUpstream).toEqual(["new"]);
  });
});

describe("loadHarnessMirror", () => {
  // The mirror loader resolves against `process.cwd()`. We point cwd at
  // an empty tmpdir so the precheck fires and emits the build-hint
  // instead of falling through to a generic ESM import error.
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "ug-drift-mirror-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws an actionable build-hint when the dist mirror module is missing (task a7e9a9e8)", async () => {
    await expect(loadHarnessMirror()).rejects.toThrow(/npm run build/);
  });

  it("names the expected dist path in the build-hint so the operator can see what was missed", async () => {
    await expect(loadHarnessMirror()).rejects.toThrow(
      /dist\/cli\/pack\/understanding-report-schema-hint\.js/,
    );
  });
});

// Spawn smoke tests: exec `node scripts/check-ug-schema-drift.mjs` as a
// child process, the way CI's check:ug-schema-drift step invokes it. The
// unit coverage above imports the module, which never sets `isDirectRun`,
// so only a spawn can catch a mutant that breaks the top-level
// `if (isDirectRun) { main().catch(...) }` guard or the exit-code wiring
// (OK 0, drift 1, zero keys or script failure 2); either would make the CLI
// exit 0 silently on a real failure.
//
// The fixtures are hermetic: a fake `npm` on the spawned script's own PATH
// supplies the upstream tarball, and the cwd holds the harness-mirror
// fixture, so OK, DRIFT and the zero-keys guard are provable without
// network access (the offline-registry env vars below make any real
// registry call fail). The live comparison against the published package
// stays in CI's own check:ug-schema-drift step.
//
// Hermetic-spawn guard: the script's own `execFileSync("npm", ...)` runs
// inside the spawned child, not in this vitest worker, so
// tests/_helpers/hermetic-spawn-allowlist.ts never sees it (that hook
// patches `node:child_process` only in the process that loaded it; see its
// "Residual exposure" note). The fake npm binary is written under
// os.tmpdir() by this file (D3 in the allowlist), and the fixture tarball
// is built through `sh -c`, an allowed direct child (allowlist D6) whose
// `tar` grandchild is outside the hook's view, the same residual exposure
// that note already names. No allowlist entry is needed, and nothing here
// reaches localhost or any real host.
describe("CLI spawn smoke test (hermetic ug fixtures, no network)", () => {
  let scratchDir: string;
  let binDir: string;
  let mirrorDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "harness-check-ug-schema-drift-hermetic-"));
    binDir = join(scratchDir, "bin");
    mirrorDir = join(scratchDir, "mirror");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(mirrorDir, "dist", "cli", "pack"), { recursive: true });
    // The mirror fixture is ESM; without a package.json "type" Node before
    // 20.19 would load it as CommonJS and fail on `export`.
    writeFileSync(join(mirrorDir, "package.json"), '{"type":"module"}\n');
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  /**
   * Builds a real gzip tarball at `<scratchDir>/<name>.tgz` containing
   * `package/dist/core/parser.js` with the given source, via a real `tar`
   * spawned as `sh`'s own grandchild (see the guard note above). Returns
   * the tarball's absolute path.
   */
  function buildUpstreamTarball(name: string, parserSource: string): string {
    const packDir = join(scratchDir, `${name}-src`);
    mkdirSync(join(packDir, "package", "dist", "core"), { recursive: true });
    writeFileSync(join(packDir, "package", "dist", "core", "parser.js"), parserSource);
    const tarballPath = join(scratchDir, `${name}.tgz`);
    execFileSync("sh", ["-c", `cd "${packDir}" && tar -czf "${tarballPath}" package`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return tarballPath;
  }

  /** Writes a fake `npm` onto `binDir` that copies `tarballPath` into its cwd, never touching the network. */
  function writeNpmShim(tarballPath: string): void {
    const shimPath = join(binDir, "npm");
    writeFileSync(shimPath, `#!/bin/sh\ncp "${tarballPath}" "./fixture-upstream.tgz"\n`, { mode: 0o755 });
  }

  function writeMirror(labels: string[]): void {
    writeFileSync(
      join(mirrorDir, "dist", "cli", "pack", "understanding-report-schema-hint.js"),
      `export const UNDERSTANDING_REPORT_REQUIRED_SECTIONS = ${JSON.stringify(labels)};\n`,
    );
  }

  function spawnHermetic(): { status: number | null; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
        cwd: mirrorDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          // Offline proof: even though the fake
          // npm above never dials out, these point any real network
          // attempt at a closed local port with zero retries, so the test
          // still passes when genuinely offline.
          npm_config_registry: "http://127.0.0.1:9/",
          npm_config_fetch_retries: "0",
        },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("matching fixture (offline registry env): exits 0 and prints the OK line", () => {
    const tarballPath = buildUpstreamTarball(
      "ok",
      'const SECTIONS = [\n  { key: "alpha" },\n  { key: "betaGamma" },\n];\n',
    );
    writeNpmShim(tarballPath);
    writeMirror(["Alpha (paragraph)", "Beta Gamma (paragraph)"]);

    const result = spawnHermetic();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ug-schema-drift: OK");
    expect(result.stdout).toContain("alpha, betaGamma");
  });

  it("mismatched fixture (offline registry env): exits 1 and prints DRIFT DETECTED", () => {
    const tarballPath = buildUpstreamTarball(
      "drift",
      'const SECTIONS = [\n  { key: "alpha" },\n  { key: "gammaDelta" },\n];\n',
    );
    writeNpmShim(tarballPath);
    writeMirror(["Alpha (paragraph)", "Beta Gamma (paragraph)"]);

    const result = spawnHermetic();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ug-schema-drift: DRIFT DETECTED");
    expect(result.stderr).toContain("gammaDelta");
  });

  it("zero-keys upstream fixture (offline registry env): exits 2 and names the extraction failure", () => {
    const tarballPath = buildUpstreamTarball("empty", "const SECTIONS = [];\n");
    writeNpmShim(tarballPath);
    writeMirror(["Alpha (paragraph)"]);

    const result = spawnHermetic();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("extracted zero section keys");
  });

  it("missing dist mirror (offline registry env): the top-level catch exits 2 with the build hint", () => {
    const tarballPath = buildUpstreamTarball("nodist", 'const SECTIONS = [\n  { key: "alpha" },\n];\n');
    writeNpmShim(tarballPath);
    // No writeMirror: loadHarnessMirror throws, and main()'s rejection
    // reaches the `.catch()` handler, the only path to its exit code.

    const result = spawnHermetic();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ug-schema-drift: script failed");
    expect(result.stderr).toContain("npm run build");
  });
});
