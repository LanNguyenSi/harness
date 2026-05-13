import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDependencies,
  dependenciesForProfile,
  formatDependencyTable,
  installPackagesGlobally,
} from "../../src/cli/init/dependencies.js";

let tmpBin: string;

beforeEach(() => {
  tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), "harness-deps-bin-"));
});

afterEach(() => {
  fs.rmSync(tmpBin, { recursive: true, force: true });
});

function makeExecutable(name: string): void {
  const p = path.join(tmpBin, name);
  fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(p, 0o755);
}

describe("dependenciesForProfile — chain composition", () => {
  it("solo lists only solo-layer binaries", () => {
    const deps = dependenciesForProfile("solo");
    const bins = deps.map((d) => d.binary);
    expect(bins).toContain("memory-router-user-prompt-submit");
    expect(bins).toContain("understanding-gate-claude-hook");
    expect(bins).not.toContain("agent-tasks-mcp-bridge");
  });

  it("team inherits solo + adds team-layer binaries", () => {
    const deps = dependenciesForProfile("team");
    const bins = deps.map((d) => d.binary);
    expect(bins).toContain("memory-router-user-prompt-submit");
    expect(bins).toContain("agent-tasks-mcp-bridge");
    expect(bins).toContain("grounding-mcp");
    // No duplicates after the chain merge.
    expect(new Set(bins).size).toBe(bins.length);
  });

  it("full inherits team + adds codebase-oracle", () => {
    const deps = dependenciesForProfile("full");
    const bins = deps.map((d) => d.binary);
    expect(bins).toContain("codebase-oracle");
    expect(bins).toContain("agent-tasks-mcp-bridge");
    expect(bins).toContain("memory-router-user-prompt-submit");
  });
});

describe("checkDependencies — PATH resolution", () => {
  it("reports all-missing when PATH has no relevant binaries", () => {
    const result = checkDependencies("solo", { pathEnv: tmpBin });
    expect(result.statuses.every((s) => !s.installed)).toBe(true);
    expect(result.missingPackages).toContain("@lannguyensi/memory-router");
    expect(result.missingPackages).toContain("@lannguyensi/understanding-gate");
  });

  it("dedupes missingPackages when several binaries share one npm package", () => {
    const result = checkDependencies("solo", { pathEnv: tmpBin });
    // understanding-gate ships two binaries the solo profile uses; the
    // missing-packages list should de-duplicate them.
    const ugCount = result.missingPackages.filter(
      (p) => p === "@lannguyensi/understanding-gate",
    ).length;
    expect(ugCount).toBe(1);
  });

  it("flags a present binary as installed and removes its package from the missing list", () => {
    makeExecutable("memory-router-user-prompt-submit");
    const result = checkDependencies("solo", { pathEnv: tmpBin });
    const mr = result.statuses.find((s) => s.dep.binary === "memory-router-user-prompt-submit");
    expect(mr?.installed).toBe(true);
    expect(mr?.resolvedPath).toBe(path.join(tmpBin, "memory-router-user-prompt-submit"));
    expect(result.missingPackages).not.toContain("@lannguyensi/memory-router");
  });
});

describe("formatDependencyTable — rendered surface", () => {
  it("renders one row per binary with check/cross marks", () => {
    const result = checkDependencies("solo", { pathEnv: tmpBin });
    const text = formatDependencyTable("solo", result);
    expect(text).toContain('Profile "solo"');
    expect(text).toContain("✗ memory-router-user-prompt-submit");
    expect(text).toContain("→ @lannguyensi/memory-router");
  });

  it('announces "all present" when nothing is missing', () => {
    makeExecutable("memory-router-user-prompt-submit");
    makeExecutable("understanding-gate-claude-hook");
    makeExecutable("understanding-gate-claude-stop");
    const result = checkDependencies("solo", { pathEnv: tmpBin });
    const text = formatDependencyTable("solo", result);
    expect(text).toContain("All required binaries are already on PATH.");
  });
});

describe("installPackagesGlobally — runner contract", () => {
  it("short-circuits on empty input without spawning anything", async () => {
    let called = false;
    const result = await installPackagesGlobally([], {
      spawn: async () => {
        called = true;
        return { code: 0, stderr: "" };
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.attempted).toHaveLength(0);
  });

  it("forwards the package list verbatim to npm i -g", async () => {
    let receivedArgs: string[] = [];
    const result = await installPackagesGlobally(["@lannguyensi/a", "@lannguyensi/b"], {
      spawn: async (_cmd: string, args: string[]) => {
        receivedArgs = args;
        return { code: 0, stderr: "" };
      },
    });
    expect(receivedArgs).toEqual(["i", "-g", "@lannguyensi/a", "@lannguyensi/b"]);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false and propagates stderr + exit code on failure", async () => {
    const result = await installPackagesGlobally(["@nope/pkg"], {
      spawn: async () => ({ code: 1, stderr: "npm ERR! 404 Not Found\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("404");
  });
});
