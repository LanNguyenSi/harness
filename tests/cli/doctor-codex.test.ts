import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../src/cli/apply/index.js";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

class FakeProbe implements McpProbe {
  async call(server: McpServer): Promise<McpProbeResult> {
    return { name: server.name, outcome: { kind: "missing-verb" } };
  }
}

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-codex-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeManifestWithPack(home: string): string {
  const manifest = {
    version: 1,
    tools: {
      mcp: [],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: [] },
    hooks: [],
    policies: [],
    policy_packs: [{ name: "understanding-before-execution" }],
  };
  const target = path.join(home, "harness.yaml");
  fs.writeFileSync(target, yamlStringify(manifest));
  return target;
}

function fakeHarnessBinary(home: string): string {
  // A real, executable file the harness-binary check accepts.
  const bin = path.join(home, "fake-harness");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe("doctor --target codex", () => {
  it("returns OK against the dogfood-shape manifest after harness apply --runtime codex", async () => {
    const home = tempHome();
    writeManifestWithPack(home);
    await apply({ homeDir: home, runtime: "codex" });

    const harnessBin = fakeHarnessBinary(home);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      target: "codex",
      codexCheckOptions: {
        manifestDir: home,
        harnessBinary: harnessBin,
        cwd: home,
        versionProbe: () => "harness 0.7.0",
      },
    });

    expect(report.codexTarget).toBeDefined();
    expect(report.codexTarget!.target).toBe("codex");
    const errorChecks = report.codexTarget!.checks.filter((c) => c.status === "error");
    expect(errorChecks).toEqual([]);
    expect(
      report.codexTarget!.checks.some(
        (c) => c.name === "harness binary" && c.status === "ok",
      ),
    ).toBe(true);
    expect(
      report.codexTarget!.checks.some(
        (c) => c.name === "codex-* subcommands" && c.status === "ok",
      ),
    ).toBe(true);
    expect(
      report.codexTarget!.checks.some(
        (c) => c.name === "codex config artefact" && c.status === "ok",
      ),
    ).toBe(true);
    expect(
      report.codexTarget!.checks.some(
        (c) =>
          c.name.startsWith("hook policy-pack:understanding-before-execution:codex:") &&
          c.status === "ok",
      ),
    ).toBe(true);
  });

  it("reports a single error (no cascade) when the harness binary cannot be resolved", async () => {
    const home = tempHome();
    writeManifestWithPack(home);
    await apply({ homeDir: home, runtime: "codex" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/nonexistent/dir",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      target: "codex",
      codexCheckOptions: {
        manifestDir: home,
        cwd: home,
        // No harnessBinary override; with empty PATH the lookup fails.
      },
    });

    expect(report.codexTarget).toBeDefined();
    const harnessCheck = report.codexTarget!.checks.find(
      (c) => c.name === "harness binary",
    );
    expect(harnessCheck?.status).toBe("error");
    expect(harnessCheck?.message).toMatch(/not found on PATH/);
    // The codex-* subcommands check is suppressed entirely (would
    // otherwise double-count this same root cause in errorCount).
    expect(
      report.codexTarget!.checks.some((c) => c.name === "codex-* subcommands"),
    ).toBe(false);
    // Exactly one codex-section error: the missing binary.
    const codexErrors = report.codexTarget!.checks.filter((c) => c.status === "error");
    expect(codexErrors.length).toBe(1);
  });

  it("reports an error when the harness on PATH is older than the codex-* introduction", async () => {
    const home = tempHome();
    writeManifestWithPack(home);
    await apply({ homeDir: home, runtime: "codex" });

    const harnessBin = fakeHarnessBinary(home);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      target: "codex",
      codexCheckOptions: {
        manifestDir: home,
        harnessBinary: harnessBin,
        cwd: home,
        versionProbe: () => "harness 0.6.4",
      },
    });

    const subcmdCheck = report.codexTarget!.checks.find(
      (c) => c.name === "codex-* subcommands",
    );
    expect(subcmdCheck?.status).toBe("error");
    expect(subcmdCheck?.message).toMatch(/v0\.6\.4.*require >= 0\.7\.0/);
  });

  it("warns (not errors) when the version probe fails to respond cleanly", async () => {
    const home = tempHome();
    writeManifestWithPack(home);
    await apply({ homeDir: home, runtime: "codex" });

    const harnessBin = fakeHarnessBinary(home);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      target: "codex",
      codexCheckOptions: {
        manifestDir: home,
        harnessBinary: harnessBin,
        cwd: home,
        versionProbe: () => null,
      },
    });

    const subcmdCheck = report.codexTarget!.checks.find(
      (c) => c.name === "codex-* subcommands",
    );
    expect(subcmdCheck?.status).toBe("warn");
    expect(subcmdCheck?.message).toMatch(/did not respond cleanly/);
  });

  it("reports an error when the codex config artefact has not been generated", async () => {
    const home = tempHome();
    writeManifestWithPack(home);
    // Skip the apply step on purpose.

    const harnessBin = fakeHarnessBinary(home);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      target: "codex",
      codexCheckOptions: {
        manifestDir: home,
        harnessBinary: harnessBin,
        cwd: home,
      },
    });

    const configCheck = report.codexTarget!.checks.find(
      (c) => c.name === "codex config artefact",
    );
    expect(configCheck?.status).toBe("error");
    expect(configCheck?.message).toMatch(/run `harness apply --runtime codex`/);
  });

  it("the format output includes a `Target: codex` section when present", async () => {
    const home = tempHome();
    writeManifestWithPack(home);
    await apply({ homeDir: home, runtime: "codex" });

    const harnessBin = fakeHarnessBinary(home);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
      target: "codex",
      codexCheckOptions: {
        manifestDir: home,
        harnessBinary: harnessBin,
        cwd: home,
      },
    });

    const text = format(report);
    expect(text).toMatch(/\nTarget: codex\n/);
    expect(text).toMatch(/✓ harness binary/);
    expect(text).toMatch(/✓ codex config artefact/);
  });

  it("the codex section is absent when --target is not passed (back-compat)", async () => {
    const home = tempHome();
    writeManifestWithPack(home);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: async () => ({ code: 1, stdout: "", stderr: "stub" }),
    });

    expect(report.codexTarget).toBeUndefined();
    expect(format(report)).not.toContain("Target: codex");
  });
});
