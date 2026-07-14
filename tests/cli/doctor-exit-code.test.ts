// Regression guard for task a07b379a: `harness doctor` used to always exit 0
// regardless of report.errorCount, so CI/scripts had no way to gate on
// doctor health. These are `run()`-level (full CLI) tests, not unit tests
// of `doctor()` directly, because the bug lived in the CLI action's exit
// path in src/cli/index.ts, not in the report-building logic itself.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";

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

// No mcp/hooks/policies declared: errorCount 0. Still carries a
// warningCount of 1 (no memory router configured), which is exactly the
// fixture we want for "warnings alone keep exit 0" — this is not a
// zero-diagnostics report, it is a report with a warning and no errors.
function writeCleanManifest(home: string): string {
  const target = path.join(home, "harness.yaml");
  fs.writeFileSync(
    target,
    `version: 1
hooks: []
policies: []
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
  - name: understanding-before-execution
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
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
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
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("--json: exits 1 when the report has errors, JSON still lands on stdout", async () => {
    const home = tempHome();
    const configPath = writeErroringManifest(home);
    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow", "--json"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
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
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { errorCount: number; warningCount: number };
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBeGreaterThanOrEqual(1);
  });

  it("--rm-rogue-ledgers: still exits 1 when the report has errors after the delete+rescan flow", async () => {
    const home = tempHome();
    const configPath = writeErroringManifest(home);
    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow", "--rm-rogue-ledgers", "--yes"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });
    expect(code).toBe(1);
    expect(stdout).toContain("nothing to delete");
  });
});
