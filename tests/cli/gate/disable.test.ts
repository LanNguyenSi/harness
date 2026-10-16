import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateDisable, GateDisableError } from "../../../src/cli/gate/disable.js";
import {
  listSnapshots,
  readSnapshot,
  sha256Hex,
  SNAPSHOT_VERSION,
} from "../../../src/cli/gate/snapshot.js";
import {
  downgradeToVersion1,
  liveSnapshotNames,
  retiredSnapshotNames,
} from "../../_helpers/claude-gate-legacy.js";

let tmp: string;
let settingsPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-disable-"));
  settingsPath = path.join(tmp, "settings.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(obj: Record<string, unknown>): void {
  fs.writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

describe("gateDisable — listing (no --matcher)", () => {
  it("returns every hook group as a candidate, sorted by event", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "/path/to/bash-hook" }] },
          { matcher: "Edit|Write|Bash", hooks: [{ command: "harness pack hook pre-tool-use" }] },
        ],
        Stop: [{ hooks: [{ command: "understanding-gate-claude-stop" }] }],
      },
    });
    const r = gateDisable({ settingsPath });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(r.candidates).toEqual([
      {
        event: "PreToolUse",
        index: 0,
        matcher: "Bash",
        description: "/path/to/bash-hook",
      },
      {
        event: "PreToolUse",
        index: 1,
        matcher: "Edit|Write|Bash",
        description: "harness pack hook pre-tool-use",
      },
      {
        event: "Stop",
        index: 0,
        matcher: null,
        description: "understanding-gate-claude-stop",
      },
    ]);
  });

  it("returns an empty candidate list when hooks is absent", () => {
    writeSettings({});
    const r = gateDisable({ settingsPath });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(r.candidates).toEqual([]);
  });

  it("does not write any backup or snapshot in list mode", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "h" }] }] },
    });
    gateDisable({ settingsPath });
    const entries = fs.readdirSync(tmp).filter((n) => n !== "settings.json");
    expect(entries).toEqual([]);
  });
});

describe("gateDisable — removal", () => {
  it("removes the matching group, writes a snapshot + backup, leaves siblings intact", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "policy-intercept" }] },
          { matcher: "Edit|Write|Bash", hooks: [{ command: "blocker" }] },
        ],
        Stop: [{ hooks: [{ command: "stop-hook" }] }],
      },
      mcpServers: { foo: { command: "x" } },
    });
    const r = gateDisable({
      settingsPath,
      matcher: "Edit|Write|Bash",
      now: new Date("2026-05-15T10:00:00Z"),
    });
    expect(r.mode).toBe("remove");
    if (r.mode !== "remove") return;
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0]?.event).toBe("PreToolUse");
    expect(r.removed[0]?.index).toBe(1);

    // settings.json after: matching group gone, sibling group + Stop event + mcpServers kept.
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = after["hooks"] as Record<string, unknown>;
    const pre = hooks["PreToolUse"] as Array<{ matcher?: string }>;
    expect(pre).toHaveLength(1);
    expect(pre[0]?.matcher).toBe("Bash");
    expect((hooks["Stop"] as unknown[]).length).toBe(1);
    expect(after["mcpServers"]).toEqual({ foo: { command: "x" } });

    // Backup is the literal pre-mutation content.
    const backup = fs.readFileSync(r.backupPath, "utf8");
    expect(backup).toContain("Edit|Write|Bash");

    // Snapshot records the right things.
    const snapRead = readSnapshot(r.snapshotPath);
    expect(snapRead.ok).toBe(true);
    if (!snapRead.ok) return;
    const snap = snapRead.snapshot;
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    expect(snap.settingsPath).toBe(settingsPath);
    expect(snap.filter.matcher).toBe("Edit|Write|Bash");
    expect(snap.removed).toHaveLength(1);
    expect(snap.settingsBeforeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.settingsAfterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.settingsBeforeSha256).not.toBe(snap.settingsAfterSha256);
  });

  it("removes multiple matching groups across events when the matcher is shared", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write|Bash", hooks: [{ command: "a" }] },
        ],
        PostToolUse: [
          { matcher: "Edit|Write|Bash", hooks: [{ command: "b" }] },
        ],
      },
    });
    const r = gateDisable({ settingsPath, matcher: "Edit|Write|Bash" });
    if (r.mode !== "remove") throw new Error("expected remove");
    expect(r.removed).toHaveLength(2);
    expect(r.removed.map((x) => x.event).sort()).toEqual(["PostToolUse", "PreToolUse"]);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(after["hooks"]).toBeUndefined();
  });

  it("matches substring (not literal-equal): a partial matcher hits the full group", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write|Bash", hooks: [{ command: "blocker" }] },
        ],
      },
    });
    const r = gateDisable({ settingsPath, matcher: "Edit" });
    if (r.mode !== "remove") throw new Error("expected remove");
    expect(r.removed).toHaveLength(1);
  });

  it("throws when no group matches the supplied matcher", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] },
    });
    expect(() => gateDisable({ settingsPath, matcher: "DoesNotExist" })).toThrow(
      GateDisableError,
    );
  });

  it("drops the `hooks` key entirely when removal empties every event", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] },
    });
    gateDisable({ settingsPath, matcher: "Bash" });
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(after).not.toHaveProperty("hooks");
  });

  it("the snapshot lands in the same directory as settings.json", () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] },
    });
    const r = gateDisable({ settingsPath, matcher: "Bash" });
    if (r.mode !== "remove") throw new Error("expected remove");
    expect(path.dirname(r.snapshotPath)).toBe(tmp);
    expect(listSnapshots(tmp)).toContain(r.snapshotPath);
  });
});

describe("gateDisable — refuses to operate on malformed settings", () => {
  it("throws on unreadable JSON", () => {
    fs.writeFileSync(settingsPath, "{ this is not json");
    expect(() => gateDisable({ settingsPath, matcher: "Bash" })).toThrow(
      /not valid JSON/,
    );
  });

  it("throws when settings.json is a JSON array (not an object)", () => {
    fs.writeFileSync(settingsPath, "[]");
    expect(() => gateDisable({ settingsPath, matcher: "Bash" })).toThrow(
      /not a JSON object/,
    );
  });

  it("throws when hooks is not an object", () => {
    writeSettings({ hooks: ["bad"] as unknown as Record<string, unknown[]> });
    expect(() => gateDisable({ settingsPath })).toThrow(/`hooks` field is not an object/);
  });

  it("throws when hooks[event] is not an array", () => {
    writeSettings({ hooks: { PreToolUse: "not-an-array" } as unknown as Record<string, unknown[]> });
    expect(() => gateDisable({ settingsPath })).toThrow(/is not an array/);
  });

  it("throws when settings.json is missing", () => {
    // Don't create the file at all.
    expect(() => gateDisable({ settingsPath, matcher: "Bash" })).toThrow(
      /settings file not found/,
    );
  });
});

describe("gateDisable: one live snapshot per settings file", () => {
  const T1 = new Date("2026-01-01T00:00:01.000Z");
  const T2 = new Date("2026-01-01T00:00:02.000Z");
  const T3 = new Date("2026-01-01T00:00:03.000Z");

  function threeGroups(): string {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
          { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
          { matcher: "Task", hooks: [{ command: "task-hook" }] },
        ],
      },
    });
    return fs.readFileSync(settingsPath, "utf8");
  }

  it("merges a second disable into the live snapshot instead of writing a second one", () => {
    const original = threeGroups();
    const first = gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    const second = gateDisable({ settingsPath, matcher: "Task", now: T2 });
    if (first.mode !== "remove" || second.mode !== "remove") throw new Error("expected remove");
    expect(first.merged).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.snapshotPath).toBe(first.snapshotPath);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);

    const read = readSnapshot(second.snapshotPath);
    if (!read.ok) throw new Error(read.reason);
    const snap = read.snapshot;
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    // The original pre-disable state and audit trail stay; the post-disable sha moves to the latest state.
    expect(snap.createdAt).toBe(T1.toISOString());
    expect(snap.settingsBeforeSha256).toBe(sha256Hex(original));
    expect(snap.settingsAfterSha256).toBe(sha256Hex(fs.readFileSync(settingsPath, "utf8")));
    expect(snap.settingsBackupPath).toBe(first.backupPath);
    expect(snap.filter.matcher).toBe("Write|Edit");
    expect(snap.removed.map((r) => [r.step, r.index, (r.group as { matcher: string }).matcher])).toEqual([
      [0, 0, "Write|Edit"],
      [1, 1, "Task"],
    ]);
    expect(snap.merges).toEqual([
      { step: 1, createdAt: T2.toISOString(), matcher: "Task", settingsBackupPath: second.backupPath },
    ]);
    // Each call still backs up the file as it was before that call.
    expect(fs.readFileSync(second.backupPath, "utf8")).toContain("Bash");
    expect(fs.readFileSync(second.backupPath, "utf8")).not.toContain("Write|Edit");
  });

  it("numbers a third disable after the second", () => {
    threeGroups();
    gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    gateDisable({ settingsPath, matcher: "Task", now: T2 });
    const third = gateDisable({ settingsPath, matcher: "Bash", now: T3 });
    if (third.mode !== "remove") throw new Error("expected remove");
    const read = readSnapshot(third.snapshotPath);
    if (!read.ok) throw new Error(read.reason);
    expect(read.snapshot.removed.map((r) => r.step)).toEqual([0, 1, 2]);
    expect(read.snapshot.merges?.map((m) => m.step)).toEqual([1, 2]);
  });

  it("upgrades a live version 1 snapshot when it merges into it", () => {
    threeGroups();
    const first = gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    if (first.mode !== "remove") throw new Error("expected remove");
    downgradeToVersion1(first.snapshotPath);
    const second = gateDisable({ settingsPath, matcher: "Task", now: T2 });
    if (second.mode !== "remove") throw new Error("expected remove");
    expect(second.merged).toBe(true);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    const read = readSnapshot(second.snapshotPath);
    if (!read.ok) throw new Error(read.reason);
    expect(read.snapshot.version).toBe(SNAPSHOT_VERSION);
    // The version 1 entry had no step: it counts as step 0, so the merged one is step 1.
    expect(read.snapshot.removed.map((r) => r.step)).toEqual([undefined, 1]);
  });

  it("retires a live snapshot the file already matches the pre-disable state of, and starts a new one", () => {
    threeGroups();
    const first = gateDisable({ settingsPath, matcher: "Write|Edit", now: T1 });
    if (first.mode !== "remove") throw new Error("expected remove");
    // The operator put the file back by hand from the backup.
    fs.copyFileSync(first.backupPath, settingsPath);
    const second = gateDisable({ settingsPath, matcher: "Task", now: T2 });
    if (second.mode !== "remove") throw new Error("expected remove");
    expect(second.merged).toBe(false);
    expect(second.snapshotPath).not.toBe(first.snapshotPath);
    expect(retiredSnapshotNames(settingsPath)).toEqual([
      path.basename(first.snapshotPath).replace(/\.json$/, ".restored.json"),
    ]);
    expect(liveSnapshotNames(settingsPath)).toEqual([path.basename(second.snapshotPath)]);
    const read = readSnapshot(second.snapshotPath);
    if (!read.ok) throw new Error(read.reason);
    expect(read.snapshot.removed).toHaveLength(1);
  });

  it("refuses, without writing anything, when a live snapshot cannot be read", () => {
    threeGroups();
    const bad = path.join(tmp, "harness.gate-disable.2026-01-01T00-00-00.000Z.json");
    fs.writeFileSync(bad, "{ broken");
    const before = fs.readFileSync(settingsPath, "utf8");
    expect(() => gateDisable({ settingsPath, matcher: "Task", now: T1 })).toThrow(GateDisableError);
    expect(() => gateDisable({ settingsPath, matcher: "Task", now: T1 })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(fs.readdirSync(tmp).filter((n) => n.includes(".bak."))).toEqual([]);
  });

  it("does not merge into a snapshot taken for another settings file in the same directory", () => {
    threeGroups();
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, null, 2)}\n`);
    const o = gateDisable({ settingsPath: other, matcher: "Bash", now: T1 });
    const mine = gateDisable({ settingsPath, matcher: "Task", now: T2 });
    if (o.mode !== "remove" || mine.mode !== "remove") throw new Error("expected remove");
    expect(mine.merged).toBe(false);
    expect(mine.snapshotPath).not.toBe(o.snapshotPath);
  });
});
