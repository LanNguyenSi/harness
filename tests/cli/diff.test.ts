import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diff } from "../../src/cli/diff/index.js";
import { diffManifests, formatDiff } from "../../src/cli/diff/engine.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

function gitCommit(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

function newRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-diff-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitInit(dir);
  return dir;
}

describe("diff — semantic engine", () => {
  it("produces no changes when manifests are equal", () => {
    expect(diffManifests({ a: 1 }, { a: 1 })).toEqual([]);
    expect(formatDiff([])).toMatch(/no changes/);
  });

  it("detects a single mcp[].command change as one hunk", () => {
    const before = {
      version: 1,
      tools: { mcp: [{ name: "oracle", command: ["old"] }, { name: "tasks", command: ["t"] }] },
    };
    const after = {
      version: 1,
      tools: { mcp: [{ name: "oracle", command: ["new"] }, { name: "tasks", command: ["t"] }] },
    };
    const changes = diffManifests(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.path).toBe("tools.mcp[oracle].command");
    expect(changes[0]!.kind).toBe("modified");
  });

  it("detects added and removed name-keyed entries", () => {
    const before = { hooks: [{ name: "a", event: "Stop", command: "/x", blocking: false }] };
    const after = { hooks: [{ name: "b", event: "Stop", command: "/y", blocking: false }] };
    const changes = diffManifests(before, after);
    const paths = changes.map((c) => `${c.kind} ${c.path}`).sort();
    expect(paths).toEqual(["added hooks[b]", "removed hooks[a]"]);
  });

  it("groups changes by pillar header in the formatter", () => {
    const before = { tools: { mcp: [{ name: "x", command: ["a"] }] } };
    const after = { tools: { mcp: [{ name: "x", command: ["b"] }] } };
    const out = formatDiff(diffManifests(before, after));
    expect(out).toContain("## tools");
  });
});

describe("diff — git integration", () => {
  function writeManifest(dir: string, contents: string): string {
    const file = path.join(dir, "harness.yaml");
    fs.writeFileSync(file, contents, "utf8");
    return file;
  }

  const baseManifest = `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: oracle
      command: [npx, tsx, /old/path.ts]
      enabled: true
    - name: tasks
      command: [node, /tasks.js]
      enabled: true
`;
  const updatedManifest = baseManifest.replace("/old/path.ts", "/new/path.ts");

  it("emits exactly one diff hunk for a single mcp[].command change", () => {
    const repo = newRepo();
    writeManifest(repo, baseManifest);
    gitCommit(repo, "initial");
    writeManifest(repo, updatedManifest);
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.path).toBe("tools.mcp[oracle].command");
    expect(r.output).toContain("/old/path.ts");
    expect(r.output).toContain("/new/path.ts");
    expect(r.output).toMatch(/## tools\n/);
  });

  it("returns no changes when working tree matches the ref", () => {
    const repo = newRepo();
    writeManifest(repo, baseManifest);
    gitCommit(repo, "initial");
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(r.changes).toEqual([]);
    expect(r.output).toMatch(/no changes/);
  });

  it("exits 64 with a usage hint when --since is omitted", () => {
    let caught: unknown;
    try {
      diff({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(64);
    expect((caught as HarnessExitError).message).toMatch(/--since-apply.*Phase 3/);
  });

  it("exits 69 when run outside a git work tree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-no-git-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "harness.yaml"), baseManifest, "utf8");
    let caught: unknown;
    try {
      diff({
        configPath: path.join(dir, "harness.yaml"),
        since: "master",
        homeDir: dir,
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(69);
  });

  it("exits 64 when --since references a missing ref", () => {
    const repo = newRepo();
    writeManifest(repo, baseManifest);
    gitCommit(repo, "initial");
    let caught: unknown;
    try {
      diff({
        configPath: path.join(repo, "harness.yaml"),
        since: "no-such-ref-xyz",
        homeDir: repo,
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(64);
    expect((caught as HarnessExitError).message).toMatch(/no-such-ref-xyz/);
  });
});
