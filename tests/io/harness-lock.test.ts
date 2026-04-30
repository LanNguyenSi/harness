import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_BASENAME,
  buildLockEntries,
  collectManifestAssetPaths,
  computeAssetEntry,
  computeDrift,
  computeMemoryDirEntry,
  parseLock,
  readLock,
  serializeLock,
  writeLock,
  type LockEntry,
} from "../../src/io/harness-lock.js";
import { parseManifest } from "../../src/schema/index.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lock-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function sha(buf: string | Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fixtureFile(rel: string, content: string): string {
  const target = path.join(tmpHome, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function fixtureManifest(): unknown {
  return {
    version: 1,
    tools: {
      mcp: [
        {
          name: "codebase-oracle",
          command: ["node", "~/oracle/server.js"],
        },
      ],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: {
      directories: [],
    },
    hooks: [
      {
        name: "git-preflight",
        event: "SessionStart",
        command: "~/hooks/git-preflight.sh",
        blocking: false,
        budget_ms: 30000,
      },
      {
        name: "review",
        event: "PreToolUse",
        match: "mcp__agent-tasks__pull_requests_merge",
        command: "~/hooks/review.sh",
        blocking: "hard",
        budget_ms: 2000,
      },
    ],
    policies: [],
  };
}

describe("computeAssetEntry", () => {
  it("returns sha256 matching the file content", () => {
    const p = fixtureFile("hooks/foo.sh", "echo hi\n");
    const entry = computeAssetEntry(p);
    expect(entry.kind).toBe("asset");
    expect(entry.path).toBe(p);
    expect(entry.sha256).toBe(sha("echo hi\n"));
  });
});

describe("computeMemoryDirEntry", () => {
  it("returns sha256 of sorted basename:filehash lines", () => {
    const dir = path.join(tmpHome, "memdir");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "b.md"), "B body\n");
    fs.writeFileSync(path.join(dir, "a.md"), "A body\n");
    fs.writeFileSync(path.join(dir, "c.md"), "C body\n");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "not md\n");

    const entry = computeMemoryDirEntry(dir);
    expect(entry.kind).toBe("memory-dir");
    expect(entry.file_count).toBe(3);

    const expected = sha(
      [
        `a.md:${sha("A body\n")}`,
        `b.md:${sha("B body\n")}`,
        `c.md:${sha("C body\n")}`,
      ].join("\n"),
    );
    expect(entry.sha256).toBe(expected);
  });

  it("editing one memory file changes the directory hash", () => {
    const dir = path.join(tmpHome, "memdir");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "v1\n");
    fs.writeFileSync(path.join(dir, "b.md"), "B\n");
    const before = computeMemoryDirEntry(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "v2\n");
    const after = computeMemoryDirEntry(dir);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.file_count).toBe(2);
  });

  it("returns file_count: 0 for an empty directory", () => {
    const dir = path.join(tmpHome, "empty");
    fs.mkdirSync(dir);
    const entry = computeMemoryDirEntry(dir);
    expect(entry.file_count).toBe(0);
    expect(entry.sha256).toBe(sha(""));
  });
});

describe("serializeLock / parseLock", () => {
  it("round-trips entries with stable ordering by (kind, path)", () => {
    const entries: LockEntry[] = [
      { kind: "asset", path: "/z", sha256: "1" },
      { kind: "memory-dir", path: "/m", sha256: "2", file_count: 3 },
      { kind: "asset", path: "/a", sha256: "3" },
    ];
    const serialized = serializeLock(entries);
    const lines = serialized.trim().split("\n");
    expect(lines).toHaveLength(3);
    // assets sort before memory-dir; within kind, by path
    expect(JSON.parse(lines[0]!).path).toBe("/a");
    expect(JSON.parse(lines[1]!).path).toBe("/z");
    expect(JSON.parse(lines[2]!).kind).toBe("memory-dir");

    const parsed = parseLock(serialized);
    expect(parsed.map((e) => `${e.kind}:${e.path}`)).toEqual([
      "asset:/a",
      "asset:/z",
      "memory-dir:/m",
    ]);
  });

  it("serialize of empty entries returns empty string", () => {
    expect(serializeLock([])).toBe("");
    expect(parseLock("")).toEqual([]);
  });

  it("parseLock skips blank lines", () => {
    const content = `${JSON.stringify({ kind: "asset", path: "/a", sha256: "x" })}\n\n${JSON.stringify({ kind: "asset", path: "/b", sha256: "y" })}\n`;
    expect(parseLock(content)).toHaveLength(2);
  });

  it("parseLock throws on an entry with an unknown kind", () => {
    const content = `${JSON.stringify({ kind: "weird", path: "/a" })}\n`;
    expect(() => parseLock(content)).toThrow(/malformed/);
  });

  it("parseLock throws on an asset entry missing sha256", () => {
    const content = `${JSON.stringify({ kind: "asset", path: "/a" })}\n`;
    expect(() => parseLock(content)).toThrow(/malformed/);
  });

  it("parseLock throws on a memory-dir entry missing file_count", () => {
    const content = `${JSON.stringify({ kind: "memory-dir", path: "/a", sha256: "x" })}\n`;
    expect(() => parseLock(content)).toThrow(/malformed/);
  });
});

describe("writeLock / readLock", () => {
  it("writes harness.lock and reads it back", () => {
    const lockPath = path.join(tmpHome, LOCK_BASENAME);
    const entries: LockEntry[] = [
      { kind: "asset", path: "/a/b.sh", sha256: "deadbeef" },
    ];
    writeLock(lockPath, entries);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readLock(lockPath)).toEqual(entries);
  });

  it("readLock returns null when the file is absent", () => {
    expect(readLock(path.join(tmpHome, "no.lock"))).toBeNull();
  });
});

describe("computeDrift", () => {
  it("reports modified for an asset whose content changed since the lock was written", () => {
    const p = fixtureFile("hooks/git-preflight.sh", "v1\n");
    const entry = computeAssetEntry(p);
    fs.writeFileSync(p, "v2\n");
    const drift = computeDrift([entry]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("modified");
    expect(drift[0]?.currentSha).toBe(sha("v2\n"));
  });

  it("reports missing for an asset that has been deleted", () => {
    const p = fixtureFile("hooks/git-preflight.sh", "v1\n");
    const entry = computeAssetEntry(p);
    fs.rmSync(p);
    const drift = computeDrift([entry]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("missing");
  });

  it("reports missing when an asset path now points at a directory", () => {
    const p = fixtureFile("hooks/git-preflight.sh", "v1\n");
    const entry = computeAssetEntry(p);
    fs.rmSync(p);
    fs.mkdirSync(p);
    const drift = computeDrift([entry]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("missing");
  });

  it("reports modified for a memory-dir whose hash changed", () => {
    const dir = path.join(tmpHome, "memdir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "v1\n");
    const entry = computeMemoryDirEntry(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "v2\n");
    const drift = computeDrift([entry]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("modified");
  });

  it("reports missing when a memory-dir path now points at a file", () => {
    const dir = path.join(tmpHome, "memdir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.md"), "v1\n");
    const entry = computeMemoryDirEntry(dir);
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "now a file\n");
    const drift = computeDrift([entry]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.reason).toBe("missing");
  });

  it("reports nothing when the on-disk content still matches the lock", () => {
    const p = fixtureFile("hooks/foo.sh", "stable\n");
    expect(computeDrift([computeAssetEntry(p)])).toEqual([]);
  });
});

describe("collectManifestAssetPaths", () => {
  it("collects 2 hook scripts + 1 MCP entrypoint that exist on disk", () => {
    const m = parseManifest(fixtureManifest());
    fixtureFile("hooks/git-preflight.sh", "echo a\n");
    fixtureFile("hooks/review.sh", "echo b\n");
    fixtureFile("oracle/server.js", "console.log('o')\n");

    const paths = collectManifestAssetPaths(m, { homeDir: tmpHome });
    expect(paths.sort()).toEqual([
      path.join(tmpHome, "hooks/git-preflight.sh"),
      path.join(tmpHome, "hooks/review.sh"),
      path.join(tmpHome, "oracle/server.js"),
    ].sort());
  });

  it("skips paths that don't exist on disk", () => {
    const m = parseManifest(fixtureManifest());
    fixtureFile("hooks/git-preflight.sh", "echo a\n");
    // review.sh and oracle/server.js intentionally NOT created
    const paths = collectManifestAssetPaths(m, { homeDir: tmpHome });
    expect(paths).toEqual([path.join(tmpHome, "hooks/git-preflight.sh")]);
  });

  it("dedupes when two manifest entries reference the same file", () => {
    const m = parseManifest({
      ...(fixtureManifest() as object),
      hooks: [
        {
          name: "h1",
          event: "SessionStart",
          command: "~/hooks/shared.sh",
          blocking: false,
          budget_ms: 30000,
        },
        {
          name: "h2",
          event: "Stop",
          command: "~/hooks/shared.sh",
          blocking: false,
          budget_ms: 30000,
        },
      ],
    });
    fixtureFile("hooks/shared.sh", "echo hi\n");
    const paths = collectManifestAssetPaths(m, { homeDir: tmpHome });
    expect(paths).toEqual([path.join(tmpHome, "hooks/shared.sh")]);
  });

  it("includes memory.router.command paths that exist", () => {
    const m = parseManifest({
      ...(fixtureManifest() as object),
      memory: {
        directories: [],
        router: { command: ["node", "~/memory-router/dist/hook.js"], enabled: true },
      },
      hooks: [],
      tools: {
        mcp: [],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    fixtureFile("memory-router/dist/hook.js", "// router\n");
    const paths = collectManifestAssetPaths(m, { homeDir: tmpHome });
    expect(paths).toEqual([path.join(tmpHome, "memory-router/dist/hook.js")]);
  });

  it("resolves enabled skill SKILL.md from the first matching source_dir", () => {
    const m = parseManifest({
      ...(fixtureManifest() as object),
      hooks: [],
      tools: {
        mcp: [],
        cli: [],
        skills: {
          enabled: ["simplify"],
          source_dirs: ["~/missing-skills", "~/skills"],
        },
        builtin: { known: [] },
      },
    });
    fixtureFile("skills/simplify/SKILL.md", "# simplify\n");
    const paths = collectManifestAssetPaths(m, { homeDir: tmpHome });
    expect(paths).toEqual([path.join(tmpHome, "skills/simplify/SKILL.md")]);
  });

  it("skips relative command tokens that aren't paths (e.g. binaries on $PATH)", () => {
    const m = parseManifest({
      ...(fixtureManifest() as object),
      hooks: [],
      tools: {
        mcp: [{ name: "x", command: ["node", "--no-warnings"] }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    expect(collectManifestAssetPaths(m, { homeDir: tmpHome })).toEqual([]);
  });

  it("supports string-form mcp.command (whitespace-split)", () => {
    const m = parseManifest({
      ...(fixtureManifest() as object),
      hooks: [],
      tools: {
        mcp: [{ name: "x", command: "node ~/oracle/server.js" }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    fixtureFile("oracle/server.js", "// s\n");
    expect(collectManifestAssetPaths(m, { homeDir: tmpHome })).toEqual([
      path.join(tmpHome, "oracle/server.js"),
    ]);
  });
});

describe("buildLockEntries", () => {
  it("emits 3 asset entries for 2 hook scripts + 1 MCP entrypoint", () => {
    const m = parseManifest(fixtureManifest());
    fixtureFile("hooks/git-preflight.sh", "echo a\n");
    fixtureFile("hooks/review.sh", "echo b\n");
    fixtureFile("oracle/server.js", "// s\n");
    const entries = buildLockEntries(m, { homeDir: tmpHome });
    const assets = entries.filter((e) => e.kind === "asset");
    expect(assets).toHaveLength(3);
    expect(assets.every((e) => e.sha256.length === 64)).toBe(true);
  });

  it("emits exactly one memory-dir entry per memory directory with 5 .md files", () => {
    const memDir = path.join(tmpHome, "memdir");
    fs.mkdirSync(memDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(memDir, `m${i}.md`), `body ${i}\n`);
    }
    const m = parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [{ path: "~/memdir", scope: "project" }] },
      hooks: [],
      policies: [],
    });
    const entries = buildLockEntries(m, { homeDir: tmpHome });
    const memEntries = entries.filter((e) => e.kind === "memory-dir");
    expect(memEntries).toHaveLength(1);
    expect((memEntries[0] as { file_count: number }).file_count).toBe(5);
  });

  it("substitutes {project} placeholder when projectName is provided", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [{ path: "~/projects/{project}/memory", scope: "project" }] },
      hooks: [],
      policies: [],
    });
    const memDir = path.join(tmpHome, "projects/foo/memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "x.md"), "x\n");
    const entries = buildLockEntries(m, { homeDir: tmpHome, projectName: "foo" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(memDir);
  });

  it("skips memory dirs with {project} placeholder when no project context is given", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [{ path: "~/projects/{project}/memory", scope: "project" }] },
      hooks: [],
      policies: [],
    });
    expect(buildLockEntries(m, { homeDir: tmpHome })).toEqual([]);
  });

  it("skips memory dirs that don't exist", () => {
    const m = parseManifest({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [{ path: "~/nonexistent", scope: "user" }] },
      hooks: [],
      policies: [],
    });
    expect(buildLockEntries(m, { homeDir: tmpHome })).toEqual([]);
  });
});

describe("readLock against externally-edited assets", () => {
  it("returns drift for exactly the asset whose script content changed", () => {
    const m = parseManifest(fixtureManifest());
    fixtureFile("hooks/git-preflight.sh", "v1\n");
    fixtureFile("hooks/review.sh", "stable\n");
    fixtureFile("oracle/server.js", "// stable\n");

    const lockPath = path.join(tmpHome, LOCK_BASENAME);
    writeLock(lockPath, buildLockEntries(m, { homeDir: tmpHome }));

    // Edit ONE script externally.
    fs.writeFileSync(path.join(tmpHome, "hooks/git-preflight.sh"), "v2-edited\n");

    const locked = readLock(lockPath);
    expect(locked).not.toBeNull();
    const drift = computeDrift(locked!);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.entry.path).toBe(path.join(tmpHome, "hooks/git-preflight.sh"));
    expect(drift[0]?.reason).toBe("modified");
  });
});
