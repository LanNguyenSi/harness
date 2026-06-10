import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uninstall, UninstallError } from "../../../src/cli/uninstall/index.js";
import {
  BACKUP_INFIX,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_VERSION,
  type UninstallSnapshot,
} from "../../../src/cli/uninstall/snapshot.js";

let tmp: string;
let homeDir: string;
let settingsPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-uninstall-"));
  homeDir = path.join(tmp, ".claude");
  fs.mkdirSync(homeDir, { recursive: true });
  settingsPath = path.join(homeDir, "settings.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(obj: Record<string, unknown>): void {
  fs.writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

describe("uninstall — inventory (no --apply)", () => {
  it("reports all harness-owned artefacts and leaves disk untouched", () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    fs.writeFileSync(path.join(homeDir, "harness.lock"), "{}\n");
    fs.mkdirSync(path.join(homeDir, "harness.generated", ".approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, "harness.generated", "settings.json"),
      "{}\n",
    );
    fs.writeFileSync(
      path.join(homeDir, "settings.json.pre-harness-2026-05-11"),
      `${JSON.stringify({ ok: true })}\n`,
    );
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/foreign-hook" }] },
          {
            matcher: "Edit|Write|Bash",
            hooks: [{ type: "command", command: "harness policy intercept" }],
          },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "harness session-start preflight" }] },
        ],
      },
      mcpServers: {
        "grounding-mcp": { command: "node", args: ["./grounding/dist/server.js"] },
        "foreign-mcp": { command: "node", args: ["./foreign/server.js"] },
      },
    });

    const r = uninstall({ homeDir, settingsPath });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(r.inventory.manifestPath).toBe(path.join(homeDir, "harness.yaml"));
    expect(r.inventory.lockPath).toBe(path.join(homeDir, "harness.lock"));
    expect(r.inventory.generatedDir).toBe(path.join(homeDir, "harness.generated"));
    expect(r.inventory.preHarnessBackups).toEqual([
      path.join(homeDir, "settings.json.pre-harness-2026-05-11"),
    ]);
    expect(r.inventory.hookGroups.map((g) => `${g.event}[${g.index}]`)).toEqual([
      "PreToolUse[1]",
      "SessionStart[0]",
    ]);
    // grounding-mcp is owned by the default allowlist; foreign-mcp is foreign.
    expect(r.inventory.mcpServers).toEqual(["grounding-mcp"]);

    // No new files on disk besides what we set up.
    const all = fs.readdirSync(homeDir).sort();
    expect(all).toContain("settings.json");
    expect(all.some((n) => n.startsWith(BACKUP_INFIX))).toBe(false);
    expect(all.some((n) => n.startsWith(SNAPSHOT_BASENAME_PREFIX))).toBe(false);
  });

  it("returns an empty inventory when ~/.claude is empty", () => {
    const r = uninstall({ homeDir, settingsPath });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.manifestPath).toBeNull();
    expect(r.inventory.lockPath).toBeNull();
    expect(r.inventory.generatedDir).toBeNull();
    expect(r.inventory.hookGroups).toEqual([]);
    expect(r.inventory.mcpServers).toEqual([]);
    expect(r.inventory.preHarnessBackups).toEqual([]);
  });

  it("treats mixed (harness + foreign) hook groups as foreign and warns", () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "harness policy intercept" },
              { type: "command", command: "/usr/local/bin/my-other-hook" },
            ],
          },
        ],
      },
    });
    const r = uninstall({ homeDir, settingsPath });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.hookGroups).toEqual([]);
    expect(r.inventory.warnings.join("\n")).toMatch(/mixed group/);
  });

  it("falls back to the bundled-template allowlist when the manifest is gone", () => {
    // No manifest on disk. uninstall must still recognise the MCP names
    // the bundled templates wire by default (agent-tasks, codebase-oracle,
    // grounding-mcp), else a manifest-less uninstall silently strands them.
    writeSettings({
      mcpServers: {
        "agent-tasks": { command: "a" },
        "codebase-oracle": { command: "c" },
        "grounding-mcp": { command: "g" },
        "foreign": { command: "f" },
      },
    });
    const r = uninstall({ homeDir, settingsPath });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.mcpServers.sort()).toEqual([
      "agent-tasks",
      "codebase-oracle",
      "grounding-mcp",
    ]);
  });

  it("picks up manifest-declared MCP names beyond the default allowlist", () => {
    fs.writeFileSync(
      path.join(homeDir, "harness.yaml"),
      "tools:\n  mcp:\n    - name: my-custom-mcp\n      command: x\n",
    );
    writeSettings({
      mcpServers: {
        "my-custom-mcp": { command: "x" },
        "grounding-mcp": { command: "g" },
        "foreign": { command: "f" },
      },
    });
    const r = uninstall({ homeDir, settingsPath });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.mcpServers.sort()).toEqual(["grounding-mcp", "my-custom-mcp"]);
  });
});

describe("uninstall — --apply", () => {
  it("removes harness-owned hook groups + mcpServers, writes backup + snapshot, leaves siblings intact", () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    fs.writeFileSync(path.join(homeDir, "harness.lock"), "{}\n");
    fs.mkdirSync(path.join(homeDir, "harness.generated"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, "harness.generated", "marker"), "x");
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/foreign-hook" }] },
          { matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "harness policy intercept" }] },
        ],
      },
      mcpServers: {
        "grounding-mcp": { command: "g" },
        "foreign": { command: "f" },
      },
      theme: "dark",
    });

    const r = uninstall({
      homeDir,
      settingsPath,
      apply: true,
      now: new Date("2026-05-16T10:00:00Z"),
    });
    expect(r.mode).toBe("apply");
    if (r.mode !== "apply") return;

    expect(r.backupPath).not.toBeNull();
    expect(r.snapshotPath).not.toBeNull();
    expect(r.removedFiles).toContain(path.join(homeDir, "harness.yaml"));
    expect(r.removedFiles).toContain(path.join(homeDir, "harness.lock"));
    expect(r.removedFiles).toContain(path.join(homeDir, "harness.generated"));
    expect(fs.existsSync(path.join(homeDir, "harness.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, "harness.generated"))).toBe(false);

    const after = readJson(settingsPath);
    const hooks = after["hooks"] as Record<string, unknown[]>;
    expect(hooks["PreToolUse"]).toHaveLength(1);
    expect((hooks["PreToolUse"]?.[0] as { matcher: string }).matcher).toBe("Bash");
    expect(after["mcpServers"]).toEqual({ foreign: { command: "f" } });
    expect(after["theme"]).toBe("dark");

    // Backup preserves the pre-mutation bytes verbatim.
    if (r.backupPath === null) throw new Error("backupPath null");
    const backup = fs.readFileSync(r.backupPath, "utf8");
    expect(backup).toContain("harness policy intercept");
    expect(backup).toContain("grounding-mcp");

    // Snapshot is well-formed.
    if (r.snapshotPath === null) throw new Error("snapshotPath null");
    const snap = readJson(r.snapshotPath) as unknown as UninstallSnapshot;
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    expect(snap.settingsPath).toBe(settingsPath);
    expect(snap.removedHookGroups).toHaveLength(1);
    expect(snap.removedHookGroups[0]?.event).toBe("PreToolUse");
    expect(snap.removedMcpServers.map((s) => s.name)).toEqual(["grounding-mcp"]);
    expect(snap.settingsBeforeSha256).not.toBe(snap.settingsAfterSha256);
  });

  it("drops the hooks and mcpServers keys entirely when removal empties them", () => {
    writeSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "harness policy intercept" }] }] },
      mcpServers: { "grounding-mcp": { command: "g" } },
    });
    const r = uninstall({ homeDir, settingsPath, apply: true });
    if (r.mode !== "apply") throw new Error("expected apply");
    const after = readJson(settingsPath);
    expect(after).not.toHaveProperty("hooks");
    expect(after).not.toHaveProperty("mcpServers");
  });

  it("on a clean system with no harness install, exits without writing anything", () => {
    const r = uninstall({ homeDir, settingsPath, apply: true });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(r.backupPath).toBeNull();
    expect(r.snapshotPath).toBeNull();
    expect(r.removedFiles).toEqual([]);
    const entries = fs.readdirSync(homeDir);
    expect(entries).toEqual([]);
  });

  it("with no settings.json, still removes ~/.claude/harness.* on --apply", () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    fs.writeFileSync(path.join(homeDir, "harness.lock"), "{}\n");
    // No settings.json on disk.
    const r = uninstall({ homeDir, settingsPath, apply: true });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(r.removedFiles).toEqual([
      path.join(homeDir, "harness.yaml"),
      path.join(homeDir, "harness.lock"),
    ]);
    expect(r.backupPath).toBeNull();
    expect(r.snapshotPath).toBeNull();
  });
});

describe("uninstall — refuses malformed settings.json", () => {
  it("throws on unreadable JSON", () => {
    fs.writeFileSync(settingsPath, "{ not json");
    expect(() => uninstall({ homeDir, settingsPath })).toThrow(UninstallError);
    expect(() => uninstall({ homeDir, settingsPath })).toThrow(/not valid JSON/);
  });

  it("throws when settings.json is an array", () => {
    fs.writeFileSync(settingsPath, "[]");
    expect(() => uninstall({ homeDir, settingsPath })).toThrow(/not a JSON object/);
  });

  it("throws when hooks is not an object", () => {
    writeSettings({ hooks: ["bad"] as unknown as Record<string, unknown[]> });
    expect(() => uninstall({ homeDir, settingsPath })).toThrow(/`hooks` field is not an object/);
  });

  it("throws when mcpServers is not an object", () => {
    writeSettings({ mcpServers: [] as unknown as Record<string, unknown> });
    expect(() => uninstall({ homeDir, settingsPath })).toThrow(/`mcpServers` field is not an object/);
  });
});

describe("uninstall — --restore-from", () => {
  it("atomically replaces settings.json from a pre-harness backup, snapshots both, and unlinks harness files", () => {
    const pristine = { theme: "dark", mcpServers: { foreign: { command: "f" } } };
    const backupSource = path.join(homeDir, "settings.json.pre-harness-2026-05-11");
    fs.writeFileSync(backupSource, `${JSON.stringify(pristine, null, 2)}\n`);
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    fs.writeFileSync(path.join(homeDir, "harness.lock"), "{}\n");
    writeSettings({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "harness policy intercept" }] }],
      },
      mcpServers: { "grounding-mcp": { command: "g" }, foreign: { command: "f" } },
      theme: "dark",
    });

    const r = uninstall({
      homeDir,
      settingsPath,
      restoreFrom: backupSource,
      now: new Date("2026-05-16T10:00:00Z"),
    });
    if (r.mode !== "restore") throw new Error("expected restore");

    const after = readJson(settingsPath);
    expect(after).toEqual(pristine);
    expect(fs.existsSync(path.join(homeDir, "harness.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, "harness.lock"))).toBe(false);

    // Backup of pre-restore live file lands next to settings.json.
    expect(fs.existsSync(r.backupPath)).toBe(true);
    const pre = readJson(r.backupPath);
    expect(pre).toHaveProperty("hooks");

    const snap = readJson(r.snapshotPath) as unknown as UninstallSnapshot & { restoredFrom: string };
    expect(snap.restoredFrom).toBe(backupSource);
    expect(snap.removedHookGroups).toHaveLength(1);
    expect(snap.removedMcpServers.map((s) => s.name)).toEqual(["grounding-mcp"]);
  });

  it("refuses when the restore source is not valid JSON", () => {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{ corrupt");
    writeSettings({});
    expect(() => uninstall({ homeDir, settingsPath, restoreFrom: bad })).toThrow(
      /restore source .* is not valid JSON/,
    );
  });

  it("refuses when settings.json does not exist", () => {
    const src = path.join(tmp, "src.json");
    fs.writeFileSync(src, `${JSON.stringify({ theme: "dark" })}\n`);
    expect(() => uninstall({ homeDir, settingsPath, restoreFrom: src })).toThrow(
      /does not exist; nothing to restore over/,
    );
  });
});

describe("uninstall — gate state + state root (harness-discovery M2)", () => {
  it("inventories and removes .understanding-gate/ under the state root", () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const gateDir = path.join(homeDir, ".understanding-gate");
    fs.mkdirSync(path.join(gateDir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(gateDir, "reports", "r.json"), "{}\n");
    fs.mkdirSync(path.join(gateDir, "parse-errors"), { recursive: true });

    const listed = uninstall({ homeDir, settingsPath });
    expect(listed.mode).toBe("list");
    if (listed.mode !== "list") return;
    expect(listed.inventory.gateStateDir).toBe(gateDir);
    // Dry-run leaves it on disk.
    expect(fs.existsSync(gateDir)).toBe(true);

    const r = uninstall({ homeDir, settingsPath, apply: true });
    expect(r.mode).toBe("apply");
    if (r.mode !== "apply") return;
    expect(r.removedFiles).toContain(gateDir);
    expect(fs.existsSync(gateDir)).toBe(false);
  });

  it("resolves manifest/lock/generated/gate-state from a split state root (migrated installs)", () => {
    const stateDir = path.join(tmp, ".harness");
    fs.mkdirSync(path.join(stateDir, "harness.generated"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "harness.yaml"), "version: 1\n");
    fs.mkdirSync(path.join(stateDir, ".understanding-gate"), { recursive: true });
    writeSettings({});

    const r = uninstall({ homeDir, settingsPath, stateDir, apply: true });
    expect(r.mode).toBe("apply");
    if (r.mode !== "apply") return;
    expect(r.inventory.stateDir).toBe(stateDir);
    expect(r.inventory.homeDir).toBe(homeDir);
    expect(r.removedFiles).toContain(path.join(stateDir, "harness.yaml"));
    expect(fs.existsSync(path.join(stateDir, "harness.generated"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, ".understanding-gate"))).toBe(false);
  });

  it("explicit homeDir without stateDir keeps the historic single-root contract", () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const r = uninstall({ homeDir, settingsPath });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(r.inventory.stateDir).toBe(homeDir);
    expect(r.inventory.manifestPath).toBe(path.join(homeDir, "harness.yaml"));
  });
});
