import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe as describeBlock, expect, it } from "vitest";
import { describe } from "../../src/cli/describe.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const EXAMPLES = path.join(REPO_ROOT, "docs", "examples");
const FULL_MANIFEST = path.join(EXAMPLES, "full-manifest.yaml");
const GOLDEN = path.join(EXAMPLES, "full-manifest.expected.yaml");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeHome(layout: { base?: string; project?: { name: string; contents: string } }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-describe-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  if (layout.base) {
    fs.writeFileSync(path.join(home, "harness.yaml"), layout.base, "utf8");
  }
  if (layout.project) {
    const projectDir = path.join(home, "projects", layout.project.name);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      layout.project.contents,
      "utf8",
    );
  }
  return home;
}

describeBlock("describe — golden output", () => {
  it("reproduces the golden merged manifest byte-for-byte", () => {
    const expected = fs.readFileSync(GOLDEN, "utf8");
    const result = describe({
      configPath: FULL_MANIFEST,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(result.output).toBe(expected);
  });
});

describeBlock("describe — --pillar filter", () => {
  it("emits only version + the requested pillar", () => {
    const result = describe({
      configPath: FULL_MANIFEST,
      pillar: "tools",
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(result.output).toMatch(/^version: 1\n/);
    expect(result.output).toContain("\ntools:\n");
    expect(result.output).not.toContain("\ngrounding:");
    expect(result.output).not.toContain("\nmemory:");
    expect(result.output).not.toContain("\nhooks:");
    expect(result.output).not.toContain("\npolicies:");
  });

  it("filters to grounding only", () => {
    const result = describe({
      configPath: FULL_MANIFEST,
      pillar: "grounding",
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(result.output).toContain("\ngrounding:\n");
    expect(result.output).not.toContain("\ntools:\n");
  });
});

describeBlock("describe — --json", () => {
  it("emits valid JSON", () => {
    const result = describe({
      configPath: FULL_MANIFEST,
      json: true,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.tools.mcp).toHaveLength(3);
    expect(parsed.policies).toHaveLength(13);
  });

  it("emits valid filtered JSON when --pillar is combined with --json", () => {
    const result = describe({
      configPath: FULL_MANIFEST,
      pillar: "policies",
      json: true,
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    const parsed = JSON.parse(result.output);
    expect(Object.keys(parsed)).toEqual(["version", "policies"]);
    expect(parsed.policies[0].name).toBe("review-before-merge");
  });
});

describeBlock("describe — --project overrides", () => {
  it("applies the project override layer", () => {
    const home = makeHome({
      base: `version: 1
tools:
  mcp:
    - name: codebase-oracle
      command: [npx, tsx, /tmp/oracle.ts]
      enabled: true
    - name: agent-tasks
      command: [node, /tmp/tasks.js]
      enabled: true
hooks: []
policies: []
`,
      project: {
        name: "agent-grounding",
        contents: `version: 1
tools:
  mcp:
    - name: codebase-oracle
      enabled: false
`,
      },
    });

    const result = describe({
      homeDir: home,
      project: "agent-grounding",
      pillar: "tools",
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(result.manifest.tools.mcp.find((m) => m.name === "codebase-oracle")?.enabled).toBe(false);
    expect(result.manifest.tools.mcp.find((m) => m.name === "agent-tasks")?.enabled).toBe(true);
  });

  it("ignores the project flag when no overrides file is present", () => {
    const home = makeHome({
      base: `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: agent-tasks
      command: [node, /tmp/tasks.js]
      enabled: true
`,
    });
    const result = describe({
      homeDir: home,
      project: "no-such-project",
      pillar: "tools",
      discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(result.manifest.tools.mcp[0]?.enabled).toBe(true);
  });
});

describeBlock("describe — per-machine layer", () => {
  it("merges the machine override file matching the discriminator", () => {
    const home = makeHome({
      base: `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: codebase-oracle
      command: ["{{HARNESS_HOME}}/oracle/server.ts"]
      enabled: true
`,
    });
    const machinesDir = path.join(home, "machines");
    fs.mkdirSync(machinesDir, { recursive: true });
    fs.writeFileSync(
      path.join(machinesDir, "wsl2.harness.overrides.yaml"),
      `version: 1
tools:
  mcp:
    - name: codebase-oracle
      command: ["/home/lan/oracle/server.ts"]
`,
      "utf8",
    );

    const procVersion = path.join(home, "proc-version");
    fs.writeFileSync(procVersion, "Linux microsoft WSL2", "utf8");

    const result = describe({
      homeDir: home,
      pillar: "tools",
      discriminator: { hostname: "x", platform: "linux", procVersionPath: procVersion },
    });
    expect(result.manifest.tools.mcp[0]?.command).toEqual(["/home/lan/oracle/server.ts"]);
  });
});

describeBlock("describe — hostname discriminator beats os layer", () => {
  it("hostname-named machine override wins over the os-named one", () => {
    const home = makeHome({
      base: `version: 1
hooks: []
policies: []
tools:
  mcp:
    - name: codebase-oracle
      command: ["base"]
      enabled: true
`,
    });
    const machinesDir = path.join(home, "machines");
    fs.mkdirSync(machinesDir, { recursive: true });
    fs.writeFileSync(
      path.join(machinesDir, "linux.harness.overrides.yaml"),
      `version: 1
tools: { mcp: [{ name: codebase-oracle, command: ["from-os"] }] }
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(machinesDir, "vps-01.harness.overrides.yaml"),
      `version: 1
tools: { mcp: [{ name: codebase-oracle, command: ["from-host"] }] }
`,
      "utf8",
    );

    const result = describe({
      homeDir: home,
      pillar: "tools",
      discriminator: { hostname: "vps-01", platform: "linux", procVersionPath: "/nonexistent" },
    });
    expect(result.manifest.tools.mcp[0]?.command).toEqual(["from-host"]);
  });
});

describeBlock("describe — error handling", () => {
  it("throws HarnessExitError with EX_NOINPUT when the manifest is missing", () => {
    const home = makeHome({});
    let caught: unknown;
    try {
      describe({
        homeDir: home,
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
    expect((caught as HarnessExitError).message).toMatch(/manifest not found/);
    // First-run DX (task 24ec07a6): the base-manifest miss points at init.
    expect((caught as HarnessExitError).message).toMatch(
      /run `harness init --interactive`/,
    );
  });

  it("throws HarnessExitError with EX_NOINPUT when YAML is malformed", () => {
    const home = makeHome({ base: "version: 1\n  bad indent: !!!\n: : :\n" });
    let caught: unknown;
    try {
      describe({
        homeDir: home,
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
  });

  it("throws HarnessExitError with EX_NOINPUT when manifest schema rejects the document", () => {
    const home = makeHome({ base: "version: 99\n" });
    let caught: unknown;
    try {
      describe({
        homeDir: home,
        discriminator: { hostname: "h", platform: "linux", procVersionPath: "/nonexistent" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(66);
    expect((caught as HarnessExitError).message).toMatch(/version/i);
  });
});
