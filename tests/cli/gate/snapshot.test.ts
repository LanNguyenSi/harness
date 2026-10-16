// Unit tests for the gate-disable snapshot file format and its two I/O
// helpers (task e345db80). `gate disable`/`gate enable` integration tests
// only ever walk the happy path (a real snapshot written by disable and
// read back by enable); every malformed-input rejection in this module (
// unreadable file, non-JSON, wrong version, missing required fields, and
// the listSnapshots filter/`stat` skips) was uncovered. These are the
// guards that decide WHICH snapshot `gate enable` restores and when it
// refuses, so each rejection is asserted with its reason here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listLiveSnapshots,
  listSnapshots,
  readSnapshot,
  retireSnapshot,
  retiredSnapshotPath,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_BASENAME_SUFFIX,
  SNAPSHOT_VERSION,
  snapshotPath,
  type GateDisableSnapshot,
} from "../../../src/cli/gate/snapshot.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-snapshot-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function validSnapshot(overrides: Partial<GateDisableSnapshot> = {}): GateDisableSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    createdAt: "2026-08-01T10:00:00.000Z",
    settingsPath: path.join(tmp, "settings.json"),
    settingsBackupPath: path.join(tmp, "settings.json.bak"),
    settingsBeforeSha256: "a".repeat(64),
    settingsAfterSha256: "b".repeat(64),
    filter: { event: "PreToolUse" },
    removed: [{ event: "PreToolUse", index: 0, group: { hooks: [{ command: "x" }] } }],
    ...overrides,
  };
}

function writeSnapshot(name: string, contents: string): string {
  const full = path.join(tmp, name);
  fs.writeFileSync(full, contents, "utf8");
  return full;
}

describe("readSnapshot: rejection reasons", () => {
  it("rejects a file that cannot be read, naming the path and cause", () => {
    const missing = path.join(tmp, "harness.gate-disable.gone.json");
    const r = readSnapshot(missing);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(`cannot read snapshot ${missing}`);
  });

  it("rejects a snapshot file that is not valid JSON", () => {
    const file = writeSnapshot("harness.gate-disable.bad.json", "{nope");
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("is not valid JSON");
  });

  it("rejects a JSON array (not an object)", () => {
    const file = writeSnapshot("harness.gate-disable.arr.json", "[1,2,3]");
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("is not a JSON object");
  });

  it("rejects an unsupported version, quoting found and expected", () => {
    const file = writeSnapshot(
      "harness.gate-disable.v2.json",
      JSON.stringify({ ...validSnapshot(), version: 3 }),
    );
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("unsupported version 3; expected 1 or 2");
  });

  it("still reads a version 1 snapshot (written before merging existed)", () => {
    const file = writeSnapshot(
      "harness.gate-disable.v1.json",
      JSON.stringify({ ...validSnapshot(), version: 1 }),
    );
    const r = readSnapshot(file);
    expect(r.ok).toBe(true);
  });

  it("rejects a snapshot missing a required string field, naming it", () => {
    const snap = { ...validSnapshot() } as Record<string, unknown>;
    delete snap["settingsBeforeSha256"];
    const file = writeSnapshot("harness.gate-disable.fields.json", JSON.stringify(snap));
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('missing string field "settingsBeforeSha256"');
  });

  it("rejects a snapshot without an object filter field", () => {
    const snap = { ...validSnapshot() } as Record<string, unknown>;
    delete snap["filter"];
    const file = writeSnapshot("harness.gate-disable.filter.json", JSON.stringify(snap));
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('missing object field "filter"');
  });

  it("rejects a snapshot without an array removed field", () => {
    const file = writeSnapshot(
      "harness.gate-disable.removed.json",
      JSON.stringify({ ...validSnapshot(), removed: "not-an-array" }),
    );
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('missing array field "removed"');
  });

  it("accepts a well-formed snapshot and returns it verbatim", () => {
    const snap = validSnapshot();
    const file = writeSnapshot("harness.gate-disable.ok.json", JSON.stringify(snap));
    const r = readSnapshot(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot).toEqual(snap);
  });
});

describe("listSnapshots: candidate filtering and ordering", () => {
  function touch(name: string, mtimeMs: number): string {
    const full = path.join(tmp, name);
    fs.writeFileSync(full, JSON.stringify(validSnapshot()), "utf8");
    fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
    return full;
  }

  it("returns [] for a directory that does not exist", () => {
    expect(listSnapshots(path.join(tmp, "missing-dir"))).toEqual([]);
  });

  it("returns [] when the path is a file, not a directory", () => {
    const file = writeSnapshot("plain.json", "{}");
    expect(listSnapshots(file)).toEqual([]);
  });

  it("skips prefix-matching names without the .json suffix", () => {
    const dir = path.join(tmp, "settings.d");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z.txt`), "{}");
    expect(listSnapshots(dir)).toEqual([]);
  });

  it("skips subdirectories that carry a snapshot-shaped name", () => {
    const dir = path.join(tmp, "settings.d");
    fs.mkdirSync(path.join(dir, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`), { recursive: true });
    expect(listSnapshots(dir)).toEqual([]);
  });

  it("skips a snapshot-shaped entry whose stat fails (dangling symlink)", () => {
    const dir = path.join(tmp, "settings.d");
    fs.mkdirSync(dir);
    const good = path.join(dir, `${SNAPSHOT_BASENAME_PREFIX}2026-08-02T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`);
    fs.writeFileSync(good, JSON.stringify(validSnapshot()));
    fs.symlinkSync(path.join(dir, "does-not-exist-target"), path.join(dir, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`));
    expect(listSnapshots(dir)).toEqual([good]);
  });

  it("orders newest-first by mtime", () => {
    const older = touch(`${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`, 1_000_000);
    const newer = touch(`${SNAPSHOT_BASENAME_PREFIX}2026-08-02T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`, 2_000_000);
    expect(listSnapshots(tmp)).toEqual([newer, older]);
  });

  it("snapshotPath embeds the colon-free ISO stamp beside the settings dir", () => {
    const p = snapshotPath("/home/op/.claude/settings.json", new Date("2026-08-01T10:11:12.013Z"));
    expect(p).toBe(
      path.join("/home/op/.claude", "harness.gate-disable.2026-08-01T10-11-12.013Z.json"),
    );
    expect(p).not.toContain(":");
  });
});

describe("retireSnapshot / listLiveSnapshots", () => {
  const settings = () => path.join(tmp, "settings.json");
  function put(stamp: string, overrides: Partial<GateDisableSnapshot> = {}, mtimeMs?: number): string {
    const full = path.join(tmp, `${SNAPSHOT_BASENAME_PREFIX}${stamp}${SNAPSHOT_BASENAME_SUFFIX}`);
    fs.writeFileSync(full, JSON.stringify(validSnapshot({ createdAt: stamp, ...overrides })), "utf8");
    if (mtimeMs !== undefined) fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
    return full;
  }

  it("retiredSnapshotPath swaps the .json suffix for .restored.json", () => {
    expect(retiredSnapshotPath("/d/harness.gate-disable.X.json")).toBe("/d/harness.gate-disable.X.restored.json");
  });

  it("retireSnapshot renames the file, keeps the content and returns the new path", () => {
    const live = put("2026-08-01T10:00:00.000Z");
    const before = fs.readFileSync(live, "utf8");
    const retired = retireSnapshot(live);
    expect(retired).toBe(retiredSnapshotPath(live));
    expect(fs.existsSync(live)).toBe(false);
    expect(fs.readFileSync(retired, "utf8")).toBe(before);
  });

  it("lists live snapshots newest first by createdAt, ignoring mtime and retired files", () => {
    const older = put("2026-08-01T10:00:00.000Z", {}, 9_000_000);
    const newer = put("2026-08-02T10:00:00.000Z", {}, 1_000_000);
    retireSnapshot(put("2026-08-03T10:00:00.000Z"));
    const r = listLiveSnapshots(settings());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.live.map((l) => l.path)).toEqual([newer, older]);
  });

  it("skips a snapshot taken for another settings file in the same directory", () => {
    const mine = put("2026-08-01T10:00:00.000Z");
    put("2026-08-02T10:00:00.000Z", { settingsPath: path.join(tmp, "settings.local.json") });
    const r = listLiveSnapshots(settings());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.live.map((l) => l.path)).toEqual([mine]);
  });

  it("reports an unreadable live snapshot instead of leaving it out", () => {
    put("2026-08-01T10:00:00.000Z");
    const bad = path.join(tmp, `${SNAPSHOT_BASENAME_PREFIX}2026-08-02T10:00:00.000Z${SNAPSHOT_BASENAME_SUFFIX}`);
    fs.writeFileSync(bad, "{ not json");
    const r = listLiveSnapshots(settings());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("is not valid JSON");
    expect(r.reason).toContain(bad);
  });

  it("breaks a createdAt tie by path, newest name first", () => {
    const a = put("2026-08-01T10:00:00.000Z");
    const b = path.join(tmp, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10:00:00.000Z0${SNAPSHOT_BASENAME_SUFFIX}`);
    fs.writeFileSync(b, JSON.stringify(validSnapshot({ createdAt: "2026-08-01T10:00:00.000Z" })));
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live.map((l) => l.path)).toEqual([b, a]);
  });
});
