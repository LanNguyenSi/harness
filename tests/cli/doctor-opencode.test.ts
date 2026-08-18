import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../src/cli/apply/index.js";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import type { ClaudeMcpExec } from "../../src/io/claude-mcp.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

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

// The manifests below declare a non-empty tools.mcp[], which activates
// doctor's separate `claudeMcp` registration section (task
// init-mcp-wiring-claude-code/T-003). That section spawns a real `claude
// mcp list` unless `claudeMcpExec` is injected -- unrelated to the
// opencode adapter under test here, but required to keep every test
// hermetic (see tests/cli/doctor-claude-mcp.test.ts's own header for the
// same convention).
function execCliMissing(): ClaudeMcpExec {
  return async () => ({ code: 127, stdout: "", stderr: "", enoent: true, timedOut: false });
}

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-opencode-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeManifest(home: string, extra: Record<string, unknown> = {}): string {
  const manifest = {
    version: 1,
    tools: {
      mcp: [{ name: "agent-tasks", command: "/bin/echo" }],
      cli: [],
      skills: { enabled: [], source_dirs: [] },
      builtin: { known: [] },
    },
    memory: { directories: [] },
    hooks: [],
    policies: [],
    ...extra,
  };
  const target = path.join(home, "harness.yaml");
  fs.writeFileSync(target, yamlStringify(manifest));
  return target;
}

describe("doctor --target opencode", () => {
  it("returns OK against a manifest with a resolvable MCP command, after harness apply --runtime opencode", async () => {
    const home = tempHome();
    writeManifest(home);
    await apply({ homeDir: home, runtime: "opencode" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home },
    });

    expect(report.opencodeTarget).toBeDefined();
    expect(report.opencodeTarget!.target).toBe("opencode");
    const errorChecks = report.opencodeTarget!.checks.filter((c) => c.status === "error");
    expect(errorChecks).toEqual([]);
    expect(
      report.opencodeTarget!.checks.some(
        (c) => c.name === "opencode config artefact" && c.status === "ok",
      ),
    ).toBe(true);
    expect(
      report.opencodeTarget!.checks.some(
        (c) => c.name === "mcp agent-tasks" && c.status === "ok",
      ),
    ).toBe(true);
  });

  it("errors when the opencode config artefact was never generated", async () => {
    const home = tempHome();
    writeManifest(home);
    // No `apply --runtime opencode` this time.

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home },
    });

    const artefactCheck = report.opencodeTarget!.checks.find(
      (c) => c.name === "opencode config artefact",
    );
    expect(artefactCheck?.status).toBe("error");
    expect(artefactCheck?.message).toMatch(/not found; run `harness apply --runtime opencode`/);
    expect(report.errorCount).toBeGreaterThan(0);
  });

  it("errors when a projected MCP server's command does not resolve on PATH", async () => {
    const home = tempHome();
    writeManifest(home, {
      tools: {
        mcp: [{ name: "ghost", command: "totally-not-a-real-binary" }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    await apply({ homeDir: home, runtime: "opencode" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home, pathEnv: "/nonexistent/dir" },
    });

    const mcpCheck = report.opencodeTarget!.checks.find((c) => c.name === "mcp ghost");
    expect(mcpCheck?.status).toBe("error");
    expect(mcpCheck?.message).toMatch(/not found on PATH/);
  });

  it("warns when the config artefact exists but does not carry the harness banner (hand-edited)", async () => {
    const home = tempHome();
    writeManifest(home);
    const target = path.join(home, "harness.generated", "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{ "mcp": {} }\n');

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home },
    });

    const artefactCheck = report.opencodeTarget!.checks.find(
      (c) => c.name === "opencode config artefact",
    );
    expect(artefactCheck?.status).toBe("warn");
    expect(artefactCheck?.message).toMatch(/hand-edited/);
  });

  it("does not PATH-check a disabled tools.mcp[] entry's marker (LOW-F4)", async () => {
    const home = tempHome();
    writeManifest(home, {
      tools: {
        mcp: [{ name: "off", command: "totally-not-a-real-binary", enabled: false }],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    await apply({ homeDir: home, runtime: "opencode" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/nonexistent/dir",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home, pathEnv: "/nonexistent/dir" },
    });

    // Before this fix, `mcp["off"]` in the generated config carried a
    // `{"enabled": false}` marker with no `.command` field, and
    // checkMcpCommands crashed reading `.command[0]` off it. Now it
    // reports `ok` (nothing to resolve) instead.
    const mcpCheck = report.opencodeTarget!.checks.find((c) => c.name === "mcp off");
    expect(mcpCheck?.status).toBe("ok");
    expect(mcpCheck?.message).toMatch(/disabled/);
    const errorChecks = report.opencodeTarget!.checks.filter((c) => c.status === "error");
    expect(errorChecks).toEqual([]);
  });

  it("warns (not errors) when no MCP servers are projected", async () => {
    const home = tempHome();
    writeManifest(home, {
      tools: {
        mcp: [],
        cli: [],
        skills: { enabled: [], source_dirs: [] },
        builtin: { known: [] },
      },
    });
    await apply({ homeDir: home, runtime: "opencode" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home },
    });

    const mcpCheck = report.opencodeTarget!.checks.find(
      (c) => c.name === "opencode MCP servers",
    );
    expect(mcpCheck?.status).toBe("warn");
    expect(mcpCheck?.message).toMatch(/no MCP servers projected/);
    const errorChecks = report.opencodeTarget!.checks.filter((c) => c.status === "error");
    expect(errorChecks).toEqual([]);
  });

  it("omits opencodeTarget when --target opencode is not passed", async () => {
    const home = tempHome();
    writeManifest(home);
    await apply({ homeDir: home, runtime: "opencode" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
    });

    expect(report.opencodeTarget).toBeUndefined();
  });

  it("renders a 'Target: opencode' section in the prose report", async () => {
    const home = tempHome();
    writeManifest(home);
    await apply({ homeDir: home, runtime: "opencode" });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe(),
      versionProbe: () => null,
      pathEnv: "/bin",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      claudeMcpExec: execCliMissing(),
      target: "opencode",
      opencodeCheckOptions: { manifestDir: home },
    });

    const prose = format(report);
    expect(prose).toContain("Target: opencode");
    expect(prose).toContain("opencode config artefact");
  });
});
