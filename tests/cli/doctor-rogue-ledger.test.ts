import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { scanForRogueLedgers } from "../../src/cli/doctor/rogue-ledger.js";
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
    expect(text).toContain(`safe to delete: \`rm -rf ${rogueDir}\``);
    expect(text).toContain("EVIDENCE_LEDGER_DB literal-tilde bug");
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
      rogueLedgerScanOptions: { homeDir: home, cwd },
    });

    expect(report.rogueLedgerDbs).toEqual([]);
  });
});
