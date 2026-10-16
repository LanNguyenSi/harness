import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateDisable } from "../../../src/cli/gate/disable.js";
import { gateEnable } from "../../../src/cli/gate/enable.js";
import { liveSnapshotNames, retiredSnapshotNames } from "../../_helpers/claude-gate-legacy.js";

// The Claude gate's writes go through atomicWriteFile. Every write is
// reported to `fault.onWrite` before it happens; a hook that throws makes
// that write fail, the way a full disk or a killed process would, and the
// recorded order pins backup -> snapshot -> settings.json.
const fault = vi.hoisted(() => ({
  onWrite: null as null | ((filePath: string, content: string) => void),
}));

vi.mock("../../../src/io/atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/io/atomic-write.js")>();
  return {
    ...actual,
    atomicWriteFile: (filePath: string, content: string, ...rest: unknown[]) => {
      fault.onWrite?.(filePath, content);
      return (actual.atomicWriteFile as (...a: unknown[]) => void)(filePath, content, ...rest);
    },
  };
});

let tmp: string;
let settingsPath: string;

const T1 = new Date("2026-01-01T00:00:01.000Z");
const T2 = new Date("2026-01-01T00:00:02.000Z");
const T3 = new Date("2026-01-01T00:00:03.000Z");

function kindOf(filePath: string): "backup" | "snapshot" | "settings" | "other" {
  const name = path.basename(filePath);
  if (name.includes(".bak.")) return "backup";
  if (name.startsWith("harness.gate-disable.")) return "snapshot";
  if (name === "settings.json") return "settings";
  return "other";
}

function matchers(): string[] {
  const hooks = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, Array<{ matcher: string }>> }).hooks;
  return (hooks?.["PreToolUse"] ?? []).map((g) => g.matcher);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-claude-gate-faults-"));
  settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
            { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
            { matcher: "Task", hooks: [{ command: "task-hook" }] },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
});

afterEach(() => {
  fault.onWrite = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gateDisable: write order", () => {
  it("writes the backup, then the snapshot, then settings.json on a fresh disable", () => {
    const order: string[] = [];
    fault.onWrite = (p) => order.push(kindOf(p));
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    expect(order).toEqual(["backup", "snapshot", "settings"]);
  });

  it("writes the backup, then the merged snapshot, then settings.json on a merge", () => {
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const order: string[] = [];
    fault.onWrite = (p) => order.push(kindOf(p));
    const r = gateDisable({ settingsPath, matcher: "Bash", now: T2 });
    expect(r.mode === "remove" && r.merged).toBe(true);
    expect(order).toEqual(["backup", "snapshot", "settings"]);
  });

  it("leaves the file untouched when the snapshot write fails (nothing mutated without its way back)", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "snapshot") throw new Error("disk full");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 })).toThrow(/disk full/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("changes neither the file nor the snapshot when the backup write fails on a merge", () => {
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const file = fs.readFileSync(settingsPath, "utf8");
    const snap = liveSnapshotNames(settingsPath);
    const snapBody = fs.readFileSync(path.join(tmp, snap[0] ?? ""), "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "backup") throw new Error("disk full");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Bash", now: T2 })).toThrow(/disk full/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(file);
    expect(fs.readFileSync(path.join(tmp, snap[0] ?? ""), "utf8")).toBe(snapBody);
  });
});

describe("gateDisable: the settings.json write fails after the snapshot was written", () => {
  it("merge path: rolls the live snapshot back to its pre-merge body, rethrows, and a retry restores the original", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const [name] = liveSnapshotNames(settingsPath);
    const snapFile = path.join(tmp, name ?? "");
    const premerge = fs.readFileSync(snapFile, "utf8");
    const afterFirst = fs.readFileSync(settingsPath, "utf8");

    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Bash", now: T2 })).toThrow(/write failed/);
    fault.onWrite = null;
    expect(fs.readFileSync(snapFile, "utf8")).toBe(premerge);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(afterFirst);

    // Retry: merges once, so one enable brings back each group exactly once.
    const retry = gateDisable({ settingsPath, matcher: "Bash", now: T3 });
    expect(retry.mode === "remove" && retry.merged).toBe(true);
    const on = gateEnable({ settingsPath });
    expect(on.mode).toBe("restored");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(matchers()).toEqual(["Write|Edit", "Bash", "Task"]);
  });

  it("merge path, rollback fails too: the original error is reported and enable restores without --force and without duplicates", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    let snapshotWrites = 0;
    fault.onWrite = (p) => {
      if (kindOf(p) === "snapshot") {
        snapshotWrites += 1;
        if (snapshotWrites > 1) throw new Error("rollback failed");
      }
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Bash", now: T2 })).toThrow(/write failed/);
    fault.onWrite = null;
    // The merged snapshot stayed, the file is still the first disable's state.
    expect(matchers()).toEqual(["Bash", "Task"]);

    const on = gateEnable({ settingsPath });
    expect(on.mode).toBe("restored");
    if (on.mode !== "restored") return;
    expect(on.restoredCount).toBe(1);
    expect(on.alreadyBack).toEqual(['PreToolUse matcher="Bash"']);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(matchers()).toEqual(["Write|Edit", "Bash", "Task"]);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("fresh path: the snapshot stays, enable only retires it, and a retried disable starts a new one", () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    fault.onWrite = (p) => {
      if (kindOf(p) === "settings") throw new Error("write failed");
    };
    expect(() => gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 })).toThrow(/write failed/);
    fault.onWrite = null;
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);

    // A retried disable finds the live snapshot spent (file at its pre-disable state) and retires it.
    const retry = gateDisable({ settingsPath, matcher: "Write|Edit", now: T2 });
    if (retry.mode !== "remove") throw new Error("expected remove");
    expect(retry.merged).toBe(false);
    expect(retry.retired).toHaveLength(1);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(1);
    gateEnable({ settingsPath });
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });
});
