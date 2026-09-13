import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMemory } from "../../src/probes/memory.js";
import type { Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeTmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-memory-probe-"));
  cleanups.push(() => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore: cleanup may race a chmod-recovery in the recursion-error test */
    }
  });
  return home;
}

/**
 * Minimal manifest scaffold matching the surface inspectMemory reads.
 * The full Manifest type is wide; we cast a partial structure rather
 * than constructing every required field for an unrelated test.
 */
function manifestFor(opts: {
  directories: Array<{ path: string; scope: string }>;
  router?: { command: string[] };
  stalenessDays?: number;
}): Manifest {
  return {
    memory: {
      directories: opts.directories,
      retention: { staleness_days: opts.stalenessDays ?? 30 },
      ...(opts.router ? { router: opts.router } : {}),
    },
  } as unknown as Manifest;
}

describe("inspectMemory: directory + router resolution", () => {
  it("substitutes {project} into directory paths when opts.project is set", () => {
    const home = makeTmpHome();
    const projectDir = path.join(home, "claude", "myproj", "memory");
    fs.mkdirSync(projectDir, { recursive: true });
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home, project: "myproj" });
    expect(report.directories).toHaveLength(1);
    expect(report.directories[0]!.path).toBe(projectDir);
    expect(report.directories[0]!.exists).toBe(true);
    expect(report.directories[0]!.scope).toBe("project");
  });

  it("rejects an invalid opts.project (\"..\") instead of letting it escape the intended directory", () => {
    const home = makeTmpHome();
    // Sibling of the directory the {project} placeholder is meant to
    // occupy, one level up from `claude/`. If the guard were missing,
    // substituteProject would happily interpolate ".." and
    // expandHome/path.join would resolve straight to `home` itself.
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home, project: ".." });
    // Invalid name degrades to the same branch as "no project supplied":
    // the {project} literal survives substitution and is reported as an
    // unresolved pattern, never joined into a path outside claude/.
    expect(report.directories[0]!.path).toBe(path.join(home, "claude", "{project}", "memory"));
    expect(report.directories[0]!.path.startsWith(home)).toBe(true);
    expect(report.directories[0]!.unresolved).toBe(true);
  });

  it("rejects an invalid opts.project (\"a/b\", a path separator) the same way \"..\" is rejected", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home, project: "a/b" });
    expect(report.directories[0]!.path).toBe(path.join(home, "claude", "{project}", "memory"));
    expect(report.directories[0]!.unresolved).toBe(true);
    expect(report.directories[0]!.exists).toBe(true);
  });

  it("resolves a project value containing a replace-special pattern ($') literally, not as a back-reference", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home, project: "$'" });
    // A regex-based `replace(/\{project\}/g, project)` would interpret
    // `$'` as "everything after the match" (here: "/memory"), producing
    // `<home>/claude/memory/memory`. The literal split/join idiom must
    // insert the two characters `$` and `'` unchanged instead.
    expect(report.directories[0]!.path).toBe(path.join(home, "claude", "$'", "memory"));
  });

  it("resolves a project value containing $` literally, not as a back-reference", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home, project: "$`" });
    // `replace`'s special syntax would interpret "$`" as "everything
    // before the match" (here: "<home>/claude/"), producing
    // `<home>/claude/<home>/claude/memory`. The literal idiom inserts
    // the two characters unchanged.
    expect(report.directories[0]!.path).toBe(path.join(home, "claude", "$`", "memory"));
  });

  it("does not let a project value of \"~\" re-anchor a leading-placeholder relative pattern to the home directory", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home, project: "~" });
    // Substitution now runs AFTER expandHome, which only ever expands
    // the manifest's OWN leading "~". A project value that happens to
    // look like "~" must stay an inert literal segment, never
    // re-interpreted and re-expanded to the home directory.
    expect(report.directories[0]!.path).toBe(path.join("~", "memory"));
    expect(report.directories[0]!.path).not.toBe(path.join(home, "memory"));
  });

  it("reports a rejected --project on MemoryReport.projectRejected, distinct from the no-project-supplied case", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const rejected = inspectMemory(manifest, { homeDir: home, project: ".." });
    expect(rejected.projectRejected).toBe("..");
    const noProject = inspectMemory(manifest, { homeDir: home });
    expect(noProject.projectRejected).toBeNull();
    const valid = inspectMemory(manifest, { homeDir: home, project: "myproj" });
    expect(valid.projectRejected).toBeNull();
  });

  it("flags {project} literal as unresolved (pattern, not missing) when no project is supplied", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home });
    expect(report.directories[0]!.path).toBe(path.join(home, "claude", "{project}", "memory"));
    // Unresolved patterns are informational, not "missing": a placeholder
    // is not a concrete path, so existence is not meaningful.
    expect(report.directories[0]!.unresolved).toBe(true);
    expect(report.directories[0]!.exists).toBe(true);
  });

  it("flags non-existent directories with exists:false and skips staleness scan", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/missing-dir", scope: "user" }],
      stalenessDays: 0,
    });
    const report = inspectMemory(manifest, { homeDir: home });
    expect(report.directories[0]!.exists).toBe(false);
    expect(report.staleMemories).toHaveLength(0);
  });

  it("returns routerExecutable=null when manifest.memory.router is absent", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/", scope: "user" }],
    });
    const report = inspectMemory(manifest, { homeDir: home });
    expect(report.routerExecutable).toBeNull();
  });

  it("reports routerExecutable.exists=true when the script path resolves to an existing file", () => {
    const home = makeTmpHome();
    const scriptPath = path.join(home, "memory-router");
    fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(scriptPath, 0o755);
    const manifest = manifestFor({
      directories: [{ path: "~/", scope: "user" }],
      router: { command: ["~/memory-router", "serve"] },
    });
    const report = inspectMemory(manifest, { homeDir: home });
    expect(report.routerExecutable).not.toBeNull();
    expect(report.routerExecutable!.path).toBe(scriptPath);
    expect(report.routerExecutable!.exists).toBe(true);
  });

  it("reports routerExecutable.exists=false when the resolved path is missing", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/", scope: "user" }],
      router: { command: ["~/no-such-router"] },
    });
    const report = inspectMemory(manifest, { homeDir: home });
    expect(report.routerExecutable).not.toBeNull();
    expect(report.routerExecutable!.exists).toBe(false);
  });

  it("resolves a bare bin name through PATH (bin-shaped manifests, not just file paths)", () => {
    // Drop a stub binary into a tmp dir, point PATH at it, and assert
    // the router probe finds it. Locks the contract that a manifest
    // shipping `command: [memory-router-user-prompt-submit]` (the
    // published bin shape) reads as installed.
    const home = makeTmpHome();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "memprobe-bin-"));
    try {
      const binPath = path.join(binDir, "memory-router-user-prompt-submit");
      fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(binPath, 0o755);
      const manifest = manifestFor({
        directories: [{ path: "~/", scope: "user" }],
        router: { command: ["memory-router-user-prompt-submit"] },
      });
      const report = inspectMemory(manifest, { homeDir: home, pathEnv: binDir });
      expect(report.routerExecutable).not.toBeNull();
      expect(report.routerExecutable!.path).toBe(binPath);
      expect(report.routerExecutable!.exists).toBe(true);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("reports routerExecutable.exists=false for a bare bin name absent from PATH", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/", scope: "user" }],
      router: { command: ["no-such-router-bin"] },
    });
    const report = inspectMemory(manifest, { homeDir: home, pathEnv: "/nonexistent" });
    expect(report.routerExecutable).not.toBeNull();
    expect(report.routerExecutable!.path).toBe("no-such-router-bin");
    expect(report.routerExecutable!.exists).toBe(false);
  });
});

describe("inspectMemory: staleness + recursion-error catch", () => {
  it("collects markdown files older than retention.staleness_days as stale", () => {
    const home = makeTmpHome();
    const memDir = path.join(home, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const stale = path.join(memDir, "old.md");
    const fresh = path.join(memDir, "new.md");
    fs.writeFileSync(stale, "# stale", "utf8");
    fs.writeFileSync(fresh, "# fresh", "utf8");
    const now = new Date("2026-05-03T00:00:00Z");
    const eightDaysAgo = new Date(now.getTime() - 8 * 86400000);
    const oneDayAgo = new Date(now.getTime() - 1 * 86400000);
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(fresh, oneDayAgo, oneDayAgo);
    const manifest = manifestFor({
      directories: [{ path: "~/memory", scope: "user" }],
      stalenessDays: 7,
    });
    const report = inspectMemory(manifest, { homeDir: home, now });
    expect(report.staleMemories.map((m) => m.path)).toEqual([stale]);
    expect(report.staleMemories[0]!.ageDays).toBe(8);
  });

  it("catches readdirSync errors on unreadable subdirectories without crashing", () => {
    if (process.getuid && process.getuid() === 0) {
      // Running as root: chmod 000 does not block readdir, so the
      // recursion-error catch cannot be exercised. Skip rather than
      // produce a false positive on the assertion.
      return;
    }
    const home = makeTmpHome();
    const memDir = path.join(home, "memory");
    const subdir = path.join(memDir, "locked");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "visible.md"), "# top-level", "utf8");
    fs.writeFileSync(path.join(subdir, "hidden.md"), "# inside locked", "utf8");
    fs.chmodSync(subdir, 0o000);
    cleanups.push(() => {
      try {
        fs.chmodSync(subdir, 0o755);
      } catch {
        /* already cleaned */
      }
    });
    const manifest = manifestFor({
      directories: [{ path: "~/memory", scope: "user" }],
      stalenessDays: 365,
    });
    // Should not throw; recursion gives up on the locked subdir and
    // continues. The visible.md file may or may not show as stale
    // depending on its mtime; we only assert absence of crash.
    expect(() => inspectMemory(manifest, { homeDir: home })).not.toThrow();
  });
});

describe("inspectMemory: memory.router min_version prerelease (task db44ab46)", () => {
  // Task db44ab46 extends the hooks[] prerelease-rejection rule
  // (docs/decisions/2026-09-08-preflight-floors.md) to memory.router: a
  // release candidate of the router binary must not satisfy an
  // equal-numeric min_version floor.
  function routerVersionFor(probedStdout: string) {
    const home = makeTmpHome();
    const scriptPath = path.join(home, "memory-router");
    fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(scriptPath, 0o755);
    const manifest = {
      memory: {
        directories: [{ path: "~/", scope: "user" }],
        retention: { staleness_days: 30 },
        router: { command: ["~/memory-router"], min_version: "1.2.3" },
      },
    } as unknown as Manifest;
    const report = inspectMemory(manifest, { homeDir: home, versionProbe: () => probedStdout });
    return report.routerVersion;
  }

  it("warns below_floor when the probed router version is a dotted prerelease of min_version", () => {
    expect(routerVersionFor("memory-router 1.2.3-rc.1\n")).toEqual({
      status: "warn",
      message: "outdated: installed v1.2.3-rc.1 < required 1.2.3",
    });
  });

  it("warns below_floor when the probed router version is a dotless prerelease of min_version", () => {
    expect(routerVersionFor("memory-router 1.2.3-beta\n")).toEqual({
      status: "warn",
      message: "outdated: installed v1.2.3-beta < required 1.2.3",
    });
  });

  it("still passes a real release meeting the floor (no regression)", () => {
    expect(routerVersionFor("memory-router 1.2.3\n")).toEqual({
      status: "ok",
      message: "v1.2.3 ≥ 1.2.3",
    });
  });

  it("passes a higher-version prerelease with no diagnostic (numeric comparison is not a tie)", () => {
    expect(routerVersionFor("memory-router 1.2.4-rc.1\n")).toEqual({
      status: "ok",
      message: "v1.2.4-rc.1 ≥ 1.2.3",
    });
  });

  it("warns below_floor on a git-describe suffix at an equal-numeric floor (accepted cost)", () => {
    expect(routerVersionFor("memory-router 1.2.3-4-gabc123\n")).toEqual({
      status: "warn",
      message: "outdated: installed v1.2.3-4-gabc123 < required 1.2.3",
    });
  });

  it("warns below_floor on a platform suffix at an equal-numeric floor (accepted cost)", () => {
    expect(routerVersionFor("memory-router 1.2.3-linux-x64\n")).toEqual({
      status: "warn",
      message: "outdated: installed v1.2.3-linux-x64 < required 1.2.3",
    });
  });

  // Residual (task 62d9778c): pins the +build-is-not-a-prerelease claim
  // (docs/CLI.md) through this surface, not only through the
  // parseProbedVersion unit test.
  it("passes a +build metadata suffix at an equal-numeric floor (not a prerelease)", () => {
    expect(routerVersionFor("memory-router 1.2.3+build.7\n")).toEqual({
      status: "ok",
      message: "v1.2.3+build.7 ≥ 1.2.3",
    });
  });
});
