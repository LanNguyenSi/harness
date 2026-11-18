// A prune that hits an I/O error must neither throw nor stop after the first
// failure. `vi.spyOn` cannot target Node builtin namespaces, so the
// call-through `vi.mock` wrapper of `tests/cli/apply/apply-target-backup-faults.test.ts`
// is used: with a flag set, `unlinkSync` of a chosen name, or `readdirSync`
// of the directory, throws.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ unlinkName: null as string | null, readdirOkCalls: null as number | null, readdirCalls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => {
      if (fault.unlinkName !== null && String(args[0]).endsWith(fault.unlinkName)) {
        throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
      }
      return actual.unlinkSync(...args);
    }) as typeof actual.unlinkSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      fault.readdirCalls += 1;
      if (fault.readdirOkCalls !== null && fault.readdirCalls > fault.readdirOkCalls) {
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdirSync,
  };
});

import { pruneDatedBackups, pruneRetiredSnapshots } from "../../src/cli/retention.js";

let dir: string;
const warnings: string[] = [];
const warn = (m: string): void => {
  warnings.push(m);
};

beforeEach(() => {
  fault.unlinkName = null;
  fault.readdirOkCalls = null;
  fault.readdirCalls = 0;
  warnings.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-retention-faults-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const stamp = (d: number): string => `2026-01-${String(d).padStart(2, "0")}T10-00-00.000Z`;

describe("pruning is best effort", () => {
  it("an unlink error is a warning, and the next file is still removed", () => {
    for (let d = 1; d <= 8; d++) fs.writeFileSync(path.join(dir, `settings.json.bak.${stamp(d)}`), "x");
    fault.unlinkName = `settings.json.bak.${stamp(1)}`;
    let removed: string[] = [];
    expect(() => {
      removed = pruneDatedBackups(path.join(dir, "settings.json"), "bak", { warn });
    }).not.toThrow();
    // Newest first: day 3 then day 2; day 1 (the oldest) fails and stays.
    expect(removed).toEqual([path.join(dir, `settings.json.bak.${stamp(3)}`), path.join(dir, `settings.json.bak.${stamp(2)}`)]);
    expect(fs.existsSync(path.join(dir, `settings.json.bak.${stamp(1)}`))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`settings.json.bak.${stamp(1)}`);
  });

  it("an unlink error on a retired snapshot is a warning too", () => {
    const prefix = "harness.gate-disable.";
    for (let d = 1; d <= 7; d++) fs.writeFileSync(path.join(dir, `${prefix}${stamp(d)}.restored.json`), "{}");
    fault.unlinkName = `${prefix}${stamp(1)}.restored.json`;
    expect(() => pruneRetiredSnapshots(dir, prefix, { warn })).not.toThrow();
    expect(fs.existsSync(path.join(dir, `${prefix}${stamp(2)}.restored.json`))).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it("an unreadable directory is a warning and removes nothing", () => {
    fault.readdirOkCalls = 0;
    expect(pruneRetiredSnapshots(dir, "harness.gate-disable.", { warn })).toEqual([]);
    expect(pruneDatedBackups(path.join(dir, "settings.json"), "bak", { warn })).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("cannot list");
  });

  it("an unreadable directory while looking for live snapshots removes no backup", () => {
    for (let d = 1; d <= 8; d++) fs.writeFileSync(path.join(dir, `settings.json.bak.${stamp(d)}`), "x");
    // The first listing (the backups) works; the second (the live snapshots) fails.
    fault.readdirOkCalls = 1;
    expect(pruneDatedBackups(path.join(dir, "settings.json"), "bak", { warn })).toEqual([]);
    expect(fs.readdirSync).toBeDefined();
    fault.readdirOkCalls = null;
    expect(fs.readdirSync(dir)).toHaveLength(8);
    expect(warnings.join("\n")).toContain("no backup was removed");
  });
});
