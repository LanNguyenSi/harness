import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import { planCodexConfigInstall, writeCodexConfigInstall } from "../../../src/cli/apply/install-codex-config.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import { listCodexSnapshots } from "../../../src/cli/gate/codex-snapshot.js";
import { atomicWriteFile } from "../../../src/io/atomic-write.js";
import { parseManifest } from "../../../src/schema/index.js";

// The write order of a Codex disable (backup, snapshot, config) and the
// snapshot rollback after a failed config write are observed through the
// atomic writer, which this file wraps; everything else runs for real.
vi.mock("../../../src/io/atomic-write.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/io/atomic-write.js")>();
  return { ...real, atomicWriteFile: vi.fn(real.atomicWriteFile) };
});

let tmp: string;
let configPath: string;
let writes: string[];
let failOn: (filePath: string, nth: number) => Error | null;
let realWrite: typeof atomicWriteFile;

const at = (hour: number): Date => new Date(`2026-10-02T${String(hour).padStart(2, "0")}:00:00.000Z`);

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../../../src/io/atomic-write.js")>("../../../src/io/atomic-write.js");
  realWrite = actual.atomicWriteFile;
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-codex-gate-order-"));
  configPath = path.join(tmp, "config.toml");
  fs.writeFileSync(configPath, 'model = "gpt-5.5"\n');
  const hook = (name: string, match: string): Record<string, unknown> => ({
    name,
    event: "PreToolUse",
    match,
    command: `harness pack hook ${name} --runtime codex`,
    blocking: "hard",
    budget_ms: 5000,
  });
  const generated = generateCodexConfig(
    parseManifest({ version: 1, hooks: [hook("branch-protection", "apply_patch"), hook("shell-guard", "Bash")] }),
  );
  writeCodexConfigInstall(
    planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
    { now: new Date("2026-10-01T00:00:00.000Z") },
  );
  writes = [];
  const counts = new Map<string, number>();
  failOn = () => null;
  vi.mocked(atomicWriteFile).mockImplementation((filePath, content, options) => {
    writes.push(filePath);
    const nth = (counts.get(filePath) ?? 0) + 1;
    counts.set(filePath, nth);
    const failure = failOn(filePath, nth);
    if (failure !== null) throw failure;
    return realWrite(filePath, content, options);
  });
});

afterEach(() => {
  vi.mocked(atomicWriteFile).mockReset();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function disable(matcher: string, hour: number): { backupPath: string; snapshotPath: string } {
  const d = codexGateDisable({ configPath, matcher, now: at(hour) });
  if (d.mode !== "remove") throw new Error("expected remove");
  return d;
}

describe("codex gate disable: write order and snapshot rollback", () => {
  it("writes the backup, then the snapshot, then the config, for a fresh snapshot and for a merge", () => {
    const first = disable("apply_patch", 1);
    expect(writes).toEqual([first.backupPath, first.snapshotPath, configPath]);
    writes.length = 0;
    const second = disable("Bash", 2);
    expect(second.snapshotPath).toBe(first.snapshotPath);
    expect(writes).toEqual([second.backupPath, first.snapshotPath, configPath]);
  });

  it("puts the snapshot back as it was when the config write of a merge fails, and rethrows that error", () => {
    const first = disable("apply_patch", 1);
    const bodyBefore = fs.readFileSync(first.snapshotPath, "utf8");
    const afterFirst = fs.readFileSync(configPath, "utf8");
    failOn = (filePath) => (filePath === configPath ? new Error("disk full") : null);
    writes.length = 0;
    expect(() => disable("Bash", 2)).toThrow("disk full");
    // backup, merged snapshot, the failed config write, the rollback of the snapshot
    expect(writes.map((w) => path.basename(w).replace(/\.bak\..*/, ".bak"))).toEqual([
      "config.toml.bak",
      path.basename(first.snapshotPath),
      "config.toml",
      path.basename(first.snapshotPath),
    ]);
    expect(fs.readFileSync(first.snapshotPath, "utf8")).toBe(bodyBefore);
    expect(fs.readFileSync(configPath, "utf8")).toBe(afterFirst);
  });

  it("does not touch a snapshot when the config write of a fresh disable fails: the orphan matches the untouched config and enable retires it", () => {
    const original = fs.readFileSync(configPath, "utf8");
    failOn = (filePath) => (filePath === configPath ? new Error("disk full") : null);
    expect(() => disable("apply_patch", 1)).toThrow("disk full");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    failOn = () => null;
    const e = codexGateEnable({ configPath, now: at(2) });
    expect(e.mode).toBe("already-restored");
    expect(listCodexSnapshots(tmp)).toEqual([]);
  });

  it("names both failures and the way out when the snapshot cannot be put back either", () => {
    const first = disable("apply_patch", 1);
    failOn = (filePath, nth) =>
      filePath === configPath ? new Error("disk full") : filePath === first.snapshotPath && nth >= 3 ? new Error("snapshot gone") : null;
    let message = "";
    try {
      disable("Bash", 2);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("disk full");
    expect(message).toContain("snapshot gone");
    expect(message).toContain(`harness gate enable --runtime codex --config ${configPath}`);
    // The merged snapshot stays, and enable still restores everything it names that is off.
    failOn = () => null;
    const e = codexGateEnable({ configPath, now: at(3) });
    expect(e.mode).toBe("restored");
    expect(e.mode === "restored" && [e.restoredCount, e.skippedEnabled]).toEqual([1, ["shell-guard"]]);
  });
});

function reinstall(hour: number): ReturnType<typeof writeCodexConfigInstall> {
  const generated = generateCodexConfig(
    parseManifest({
      version: 1,
      hooks: [
        {
          name: "branch-protection",
          event: "PreToolUse",
          match: "apply_patch",
          command: "harness pack hook branch-protection --runtime codex --reinstalled",
          blocking: "hard",
          budget_ms: 5000,
        },
      ],
    }),
  );
  return writeCodexConfigInstall(
    planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
    { now: at(hour) },
  );
}

describe("codex install: the snapshots are retired only after the config is written", () => {
  it("writes the backup, then the config, and only then renames the live snapshot", () => {
    const snap = disable("apply_patch", 1).snapshotPath;
    writes.length = 0;
    const result = reinstall(2);
    expect(writes).toEqual([result.backupPath, configPath]);
    expect(result.supersededSnapshots).toEqual([snap.replace(/\.json$/, ".superseded.json")]);
    expect(listCodexSnapshots(tmp)).toEqual([]);
  });

  it("keeps every matched snapshot live when the config write fails, and rethrows that error", () => {
    const snap = disable("apply_patch", 1).snapshotPath;
    const configBefore = fs.readFileSync(configPath, "utf8");
    failOn = (filePath) => (filePath === configPath ? new Error("disk full") : null);
    expect(() => reinstall(2)).toThrow("disk full");
    expect(listCodexSnapshots(tmp)).toEqual([snap]);
    expect(fs.existsSync(snap.replace(/\.json$/, ".superseded.json"))).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(configBefore);
  });

  it("keeps every matched snapshot live when the backup write fails", () => {
    const snap = disable("apply_patch", 1).snapshotPath;
    failOn = (filePath) => (filePath.includes(".harness-backup-") ? new Error("no space") : null);
    expect(() => reinstall(2)).toThrow("no space");
    expect(listCodexSnapshots(tmp)).toEqual([snap]);
  });
});
