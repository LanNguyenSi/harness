import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateDisable, GateDisableError } from "../../../src/cli/gate/disable.js";
import {
  listSnapshots,
  readSnapshot,
  SNAPSHOT_VERSION,
} from "../../../src/cli/gate/snapshot.js";

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
