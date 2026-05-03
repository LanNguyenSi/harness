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

  it("leaves {project} literal when no project is supplied", () => {
    const home = makeTmpHome();
    const manifest = manifestFor({
      directories: [{ path: "~/claude/{project}/memory", scope: "project" }],
    });
    const report = inspectMemory(manifest, { homeDir: home });
    expect(report.directories[0]!.path).toBe(path.join(home, "claude", "{project}", "memory"));
    expect(report.directories[0]!.exists).toBe(false);
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
