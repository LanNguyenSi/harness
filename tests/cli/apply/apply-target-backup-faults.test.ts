// A backup copy that fails after the destination was opened must not
// leave a partial `<target>.bak.<timestamp>` file behind: like
// `atomicWriteFile`, a failed write removes the file the call created,
// then the apply aborts with the target untouched. `vi.spyOn` cannot
// target Node builtin namespaces ("Cannot redefine property"), so the
// established call-through `vi.mock` wrapper is used (same workaround as
// `tests/io/read-regular-file.test.ts`): with the matching flag set, a
// `writeSync`/`writeFileSync` (or `fsyncSync`) call on a numeric fd (the
// only such writers in src are in the backup copy in `target-backup.ts`)
// throws EIO.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as yamlStringify } from "yaml";

const fault = vi.hoisted(() => ({ failWrite: false, failFsync: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      if (fault.failWrite && typeof args[0] === "number") {
        throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      }
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.failWrite && typeof args[0] === "number") {
        throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      }
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
    fsyncSync: ((...args: Parameters<typeof actual.fsyncSync>) => {
      if (fault.failFsync && typeof args[0] === "number") {
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      }
      return actual.fsyncSync(...args);
    }) as typeof actual.fsyncSync,
  };
});

import { apply } from "../../../src/cli/apply/index.js";
import { HarnessExitError } from "../../../src/cli/exit-codes.js";

let tmpHome: string;

beforeEach(() => {
  fault.failWrite = false;
  fault.failFsync = false;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-target-backup-faults-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeManifest(hookCommand = "/h.sh"): void {
  const manifest: Record<string, unknown> = {
    version: 1,
    tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
    memory: { directories: [] },
    hooks: [
      { name: "h", event: "SessionStart", command: hookCommand, blocking: false, budget_ms: 30000 },
    ],
    policies: [],
  };
  fs.writeFileSync(path.join(tmpHome, "harness.yaml"), yamlStringify(manifest));
}

const NOW = new Date("2026-11-13T08:00:00.000Z");
const STAMP = "2026-11-13T08-00-00.000Z";

function backupName(target: string): string {
  return `${target}.bak.${STAMP}`;
}

const HAND_EDITED = `${JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, env: { KEEP: "1" } },
  null,
  2,
)}\n`;

describe("apply --target backup: copy failure after the destination is opened", () => {
  it("the write fails: the partial backup is removed, the apply aborts with the target untouched", async () => {
    writeManifest();
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, HAND_EDITED);
    fault.failWrite = true;
    let err: unknown;
    try {
      await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessExitError);
    expect((err as Error).message).toContain(backupName(target));
    // The open created the file and the copy then failed: the partial
    // file is gone, not a truncated backup left to restore from.
    expect(fs.existsSync(backupName(target))).toBe(false);
    expect(fs.readdirSync(tmpHome).filter((n) => n.includes(".bak."))).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(HAND_EDITED);
  });

  it("the write lands but fsync fails: the backup file is still removed, the apply aborts", async () => {
    writeManifest();
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, HAND_EDITED);
    fault.failFsync = true;
    let err: unknown;
    try {
      await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarnessExitError);
    expect((err as Error).message).toContain(backupName(target));
    expect(fs.existsSync(backupName(target))).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(HAND_EDITED);
  });

  it("after the injected failure is lifted, the next apply takes the backup and writes normally", async () => {
    writeManifest();
    const target = path.join(tmpHome, "settings.local.json");
    fs.writeFileSync(target, HAND_EDITED);
    fault.failWrite = true;
    await expect(apply({ homeDir: tmpHome, target, force: true, now: NOW })).rejects.toBeInstanceOf(
      HarnessExitError,
    );
    fault.failWrite = false;
    const r = await apply({ homeDir: tmpHome, target, force: true, now: NOW });
    expect(r.targetBackupPath).toBe(backupName(target));
    expect(fs.readFileSync(backupName(target), "utf8")).toBe(HAND_EDITED);
  });
});
