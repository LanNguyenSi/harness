// Regression guard for `harness doctor --rm-rogue-ledgers` acceptance criteria:
//   1. When rogue dirs exist, --rm-rogue-ledgers --yes deletes them and prints
//      a "deleted: ..." line per hit plus a "rogue evidence-ledger DBs remaining: 0"
//      delta line after the post-deletion re-scan.
//   2. When no rogue dirs exist, prints "nothing to delete" and exits cleanly.
//
// These are buildProgram-level tests that drive the full CLI action (including
// the post-deletion re-scan) rather than the unit-level scan/delete helpers,
// which are already covered in doctor-rogue-ledger.test.ts. The
// RunOptions.rogueLedgerScanOptions injection knob (threaded in this PR) makes
// both the initial doctor() scan and the re-scan hermetic without touching the
// real filesystem outside the temp dir.
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

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rm-rogue-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeMinimalManifest(home: string): string {
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

function plantRogueLedger(parent: string): { rogueDir: string } {
  const rogueDir = path.join(parent, "~");
  const dir = path.join(rogueDir, ".evidence-ledger");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ledger.db"), "");
  return { rogueDir };
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: rogue dirs found → delete + delta line
// ---------------------------------------------------------------------------

describe("harness doctor --rm-rogue-ledgers --yes (rogue dirs present)", () => {
  it("prints 'deleted: <rogueDir>' and 'rogue evidence-ledger DBs remaining: 0'", async () => {
    const home = tempDir();
    const configPath = writeMinimalManifest(home);
    const { rogueDir } = plantRogueLedger(home);

    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--rm-rogue-ledgers", "--yes", "--shallow"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });

    expect(code).toBe(0);
    expect(stdout).toContain(`deleted: ${rogueDir}`);
    expect(stdout).toContain("rogue evidence-ledger DBs remaining: 0");
    // The rogueDir must actually be gone from disk.
    expect(fs.existsSync(rogueDir)).toBe(false);
  });

  it("re-scan confirms the on-disk count dropped to 0 after deletion", async () => {
    const home = tempDir();
    const repoDir = path.join(home, "git", "my-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const configPath = writeMinimalManifest(home);
    plantRogueLedger(home);
    plantRogueLedger(repoDir);

    let stdout = "";
    await run({
      argv: ["doctor", "--config", configPath, "--rm-rogue-ledgers", "--yes", "--shallow"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });

    expect(stdout).toContain("rogue evidence-ledger DBs remaining: 0");
    // Both rogue dirs removed from disk.
    expect(fs.existsSync(path.join(home, "~"))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, "~"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: no rogue dirs → "nothing to delete" message
// ---------------------------------------------------------------------------

describe("harness doctor --rm-rogue-ledgers (no rogue dirs)", () => {
  it("prints 'nothing to delete' when the scan finds no rogue DBs", async () => {
    const home = tempDir();
    const configPath = writeMinimalManifest(home);
    // No plantRogueLedger call — clean host.

    let stdout = "";
    const code = await run({
      argv: ["doctor", "--config", configPath, "--rm-rogue-ledgers", "--yes", "--shallow"],
      stdout: (s) => { stdout += s; },
      stderr: () => {},
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("nothing to delete");
    // Must NOT print a delta line when there was nothing to do.
    expect(stdout).not.toContain("rogue evidence-ledger DBs remaining:");
  });
});
