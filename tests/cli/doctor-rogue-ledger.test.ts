import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import {
  deleteRogueLedgers,
  scanForRogueLedgers,
  type RogueLedgerDb,
} from "../../src/cli/doctor/rogue-ledger.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

class FakeProbe implements McpProbe {
  async call(server: McpServer): Promise<McpProbeResult> {
    return { name: server.name, outcome: { kind: "missing-verb" } };
  }
}

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rogue-ledger-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeMinimalManifest(home: string): string {
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

function plantRogueLedger(parent: string): { rogueDir: string; dbPath: string } {
  const rogueDir = path.join(parent, "~");
  const dir = path.join(rogueDir, ".evidence-ledger");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "ledger.db");
  fs.writeFileSync(dbPath, "");
  return { rogueDir, dbPath };
}

describe("scanForRogueLedgers", () => {
  it("flags a rogue ledger.db planted directly under $HOME", () => {
    const home = tempHome();
    const cwd = tempHome();
    const { rogueDir, dbPath } = plantRogueLedger(home);

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe(dbPath);
    expect(hits[0]?.rogueDir).toBe(rogueDir);
  });

  it("flags a rogue ledger.db planted under $HOME/git/<repo>", () => {
    const home = tempHome();
    const cwd = tempHome();
    const repoDir = path.join(home, "git", "my-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const { dbPath } = plantRogueLedger(repoDir);

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits.map((h) => h.path)).toEqual([dbPath]);
  });

  it("flags a rogue ledger.db under $PWD when distinct from $HOME", () => {
    const home = tempHome();
    const cwd = tempHome();
    const { dbPath } = plantRogueLedger(cwd);

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits.map((h) => h.path)).toEqual([dbPath]);
  });

  it("returns an empty list on a clean HOME / cwd", () => {
    const home = tempHome();
    const cwd = tempHome();
    fs.mkdirSync(path.join(home, "git", "clean-repo"), { recursive: true });

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits).toEqual([]);
  });

  it("does NOT flag the real ~/.evidence-ledger/ledger.db (intended path)", () => {
    const home = tempHome();
    const cwd = tempHome();
    fs.mkdirSync(path.join(home, ".evidence-ledger"), { recursive: true });
    fs.writeFileSync(path.join(home, ".evidence-ledger", "ledger.db"), "");

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits).toEqual([]);
  });

  it("does not recurse past one level into git children", () => {
    const home = tempHome();
    const cwd = tempHome();
    // Plant the rogue tree two levels deep — should NOT be flagged.
    const nested = path.join(home, "git", "outer", "inner");
    fs.mkdirSync(nested, { recursive: true });
    plantRogueLedger(nested);

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits).toEqual([]);
  });

  it("deduplicates when $HOME and $PWD point at the same parent", () => {
    const home = tempHome();
    plantRogueLedger(home);

    const hits = scanForRogueLedgers({ homeDir: home, cwd: home });

    expect(hits).toHaveLength(1);
  });
});

describe("doctor — rogue evidence-ledger scan", () => {
  it("surfaces rogue DBs as warnings without erroring out", async () => {
    const home = tempHome();
    writeMinimalManifest(home);
    const { rogueDir, dbPath } = plantRogueLedger(home);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });

    expect(report.rogueLedgerDbs).toHaveLength(1);
    expect(report.rogueLedgerDbs[0]?.path).toBe(dbPath);
    expect(report.rogueLedgerDbs[0]?.rogueDir).toBe(rogueDir);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);

    const text = format(report);
    expect(text).toContain("Rogue evidence-ledger DBs");
    expect(text).toContain(`rogue evidence-ledger db found: ${dbPath}`);
    expect(text).toContain(`safe to delete: \`rm -rf '${rogueDir}'\``);
    expect(text).toContain("EVIDENCE_LEDGER_DB literal-tilde bug");
  });

  it("shell-quotes paths containing single quotes so the cleanup hint stays paste-safe", async () => {
    const home = tempHome();
    writeMinimalManifest(home);
    // Plant a rogue at the canonical $HOME/~ location, then patch the
    // scan result to carry a path with a `'` to verify the rendering
    // path. Doing this end-to-end (planting a real dir whose name
    // contains a quote) is OS-dependent and brittle; the format layer
    // is the unit under test here.
    const planted = plantRogueLedger(home);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      rogueLedgerScanOptions: { homeDir: home, cwd: home },
    });
    // Inject a quote-containing path into the report and re-render.
    report.rogueLedgerDbs[0] = {
      path: planted.dbPath,
      rogueDir: "/tmp/weird's-repo/~",
    };
    const text = format(report);
    expect(text).toContain(`safe to delete: \`rm -rf '/tmp/weird'\\''s-repo/~'\``);
  });

  it("does not render the rogue section on a clean host", async () => {
    const home = tempHome();
    const cwd = tempHome();
    writeMinimalManifest(home);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      rogueLedgerScanOptions: { homeDir: home, cwd },
    });

    expect(report.rogueLedgerDbs).toEqual([]);
    const text = format(report);
    expect(text).not.toContain("Rogue evidence-ledger DBs");
  });

  it("does not flag the real ~/.evidence-ledger/ledger.db", async () => {
    const home = tempHome();
    const cwd = tempHome();
    writeMinimalManifest(home);
    fs.mkdirSync(path.join(home, ".evidence-ledger"), { recursive: true });
    fs.writeFileSync(path.join(home, ".evidence-ledger", "ledger.db"), "");

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      rogueLedgerScanOptions: { homeDir: home, cwd },
    });

    expect(report.rogueLedgerDbs).toEqual([]);
  });
});

describe("scanForRogueLedgers — symlink semantics (task 44f66fa4 polish)", () => {
  it("does NOT flag a symlinked `~` directory (M3: lstat short-circuit)", () => {
    const home = tempHome();
    const cwd = tempHome();
    // Create a real ~/.evidence-ledger/ledger.db elsewhere and symlink
    // <home>/~ at it. The scan would follow stat into the symlink and
    // false-positive without the lstat guard.
    const realTarget = path.join(home, "real-tree");
    fs.mkdirSync(path.join(realTarget, ".evidence-ledger"), { recursive: true });
    fs.writeFileSync(path.join(realTarget, ".evidence-ledger", "ledger.db"), "");
    fs.symlinkSync(realTarget, path.join(home, "~"));

    const hits = scanForRogueLedgers({ homeDir: home, cwd });

    expect(hits).toEqual([]);
  });

  it("deduplicates by realpath when two parents symlink to the same physical dir (M2)", () => {
    // Use the fs-interface injection knob: real cross-tmpdir symlinks
    // behave differently on macOS vs Linux because of /tmp -> /private/tmp,
    // which makes this case noisy to test against real fs. The injected
    // realpathSync collapses both parents to the same target, exercising
    // the dedup contract directly.
    const homeDir = "/fake/home";
    const cwd = "/fake/pwd";
    const collidingTarget = "/fake/physical/~/.evidence-ledger/ledger.db";

    const existsPaths = new Set<string>([
      "/fake/home/~",
      "/fake/home/~/.evidence-ledger/ledger.db",
      "/fake/pwd/~",
      "/fake/pwd/~/.evidence-ledger/ledger.db",
    ]);
    const fakeFs = {
      existsSync: (p: fs.PathLike) => existsPaths.has(String(p)),
      statSync: (() => ({ isFile: () => true })) as unknown as typeof fs.statSync,
      lstatSync: (() => ({ isSymbolicLink: () => false })) as unknown as typeof fs.lstatSync,
      readdirSync: (() => []) as unknown as typeof fs.readdirSync,
      realpathSync: ((_p: fs.PathLike) => collidingTarget) as unknown as typeof fs.realpathSync,
    };

    const hits = scanForRogueLedgers({ homeDir, cwd, fsInterface: fakeFs });

    expect(hits).toHaveLength(1);
  });

  it("falls back to the joined path when realpathSync throws (EACCES race)", () => {
    const homeDir = "/fake/home";
    const cwd = "/fake/pwd";
    const existsPaths = new Set<string>([
      "/fake/home/~",
      "/fake/home/~/.evidence-ledger/ledger.db",
      "/fake/pwd/~",
      "/fake/pwd/~/.evidence-ledger/ledger.db",
    ]);
    const fakeFs = {
      existsSync: (p: fs.PathLike) => existsPaths.has(String(p)),
      statSync: (() => ({ isFile: () => true })) as unknown as typeof fs.statSync,
      lstatSync: (() => ({ isSymbolicLink: () => false })) as unknown as typeof fs.lstatSync,
      readdirSync: (() => []) as unknown as typeof fs.readdirSync,
      realpathSync: ((() => {
        throw new Error("EACCES");
      }) as unknown) as typeof fs.realpathSync,
    };

    const hits = scanForRogueLedgers({ homeDir, cwd, fsInterface: fakeFs });

    // With realpath broken, dedup falls back to joined path. Two distinct
    // parents → two hits.
    expect(hits.map((h) => h.path).sort()).toEqual([
      "/fake/home/~/.evidence-ledger/ledger.db",
      "/fake/pwd/~/.evidence-ledger/ledger.db",
    ]);
  });

  it("deduplicates when $HOME/git/<repo> is the same parent as $PWD (N3)", () => {
    const home = tempHome();
    const repoDir = path.join(home, "git", "shared-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    plantRogueLedger(repoDir);
    // $PWD == $HOME/git/shared-repo — the walker would discover the same
    // rogue dir twice (once via the git/<repo> loop, once via the cwd
    // probe) without dedup.

    const hits = scanForRogueLedgers({ homeDir: home, cwd: repoDir });

    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deleteRogueLedgers
// ---------------------------------------------------------------------------

describe("deleteRogueLedgers", () => {
  it("--yes: deletes the rogueDir and a follow-up scan returns empty", async () => {
    const home = tempHome();
    const { rogueDir } = plantRogueLedger(home);

    const hits = scanForRogueLedgers({ homeDir: home, cwd: home });
    expect(hits).toHaveLength(1);

    const result = await deleteRogueLedgers(hits, { yes: true });

    expect(result.deleted).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(fs.existsSync(rogueDir)).toBe(false);

    // Follow-up scan must return empty.
    const afterScan = scanForRogueLedgers({ homeDir: home, cwd: home });
    expect(afterScan).toHaveLength(0);
  });

  it("--yes: parent directory is NOT deleted, only the rogueDir itself", async () => {
    const home = tempHome();
    plantRogueLedger(home);

    const hits = scanForRogueLedgers({ homeDir: home, cwd: home });
    await deleteRogueLedgers(hits, { yes: true });

    // The parent (home) must still exist.
    expect(fs.existsSync(home)).toBe(true);
  });

  it("injected promptFn returning true deletes the rogueDir", async () => {
    const home = tempHome();
    const { rogueDir } = plantRogueLedger(home);

    const hits = scanForRogueLedgers({ homeDir: home, cwd: home });
    const promptFn = vi.fn().mockResolvedValue(true);
    const result = await deleteRogueLedgers(hits, { promptFn });

    expect(promptFn).toHaveBeenCalledOnce();
    expect(promptFn).toHaveBeenCalledWith(rogueDir);
    expect(result.deleted).toHaveLength(1);
    expect(fs.existsSync(rogueDir)).toBe(false);
  });

  it("injected promptFn returning false skips deletion and leaves the rogueDir intact", async () => {
    const home = tempHome();
    const { rogueDir } = plantRogueLedger(home);

    const hits = scanForRogueLedgers({ homeDir: home, cwd: home });
    const promptFn = vi.fn().mockResolvedValue(false);
    const result = await deleteRogueLedgers(hits, { promptFn });

    expect(promptFn).toHaveBeenCalledOnce();
    expect(result.deleted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(fs.existsSync(rogueDir)).toBe(true);
  });

  it("does nothing when the hits list is empty", async () => {
    const result = await deleteRogueLedgers([], { yes: true });
    expect(result.deleted).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("skips a hit whose rogueDir basename is not '~' (safety guard)", async () => {
    const home = tempHome();
    // Fabricate a hit that bypasses the scan filter to test the
    // basename safety check inside deleteRogueLedgers directly.
    const fakeHit: RogueLedgerDb = {
      rogueDir: path.join(home, "not-a-tilde"),
      path: path.join(home, "not-a-tilde", ".evidence-ledger", "ledger.db"),
    };
    const promptFn = vi.fn().mockResolvedValue(true);
    const result = await deleteRogueLedgers([fakeHit], { promptFn });

    // The hit is skipped without calling the prompt.
    expect(promptFn).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(1);
    expect(result.deleted).toHaveLength(0);
  });

  it("prompts per hit when multiple rogue dirs exist (--yes skips all)", async () => {
    const home = tempHome();
    // Plant two rogue dirs: one under $HOME and one under $HOME/git/repo.
    const repoDir = path.join(home, "git", "my-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    plantRogueLedger(home);
    plantRogueLedger(repoDir);

    const hits = scanForRogueLedgers({ homeDir: home, cwd: home });
    expect(hits).toHaveLength(2);

    const promptFn = vi.fn().mockResolvedValue(true);
    const result = await deleteRogueLedgers(hits, { promptFn });

    // One prompt call per hit.
    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(result.deleted).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);

    const afterScan = scanForRogueLedgers({ homeDir: home, cwd: home });
    expect(afterScan).toHaveLength(0);
  });
});
