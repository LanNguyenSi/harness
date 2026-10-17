// The parts of the Codex snapshot ownership rule that depend on what `lstat`
// reports for another spelling of the config's name, and the decision rule
// the Codex and the Claude gate share. No single machine exercises them all
// on a real filesystem (one that folds case cannot hold two files that differ
// only in case; one that does not never resolves the spellings to one file).
// Here the test answers `lstatSync` for the recorded spelling with what each
// kind of filesystem would report, and the real files are used for everything
// else, so every branch runs on every machine.

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

import { latestCodexInstallBackup } from "../../../src/cli/apply/install-codex-config.js";
import { linkChain } from "../../../src/cli/gate/link-chain.js";
import {
  CODEX_SNAPSHOT_BASENAME_PREFIX,
  CODEX_SNAPSHOT_TARGET,
  CODEX_SNAPSHOT_VERSION,
  readCodexSnapshot,
  readLiveCodexSnapshots,
} from "../../../src/cli/gate/codex-snapshot.js";
import {
  listLiveSnapshots,
  namesSameEntry,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_BASENAME_SUFFIX,
  SNAPSHOT_VERSION,
} from "../../../src/cli/gate/snapshot.js";

let tmp: string;
let configPath: string;
let settingsPath: string;
/** The recorded spellings: the same names as `config.toml` and `settings.json` up to letter case. */
let configVariant: string;
let settingsVariant: string;
let codexSnapshot: string;
let claudeSnapshot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-codex-identity-"));
  configPath = path.join(tmp, "config.toml");
  settingsPath = path.join(tmp, "settings.json");
  configVariant = path.join(tmp, "Config.toml");
  settingsVariant = path.join(tmp, "Settings.json");
  fs.writeFileSync(configPath, "x = 1\n");
  fs.writeFileSync(settingsPath, "{}\n");
  codexSnapshot = path.join(tmp, `${CODEX_SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`);
  fs.writeFileSync(
    codexSnapshot,
    JSON.stringify({
      version: CODEX_SNAPSHOT_VERSION,
      target: CODEX_SNAPSHOT_TARGET,
      createdAt: "2026-08-01T10:00:00.000Z",
      configPath: configVariant,
      configBackupPath: `${configVariant}.bak.2026-08-01T10-00-00.000Z`,
      configBeforeSha256: "a".repeat(64),
      configAfterSha256: "b".repeat(64),
      filter: { matcher: "Bash" },
      neutralised: [{ event: "PreToolUse", eventIndex: 0, ordinal: 0, id: "u", matcher: "Bash", hooksText: "hooks = [1]" }],
    }),
  );
  claudeSnapshot = path.join(tmp, `${SNAPSHOT_BASENAME_PREFIX}2026-08-01T10-00-00.000Z${SNAPSHOT_BASENAME_SUFFIX}`);
  fs.writeFileSync(
    claudeSnapshot,
    JSON.stringify({
      version: SNAPSHOT_VERSION,
      createdAt: "2026-08-01T10:00:00.000Z",
      settingsPath: settingsVariant,
      settingsBackupPath: `${settingsVariant}.bak.2026-08-01T10-00-00.000Z`,
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

type Over = Partial<Record<"dev" | "ino" | "nlink", bigint>> & { symlink?: boolean };

/** The real file's stats with some fields replaced: what `lstat` of a variant spelling would report. */
function statsLike(real: string, over: Over): fs.BigIntStats {
  const base = fs.lstatSync(real, { bigint: true });
  const s = Object.create(Object.getPrototypeOf(base) as object) as fs.BigIntStats;
  Object.assign(s, base);
  if (over.dev !== undefined) s.dev = over.dev;
  if (over.ino !== undefined) s.ino = over.ino;
  if (over.nlink !== undefined) s.nlink = over.nlink;
  if (over.symlink) {
    s.isFile = () => false;
    s.isSymbolicLink = () => true;
  }
  return s;
}

/** Answers `lstat` of both variant spellings as `over` describes (relative to the real file's own stats). */
function answerVariantsWith(over: (real: bigint) => Over): void {
  const cfg = fs.lstatSync(configPath, { bigint: true });
  const set = fs.lstatSync(settingsPath, { bigint: true });
  fake.answer = (p) =>
    p === configVariant
      ? statsLike(configPath, over(cfg.ino))
      : p === settingsVariant
        ? statsLike(settingsPath, over(set.ino))
        : null;
}

function codexOwnership(): { own: string[]; foreign: string[] } {
  const r = readLiveCodexSnapshots(configPath, (m) => new Error(m));
  return { own: r.own.map((l) => l.path), foreign: r.foreign.map((f) => f.path) };
}

function claudeOwnership(): { own: string[]; foreign: string[] } {
  const r = listLiveSnapshots(settingsPath);
  if (!r.ok) throw new Error(r.reason);
  return { own: r.live.map((l) => l.path), foreign: r.skippedForeign.map((f) => f.path) };
}

describe("Codex snapshot ownership by another spelling of the name", () => {
  const cases: Array<[string, (real: bigint) => Over, "own" | "foreign"]> = [
    ["is the config's when the spelling resolves to the same regular file with no second name", () => ({ nlink: 1n }), "own"],
    ["is foreign when the inode has a second name (a hard link elsewhere)", () => ({ nlink: 2n }), "foreign"],
    ["is foreign when the spelling is another file (a case-sensitive filesystem holding both names)", (r) => ({ ino: r + 1n, nlink: 1n }), "foreign"],
    ["is foreign when the spelling is the same inode number on another device", () => ({ dev: 0xdeadbeefn, nlink: 1n }), "foreign"],
    ["is foreign when the spelling is a symlink and the config is a regular file", () => ({ nlink: 1n, symlink: true }), "foreign"],
  ];

  for (const [title, over, want] of cases) {
    it(`${title}, and the Claude gate decides the same way`, () => {
      answerVariantsWith(over);
      const codex = codexOwnership();
      expect(codex).toEqual(want === "own" ? { own: [codexSnapshot], foreign: [] } : { own: [], foreign: [codexSnapshot] });
      const claude = claudeOwnership();
      expect(claude).toEqual(want === "own" ? { own: [claudeSnapshot], foreign: [] } : { own: [], foreign: [claudeSnapshot] });
    });
  }

  it("is foreign when nothing is at the spelling", () => {
    fake.answer = (p) => {
      if (p !== configVariant) return null;
      const err = new Error(`ENOENT: no such file or directory, lstat '${p}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    expect(codexOwnership()).toEqual({ own: [], foreign: [codexSnapshot] });
  });

  it("is the config's for a symlinked config named by another spelling when both are the one link entry (Codex edits a link at its target)", () => {
    // The requested path is a symlink: both spellings lstat as the same symlink inode with one name.
    const real = path.join(tmp, "dotfiles.toml");
    fs.writeFileSync(real, "x = 1\n");
    fs.rmSync(configPath);
    fs.symlinkSync(real, configPath);
    fake.answer = (p) => (p === configVariant ? statsLike(configPath, { nlink: 1n }) : null);
    expect(codexOwnership()).toEqual({ own: [codexSnapshot], foreign: [] });
  });

  it("names the config a foreign snapshot was taken for under the snapshot's directory, and whether a file is there", () => {
    answerVariantsWith(() => ({ nlink: 2n }));
    const r = readLiveCodexSnapshots(configPath, (m) => new Error(m));
    expect(r.foreign).toEqual([
      {
        path: codexSnapshot,
        configPath: configVariant,
        configExists: true,
        configBackupPath: `${configVariant}.bak.2026-08-01T10-00-00.000Z`,
      },
    ]);
    fake.answer = (p) => {
      if (p !== configVariant) return null;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(readLiveCodexSnapshots(configPath, (m) => new Error(m)).foreign[0]?.configExists).toBe(false);
  });
});

describe("readCodexSnapshot: the recorded config must name a file", () => {
  it("accepts a snapshot that records a file name and refuses one that records an empty path, `.`, `..` or `/`", () => {
    expect(readCodexSnapshot(codexSnapshot).ok).toBe(true);
    const body = JSON.parse(fs.readFileSync(codexSnapshot, "utf8")) as Record<string, unknown>;
    for (const recorded of ["", ".", "..", "/", "/.."]) {
      const file = path.join(tmp, "named-nothing.json");
      fs.writeFileSync(file, JSON.stringify({ ...body, configPath: recorded }));
      const r = readCodexSnapshot(file);
      expect(r).toEqual({ ok: false, reason: `snapshot ${file} has a "configPath" that names no file` });
    }
  });
});

describe("readCodexSnapshot: object shapes", () => {
  it("refuses a snapshot whose body is not a JSON object, and one whose neutralised entry or merge is an array", () => {
    const body = JSON.parse(fs.readFileSync(codexSnapshot, "utf8")) as Record<string, unknown>;
    const file = path.join(tmp, "shapes.json");
    fs.writeFileSync(file, JSON.stringify([body]));
    expect(readCodexSnapshot(file)).toEqual({ ok: false, reason: `snapshot ${file} is not a JSON object` });
    fs.writeFileSync(file, JSON.stringify({ ...body, neutralised: [[]] }));
    expect(readCodexSnapshot(file)).toEqual({ ok: false, reason: `snapshot ${file} has a malformed "neutralised" list` });
    fs.writeFileSync(file, JSON.stringify({ ...body, merges: [[]] }));
    expect(readCodexSnapshot(file)).toEqual({ ok: false, reason: `snapshot ${file} has a malformed "merges" list` });
  });
});

describe("namesSameEntry symlinks option", () => {
  it("accepts two spellings of one symlink entry only when asked, and never a second name or another inode", () => {
    const link = path.join(tmp, "link.toml");
    fs.symlinkSync(configPath, link);
    const variant = path.join(tmp, "Link.toml");
    const real = fs.lstatSync(link, { bigint: true });
    const same = (over: Over = {}): fs.BigIntStats => statsLike(link, { nlink: 1n, ...over });
    fake.answer = (p) => (p === variant ? same() : null);
    expect(namesSameEntry(tmp, "Link.toml", "link.toml")).toBe(false);
    expect(namesSameEntry(tmp, "Link.toml", "link.toml", { symlinks: true })).toBe(true);
    fake.answer = (p) => (p === variant ? same({ nlink: 2n }) : null);
    expect(namesSameEntry(tmp, "Link.toml", "link.toml", { symlinks: true })).toBe(false);
    fake.answer = (p) => (p === variant ? same({ ino: real.ino + 1n }) : null);
    expect(namesSameEntry(tmp, "Link.toml", "link.toml", { symlinks: true })).toBe(false);
    // Spellings that are not one name up to case and normalization are never one entry.
    expect(namesSameEntry(tmp, "other.toml", "link.toml", { symlinks: true })).toBe(false);
    expect(namesSameEntry(tmp, "link.toml", "link.toml")).toBe(true);
  });
});

describe("the installer's backup dating by another spelling of the name", () => {
  const stamp = "2026-10-02T02-00-00-000Z";
  const at = Date.parse("2026-10-02T02:00:00.000Z");

  it("counts a backup spelled in another letter case when both spellings are one entry, and none otherwise", () => {
    const backup = path.join(tmp, `Config.toml.harness-backup-${stamp}`);
    fs.writeFileSync(backup, "");
    // Nothing at the spelling (a filesystem that keeps the cases apart, with no such file).
    fake.answer = (p) => {
      if (p !== configVariant) return null;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(latestCodexInstallBackup(configPath)).toBeNull();
    answerVariantsWith(() => ({ nlink: 1n }));
    expect(latestCodexInstallBackup(configPath)).toEqual({ ms: at, path: backup });
    answerVariantsWith(() => ({ nlink: 2n }));
    expect(latestCodexInstallBackup(configPath)).toBeNull();
    answerVariantsWith((r) => ({ ino: r + 1n, nlink: 1n }));
    expect(latestCodexInstallBackup(configPath)).toBeNull();
  });

  it("keeps matching the exact spelling, and skips another file's backups and names with no stamp", () => {
    fs.writeFileSync(path.join(tmp, "other.toml.harness-backup-2026-12-01T00-00-00-000Z"), "");
    fs.writeFileSync(`${configPath}.harness-backup-not-a-time`, "");
    fs.writeFileSync(`${configPath}.harness-backup-${stamp}`, "");
    fs.writeFileSync(path.join(tmp, "config.toml.harness-backup-2026-09-01T00-00-00-000Z"), "");
    expect(latestCodexInstallBackup(configPath)).toEqual({ ms: at, path: `${configPath}.harness-backup-${stamp}` });
  });
});

describe("linkChain on a Codex config path", () => {
  it("is just the path for a regular file or a path that does not exist", () => {
    expect(linkChain(configPath)).toEqual([configPath]);
    expect(linkChain(path.join(tmp, "absent.toml"))).toEqual([path.join(tmp, "absent.toml")]);
  });

  it("lists every hop to the target, resolving a relative link text against the physical directory of the link holding it", () => {
    const dirA = path.join(tmp, "a");
    const dirB = path.join(tmp, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const l1 = path.join(dirA, "config.toml");
    const l2 = path.join(dirB, "mid.toml");
    fs.symlinkSync(path.join("..", "b", "mid.toml"), l1);
    fs.symlinkSync(path.join("..", "config.toml"), l2);
    expect(linkChain(l1)).toEqual([l1, l2, configPath]);
    expect(linkChain(l2)).toEqual([l2, configPath]);
  });

  it("resolves a relative link text against the physical directory of a link that sits under a symlinked directory", () => {
    const dotfiles = path.join(tmp, "dotfiles");
    fs.mkdirSync(path.join(dotfiles, "codex"), { recursive: true });
    fs.mkdirSync(path.join(dotfiles, "shared"));
    const target = path.join(dotfiles, "shared", "config.toml");
    fs.writeFileSync(target, "x = 1\n");
    fs.symlinkSync(path.join("..", "shared", "config.toml"), path.join(dotfiles, "codex", "config.toml"));
    fs.mkdirSync(path.join(tmp, "home"));
    fs.symlinkSync(path.join(dotfiles, "codex"), path.join(tmp, "home", ".codex"));
    const requested = path.join(tmp, "home", ".codex", "config.toml");
    // `..` is taken from dotfiles/codex, where the link is, not from home/.codex, the way it was asked for.
    expect(linkChain(requested)).toEqual([requested, target]);
  });

  it("stops at a dangling link and at a loop instead of failing or spinning", () => {
    const dangling = path.join(tmp, "dangling.toml");
    fs.symlinkSync(path.join(tmp, "missing.toml"), dangling);
    expect(linkChain(dangling)).toEqual([dangling, path.join(tmp, "missing.toml")]);
    const x = path.join(tmp, "x.toml");
    const y = path.join(tmp, "y.toml");
    fs.symlinkSync(y, x);
    fs.symlinkSync(x, y);
    const chain = linkChain(x);
    expect(chain.length).toBe(41);
    expect(new Set(chain)).toEqual(new Set([x, y]));
  });
});
