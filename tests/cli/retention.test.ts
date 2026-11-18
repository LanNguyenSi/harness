// Retention for retired gate snapshots and dated backups
// (`src/cli/retention.ts`). One shared helper serves four name shapes; each
// case pins one branch: the keep count, the live-snapshot guard, the
// referenced-backup guard, the exact name match, symlinks, ties, and the
// rule that an error never escapes. Temp directories only.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_SNAPSHOT_PREFIXES,
  pruneDatedBackups,
  pruneRetiredSnapshots,
  RETENTION_KEEP,
  snapshotTargetName,
} from "../../src/cli/retention.js";
import { CODEX_SNAPSHOT_BASENAME_PREFIX } from "../../src/cli/gate/codex-snapshot.js";
import { SNAPSHOT_BASENAME_PREFIX } from "../../src/cli/gate/snapshot.js";
import { type ChildRun, distUrl, expectBounded, mkfifo, runChild } from "../_helpers/fifo-child.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-retention-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `2026-01-<day>T10-00-00.000Z` (the gate's stamp) for day 1..28. */
function gateStamp(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T10-00-00.000Z`;
}

/** The Codex installer's stamp (`.` as `-`). */
function installStamp(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T10-00-00-000Z`;
}

function touch(name: string, body = "x"): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  return full;
}

function names(): string[] {
  return fs.readdirSync(dir).sort();
}

const warnings: string[] = [];
const warn = (m: string): void => {
  warnings.push(m);
};
beforeEach(() => {
  warnings.length = 0;
});

function liveClaudeSnapshot(name: string, fields: Record<string, unknown>): void {
  touch(name, JSON.stringify({ version: 2, settingsPath: path.join(dir, "settings.json"), ...fields }));
}

describe("constants", () => {
  it("documents N as 5", () => {
    expect(RETENTION_KEEP).toBe(5);
  });

  it("scans for live snapshots under exactly the two prefixes the gates write", () => {
    expect([...LIVE_SNAPSHOT_PREFIXES]).toEqual([SNAPSHOT_BASENAME_PREFIX, CODEX_SNAPSHOT_BASENAME_PREFIX]);
  });
});

describe.each([
  ["Claude", "harness.gate-disable."],
  ["Codex", "harness.gate-disable-codex."],
])("retired %s snapshots", (_label, prefix) => {
  const retired = (day: number, why = "restored"): string => `${prefix}${gateStamp(day)}.${why}.json`;

  it("keeps the newest 5 of 6 and removes the oldest", () => {
    for (let d = 1; d <= 6; d++) touch(retired(d));
    const removed = pruneRetiredSnapshots(dir, prefix, { warn });
    expect(removed).toEqual([path.join(dir, retired(1))]);
    expect(names()).toEqual([2, 3, 4, 5, 6].map((d) => retired(d)).sort());
  });

  it("counts .restored and .superseded as one family", () => {
    touch(retired(1, "superseded"));
    touch(retired(2, "restored"));
    touch(retired(3, "superseded"));
    touch(retired(4, "restored"));
    touch(retired(5, "superseded"));
    touch(retired(6, "restored"));
    pruneRetiredSnapshots(dir, prefix, { warn });
    expect(names()).not.toContain(retired(1, "superseded"));
    expect(names()).toHaveLength(5);
  });

  it("removes nothing at 5 or fewer", () => {
    for (let d = 1; d <= 5; d++) touch(retired(d));
    expect(pruneRetiredSnapshots(dir, prefix, { warn })).toEqual([]);
    expect(names()).toHaveLength(5);
  });

  it("never removes a live snapshot, even when it is the oldest", () => {
    const live = `${prefix}${gateStamp(1)}.json`;
    touch(live);
    for (let d = 2; d <= 9; d++) touch(retired(d));
    pruneRetiredSnapshots(dir, prefix, { warn });
    expect(names()).toContain(live);
    expect(names().filter((n) => n !== live)).toHaveLength(5);
  });

  it("orders by the stamp in the name, not by mtime", () => {
    for (let d = 1; d <= 6; d++) touch(retired(d));
    // The oldest by name is the newest by mtime.
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(path.join(dir, retired(1)), future, future);
    pruneRetiredSnapshots(dir, prefix, { warn });
    expect(names()).not.toContain(retired(1));
    expect(names()).toContain(retired(2));
  });

  it("breaks a tie of equal stamps by mtime, so the older retirement goes", () => {
    for (let d = 3; d <= 6; d++) touch(retired(d));
    const a = touch(retired(2, "restored"));
    const b = touch(retired(2, "superseded"));
    fs.utimesSync(a, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(b, new Date(2_000_000), new Date(2_000_000));
    pruneRetiredSnapshots(dir, prefix, { warn });
    expect(names()).toContain(retired(2, "superseded"));
    expect(names()).not.toContain(retired(2, "restored"));
  });

  it("leaves names that do not match exactly alone", () => {
    for (let d = 1; d <= 7; d++) touch(retired(d));
    const others = [
      `${prefix}notastamp.restored.json`,
      `${prefix}${gateStamp(1)}.restored.json.bak`,
      `${prefix}${gateStamp(1)}.restored.txt`,
      `${prefix}${gateStamp(1)}.other.json`,
      `${prefix}2026-13-45T10-00-00.000Z.restored.json`,
      `x${prefix}${gateStamp(1)}.restored.json`,
      `${prefix.replace("harness", "other")}${gateStamp(1)}.restored.json`,
    ];
    for (const n of others) touch(n);
    pruneRetiredSnapshots(dir, prefix, { warn });
    for (const n of others) expect(names()).toContain(n);
    expect(names().filter((n) => !others.includes(n))).toHaveLength(5);
  });

  it("does not follow a symlink and does not count it", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-retention-out-"));
    try {
      const target = path.join(outside, "precious.json");
      fs.writeFileSync(target, "precious");
      fs.symlinkSync(target, path.join(dir, retired(1)));
      for (let d = 2; d <= 7; d++) touch(retired(d));
      pruneRetiredSnapshots(dir, prefix, { warn });
      expect(fs.lstatSync(path.join(dir, retired(1))).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("precious");
      // 6 regular files remain after removing the oldest regular one (day 2): 5 kept.
      expect(names().filter((n) => n !== retired(1))).toHaveLength(5);
      expect(names()).not.toContain(retired(2));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not remove a directory with a matching name", () => {
    fs.mkdirSync(path.join(dir, retired(1)));
    for (let d = 2; d <= 7; d++) touch(retired(d));
    pruneRetiredSnapshots(dir, prefix, { warn });
    expect(fs.statSync(path.join(dir, retired(1))).isDirectory()).toBe(true);
  });

  it("never removes an excluded path, even beyond the count", () => {
    for (let d = 1; d <= 8; d++) touch(retired(d));
    pruneRetiredSnapshots(dir, prefix, { exclude: [path.join(dir, retired(1))], warn });
    expect(names()).toContain(retired(1));
    expect(names()).toHaveLength(6);
  });

  it("honours a different keep", () => {
    for (let d = 1; d <= 6; d++) touch(retired(d));
    pruneRetiredSnapshots(dir, prefix, { keep: 2, warn });
    expect(names()).toEqual([retired(5), retired(6)]);
  });

  it("does not touch the other family's snapshots", () => {
    const otherPrefix = prefix === "harness.gate-disable." ? "harness.gate-disable-codex." : "harness.gate-disable.";
    for (let d = 1; d <= 8; d++) touch(`${otherPrefix}${gateStamp(d)}.restored.json`);
    for (let d = 1; d <= 6; d++) touch(retired(d));
    pruneRetiredSnapshots(dir, prefix, { warn });
    expect(names().filter((n) => n.startsWith(otherPrefix))).toHaveLength(8);
  });
});

describe.each([
  ["bak", "settings.json", (d: number) => `settings.json.bak.${gateStamp(d)}`],
  ["harness-backup", "config.toml", (d: number) => `config.toml.harness-backup-${installStamp(d)}`],
] as const)("dated backups (%s)", (kind, base, backupName) => {
  const file = (): string => path.join(dir, base);

  it("keeps the newest 5 of 6 and removes the oldest", () => {
    for (let d = 1; d <= 6; d++) touch(backupName(d));
    const removed = pruneDatedBackups(file(), kind, { warn });
    expect(removed).toEqual([path.join(dir, backupName(1))]);
    expect(names()).toEqual([2, 3, 4, 5, 6].map(backupName).sort());
  });

  it("removes nothing at 5 or fewer", () => {
    for (let d = 1; d <= 5; d++) touch(backupName(d));
    expect(pruneDatedBackups(file(), kind, { warn })).toEqual([]);
  });

  it("orders by the stamp in the name, not by mtime", () => {
    for (let d = 1; d <= 6; d++) touch(backupName(d));
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(path.join(dir, backupName(1)), future, future);
    pruneDatedBackups(file(), kind, { warn });
    expect(names()).not.toContain(backupName(1));
  });

  it("only touches the files of its own base name", () => {
    for (let d = 1; d <= 7; d++) touch(backupName(d));
    const sibling = backupName(1).replace(base, `other-${base}`);
    const prefixed = backupName(1).replace(base, `x${base}`);
    touch(sibling);
    touch(prefixed);
    pruneDatedBackups(file(), kind, { warn });
    expect(names()).toContain(sibling);
    expect(names()).toContain(prefixed);
  });

  it("leaves names that do not match exactly alone", () => {
    for (let d = 1; d <= 7; d++) touch(backupName(d));
    const others = [
      `${base}.bak`,
      `${base}.bak-2026-07-22`,
      `${base}.bak.uninstall.${gateStamp(1)}`,
      `${base}.bak.notastamp`,
      `${base}.bak.${gateStamp(1)}.orig`,
      `${base}.harness-backup-notastamp`,
      `${base}.pre-harness-${gateStamp(1)}`,
      `${base}.backup-20260905T000000Z`,
      // The other family's shape for the same base.
      kind === "bak" ? `${base}.harness-backup-${installStamp(1)}` : `${base}.bak.${gateStamp(1)}`,
      // The wrong stamp shape for this family.
      kind === "bak" ? `${base}.bak.${installStamp(1)}` : `${base}.harness-backup-${gateStamp(1)}`,
    ];
    for (const n of others) touch(n);
    pruneDatedBackups(file(), kind, { warn });
    for (const n of others) expect(names()).toContain(n);
    expect(names().filter((n) => !others.includes(n))).toHaveLength(5);
  });

  it("does not follow a symlink and does not count it", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-retention-out-"));
    try {
      const target = path.join(outside, "precious");
      fs.writeFileSync(target, "precious");
      fs.symlinkSync(target, path.join(dir, backupName(1)));
      for (let d = 2; d <= 7; d++) touch(backupName(d));
      pruneDatedBackups(file(), kind, { warn });
      expect(fs.lstatSync(path.join(dir, backupName(1))).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("precious");
      expect(names()).not.toContain(backupName(2));
      expect(names().filter((n) => n !== backupName(1))).toHaveLength(5);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never removes an excluded path", () => {
    for (let d = 1; d <= 8; d++) touch(backupName(d));
    pruneDatedBackups(file(), kind, { exclude: [path.join(dir, backupName(1))], warn });
    expect(names()).toContain(backupName(1));
    expect(names()).toHaveLength(6);
  });

  it("works on a symlinked file by pruning beside the link, not beside its target", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-retention-out-"));
    try {
      const real = path.join(outside, base);
      fs.writeFileSync(real, "cfg");
      fs.symlinkSync(real, file());
      for (let d = 1; d <= 7; d++) {
        touch(backupName(d));
        fs.writeFileSync(path.join(outside, backupName(d)), "other dir");
      }
      pruneDatedBackups(file(), kind, { warn });
      expect(names().filter((n) => n !== base)).toHaveLength(5);
      expect(fs.readdirSync(outside)).toHaveLength(8);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("backups a live snapshot names", () => {
    it("keeps the oldest when a live Claude snapshot names it", () => {
      for (let d = 1; d <= 8; d++) touch(backupName(d));
      liveClaudeSnapshot(`harness.gate-disable.${gateStamp(1)}.json`, {
        settingsBackupPath: path.join(dir, backupName(1)),
      });
      pruneDatedBackups(file(), kind, { warn });
      // Newest 5 (4..8) plus the referenced one; 2 and 3 are gone.
      expect(names()).toContain(backupName(1));
      expect(names()).not.toContain(backupName(2));
      expect(names()).not.toContain(backupName(3));
      expect(names().filter((n) => n.includes("backup") || n.includes(".bak."))).toHaveLength(6);
    });

    it("keeps a backup named by a merge of a live snapshot", () => {
      for (let d = 1; d <= 8; d++) touch(backupName(d));
      liveClaudeSnapshot(`harness.gate-disable.${gateStamp(9)}.json`, {
        settingsBackupPath: path.join(dir, backupName(8)),
        merges: [
          { step: 1, createdAt: "x", matcher: "m", settingsBackupPath: path.join(dir, backupName(2)) },
          { step: 2, createdAt: "x", matcher: "m", settingsBackupPath: path.join(dir, backupName(1)) },
        ],
      });
      pruneDatedBackups(file(), kind, { warn });
      expect(names()).toContain(backupName(1));
      expect(names()).toContain(backupName(2));
      expect(names()).not.toContain(backupName(3));
    });

    it("keeps a backup named by a live Codex snapshot (configBackupPath and its merges)", () => {
      for (let d = 1; d <= 8; d++) touch(backupName(d));
      touch(
        `harness.gate-disable-codex.${gateStamp(9)}.json`,
        JSON.stringify({
          version: 3,
          configPath: path.join(dir, "config.toml"),
          configBackupPath: path.join(dir, backupName(1)),
          merges: [{ createdAt: "x", matcher: "m", configBackupPath: path.join(dir, backupName(2)) }],
        }),
      );
      pruneDatedBackups(file(), kind, { warn });
      expect(names()).toContain(backupName(1));
      expect(names()).toContain(backupName(2));
      expect(names()).not.toContain(backupName(3));
    });

    it("matches a recorded path by its file name, whatever directory it records", () => {
      for (let d = 1; d <= 7; d++) touch(backupName(d));
      liveClaudeSnapshot(`harness.gate-disable.${gateStamp(9)}.json`, {
        settingsBackupPath: `/somewhere/else/${backupName(1)}`,
      });
      pruneDatedBackups(file(), kind, { warn });
      expect(names()).toContain(backupName(1));
    });

    it("no longer protects a backup once its snapshot is retired", () => {
      for (let d = 1; d <= 7; d++) touch(backupName(d));
      liveClaudeSnapshot(`harness.gate-disable.${gateStamp(1)}.restored.json`, {
        settingsBackupPath: path.join(dir, backupName(1)),
      });
      pruneDatedBackups(file(), kind, { warn });
      expect(names()).not.toContain(backupName(1));
    });

    it("removes nothing when a live snapshot cannot be parsed, and says so", () => {
      for (let d = 1; d <= 8; d++) touch(backupName(d));
      touch(`harness.gate-disable.${gateStamp(9)}.json`, "{ not json");
      expect(pruneDatedBackups(file(), kind, { warn })).toEqual([]);
      expect(names().filter((n) => n.includes("backup") || n.includes(".bak."))).toHaveLength(8);
      expect(warnings.join("\n")).toContain("no backup was removed");
    });

    it("removes nothing when a live snapshot is not a JSON object", () => {
      for (let d = 1; d <= 8; d++) touch(backupName(d));
      touch(`harness.gate-disable-codex.${gateStamp(9)}.json`, "[]");
      expect(pruneDatedBackups(file(), kind, { warn })).toEqual([]);
    });

    it("reads the snapshots beside the file a symlink leads to", () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-retention-out-"));
      try {
        const real = path.join(outside, base);
        fs.writeFileSync(real, "cfg");
        fs.symlinkSync(real, file());
        for (let d = 1; d <= 7; d++) touch(backupName(d));
        fs.writeFileSync(
          path.join(outside, `harness.gate-disable.${gateStamp(9)}.json`),
          JSON.stringify({ settingsBackupPath: path.join(dir, backupName(1)) }),
        );
        pruneDatedBackups(file(), kind, { warn });
        expect(names()).toContain(backupName(1));
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("ignores a non-snapshot json file that merely sits there", () => {
      for (let d = 1; d <= 7; d++) touch(backupName(d));
      touch("harness.gate-disable-notes.json", JSON.stringify({ settingsBackupPath: backupName(1) }));
      touch("harness.other.json", JSON.stringify({ settingsBackupPath: backupName(1) }));
      pruneDatedBackups(file(), kind, { warn });
      expect(names()).not.toContain(backupName(1));
    });
  });
});

describe("entries that are not regular files never block pruning", () => {
  const kind = "bak" as const;
  const backupName = (d: number): string => `settings.json.bak.${gateStamp(d)}`;
  const file = (): string => path.join(dir, "settings.json");
  const snapName = (d: number): string => `${LIVE_SNAPSHOT_PREFIXES[0]}${gateStamp(d)}.json`;
  function seed(): void {
    for (let d = 1; d <= 8; d++) touch(backupName(d));
  }
  function expectPruned(): void {
    expect(names().filter((n) => n.startsWith("settings.json.bak."))).toHaveLength(5);
  }

  it("a directory named like a live snapshot is skipped", () => {
    seed();
    fs.mkdirSync(path.join(dir, snapName(9)));
    pruneDatedBackups(file(), kind, { warn });
    expectPruned();
    expect(warnings).toEqual([]);
  });

  it("a dangling link named like a live snapshot is skipped", () => {
    seed();
    fs.symlinkSync(path.join(dir, "gone.json"), path.join(dir, snapName(9)));
    pruneDatedBackups(file(), kind, { warn });
    expectPruned();
    expect(warnings).toEqual([]);
  });

  it("a link to a regular live snapshot still counts: the backup it names stays", () => {
    seed();
    const real = path.join(dir, "elsewhere.json.txt");
    fs.writeFileSync(real, JSON.stringify({ settingsBackupPath: path.join(dir, backupName(1)) }));
    fs.symlinkSync(real, path.join(dir, snapName(9)));
    pruneDatedBackups(file(), kind, { warn });
    expect(names()).toContain(backupName(1));
  });

  // The prune runs in a child under a kill timeout (needs `dist/`, like the
  // other FIFO tests): a read of the FIFO would block it for good, and a
  // blocked in-process read would hang the whole worker.
  const pruneInChild = (): ChildRun =>
    runChild(
      `import(${JSON.stringify(distUrl("cli/retention.js"))}).then((m) => {` +
        `console.log(JSON.stringify(m.pruneDatedBackups(process.argv[1], "bak", { warn: () => {} })));});`,
      [file()],
    );

  it("a FIFO named like a live snapshot is not opened, so pruning returns", () => {
    seed();
    mkfifo(path.join(dir, snapName(9)));
    const run = pruneInChild();
    expectBounded(run);
    expect(run.value).toHaveLength(3);
    expectPruned();
  });

  it("control: the same child prunes beside a regular live snapshot", () => {
    seed();
    touch(snapName(9), JSON.stringify({ settingsBackupPath: path.join(dir, backupName(1)) }));
    const run = pruneInChild();
    expectBounded(run);
    expect(run.value).toHaveLength(2);
    expect(names()).toContain(backupName(1));
  });
});

describe("a directory spelled through a link and `..`", () => {
  it("lists, reads and removes in the directory the kernel reaches, not the folded one", () => {
    const real = path.join(dir, "real", "sub");
    fs.mkdirSync(real, { recursive: true });
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.symlinkSync(real, path.join(work, "a"));
    // `work/a/..` is `real` for the kernel and `work` for a lexical reading.
    const kernelDir = path.join(dir, "real");
    for (let d = 1; d <= 7; d++) {
      fs.writeFileSync(path.join(kernelDir, `settings.json.bak.${gateStamp(d)}`), "kernel");
      fs.writeFileSync(path.join(work, `settings.json.bak.${gateStamp(d)}`), "lexical");
    }
    const removed = pruneDatedBackups(`${work}/a/../settings.json`, "bak", { warn });
    expect(removed).toHaveLength(2);
    expect(fs.readdirSync(work).filter((n) => n.includes(".bak."))).toHaveLength(7);
    expect(fs.readdirSync(kernelDir).filter((n) => n.includes(".bak."))).toHaveLength(5);
    expect(warnings).toEqual([]);
  });

  it("does the same for retired snapshots", () => {
    const real = path.join(dir, "real", "sub");
    fs.mkdirSync(real, { recursive: true });
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.symlinkSync(real, path.join(work, "a"));
    const kernelDir = path.join(dir, "real");
    for (let d = 1; d <= 7; d++) {
      fs.writeFileSync(path.join(kernelDir, `${SNAPSHOT_BASENAME_PREFIX}${gateStamp(d)}.restored.json`), "kernel");
      fs.writeFileSync(path.join(work, `${SNAPSHOT_BASENAME_PREFIX}${gateStamp(d)}.restored.json`), "lexical");
    }
    pruneRetiredSnapshots(`${work}/a/..`, SNAPSHOT_BASENAME_PREFIX, { warn });
    expect(fs.readdirSync(work).filter((n) => n.endsWith(".restored.json"))).toHaveLength(7);
    expect(fs.readdirSync(kernelDir).filter((n) => n.endsWith(".restored.json"))).toHaveLength(5);
  });
});

describe("a Claude and a Codex config in one directory share nothing", () => {
  it("prunes each base name on its own", () => {
    for (let d = 1; d <= 7; d++) {
      touch(`settings.json.bak.${gateStamp(d)}`);
      touch(`config.toml.bak.${gateStamp(d)}`);
    }
    pruneDatedBackups(path.join(dir, "settings.json"), "bak", { warn });
    expect(names().filter((n) => n.startsWith("settings.json.bak."))).toHaveLength(5);
    expect(names().filter((n) => n.startsWith("config.toml.bak."))).toHaveLength(7);
  });
});

describe("errors never escape", () => {
  it("a missing directory is a no-op without a warning", () => {
    const missing = path.join(dir, "nope");
    expect(pruneRetiredSnapshots(missing, "harness.gate-disable.", { warn })).toEqual([]);
    expect(pruneDatedBackups(path.join(missing, "settings.json"), "bak", { warn })).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a directory path that is a file warns at most and does not throw", () => {
    const f = touch("plain");
    expect(() => pruneRetiredSnapshots(f, "harness.gate-disable.", { warn })).not.toThrow();
    expect(() => pruneDatedBackups(path.join(f, "settings.json"), "bak", { warn })).not.toThrow();
  });

  it("a throwing warn callback does not escape from the prune", () => {
    for (let d = 1; d <= 8; d++) touch(`settings.json.bak.${gateStamp(d)}`);
    touch(`harness.gate-disable.${gateStamp(9)}.json`, "{ not json");
    expect(() =>
      pruneDatedBackups(path.join(dir, "settings.json"), "bak", {
        warn: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
  });
});

describe("snapshotTargetName", () => {
  it("reads the basename of settingsPath (Claude) or configPath (Codex)", () => {
    const a = touch("a.json", JSON.stringify({ settingsPath: "/x/y/settings.local.json" }));
    const b = touch("b.json", JSON.stringify({ configPath: "/x/y/config.toml" }));
    expect(snapshotTargetName(a)).toBe("settings.local.json");
    expect(snapshotTargetName(b)).toBe("config.toml");
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["no path", "{}"],
    ["a non-string path", JSON.stringify({ settingsPath: 1 })],
    ["an empty path", JSON.stringify({ settingsPath: "" })],
    ["a dot path", JSON.stringify({ settingsPath: "/x/.." })],
  ])("returns null for %s", (_label, body) => {
    expect(snapshotTargetName(touch("c.json", body))).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(snapshotTargetName(path.join(dir, "missing.json"))).toBeNull();
  });
});
