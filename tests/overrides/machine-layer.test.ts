import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyLayers } from "../../src/overrides/merge.js";
import {
  machineOverrideCandidates,
  resolveMachineDiscriminators,
} from "../../src/overrides/machines.js";

interface FixtureFs {
  baseManifest: unknown;
  machineFiles: Record<string, unknown>;
  procVersionPath: string;
  cleanup: () => void;
}

function setupFixture(procVersionContents: string): FixtureFs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-machine-layer-"));
  fs.writeFileSync(path.join(root, "version"), procVersionContents, "utf8");

  const base = {
    version: 1,
    tools: {
      mcp: [
        {
          name: "codebase-oracle",
          command: ["{{HARNESS_HOME}}/oracle/dist/server.js"],
          enabled: true,
        },
      ],
    },
  };
  const wsl2Override = {
    version: 1,
    tools: {
      mcp: [
        {
          name: "codebase-oracle",
          command: ["/home/lan/git/pandora/codebase-oracle/dist/server.js"],
        },
      ],
    },
  };
  const linuxOverride = {
    version: 1,
    tools: {
      mcp: [
        {
          name: "codebase-oracle",
          command: ["/srv/oracle/dist/server.js"],
        },
      ],
    },
  };

  return {
    baseManifest: base,
    machineFiles: { wsl2: wsl2Override, linux: linuxOverride },
    procVersionPath: path.join(root, "version"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function pickMachineLayer(
  files: Record<string, unknown>,
  candidates: string[],
): unknown[] {
  return candidates
    .map((c) => files[c])
    .filter((v): v is unknown => v !== undefined);
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe("per-machine override layer", () => {
  it("merges the wsl2 layer when /proc/version contains microsoft", () => {
    const fx = setupFixture(
      "Linux version 5.15.153.1-microsoft-standard-WSL2 (...)",
    );
    cleanups.push(fx.cleanup);
    const d = resolveMachineDiscriminators({
      hostname: "wsl-host",
      platform: "linux",
      procVersionPath: fx.procVersionPath,
    });
    expect(d.os).toBe("wsl2");
    const layers = pickMachineLayer(fx.machineFiles, machineOverrideCandidates(d));
    const merged = applyLayers(fx.baseManifest, ...layers);
    expect((merged as any).tools.mcp[0].command).toEqual([
      "/home/lan/git/pandora/codebase-oracle/dist/server.js",
    ]);
  });

  it("falls back to the base manifest on a non-WSL Linux host where no machine layer exists", () => {
    const fx = setupFixture("Linux version 6.5.0-generic (...)");
    cleanups.push(fx.cleanup);
    fx.machineFiles = {};
    const d = resolveMachineDiscriminators({
      hostname: "vps-99",
      platform: "linux",
      procVersionPath: fx.procVersionPath,
    });
    expect(d.os).toBe("linux");
    const layers = pickMachineLayer(fx.machineFiles, machineOverrideCandidates(d));
    expect(layers).toEqual([]);
    const merged = applyLayers(fx.baseManifest, ...layers);
    expect((merged as any).tools.mcp[0].command).toEqual([
      "{{HARNESS_HOME}}/oracle/dist/server.js",
    ]);
  });

  it("layers default → os → hostname when all are present", () => {
    const fx = setupFixture("Linux version 6.5.0-generic (...)");
    cleanups.push(fx.cleanup);
    fx.machineFiles = {
      default: {
        version: 1,
        tools: {
          mcp: [{ name: "codebase-oracle", enabled: true, env: { TIER: "default" } }],
        },
      },
      linux: {
        version: 1,
        tools: {
          mcp: [{ name: "codebase-oracle", env: { TIER: "linux" } }],
        },
      },
      "vps-01": {
        version: 1,
        tools: {
          mcp: [{ name: "codebase-oracle", env: { TIER: "vps-01" } }],
        },
      },
    };
    const d = resolveMachineDiscriminators({
      hostname: "vps-01",
      platform: "linux",
      procVersionPath: fx.procVersionPath,
    });
    const layers = pickMachineLayer(fx.machineFiles, machineOverrideCandidates(d));
    const merged = applyLayers(fx.baseManifest, ...layers);
    expect((merged as any).tools.mcp[0].env).toEqual({ TIER: "vps-01" });
  });
});
