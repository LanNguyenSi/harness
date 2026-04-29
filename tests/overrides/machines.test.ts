import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  machineOverrideCandidates,
  resolveMachineDiscriminators,
} from "../../src/overrides/machines.js";

function makeFakeProcVersion(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-machines-"));
  const file = path.join(dir, "version");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

let toCleanup: string[] = [];

afterEach(() => {
  for (const f of toCleanup) {
    try {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  toCleanup = [];
});

describe("resolveMachineDiscriminators", () => {
  it("returns wsl2 when /proc/version contains 'microsoft'", () => {
    const procVersionPath = makeFakeProcVersion(
      "Linux version 5.15.153.1-microsoft-standard-WSL2 (...)",
    );
    toCleanup.push(procVersionPath);
    const d = resolveMachineDiscriminators({
      hostname: "MY-WSL",
      platform: "linux",
      procVersionPath,
    });
    expect(d.os).toBe("wsl2");
    expect(d.hostname).toBe("my-wsl");
  });

  it("returns linux on Linux without microsoft string", () => {
    const procVersionPath = makeFakeProcVersion("Linux version 6.5.0-generic ...");
    toCleanup.push(procVersionPath);
    const d = resolveMachineDiscriminators({
      hostname: "vps-01",
      platform: "linux",
      procVersionPath,
    });
    expect(d.os).toBe("linux");
  });

  it("returns darwin on macOS regardless of /proc/version", () => {
    const d = resolveMachineDiscriminators({
      hostname: "macbook",
      platform: "darwin",
      procVersionPath: "/nonexistent",
    });
    expect(d.os).toBe("darwin");
  });

  it("falls back to default on unexpected platforms", () => {
    const d = resolveMachineDiscriminators({
      hostname: "h",
      platform: "freebsd" as NodeJS.Platform,
      procVersionPath: "/nonexistent",
    });
    expect(d.os).toBe("default");
  });

  it("treats a missing /proc/version as non-WSL2 on Linux", () => {
    const d = resolveMachineDiscriminators({
      hostname: "h",
      platform: "linux",
      procVersionPath: "/nonexistent/proc/version",
    });
    expect(d.os).toBe("linux");
  });
});

describe("machineOverrideCandidates", () => {
  it("returns default → os → hostname order, deduplicated", () => {
    const cands = machineOverrideCandidates({ hostname: "vps-01", os: "linux" });
    expect(cands).toEqual(["default", "linux", "vps-01"]);
  });

  it("dedupes when hostname equals os string", () => {
    const cands = machineOverrideCandidates({ hostname: "linux", os: "linux" });
    expect(cands).toEqual(["default", "linux"]);
  });

  it("omits empty hostname", () => {
    const cands = machineOverrideCandidates({ hostname: "", os: "linux" });
    expect(cands).toEqual(["default", "linux"]);
  });
});
