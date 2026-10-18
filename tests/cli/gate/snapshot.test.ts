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
  changedLabel,
  claudeEnableRefusal,
  groupCommands,
  groupLabel,
  listLiveSnapshots,
  listSnapshots,
  missingLabel,
  planRestore,
  readSnapshot,
  retireSnapshot,
  retiredSnapshotPath,
  sha256Hex,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_BASENAME_SUFFIX,
  SNAPSHOT_VERSION,
  snapshotPath,
  type GateDisableSnapshot,
} from "../../../src/cli/gate/snapshot.js";
import { isCaseInsensitiveFilesystem } from "../../_helpers/case-sensitivity.js";

let tmp: string;

/** Whether the temp directory's filesystem folds the case of names (APFS and HFS+ by default). */
function tmpIsCaseInsensitive(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-snapshot-case-"));
  try {
    return isCaseInsensitiveFilesystem(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

  it("names a snapshot taken for another settings file in skippedForeign instead of dropping it silently", () => {
    put("2026-08-01T10:00:00.000Z");
    const foreign = put("2026-08-02T10:00:00.000Z", { settingsPath: path.join(tmp, "settings.local.json") });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.skippedForeign).toEqual([
      {
        path: foreign,
        settingsPath: path.join(tmp, "settings.local.json"),
        settingsExists: false,
        settingsBackupPath: path.join(tmp, "settings.json.bak"),
      },
    ]);
  });

  it("names the recorded file beside the target, whatever directory the snapshot recorded, and whether it exists", () => {
    fs.writeFileSync(path.join(tmp, "settings.local.json"), "{}\n");
    const foreign = put("2026-08-02T10:00:00.000Z", {
      settingsPath: "/elsewhere/settings.local.json",
      settingsBackupPath: "/elsewhere/settings.local.json.bak.2026-08-02T10-00-00.000Z",
    });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.skippedForeign).toEqual([
      {
        path: foreign,
        settingsPath: path.join(tmp, "settings.local.json"),
        settingsExists: true,
        settingsBackupPath: "/elsewhere/settings.local.json.bak.2026-08-02T10-00-00.000Z",
      },
    ]);
  });

  it("a snapshot recorded under another name of the same inode (a hard link) is another file's, not this one's", () => {
    fs.writeFileSync(settings(), "{}\n");
    const alias = path.join(tmp, "alias.json");
    fs.linkSync(settings(), alias);
    const theirs = put("2026-08-01T10:00:00.000Z", { settingsPath: "/old/dir/alias.json" });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live).toEqual([]);
    expect(r.skippedForeign.map((f) => [f.path, f.settingsPath, f.settingsExists])).toEqual([[theirs, alias, true]]);
    // And the other way round: the file's own snapshot is not the alias's.
    const mine = put("2026-08-02T10:00:00.000Z");
    const viaAlias = listLiveSnapshots(alias);
    if (!viaAlias.ok) throw new Error("expected ok");
    expect(viaAlias.live.map((l) => l.path)).toEqual([theirs]);
    expect(viaAlias.skippedForeign.map((f) => f.path)).toEqual([mine]);
  });

  it("a snapshot recorded under a symlink to the file is the symlink's, not the file's", () => {
    fs.writeFileSync(settings(), "{}\n");
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(settings(), link);
    const theirs = put("2026-08-01T10:00:00.000Z", { settingsPath: link });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live).toEqual([]);
    expect(r.skippedForeign.map((f) => [f.path, f.settingsPath, f.settingsExists])).toEqual([[theirs, link, true]]);
  });

  it("another spelling of the name is foreign while no file is at either name", () => {
    const theirs = put("2026-08-01T10:00:00.000Z", { settingsPath: path.join(tmp, "Settings.json") });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live).toEqual([]);
    expect(r.skippedForeign.map((f) => [f.path, f.settingsExists])).toEqual([[theirs, false]]);
  });

  it.skipIf(!tmpIsCaseInsensitive())(
    "on a case-insensitive filesystem another spelling of the one entry is the file's, unless the inode has a second name",
    () => {
      fs.writeFileSync(settings(), "{}\n");
      const mine = put("2026-08-01T10:00:00.000Z", { settingsPath: path.join(tmp, "Settings.json") });
      const own = listLiveSnapshots(settings());
      if (!own.ok) throw new Error("expected ok");
      expect(own.live.map((l) => l.path)).toEqual([mine]);
      expect(own.skippedForeign).toEqual([]);
      // A hard link elsewhere makes the inode's link count 2: the spelling can no longer be told to be this entry.
      fs.linkSync(settings(), path.join(tmp, "alias.json"));
      const linked = listLiveSnapshots(settings());
      if (!linked.ok) throw new Error("expected ok");
      expect(linked.live).toEqual([]);
      expect(linked.skippedForeign.map((f) => f.path)).toEqual([mine]);
    },
  );

  it.skipIf(tmpIsCaseInsensitive())(
    "on a case-sensitive filesystem another spelling is another entry: a second file, or a symlink, under that spelling is foreign",
    () => {
      fs.writeFileSync(settings(), "{}\n");
      const variant = path.join(tmp, "Settings.json");
      fs.writeFileSync(variant, "{}\n");
      const theirs = put("2026-08-01T10:00:00.000Z", { settingsPath: variant });
      const twoFiles = listLiveSnapshots(settings());
      if (!twoFiles.ok) throw new Error("expected ok");
      expect(twoFiles.live).toEqual([]);
      expect(twoFiles.skippedForeign.map((f) => f.path)).toEqual([theirs]);
      fs.rmSync(variant);
      fs.symlinkSync(settings(), variant);
      const viaLink = listLiveSnapshots(settings());
      if (!viaLink.ok) throw new Error("expected ok");
      expect(viaLink.live).toEqual([]);
      expect(viaLink.skippedForeign.map((f) => f.path)).toEqual([theirs]);
    },
  );

  it("does not count a snapshot recorded for another existing file in the directory", () => {
    fs.writeFileSync(settings(), "{}\n");
    fs.writeFileSync(path.join(tmp, "other.json"), "{}\n");
    const foreign = put("2026-08-01T10:00:00.000Z", { settingsPath: path.join(tmp, "other.json") });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live).toEqual([]);
    expect(r.skippedForeign.map((f) => f.path)).toEqual([foreign]);
  });

  it("falls back to the basename when the target does not exist", () => {
    const mine = put("2026-08-01T10:00:00.000Z");
    const foreign = put("2026-08-02T10:00:00.000Z", { settingsPath: path.join(tmp, "settings.local.json") });
    fs.writeFileSync(path.join(tmp, "settings.local.json"), "{}\n");
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live.map((l) => l.path)).toEqual([mine]);
    expect(r.skippedForeign.map((f) => f.path)).toEqual([foreign]);
  });

  it("tells the file by the basename of the recorded path, however the directory was spelled", () => {
    const relative = put("2026-08-01T10:00:00.000Z", { settingsPath: "settings.json" });
    const elsewhere = put("2026-08-02T10:00:00.000Z", { settingsPath: "/some/link/to/dir/settings.json" });
    const r = listLiveSnapshots(settings());
    if (!r.ok) throw new Error("expected ok");
    expect(r.live.map((l) => l.path)).toEqual([elsewhere, relative]);
    expect(r.skippedForeign).toEqual([]);
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
    expect(r.path).toBe(bad);
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

describe("planRestore", () => {
  const group = (matcher: string, command = matcher) => ({ matcher, hooks: [{ command }] });
  function snap(removed: GateDisableSnapshot["removed"]): GateDisableSnapshot {
    return validSnapshot({ removed });
  }

  it("splices the missing groups back at their recorded positions and leaves its input alone", () => {
    const current = { PreToolUse: [group("A"), group("C")] };
    const plan = planRestore(current, snap([{ event: "PreToolUse", index: 1, group: group("B") }]));
    expect(plan.hooks["PreToolUse"]?.map((g) => (g as { matcher: string }).matcher)).toEqual(["A", "B", "C"]);
    expect(plan.restored).toHaveLength(1);
    expect(plan.alreadyBack).toEqual([]);
    expect(current.PreToolUse).toHaveLength(2);
  });

  it("reports a group with the same event and matcher but other content as changed: not back, never spliced in", () => {
    const current = { PreToolUse: [group("B", "rewritten")] };
    const entry = { event: "PreToolUse", index: 0, group: group("B", "original") };
    const plan = planRestore(current, snap([entry]));
    expect(plan.restored).toEqual([]);
    expect(plan.alreadyBack).toEqual([]);
    expect(plan.changed).toEqual([{ entry, current: group("B", "rewritten") }]);
    expect(plan.hooks["PreToolUse"]).toEqual(current.PreToolUse);
  });

  it("leaves a group alone when the file holds an unchanged copy of it", () => {
    const current = { PreToolUse: [group("B", "original")] };
    const plan = planRestore(current, snap([{ event: "PreToolUse", index: 0, group: group("B", "original") }]));
    expect(plan.restored).toEqual([]);
    expect(plan.alreadyBack).toHaveLength(1);
    expect(plan.changed).toEqual([]);
    expect(plan.hooks["PreToolUse"]).toEqual(current.PreToolUse);
  });

  it("pairs unchanged copies first, so another group sharing the matcher never hides a missing one", () => {
    // Both Write|Edit groups were removed; only the operator's own came back.
    const gate = group("Write|Edit", "branch-protection");
    const own = group("Write|Edit", "my-guard");
    const plan = planRestore(
      { PreToolUse: [own] },
      snap([
        { event: "PreToolUse", index: 0, group: gate },
        { event: "PreToolUse", index: 1, group: own },
      ]),
    );
    expect(plan.alreadyBack.map((r) => r.group)).toEqual([own]);
    expect(plan.changed).toEqual([]);
    expect(plan.restored.map((r) => r.group)).toEqual([gate]);
    expect(plan.hooks["PreToolUse"]).toEqual([gate, own]);
  });

  it("takes two groups as equal whatever order their keys were written in", () => {
    const written = { hooks: [{ command: "b", type: "command" }], matcher: "B" };
    const plan = planRestore(
      { PreToolUse: [written] },
      snap([{ event: "PreToolUse", index: 0, group: { matcher: "B", hooks: [{ type: "command", command: "b" }] } }]),
    );
    expect(plan.alreadyBack).toHaveLength(1);
    expect(plan.changed).toEqual([]);
  });

  it("pairs a file group with one changed entry only", () => {
    const plan = planRestore(
      { PreToolUse: [group("B", "three")] },
      snap([
        { event: "PreToolUse", index: 0, group: group("B", "one") },
        { event: "PreToolUse", index: 1, group: group("B", "two") },
      ]),
    );
    expect(plan.changed.map((c) => c.entry.group)).toEqual([group("B", "one")]);
    expect(plan.restored.map((r) => r.group)).toEqual([group("B", "two")]);
  });

  it("pairs a group only with groups of its own event, whichever event that is", () => {
    const back = planRestore({ Stop: [group("B")] }, snap([{ event: "Stop", index: 0, group: group("B") }]));
    expect(back.alreadyBack).toHaveLength(1);
    expect(back.restored).toEqual([]);
    const elsewhere = planRestore({ PreToolUse: [group("B")] }, snap([{ event: "Stop", index: 0, group: group("B") }]));
    expect(elsewhere.alreadyBack).toEqual([]);
    expect(elsewhere.restored).toHaveLength(1);
    expect(elsewhere.hooks["Stop"]).toEqual([group("B")]);
  });

  it("does not take a group of another event for a match", () => {
    const plan = planRestore({ Stop: [group("B")] }, snap([{ event: "PreToolUse", index: 0, group: group("B") }]));
    expect(plan.restored).toHaveLength(1);
    expect(plan.hooks["PreToolUse"]).toHaveLength(1);
  });

  it("lets one file group cover one entry only", () => {
    const plan = planRestore(
      { PreToolUse: [group("B", "one")] },
      snap([
        { event: "PreToolUse", index: 0, group: group("B", "one") },
        { event: "PreToolUse", index: 1, group: group("B", "two") },
      ]),
    );
    expect(plan.restored).toHaveLength(1);
    expect(plan.alreadyBack).toHaveLength(1);
    expect(plan.hooks["PreToolUse"]).toHaveLength(2);
  });

  it("undoes the newest step first, so a later removal that shifted positions still lands in place", () => {
    // Start [A, B, C]; step 0 removed C (index 2), step 1 removed A (index 0 of [A, B]).
    const plan = planRestore(
      { PreToolUse: [group("B")] },
      snap([
        { event: "PreToolUse", index: 2, step: 0, group: group("C") },
        { event: "PreToolUse", index: 0, step: 1, group: group("A") },
      ]),
    );
    expect(plan.hooks["PreToolUse"]?.map((g) => (g as { matcher: string }).matcher)).toEqual(["A", "B", "C"]);
  });

  it("names a changed group with the commands of both versions", () => {
    const entry = { event: "PreToolUse", index: 0, group: group("Write|Edit", "branch-protection") };
    expect(changedLabel({ entry, current: group("Write|Edit", "formatter") })).toBe(
      'PreToolUse matcher="Write|Edit": the snapshot\'s group runs `branch-protection`, the file\'s group runs `formatter`',
    );
    expect(changedLabel({ entry, current: { ...group("Write|Edit", "branch-protection"), timeout: 5 } })).toContain(
      "(they differ in another field)",
    );
    expect(changedLabel({ entry, current: { matcher: "Write|Edit", hooks: [] } })).toContain("the file's group runs no command");
  });

  it("names a missing group with its commands, so two groups sharing a matcher can be told apart", () => {
    expect(missingLabel({ event: "PreToolUse", index: 1, group: group("Write|Edit", "own-guard v1") })).toBe(
      'PreToolUse matcher="Write|Edit" running `own-guard v1`',
    );
    expect(missingLabel({ event: "PreToolUse", index: 0, group: { matcher: "Bash", hooks: [{ command: "a" }, { command: "b" }] } })).toBe(
      'PreToolUse matcher="Bash" running `a`, `b`',
    );
    expect(missingLabel({ event: "Stop", index: 0, group: { hooks: [] } })).toBe("Stop matcher=null running no command");
  });

  it("lists a group's commands, none for a malformed group", () => {
    expect(groupCommands({ hooks: [{ command: "a" }, { type: "x" }, "junk", { command: "b" }] })).toEqual(["a", "b"]);
    expect(groupCommands({ hooks: "nope" })).toEqual([]);
    expect(groupCommands(["not", "an", "object"])).toEqual([]);
    expect(groupCommands(null)).toEqual([]);
  });

  it("names a group by event and matcher, null for one without", () => {
    expect(groupLabel("PreToolUse", group("Bash"))).toBe('PreToolUse matcher="Bash"');
    expect(groupLabel("Stop", { hooks: [] })).toBe("Stop matcher=null");
    expect(groupLabel("Stop", "junk")).toBe("Stop matcher=null");
  });
});

describe("claudeEnableRefusal", () => {
  const group = (matcher: string, command = matcher) => ({ matcher, hooks: [{ command }] });

  it("a file that already matches the pre-disable state never refuses, even when the plan still wants to splice a group in", () => {
    // A hand-built snapshot whose `removed` list names a group the pre-disable file
    // never held: `planRestore` reports it missing although the current file IS the
    // pre-disable file. `gate enable` cannot reach the predicate in that state (it
    // retires the snapshot on the same sha), doctor can, and the pre-disable match
    // decides first there: nothing is put back, so neither refusal holds.
    const before = { hooks: { PreToolUse: [group("A")] } };
    const beforeText = `${JSON.stringify(before, null, 2)}\n`;
    const snapshot = validSnapshot({
      settingsBeforeSha256: sha256Hex(beforeText),
      settingsAfterSha256: sha256Hex(`${JSON.stringify({ hooks: {} }, null, 2)}\n`),
      removed: [{ event: "PreToolUse", index: 1, group: group("B") }],
    });
    const plan = planRestore(before.hooks, snapshot);
    // The guard's premise: a plan that still wants to splice a group into a file that
    // already matches the pre-disable state, and a spliced file that is neither recorded
    // sha. Without the pre-disable match the call would report `edited-settings`.
    expect(plan.restored).toHaveLength(1);
    expect(plan.changed).toEqual([]);
    expect(claudeEnableRefusal(sha256Hex(beforeText), before, plan, snapshot)).toBeNull();
  });
});
