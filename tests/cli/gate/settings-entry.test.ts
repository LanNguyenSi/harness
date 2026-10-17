// The settings file a Claude gate verb reads and writes when the path it was
// given is a symlink, the snapshots that belong to it under either spelling,
// the snapshot that records no target, and the `--settings` a printed command
// carries.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listLiveSnapshots,
  readSnapshot,
  resolveSettingsEntry,
  settingsFlag,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_BASENAME_SUFFIX,
  SNAPSHOT_VERSION,
} from "../../../src/cli/gate/snapshot.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-entry-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function snapshotBody(settingsPath: unknown): string {
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    createdAt: "2026-08-01T10:00:00.000Z",
    settingsPath,
    settingsBackupPath: path.join(tmp, "settings.json.bak"),
    settingsBeforeSha256: "a".repeat(64),
    settingsAfterSha256: "b".repeat(64),
    filter: { matcher: "Bash" },
    removed: [],
  });
}

function putSnapshot(dir: string, settingsPath: unknown, stamp = "2026-08-01T10-00-00.000Z"): string {
  const file = path.join(dir, `${SNAPSHOT_BASENAME_PREFIX}${stamp}${SNAPSHOT_BASENAME_SUFFIX}`);
  fs.writeFileSync(file, snapshotBody(settingsPath));
  return file;
}

describe("resolveSettingsEntry", () => {
  it("is the path itself for a regular file and for a path with nothing at it", () => {
    const file = path.join(tmp, "settings.json");
    fs.writeFileSync(file, "{}\n");
    expect(resolveSettingsEntry(file)).toBe(file);
    expect(resolveSettingsEntry(path.join(tmp, "missing.json"))).toBe(path.join(tmp, "missing.json"));
  });

  it("is the file a symlink leads to, in whatever directory it sits, relative links included", () => {
    fs.mkdirSync(path.join(tmp, "a"));
    fs.mkdirSync(path.join(tmp, "b"));
    const real = path.join(tmp, "b", "settings.json");
    fs.writeFileSync(real, "{}\n");
    fs.symlinkSync(path.join("..", "b", "settings.json"), path.join(tmp, "a", "settings.json"));
    expect(resolveSettingsEntry(path.join(tmp, "a", "settings.json"))).toBe(real);
  });

  it("follows a link whose file is gone to where the file would be, through a chain", () => {
    fs.mkdirSync(path.join(tmp, "b"));
    const gone = path.join(tmp, "b", "settings.json");
    fs.symlinkSync(gone, path.join(tmp, "mid.json"));
    fs.symlinkSync(path.join(tmp, "mid.json"), path.join(tmp, "outer.json"));
    expect(resolveSettingsEntry(path.join(tmp, "outer.json"))).toBe(gone);
  });

  it("follows a chain of relative links whose file is gone", () => {
    fs.mkdirSync(path.join(tmp, "x"));
    fs.mkdirSync(path.join(tmp, "y"));
    fs.symlinkSync(path.join("..", "y", "mid.json"), path.join(tmp, "x", "first.json"));
    fs.symlinkSync("gone.json", path.join(tmp, "y", "mid.json"));
    expect(resolveSettingsEntry(path.join(tmp, "x", "first.json"))).toBe(path.join(tmp, "y", "gone.json"));
  });

  it("resolves a directory link on the way as well as the final link", () => {
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, "viaDir"));
    fs.writeFileSync(path.join(real, "y.json"), "{}\n");
    fs.symlinkSync("y.json", path.join(real, "x.json"));
    expect(resolveSettingsEntry(path.join(tmp, "viaDir", "x.json"))).toBe(path.join(real, "y.json"));
  });

  it("follows a dangling relative link written with .. from a link reached through a directory symlink to where the kernel leads", () => {
    const dot = path.join(tmp, "dot");
    fs.mkdirSync(path.join(dot, "real"), { recursive: true });
    fs.mkdirSync(path.join(dot, "x"));
    fs.mkdirSync(path.join(tmp, "home"));
    fs.symlinkSync(path.join(dot, "real"), path.join(tmp, "home", "via"));
    fs.symlinkSync(path.join("..", "x", "settings.json"), path.join(dot, "real", "settings.json"));
    // Read from home/via, `..` would be home; from dot/real, where the link is, it is dot.
    expect(resolveSettingsEntry(path.join(tmp, "home", "via", "settings.json"))).toBe(path.join(dot, "x", "settings.json"));
  });

  it("leaves a link loop as it was given", () => {
    const names = ["one.json", "two.json", "three.json"].map((n) => path.join(tmp, n));
    names.forEach((n, i) => fs.symlinkSync(names[(i + 1) % names.length] ?? n, n));
    expect(resolveSettingsEntry(names[0] ?? "")).toBe(names[0]);
  });
});

describe("listLiveSnapshots through a symlink", () => {
  it("finds the snapshot beside the file the link leads to and owns it by the file's name", () => {
    fs.mkdirSync(path.join(tmp, "a"));
    fs.mkdirSync(path.join(tmp, "b"));
    const real = path.join(tmp, "b", "settings.json");
    const link = path.join(tmp, "a", "settings.json");
    fs.writeFileSync(real, "{}\n");
    fs.symlinkSync(real, link);
    const snap = putSnapshot(path.join(tmp, "b"), "relative/to/nowhere/settings.json");
    const viaLink = listLiveSnapshots(link);
    if (!viaLink.ok) throw new Error(viaLink.reason);
    expect(viaLink.live.map((l) => l.path)).toEqual([snap]);
    expect(viaLink.skippedForeign).toEqual([]);
    const viaFile = listLiveSnapshots(real);
    if (!viaFile.ok) throw new Error(viaFile.reason);
    expect(viaFile.live.map((l) => l.path)).toEqual([snap]);
  });

  it("a snapshot beside the file for another name stays foreign", () => {
    fs.mkdirSync(path.join(tmp, "b"));
    const real = path.join(tmp, "b", "settings.json");
    const link = path.join(tmp, "settings.json");
    fs.writeFileSync(real, "{}\n");
    fs.symlinkSync(real, link);
    const other = putSnapshot(path.join(tmp, "b"), path.join(tmp, "b", "settings.local.json"));
    const r = listLiveSnapshots(link);
    if (!r.ok) throw new Error(r.reason);
    expect(r.live).toEqual([]);
    expect(r.skippedForeign.map((f) => f.path)).toEqual([other]);
  });

  it("lists a foreign snapshot once when both spellings of the directory name it", () => {
    // `viaDir` is the same directory as `real`, so the link and the file it leads to share it.
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, "viaDir"));
    fs.writeFileSync(path.join(real, "y.json"), "{}\n");
    fs.symlinkSync("y.json", path.join(real, "x.json"));
    putSnapshot(real, path.join(real, "z.json"));
    const r = listLiveSnapshots(path.join(tmp, "viaDir", "x.json"));
    if (!r.ok) throw new Error(r.reason);
    expect(r.live).toEqual([]);
    expect(r.skippedForeign).toHaveLength(1);
  });

  it("a snapshot of the file's name counts as the file's, not foreign, when the link sits in the same directory under another name", () => {
    fs.writeFileSync(path.join(tmp, "settings.json"), "{}\n");
    fs.symlinkSync("settings.json", path.join(tmp, "alias.json"));
    const snap = putSnapshot(tmp, path.join(tmp, "settings.json"));
    const r = listLiveSnapshots(path.join(tmp, "alias.json"));
    if (!r.ok) throw new Error(r.reason);
    expect(r.live.map((l) => l.path)).toEqual([snap]);
    expect(r.skippedForeign).toEqual([]);
  });
});

describe("a snapshot that records no target", () => {
  function read(settingsPath: unknown): ReturnType<typeof readSnapshot> {
    const file = path.join(tmp, "snap.json");
    fs.writeFileSync(file, snapshotBody(settingsPath));
    return readSnapshot(file);
  }

  for (const recorded of ["", "/", ".", "..", "some/dir/.."]) {
    it(`reads ${JSON.stringify(recorded)} as an unreadable snapshot that says so`, () => {
      const r = read(recorded);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("has no recorded target");
    });
  }

  it("reads a missing settingsPath the same way", () => {
    const file = path.join(tmp, "snap.json");
    const body = JSON.parse(snapshotBody("x")) as Record<string, unknown>;
    delete body["settingsPath"];
    fs.writeFileSync(file, JSON.stringify(body));
    const r = readSnapshot(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("has no recorded target");
  });

  it("keeps a recorded path with a file name, absolute or relative", () => {
    expect(read("/home/op/.claude/settings.json").ok).toBe(true);
    expect(read("settings.json").ok).toBe(true);
  });

  it("makes listLiveSnapshots fail naming the snapshot instead of listing it as foreign", () => {
    const file = putSnapshot(tmp, "");
    const r = listLiveSnapshots(path.join(tmp, "settings.json"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.path).toBe(file);
    expect(r.reason).toContain("has no recorded target");
  });
});

describe("settingsFlag", () => {
  it("prints a plain path as it is", () => {
    expect(settingsFlag("/home/op/.claude/settings.json")).toBe("--settings /home/op/.claude/settings.json");
    expect(settingsFlag("rel/dir-1/settings_2.json")).toBe("--settings rel/dir-1/settings_2.json");
  });

  it("single-quotes a path with a space, a quote or a shell character", () => {
    expect(settingsFlag("/tmp/my dir/settings.json")).toBe("--settings '/tmp/my dir/settings.json'");
    expect(settingsFlag("/tmp/a'b/settings.json")).toBe(`--settings '/tmp/a'\\''b/settings.json'`);
    expect(settingsFlag("/tmp/$HOME/s.json")).toBe("--settings '/tmp/$HOME/s.json'");
  });

  it("single-quotes a leading tilde and an equals sign, which a shell expands in a bare word", () => {
    expect(settingsFlag("~/x")).toBe("--settings '~/x'");
    expect(settingsFlag("=x")).toBe("--settings '=x'");
    expect(settingsFlag("/tmp/100%/s.json")).toBe("--settings '/tmp/100%/s.json'");
  });
});
