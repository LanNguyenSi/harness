// Regression guard for task a07b379a: `harness doctor` used to always exit 0
// regardless of report.errorCount, so CI/scripts had no way to gate on
// doctor health. These are `run()`-level (full CLI) tests, not unit tests
// of `doctor()` directly, because the bug lived in the CLI action's exit
// path in src/cli/register-inspect-group.ts, not in the report-building logic itself.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-exit-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// No mcp/hooks/policies declared: errorCount 0. Still carries at least
// one warning (no memory router declared; the removed `doctor:` key also
// warns), which is exactly the fixture we want for "warnings alone keep
// exit 0": not a zero-diagnostics report, a report with warnings and no
// errors.
// The prose-exits-0 case below proves the warning through the --json path.
function writeCleanManifest(home: string): string {
  const target = path.join(home, "harness.yaml");
  fs.writeFileSync(
    target,
    `version: 1
hooks: []
policies: []
doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
tools:
  builtin:
    known: [Read]
`,
  );
  return target;
}

// A policy pack declared with an unrecognised source resolves to
// "declared but not live" and rolls into errorCount (see
// doctor.test.ts "flags a pack with an unknown source as
// declared-but-not-live"). Deterministic under --shallow: no MCP or
// npm-bin spawns are involved in producing this error.
function writeErroringManifest(home: string): string {
  const target = path.join(home, "harness.yaml");
  fs.writeFileSync(
    target,
    `version: 1
hooks: []
policies: []
policy_packs:
  - name: branch-protection
    source: marketplace-that-does-not-exist-yet
`,
  );
  return target;
}

describe("harness doctor — exit code wired to report.errorCount (task a07b379a)", () => {
  it("prose: exits 1 when the report has errors", async () => {
    const home = tempHome();
    const configPath = writeErroringManifest(home);
    let stdout = "";
    let stderr = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow"],
      stdout: (s) => { stdout += s; },
      stderr: (s) => { stderr += s; },
    });
    expect(code).toBe(1);
    // The prose report itself is still printed before the non-zero exit.
    expect(stdout).toContain("declared but not live");
    expect(stderr).toBe("");
  });

  it("prose: exits 0 on a clean-of-errors report even though it carries a warning", async () => {
    const home = tempHome();
    const configPath = writeCleanManifest(home);
    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // Prove the fixture really carries a warning (same fixture, same
    // report, read through the --json path), so this case keeps pinning
    // "warnings alone exit 0" rather than "a report with nothing in it
    // exits 0".
    let jsonOut = "";
    const jsonCode = await run({
      argv: ["doctor", "--config", configPath, "--shallow", "--json"],
      stdout: (s) => { jsonOut += s; },
      stderr: () => {},
    });
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(jsonOut) as { errorCount: number; warningCount: number };
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBeGreaterThan(0);
  });

  it("--json: exits 1 when the report has errors, JSON still lands on stdout", async () => {
    const home = tempHome();
    const configPath = writeErroringManifest(home);
    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow", "--json"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { errorCount: number; warningCount: number };
    expect(parsed.errorCount).toBeGreaterThanOrEqual(1);
  });

  it("--json: exits 0 when the report has no errors", async () => {
    const home = tempHome();
    const configPath = writeCleanManifest(home);
    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow", "--json"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { errorCount: number; warningCount: number };
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBeGreaterThanOrEqual(1);
  });
});

describe("harness doctor: hermetic spawn guard re-throw at the run() boundary (task f9fd9cb9, reviewer finding-set of task 325ace29)", () => {
  it("`doctor` without --shallow (no injected npmBinExec seam exists on RunOptions) propagates HermeticSpawnViolationError out of run(), not folded into exit code 70", async () => {
    // run()'s catch (src/cli/index.ts) has
    // `if (err instanceof HermeticSpawnViolationError) throw err;` before
    // the generic handling that folds every other error into
    // `return 70`. The analogous re-throw in runInteractive's outer catch
    // is tested (tests/cli/init-interactive.test.ts, "wiring claude-code
    // ... WITHOUT an injected mcpExec ..."), but this run()-level branch
    // had no direct test.
    //
    // Call-path: `RunOptions` deliberately has no `npmBinExec` seam
    // (task 325ace29 review finding F2, documented on `realNpmExec` in
    // src/cli/doctor/npm-bin-path.ts), and the `doctor` CLI action does
    // not thread one through either. So a CLI-level `run({ argv:
    // ["doctor", ...] })` WITHOUT `--shallow` is the only way to reach
    // `realNpmExec` (and therefore the hermetic-spawn guard) through
    // `run()`. `doctor()` (src/cli/doctor/index.ts) calls
    // `checkNpmBinPath` unconditionally as its first async step whenever
    // `!opts.shallow`, before any MCP or CLI version probe, so a minimal
    // manifest with no declared tools already reaches it.
    const home = tempHome();
    const configPath = writeCleanManifest(home);
    let stdout = "";
    let stderr = "";
    let caught: unknown;
    try {
      await run({
        argv: ["doctor", "--config", configPath],
        stdout: (s) => { stdout += s; },
        stderr: (s) => { stderr += s; },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HermeticSpawnViolationError);
    expect((caught as Error).message).toMatch(/Refusing to spawn a REAL "npm prefix -g"/);
    // Never folded into the generic "return 70" branch: that branch
    // writes `${err.message}\n` to stderr before returning, and the
    // doctor prose report (only produced after the throwing call) never
    // gets written to stdout either.
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
