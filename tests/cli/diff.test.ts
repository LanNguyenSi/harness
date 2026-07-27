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

  it("resolves a symlinked manifest path before relativizing against git's physical root", () => {
    const repo = newRepo();
    writeManifest(repo, baseManifest);
    gitCommit(repo, "initial");
    // Mirrors macOS os.tmpdir(): /var/folders/… is a symlink into
    // /private/var/folders/…, while `git rev-parse --show-toplevel`
    // reports the physical root. Explicit symlink so Linux CI covers
    // the same shape.
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "harness-diff-link-"));
    cleanups.push(() => fs.rmSync(linkParent, { recursive: true, force: true }));
    const link = path.join(linkParent, "repo-link");
    fs.symlinkSync(fs.realpathSync(repo), link, "dir");
    const r = diff({
      configPath: path.join(link, "harness.yaml"),
      since: "master",
      homeDir: link,
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

// task b2660f9e (harness-review-2026-07-01/diff-override-asymmetry): the ref
// side of `diff --since` was override-naive while the working side was
// override-merged, so active machine/project override layers showed up as
// phantom diffs. The ref side now merges the SAME layers: read at the ref
// when versioned in the repo, treated as constant (with a warning) when the
// layer lives outside the repo. The pre-existing no-override tests above pin
// that the plain path is unchanged.
describe("diff — override-layer symmetry (--since)", () => {
  // `as const` narrows `platform` to the literal "linux" (NodeJS.Platform
  // member) instead of the widened `string` TS infers by default — without
  // it, `diff()`'s `discriminator: DiscriminatorOptions` param rejects the
  // object at every call site below.
  const DISCRIMINATOR = { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" } as const;

  const plainBase = `version: 1
hooks: []
policies: []
tools:
  mcp: []
`;

  const overrideLayer = `grounding:
  evidence_ledger:
    retention_days: 30
`;

  function writeAt(dir: string, rel: string, contents: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }

  it("reports no phantom changes when a committed machine override is active and unchanged", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    writeAt(repo, "machines/h.harness.overrides.yaml", overrideLayer);
    gitCommit(repo, "base + override");
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      discriminator: DISCRIMINATOR,
    });
    expect(r.changes).toEqual([]);
    expect(r.warnings).toEqual([]);
    // Sanity: the override actually took effect on both sides.
    expect(r.before.grounding.evidence_ledger.retention_days).toBe(30);
    expect(r.after.grounding.evidence_ledger.retention_days).toBe(30);
  });

  it("recognizes a committed override layer through a symlinked home as versioned", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    writeAt(repo, "machines/h.harness.overrides.yaml", overrideLayer);
    gitCommit(repo, "base + override");
    // Same symlink shape as the manifest-path regression test above, but
    // with a layer in play: without physical-path resolution in
    // repoRelativePath the layer under the symlinked home relativizes to
    // a climbing "..", reads as unversioned, and emits the outside-repo
    // warning. The pin is versioned-layer behavior end-to-end.
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "harness-diff-link-"));
    cleanups.push(() => fs.rmSync(linkParent, { recursive: true, force: true }));
    const link = path.join(linkParent, "repo-link");
    fs.symlinkSync(fs.realpathSync(repo), link, "dir");
    const r = diff({
      configPath: path.join(link, "harness.yaml"),
      since: "master",
      homeDir: link,
      discriminator: DISCRIMINATOR,
    });
    expect(r.changes).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.after.grounding.evidence_ledger.retention_days).toBe(30);
  });

  it("still reports a genuine base change while an override layer is active", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    writeAt(repo, "machines/h.harness.overrides.yaml", overrideLayer);
    gitCommit(repo, "base + override");
    writeAt(
      repo,
      "harness.yaml",
      plainBase.replace("mcp: []", `mcp:\n    - name: oracle\n      command: [node, /o.js]\n      enabled: true`),
    );
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      discriminator: DISCRIMINATOR,
    });
    // Engine granularity: an empty->non-empty mcp[] surfaces as one
    // modified hunk on tools.mcp. The pin here is: exactly ONE change,
    // and it is the base edit — no override-induced noise around it.
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]!.path).toBe("tools.mcp");
    expect(r.output).toContain("oracle");
  });

  it("treats a layer added since the ref as a real change (ref side goes without it)", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    gitCommit(repo, "base only");
    writeAt(repo, "machines/h.harness.overrides.yaml", overrideLayer);
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      discriminator: DISCRIMINATOR,
    });
    expect(r.changes.map((c) => c.path)).toContain("grounding.evidence_ledger.retention_days");
    expect(r.warnings).toEqual([]);
  });

  it("treats an unversioned (outside-repo) layer as constant on both sides and warns", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    gitCommit(repo, "base only");
    // Separate non-repo home holding the machine layer.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-diff-home-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    writeAt(home, "machines/h.harness.overrides.yaml", overrideLayer);
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: home,
      discriminator: DISCRIMINATOR,
    });
    expect(r.changes).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("not versioned in this repo");
    // Constant on both sides: the override applies to before AND after.
    expect(r.before.grounding.evidence_ledger.retention_days).toBe(30);
    expect(r.after.grounding.evidence_ledger.retention_days).toBe(30);
  });

  it("applies machine and project layers in loader order on BOTH sides (project wins)", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    writeAt(repo, "machines/h.harness.overrides.yaml", overrideLayer); // 30
    writeAt(
      repo,
      "projects/p/harness.overrides.yaml",
      "grounding:\n  evidence_ledger:\n    retention_days: 45\n",
    );
    gitCommit(repo, "base + both layers");
    const r = diff({
      configPath: path.join(repo, "harness.yaml"),
      since: "master",
      homeDir: repo,
      project: "p",
      discriminator: DISCRIMINATOR,
    });
    expect(r.changes).toEqual([]);
    // Last-wins order (machine, then project) must match loadManifest on
    // the ref side too — an order swap in buildRefManifest flips this to 30.
    expect(r.before.grounding.evidence_ledger.retention_days).toBe(45);
    expect(r.after.grounding.evidence_ledger.retention_days).toBe(45);
  });

  it("scopes a ref-side override merge conflict to the ref in a clean error", () => {
    const repo = newRepo();
    writeAt(repo, "harness.yaml", plainBase);
    // Mixed named/plain list: OverrideMergeError at merge time. diff()
    // builds the ref side FIRST, so the wrapper must label the failure as
    // the historical merge and exit with a sysexits data error, not a bare
    // exit-70 crash.
    writeAt(
      repo,
      "machines/h.harness.overrides.yaml",
      "hooks:\n  - name: a\n    event: Stop\n    command: /x\n    blocking: false\n  - command: /y\n",
    );
    gitCommit(repo, "base + conflicting layer");
    try {
      diff({
        configPath: path.join(repo, "harness.yaml"),
        since: "master",
        homeDir: repo,
        discriminator: DISCRIMINATOR,
      });
      expect.unreachable("diff should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessExitError);
      expect((err as HarnessExitError).message).toContain('override merge at git ref "master"');
      expect((err as HarnessExitError).exitCode).toBe(66);
    }
  });
});
