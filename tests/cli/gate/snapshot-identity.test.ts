// The parts of the snapshot ownership rule that depend on what `lstat`
// reports for another spelling of the settings file's name. No single
// machine exercises them all on a real filesystem: one that folds case (APFS
// by default) cannot hold a symlink named `Settings.json` beside
// `settings.json`, and one that does not fold never resolves the two
// spellings to one file. Here the test answers `lstatSync` for the recorded
// spelling with what each kind of filesystem would report, and the real file
// is used for everything else, so every branch runs on every machine.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** What `lstatSync` answers for a path, or null to ask the real filesystem. */
  answer: null as null | ((p: string) => fs.BigIntStats | null),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realLstat = actual.lstatSync as (p: fs.PathLike, o?: unknown) => fs.Stats | fs.BigIntStats;
  const lstatSync = (p: fs.PathLike, opts?: unknown): fs.Stats | fs.BigIntStats => {
    const faked = typeof p === "string" ? fake.answer?.(p) : null;
    return faked ?? realLstat(p, opts);
  };
  const withDefault = actual as unknown as { default?: Record<string, unknown> };
  return { ...actual, lstatSync, default: { ...(withDefault.default ?? {}), lstatSync } };
});

import {
  listLiveSnapshots,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_BASENAME_SUFFIX,
  SNAPSHOT_VERSION,
} from "../../../src/cli/gate/snapshot.js";

let tmp: string;
let settingsPath: string;
/** The recorded spelling: the same name as `settings.json` up to letter case. */
let variantPath: string;
let snapshotFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gate-identity-"));
  settingsPath = path.join(tmp, "settings.json");
  variantPath = path.join(tmp, "Settings.json");
  fs.writeFileSync(settingsPath, "{}\n");
  snapshotFile = path.join(tmp, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`);
  fs.writeFileSync(
    snapshotFile,
    JSON.stringify({
      version: SNAPSHOT_VERSION,
      createdAt: "2026-08-01T10:00:00.000Z",
      settingsPath: variantPath,
      settingsBackupPath: `${variantPath}.bak.2026-08-01T10-00-00.000Z`,
      settingsBeforeSha256: "a".repeat(64),
      settingsAfterSha256: "b".repeat(64),
      filter: { matcher: "Bash" },
      removed: [{ event: "PreToolUse", index: 0, step: 0, group: { matcher: "Bash", hooks: [{ command: "x" }] } }],
    }),
  );
});

afterEach(() => {
  fake.answer = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The real file's stats with some fields replaced: what `lstat` of the variant spelling would report. */
function variantStats(over: Partial<Record<"dev" | "ino" | "nlink", bigint>> & { symlink?: boolean }): fs.BigIntStats {
  const real = fs.lstatSync(settingsPath, { bigint: true });
  const s = Object.create(Object.getPrototypeOf(real) as object) as fs.BigIntStats;
  Object.assign(s, real);
  if (over.dev !== undefined) s.dev = over.dev;
  if (over.ino !== undefined) s.ino = over.ino;
  if (over.nlink !== undefined) s.nlink = over.nlink;
  if (over.symlink) {
    s.isFile = () => false;
    s.isSymbolicLink = () => true;
  }
  return s;
}

function answerVariantWith(stats: fs.BigIntStats): void {
  fake.answer = (p) => (p === variantPath ? stats : null);
}

function enoent(): never {
  const err = new Error(`ENOENT: no such file or directory, lstat '${variantPath}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
}

function ownership(): { live: string[]; foreign: string[] } {
  const r = listLiveSnapshots(settingsPath);
  if (!r.ok) throw new Error(r.reason);
  return { live: r.live.map((l) => l.path), foreign: r.skippedForeign.map((f) => f.path) };
}

describe("snapshot ownership by another spelling of the name", () => {
  it("is the file's when the spelling resolves to the same regular file with no second name (a case-folding filesystem)", () => {
    answerVariantWith(variantStats({ nlink: 1n }));
    expect(ownership()).toEqual({ live: [snapshotFile], foreign: [] });
  });

  it("is foreign when the spelling is a symlink, even one that points at the file", () => {
    answerVariantWith(variantStats({ nlink: 1n, symlink: true }));
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
  });

  it("is foreign when the inode has a second name (a hard link elsewhere), since the spelling cannot be told to be this entry", () => {
    answerVariantWith(variantStats({ nlink: 2n }));
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
    // The same when only the target's own stat shows the second name.
    fs.linkSync(settingsPath, path.join(tmp, "alias.json"));
    answerVariantWith(variantStats({ nlink: 1n }));
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
  });

  it("is foreign when the target itself is a symlink, whatever the spelling resolves to", () => {
    const regular = variantStats({ nlink: 1n });
    const link = variantStats({ nlink: 1n, symlink: true });
    fake.answer = (p) => (p === variantPath ? regular : p === settingsPath ? link : null);
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
  });

  it("is foreign when the spelling is another file (a case-sensitive filesystem holding both names)", () => {
    const real = fs.lstatSync(settingsPath, { bigint: true });
    answerVariantWith(variantStats({ ino: real.ino + 1n, nlink: 1n }));
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
  });

  it("is foreign when the spelling resolves to the same inode number on another device", () => {
    const real = fs.lstatSync(settingsPath, { bigint: true });
    answerVariantWith(variantStats({ dev: real.dev + 1n, nlink: 1n }));
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
  });

  it("is foreign when nothing is at the spelling, or the target itself cannot be stat'ed", () => {
    fake.answer = (p) => (p === variantPath ? enoent() : null);
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
    fake.answer = (p) => (p === settingsPath ? enoent() : p === variantPath ? variantStats({ nlink: 1n }) : null);
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
  });

  it("is the file's when the spelling differs only in Unicode normalization (NFD recorded, NFC given)", () => {
    const nfc = "café.json";
    const nfd = "café.json";
    const target = path.join(tmp, nfc);
    const recorded = path.join(tmp, nfd);
    fs.writeFileSync(target, "{}\n");
    const own = path.join(tmp, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T11-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`);
    fs.writeFileSync(
      own,
      fs.readFileSync(snapshotFile, "utf8").split(JSON.stringify(variantPath)).join(JSON.stringify(recorded)),
    );
    const real = fs.lstatSync(target, { bigint: true });
    const same = Object.assign(Object.create(Object.getPrototypeOf(real) as object) as fs.BigIntStats, real, { nlink: 1n });
    fake.answer = (p) => (p === recorded || p === target ? same : null);
    const r = listLiveSnapshots(target);
    if (!r.ok) throw new Error(r.reason);
    expect(r.live.map((l) => l.path)).toEqual([own]);
  });

  it("never consults lstat for the same spelling, and never for a name that differs beyond case", () => {
    const asked: string[] = [];
    fake.answer = (p) => {
      asked.push(p);
      return null;
    };
    fs.writeFileSync(
      snapshotFile,
      fs.readFileSync(snapshotFile, "utf8").replace(JSON.stringify(variantPath), JSON.stringify(settingsPath)),
    );
    expect(ownership()).toEqual({ live: [snapshotFile], foreign: [] });
    fs.writeFileSync(
      snapshotFile,
      fs.readFileSync(snapshotFile, "utf8").replace(JSON.stringify(settingsPath), JSON.stringify(path.join(tmp, "alias.json"))),
    );
    expect(ownership()).toEqual({ live: [], foreign: [snapshotFile] });
    expect(asked.filter((p) => p.startsWith(tmp))).toEqual([]);
  });
});
