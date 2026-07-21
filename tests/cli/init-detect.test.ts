import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "../../src/cli/init/detect.js";
import { VERSION } from "../../src/version.js";

let tmpHome: string;
let savedHarnessHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-detect-"));
  // `detect()` resolves the manifest path through `resolveHomeDir`,
  // whose `$HARNESS_HOME` tier outranks the `userHome`-based resolution
  // these tests rely on. Clear it so a CI env leak cannot redirect the
  // probe away from the per-test tmp home.
  savedHarnessHome = process.env.HARNESS_HOME;
  delete process.env.HARNESS_HOME;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
});

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe("init detect — runtime presence", () => {
  it("reports both runtimes absent in a clean home", async () => {
    const r = await detect({ homeDir: tmpHome });
    const claude = r.runtimes.find((x) => x.name === "claude-code");
    const codex = r.runtimes.find((x) => x.name === "codex");
    expect(claude?.homeExists).toBe(false);
    expect(claude?.settingsExists).toBe(false);
    expect(codex?.homeExists).toBe(false);
    expect(codex?.settingsExists).toBe(false);
  });

  it("flags Claude Code present when ~/.claude exists, even without settings.json", async () => {
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    const r = await detect({ homeDir: tmpHome });
    const claude = r.runtimes.find((x) => x.name === "claude-code");
    expect(claude?.homeExists).toBe(true);
    expect(claude?.settingsExists).toBe(false);
    expect(r.mcpServers).toEqual([]);
  });

  it("flags Codex present via ~/.codex/config.toml", async () => {
    fs.mkdirSync(path.join(tmpHome, ".codex"));
    fs.writeFileSync(path.join(tmpHome, ".codex", "config.toml"), "# codex\n");
    const r = await detect({ homeDir: tmpHome });
    const codex = r.runtimes.find((x) => x.name === "codex");
    expect(codex?.homeExists).toBe(true);
    expect(codex?.settingsExists).toBe(true);
  });
});

describe("init detect — manifest presence", () => {
  it("flags ~/.harness/harness.yaml absent in a clean home", async () => {
    const r = await detect({ homeDir: tmpHome });
    expect(r.manifest.exists).toBe(false);
    // Post the v0.24.0 home-dir migration the manifest is probed under
    // the runtime-neutral harness home (resolveHomeDir), not the
    // claude-code runtime dir. A clean home has no ~/.harness/ yet, so
    // resolveHomeDir reports the create-on-first-use ~/.harness/ target.
    expect(r.manifest.path).toBe(path.join(tmpHome, ".harness", "harness.yaml"));
  });

  it("flags ~/.harness/harness.yaml present when the file exists", async () => {
    fs.mkdirSync(path.join(tmpHome, ".harness"));
    fs.writeFileSync(path.join(tmpHome, ".harness", "harness.yaml"), "version: 1\n");
    const r = await detect({ homeDir: tmpHome });
    expect(r.manifest.exists).toBe(true);
    expect(r.manifest.path).toBe(path.join(tmpHome, ".harness", "harness.yaml"));
  });

  it("falls back to a legacy ~/.claude/harness.yaml when state still lives there", async () => {
    // Un-migrated install: harness state physically under ~/.claude/.
    // resolveHomeDir's legacy fallback keeps detect() and init() agreed
    // on that path until the operator runs `harness migrate-home`.
    fs.mkdirSync(path.join(tmpHome, ".claude"));
    fs.writeFileSync(path.join(tmpHome, ".claude", "harness.yaml"), "version: 1\n");
    const r = await detect({ homeDir: tmpHome });
    expect(r.manifest.exists).toBe(true);
    expect(r.manifest.path).toBe(path.join(tmpHome, ".claude", "harness.yaml"));
  });
});

// task 83d8d03a: detect() reads Claude Code's EFFECTIVE user-scope MCP
// registration — the top-level `mcpServers` key of `~/.claude.json` /
// `$CLAUDE_CONFIG_DIR/.claude.json` — via the shared read-only primitive
// in io/claude-mcp.ts, NOT the (dead-at-runtime) `mcpServers` block in
// `~/.claude/settings.json`. This is what feeds `interactive.ts`'s
// team/full agent-tasks detection (`detectionHasAgentTasks`).
describe("init detect — MCP servers from the effective Claude Code registry (task 83d8d03a)", () => {
  function registryPath(): string {
    return path.join(tmpHome, ".claude.json");
  }

  it("returns an empty list when the registry file is missing", async () => {
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers).toEqual([]);
  });

  it("does NOT read a dead mcpServers block in ~/.claude/settings.json", async () => {
    writeJson(path.join(tmpHome, ".claude", "settings.json"), {
      mcpServers: { "agent-tasks": { command: "node", args: ["x.js"] } },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers).toEqual([]);
  });

  it("parses mcpServers into a sorted list of {name, command, args}", async () => {
    writeJson(registryPath(), {
      mcpServers: {
        "z-server": { command: "/usr/bin/z", args: ["--mode", "x"] },
        "agent-tasks": { command: "node", args: ["/opt/agent-tasks/dist/server.js"] },
      },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers).toEqual([
      { name: "agent-tasks", runtime: "claude-code", command: "node", args: ["/opt/agent-tasks/dist/server.js"] },
      { name: "z-server", runtime: "claude-code", command: "/usr/bin/z", args: ["--mode", "x"] },
    ]);
  });

  it("ignores projects.<path>.mcpServers, only reading the top-level key", async () => {
    writeJson(registryPath(), {
      mcpServers: { top: { command: "/bin/top" } },
      projects: { "/some/path": { mcpServers: { nested: { command: "/bin/nested" } } } },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers.map((s) => s.name)).toEqual(["top"]);
  });

  it("defaults args to [] when omitted in the registry entry", async () => {
    writeJson(registryPath(), { mcpServers: { bare: { command: "/bin/bare" } } });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers).toEqual([
      { name: "bare", runtime: "claude-code", command: "/bin/bare", args: [] },
    ]);
  });

  it("drops entries missing a command (defensive)", async () => {
    writeJson(registryPath(), {
      mcpServers: {
        valid: { command: "/bin/valid" },
        broken: { args: ["--lonely"] },
      },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers.map((s) => s.name)).toEqual(["valid"]);
  });

  it("reports mcpRegistryParseError on invalid JSON without throwing", async () => {
    fs.writeFileSync(registryPath(), "{ not valid json");
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpRegistryParseError).toMatch(/not valid JSON/);
    expect(r.mcpServers).toEqual([]);
  });

  it("defaults args to [] when the entry's args field is not an array", async () => {
    writeJson(registryPath(), {
      mcpServers: { x: { command: "/bin/x", args: "not-an-array" } },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers).toEqual([
      { name: "x", runtime: "claude-code", command: "/bin/x", args: [] },
    ]);
  });

  it("filters non-string elements out of args, keeping the string-typed ones", async () => {
    writeJson(registryPath(), {
      mcpServers: { x: { command: "/bin/x", args: [1, "keep", null, "also-keep", false] } },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers).toEqual([
      { name: "x", runtime: "claude-code", command: "/bin/x", args: ["keep", "also-keep"] },
    ]);
  });

  it("drops entries whose command field is not a string", async () => {
    writeJson(registryPath(), {
      mcpServers: {
        valid: { command: "/bin/valid" },
        nonStringCommand: { command: 42, args: ["--ignored"] },
      },
    });
    const r = await detect({ homeDir: tmpHome });
    expect(r.mcpServers.map((s) => s.name)).toEqual(["valid"]);
  });

  it("reports mcpRegistryParseError when the registry file is unreadable", async () => {
    // chmod 0000 is unreliable for root, so skip when running as root.
    if (process.getuid?.() === 0) return;
    fs.writeFileSync(registryPath(), JSON.stringify({ mcpServers: {} }));
    fs.chmodSync(registryPath(), 0o000);
    try {
      const r = await detect({ homeDir: tmpHome });
      expect(r.mcpRegistryParseError).toContain("cannot read");
      expect(r.mcpServers).toEqual([]);
    } finally {
      // Restore so afterEach's rmSync can clean up the tmp tree.
      fs.chmodSync(registryPath(), 0o600);
    }
  });

  it("respects CLAUDE_CONFIG_DIR precedence over ~/.claude.json (D-102)", async () => {
    // A registry at the default ~/.claude.json location that must be
    // ignored once CLAUDE_CONFIG_DIR points elsewhere.
    writeJson(registryPath(), {
      mcpServers: { "should-be-ignored": { command: "/bin/wrong" } },
    });
    const customConfigDir = path.join(tmpHome, "custom-config-dir");
    writeJson(path.join(customConfigDir, ".claude.json"), {
      mcpServers: { "from-custom-dir": { command: "/bin/right" } },
    });
    const r = await detect({ homeDir: tmpHome, env: { CLAUDE_CONFIG_DIR: customConfigDir } });
    expect(r.mcpServers.map((s) => s.name)).toEqual(["from-custom-dir"]);
  });
});

describe("init detect — harness self-report", () => {
  it("returns the binary's package.json version", async () => {
    const r = await detect({ homeDir: tmpHome });
    expect(r.harness.version).toBe(VERSION);
  });
});
