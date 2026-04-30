import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import type { McpProbe, McpProbeResult } from "../../src/probes/mcp.js";
import type { McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

class FakeProbe implements McpProbe {
  constructor(private readonly outcomes: Record<string, McpProbeResult["outcome"]>) {}
  async call(server: McpServer): Promise<McpProbeResult> {
    return {
      name: server.name,
      outcome: this.outcomes[server.name] ?? { kind: "missing-verb" },
    };
  }
}

describe("doctor — Appendix D structure", () => {
  it("renders Manifest / Tools / Memory / Hooks / Policies / Summary sections in order", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  builtin:
    known: [Read, Edit]
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      versionProbe: () => null,
      pathEnv: "",
    });
    const text = format(report);
    expect(text).toMatch(/Manifest\n/);
    expect(text).toMatch(/\nTools\n/);
    expect(text).toMatch(/\nMemory\n/);
    expect(text).toMatch(/\nHooks\n/);
    expect(text).toMatch(/\nPolicies\n/);
    expect(text).toMatch(/\nSummary\n/);
    expect(text.indexOf("Manifest")).toBeLessThan(text.indexOf("Tools"));
    expect(text.indexOf("Tools")).toBeLessThan(text.indexOf("Memory"));
    expect(text.indexOf("Memory")).toBeLessThan(text.indexOf("Hooks"));
    expect(text.indexOf("Hooks")).toBeLessThan(text.indexOf("Policies"));
    expect(text.indexOf("Policies")).toBeLessThan(text.indexOf("Summary"));
  });
});

describe("doctor — MCP probe surfacing", () => {
  it("renders broken MCP servers with the actual error message, not a generic label", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: codebase-oracle
      command: [/usr/bin/true]
      health:
        verb: oracle_list_repos
        timeout_ms: 1000
      enabled: true
`,
    });
    const probe = new FakeProbe({
      "codebase-oracle": {
        kind: "error",
        latencyMs: 412,
        message: "process exit 1: Cannot find module 'sqlite-vec'",
      },
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: probe,
      pathEnv: "",
    });
    const text = format(report);
    expect(text).toContain("codebase-oracle");
    expect(text).toContain("Cannot find module 'sqlite-vec'");
    expect(report.errorCount).toBe(1);
  });

  it("reports `unknown — no health verb declared` when health block is absent", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: bare-mcp
      command: [/usr/bin/true]
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({}),
      pathEnv: "",
    });
    expect(report.tools.mcp[0]?.outcome.kind).toBe("missing-verb");
    expect(format(report)).toContain("unknown — no health verb declared");
  });

  it("emits a healthy line with the probe latency", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: alpha
      command: [/usr/bin/true]
      health:
        verb: ping
      enabled: true
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      mcpProbe: new FakeProbe({ alpha: { kind: "healthy", latencyMs: 89 } }),
      pathEnv: "",
    });
    expect(format(report)).toContain("✓ alpha  healthy in 89ms");
  });
});

describe("doctor — --shallow timing budget", () => {
  it("completes in under 100ms against an 8-MCP-server fixture (no real probes)", async () => {
    const mcpEntries = Array.from({ length: 8 }, (_, i) => `
    - name: server-${i}
      command: [/usr/bin/true]
      health:
        verb: ping
      enabled: true`).join("\n");
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
tools:
  mcp:${mcpEntries}
`,
    });
    const start = performance.now();
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      pathEnv: "",
    });
    const elapsed = performance.now() - start;
    expect(report.tools.mcp).toHaveLength(8);
    expect(report.shallow).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("doctor — stale memory detection", () => {
  it("surfaces memory files older than retention.staleness_days", async () => {
    const home = makeFixture({
      "memory/dir/old.md": "# old\n",
      "memory/dir/fresh.md": "# fresh\n",
    });
    const oldPath = path.join(home, "memory/dir/old.md");
    const freshPath = path.join(home, "memory/dir/fresh.md");
    const now = new Date("2026-04-29T00:00:00Z");
    const oldTime = new Date("2025-09-01T00:00:00Z");
    const freshTime = new Date("2026-04-20T00:00:00Z");
    fs.utimesSync(oldPath, oldTime, oldTime);
    fs.utimesSync(freshPath, freshTime, freshTime);

    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      `version: 1
hooks: []
policies: []
memory:
  directories:
    - path: ${path.join(home, "memory/dir")}
      scope: project
  retention:
    staleness_days: 30
`,
      "utf8",
    );
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      now,
      pathEnv: "",
    });
    const stalePaths = report.memory.staleMemories.map((m) => m.path);
    expect(stalePaths).toContain(oldPath);
    expect(stalePaths).not.toContain(freshPath);
    const text = format(report);
    expect(text).toContain("haven't been touched");
    expect(text).toContain("2025-09-01");
  });
});

describe("doctor — summary counts", () => {
  it("counts errors and warnings across sections", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: missing-hook
    event: SessionStart
    command: ${path.join("{{HOME}}", "no-such.sh")}
    blocking: false
policies: []
tools:
  mcp:
    - name: dead
      command: [/usr/bin/true]
      health:
        verb: x
      enabled: true
  cli:
    - name: optional-missing
      binary: this-cannot-exist-00000
      required: false
  builtin:
    known: []
`.replace("{{HOME}}", "${HOME}"),
    });
    const manifestPath = path.join(home, "harness.yaml");
    let contents = fs.readFileSync(manifestPath, "utf8");
    contents = contents.replace("${HOME}", home);
    fs.writeFileSync(manifestPath, contents, "utf8");

    const report = await doctor({
      configPath: manifestPath,
      homeOverride: home,
      mcpProbe: new FakeProbe({
        dead: { kind: "error", latencyMs: 50, message: "exit 1" },
      }),
      pathEnv: "/nonexistent",
      versionProbe: () => null,
    });
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toMatch(/\d+ errors?/);
    expect(text).toMatch(/\d+ warnings?/);
  });
});

describe("doctor — full reference manifest header line", () => {
  it("includes the manifest path, version, and shallow tag when --shallow is set", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      shallow: true,
      pathEnv: "",
    });
    const text = format(report);
    expect(text).toMatch(/^harness 0\.4\.0/);
    expect(text).toContain(`(version 1) [shallow]`);
  });
});
