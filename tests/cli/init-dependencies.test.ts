import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDependencies,
  dependenciesForCustom,
  dependenciesForProfile,
  formatDependencyTable,
  installPackagesGlobally,
} from "../../src/cli/init/dependencies.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";
import { GIT_PREFLIGHT_HOOK_MIN_VERSION } from "../../src/cli/init/templates.js";
import { SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION } from "../../src/schema/session-start-preflight.js";

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

  it("full extends the team chain with the agent-preflight producer", () => {
    // Full inherits the whole Team chain and adds exactly one binary:
    // `preflight` (the SessionStart preflight producer). The
    // codebase-oracle MCP server is intentionally NOT in the chain —
    // it is a useful standalone but an opinionated workflow add-on
    // that operators wire manually if they want multi-repo RAG.
    const fullBins = dependenciesForProfile("full").map((d) => d.binary);
    const teamBins = dependenciesForProfile("team").map((d) => d.binary);
    expect(fullBins).toEqual([...teamBins, "preflight"]);
    expect(fullBins).not.toContain("codebase-oracle");
    const preflight = dependenciesForProfile("full").find((d) => d.binary === "preflight");
    expect(preflight?.npmPackage).toBe("@lannguyensi/agent-preflight");
  });

  // Task 6993d9b5, round 2 F2: the wizard's own minVersion floor for
  // `preflight` must share the same 0.6.0 build-capable floor as the
  // FULL_TEMPLATE git-preflight hook, so `harness init --template
  // full` never tells an operator that a pre-build-step preflight
  // suffices while the generated manifest's min_version (and the next
  // `harness doctor` run) says otherwise. Task 65952a0c
  // (docs/decisions/2026-09-08-preflight-floors.md) split the shared
  // constant this used to read into a hook floor
  // (GIT_PREFLIGHT_HOOK_MIN_VERSION, src/cli/init/templates.ts) and a
  // separate setup floor (SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION,
  // src/schema/session-start-preflight.ts); this table must track the
  // HOOK floor, since that is what the generated manifest's own
  // min_version declares.
  it("full's preflight dep shares GIT_PREFLIGHT_HOOK_MIN_VERSION, not a stale floor", () => {
    const preflight = dependenciesForProfile("full").find((d) => d.binary === "preflight");
    expect(preflight?.minVersion).toBe(GIT_PREFLIGHT_HOOK_MIN_VERSION);
    expect(preflight?.minVersion).toBe("0.6.0");
  });

  // Discriminates by source identity, not value: GIT_PREFLIGHT_HOOK_MIN_VERSION
  // and SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION are both "0.6.0"
  // today, so a mutant that swaps which constant dependencies.ts's
  // `minVersion:` field reads would pass the value-only assertion above
  // unnoticed. Reading the source text and asserting which identifier
  // the `minVersion:` line interpolates is what catches that swap.
  it("dependencies.ts's minVersion field reads the HOOK floor identifier, not the setup floor", () => {
    const src = readFileSync(new URL("../../src/cli/init/dependencies.ts", import.meta.url), "utf8");
    const minVersionLine = src
      .split("\n")
      .find((line) => line.trim().startsWith("minVersion:") && line.includes("MIN_VERSION"));
    expect(minVersionLine, "minVersion: field not found in dependencies.ts").toBeDefined();
    expect(minVersionLine).toContain("GIT_PREFLIGHT_HOOK_MIN_VERSION");
    expect(minVersionLine).not.toContain("SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION");
  });

  it("the split hook and setup floors still agree in value today", () => {
    expect(GIT_PREFLIGHT_HOOK_MIN_VERSION).toBe(SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION);
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
    // minVersion floor is shown in the missing-row arrow target so
    // operators see the floor without an extra column (agent-tasks/3a536aca).
    expect(text).toContain("→ @lannguyensi/memory-router@0.3.0+");
    expect(text).toContain("→ @lannguyensi/understanding-gate@0.4.0+");
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

  it("hermetic guard (task 54739002): a non-empty package list with NO injected spawn hits the real `npm i -g` runner, which must refuse under vitest", async () => {
    // Meta-test for the hermetic-spawn guard on realSpawn
    // (src/cli/init/dependencies.ts). No `spawn` in opts at all, so
    // `installPackagesGlobally` falls back to `realSpawn`, which must
    // refuse to actually run `npm i -g` under vitest. Non-inert: remove
    // the `assertNoRealSpawnInTests(...)` call at the top of `realSpawn`
    // and this rejects on a hang/real spawn attempt instead of the
    // expected HermeticSpawnViolationError (and, if a real `npm` were on
    // PATH, would actually attempt a global install).
    await expect(installPackagesGlobally(["@lannguyensi/does-not-matter"], {})).rejects.toThrow(
      HermeticSpawnViolationError,
    );
  });
});

describe("dependenciesForCustom — grounding-mcp auto-add mirror", () => {
  it("includes grounding-mcp dep when policies are non-empty and grounding-mcp is not in sel.mcps (mirrors composeCustom H3 auto-add predicate)", () => {
    const deps = dependenciesForCustom({
      packs: [],
      mcps: [],
      policies: ["review-before-merge"],
      memoryDir: "~/.claude/projects/{project}/memory",
    });
    const bins = deps.map((d) => d.binary);
    expect(bins).toContain("grounding-mcp");
    const gmDep = deps.find((d) => d.binary === "grounding-mcp");
    expect(gmDep?.npmPackage).toBe("@lannguyensi/grounding-mcp");
  });

  it("does NOT double-add grounding-mcp when it is already in sel.mcps", () => {
    const deps = dependenciesForCustom({
      packs: [],
      mcps: ["grounding-mcp"],
      policies: ["review-before-merge"],
      memoryDir: "~/.claude/projects/{project}/memory",
    });
    const gmEntries = deps.filter((d) => d.binary === "grounding-mcp");
    expect(gmEntries).toHaveLength(1);
  });

  it("does NOT include grounding-mcp dep when policies array is empty (no auto-add needed)", () => {
    const deps = dependenciesForCustom({
      packs: ["understanding-before-execution"],
      mcps: [],
      policies: [],
      memoryDir: "~/.claude/projects/{project}/memory",
    });
    const bins = deps.map((d) => d.binary);
    expect(bins).not.toContain("grounding-mcp");
  });
});
