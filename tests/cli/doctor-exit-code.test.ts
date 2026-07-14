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

// Mirrors doctor-rm-rogue-ledgers.test.ts's plantRogueLedger: seeds a
// leftover `<parent>/~/.evidence-ledger/ledger.db` so scanForRogueLedgers
// (and therefore deleteRogueLedgers) has an actual hit to act on.
function plantRogueLedger(parent: string): { rogueDir: string } {
  const rogueDir = path.join(parent, "~");
  const dir = path.join(rogueDir, ".evidence-ledger");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ledger.db"), "");
  return { rogueDir };
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

  it("--rm-rogue-ledgers: still exits 1 on the no-hits branch when the report has errors", async () => {
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
    // No rogue ledger was planted, so this exercises the `hits.length === 0`
    // early-return branch (src/cli/index.ts ~line 290), not the
    // delete+rescan tail below.
    expect(stdout).toContain("nothing to delete");
  });

  it("--rm-rogue-ledgers: exits 1 after an actual delete+rescan when the report also has errors", async () => {
    const home = tempHome();
    const configPath = writeErroringManifest(home);
    const { rogueDir } = plantRogueLedger(home);
    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--shallow", "--rm-rogue-ledgers", "--yes"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });
    expect(code).toBe(1);
    // Proves this run went through the actual deletion + rescan path
    // (src/cli/index.ts ~line 317's failIfErrors), not the no-hits
    // short-circuit above.
    expect(stdout).toContain(`deleted: ${rogueDir}`);
    expect(stdout).toContain("rogue evidence-ledger DBs remaining: 0");
    expect(fs.existsSync(rogueDir)).toBe(false);
  });
});
