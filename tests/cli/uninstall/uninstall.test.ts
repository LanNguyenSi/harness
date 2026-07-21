import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstall, UninstallError } from "../../../src/cli/uninstall/index.js";
import {
  BACKUP_INFIX,
  SNAPSHOT_BASENAME_PREFIX,
  SNAPSHOT_VERSION,
  type UninstallSnapshot,
} from "../../../src/cli/uninstall/snapshot.js";
import { manualRemoveLines, type ClaudeMcpExec } from "../../../src/io/claude-mcp.js";

// Mutable override for `os.homedir()`, used ONLY by the "MCP registry axis
// seatbelt" tests below to keep the real-homedir fallback inside `tmp`
// when a test intentionally omits the `homeDir` option (to exercise
// `mcpRegistryAxisAllowed`'s "no explicit override" branch without ever
// touching the developer's actual home directory). `vi.spyOn` can't patch
// a live ESM namespace export directly ("Module namespace is not
// configurable in ESM"), hence the `vi.mock` + `vi.hoisted` indirection.
// Every other test in this file leaves `homedirOverride.value` unset, so
// `os.homedir()` behaves exactly as the real one for them.
const homedirOverride = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homedirOverride.value ?? actual.homedir() };
});

let tmp: string;
let homeDir: string;
let settingsPath: string;
/** `resolveClaudeUserRegistryPath` derives this as `path.join(path.dirname(homeDir), ".claude.json")`. */
let registryPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-uninstall-"));
  homeDir = path.join(tmp, ".claude");
  fs.mkdirSync(homeDir, { recursive: true });
  settingsPath = path.join(homeDir, "settings.json");
  registryPath = path.join(tmp, ".claude.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(obj: Record<string, unknown>): void {
  fs.writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

function writeRegistry(obj: Record<string, unknown>): void {
  fs.writeFileSync(registryPath, `${JSON.stringify(obj, null, 2)}\n`);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Fake-exec helpers (mirrors tests/cli/doctor-claude-mcp.test.ts) — every
// test in the "MCP registry deregistration" describe blocks below injects
// `mcpExec` so no real `claude` CLI is ever spawned.
// ---------------------------------------------------------------------

function execCliMissing(): ClaudeMcpExec {
  return async () => ({ code: 127, stdout: "", stderr: "", enoent: true, timedOut: false });
}

function execThrowsIfCalled(): ClaudeMcpExec {
  return async () => {
    throw new Error("claude mcp remove must not be spawned in this test");
  };
}

/**
 * Records every `args` array it's called with and resolves per-name
 * outcomes from `outcomes` (default: success, exit 0). The server name is
 * always the last element of `claude mcp remove --scope user <name>`.
 */
function execRecordingRemove(
  calls: string[][],
  outcomes: Record<string, { code: number; stderr?: string }> = {},
): ClaudeMcpExec {
  return async (args) => {
    calls.push(args);
    const name = args[args.length - 1] ?? "";
    const outcome = outcomes[name] ?? { code: 0 };
    return {
      code: outcome.code,
      stdout: "",
      stderr: outcome.stderr ?? "",
      enoent: false,
      timedOut: false,
    };
  };
}

describe("uninstall — inventory (no --apply)", () => {
  it("reports all harness-owned artefacts and leaves disk untouched", async () => {
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

    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
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
    // No registry file on disk -> nothing registered, nothing planned.
    expect(r.inventory.mcpRegistryServers).toEqual([]);
    expect(r.inventory.mcpRegistryReadError).toBeNull();

    // No new files on disk besides what we set up.
    const all = fs.readdirSync(homeDir).sort();
    expect(all).toContain("settings.json");
    expect(all.some((n) => n.startsWith(BACKUP_INFIX))).toBe(false);
    expect(all.some((n) => n.startsWith(SNAPSHOT_BASENAME_PREFIX))).toBe(false);
  });

  it("returns an empty inventory when ~/.claude is empty", async () => {
    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.manifestPath).toBeNull();
    expect(r.inventory.lockPath).toBeNull();
    expect(r.inventory.generatedDir).toBeNull();
    expect(r.inventory.hookGroups).toEqual([]);
    expect(r.inventory.mcpServers).toEqual([]);
    expect(r.inventory.mcpRegistryServers).toEqual([]);
    expect(r.inventory.preHarnessBackups).toEqual([]);
  });

  it("treats mixed (harness + foreign) hook groups as foreign and warns", async () => {
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
    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.hookGroups).toEqual([]);
    expect(r.inventory.warnings.join("\n")).toMatch(/mixed group/);
  });

  it("falls back to the bundled-template allowlist when the manifest is gone", async () => {
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
    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.mcpServers.sort()).toEqual([
      "agent-tasks",
      "codebase-oracle",
      "grounding-mcp",
    ]);
  });

  it("picks up manifest-declared MCP names beyond the default allowlist", async () => {
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
    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.mcpServers.sort()).toEqual(["grounding-mcp", "my-custom-mcp"]);
  });
});

describe("uninstall — --apply", () => {
  it("removes harness-owned hook groups + mcpServers, writes backup + snapshot, leaves siblings intact", async () => {
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

    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      now: new Date("2026-05-16T10:00:00Z"),
      mcpExec: execThrowsIfCalled(),
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
    // No registry file on disk -> no candidates -> no exec calls at all
    // (execThrowsIfCalled would have failed the test otherwise).
    expect(r.mcpRegistryRemovals).toEqual([]);

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

  it("drops the hooks and mcpServers keys entirely when removal empties them", async () => {
    writeSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "harness policy intercept" }] }] },
      mcpServers: { "grounding-mcp": { command: "g" } },
    });
    const r = await uninstall({ homeDir, settingsPath, apply: true, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "apply") throw new Error("expected apply");
    const after = readJson(settingsPath);
    expect(after).not.toHaveProperty("hooks");
    expect(after).not.toHaveProperty("mcpServers");
  });

  it("on a clean system with no harness install, exits without writing anything", async () => {
    const r = await uninstall({ homeDir, settingsPath, apply: true, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(r.backupPath).toBeNull();
    expect(r.snapshotPath).toBeNull();
    expect(r.removedFiles).toEqual([]);
    expect(r.mcpRegistryRemovals).toEqual([]);
    const entries = fs.readdirSync(homeDir);
    expect(entries).toEqual([]);
  });

  it("with no settings.json, still removes ~/.claude/harness.* on --apply", async () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    fs.writeFileSync(path.join(homeDir, "harness.lock"), "{}\n");
    // No settings.json on disk.
    const r = await uninstall({ homeDir, settingsPath, apply: true, mcpExec: execThrowsIfCalled() });
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
  it("throws on unreadable JSON", async () => {
    fs.writeFileSync(settingsPath, "{ not json");
    await expect(uninstall({ homeDir, settingsPath })).rejects.toThrow(UninstallError);
    await expect(uninstall({ homeDir, settingsPath })).rejects.toThrow(/not valid JSON/);
  });

  it("throws when settings.json is an array", async () => {
    fs.writeFileSync(settingsPath, "[]");
    await expect(uninstall({ homeDir, settingsPath })).rejects.toThrow(/not a JSON object/);
  });

  it("throws when hooks is not an object", async () => {
    writeSettings({ hooks: ["bad"] as unknown as Record<string, unknown[]> });
    await expect(uninstall({ homeDir, settingsPath })).rejects.toThrow(
      /`hooks` field is not an object/,
    );
  });

  it("throws when mcpServers is not an object", async () => {
    writeSettings({ mcpServers: [] as unknown as Record<string, unknown> });
    await expect(uninstall({ homeDir, settingsPath })).rejects.toThrow(
      /`mcpServers` field is not an object/,
    );
  });
});

describe("uninstall — --restore-from", () => {
  it("atomically replaces settings.json from a pre-harness backup, snapshots both, and unlinks harness files", async () => {
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

    const r = await uninstall({
      homeDir,
      settingsPath,
      restoreFrom: backupSource,
      now: new Date("2026-05-16T10:00:00Z"),
      mcpExec: execThrowsIfCalled(),
    });
    if (r.mode !== "restore") throw new Error("expected restore");

    const after = readJson(settingsPath);
    expect(after).toEqual(pristine);
    expect(fs.existsSync(path.join(homeDir, "harness.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, "harness.lock"))).toBe(false);
    expect(r.mcpRegistryRemovals).toEqual([]);

    // Backup of pre-restore live file lands next to settings.json.
    expect(fs.existsSync(r.backupPath)).toBe(true);
    const pre = readJson(r.backupPath);
    expect(pre).toHaveProperty("hooks");

    const snap = readJson(r.snapshotPath) as unknown as UninstallSnapshot & { restoredFrom: string };
    expect(snap.restoredFrom).toBe(backupSource);
    expect(snap.removedHookGroups).toHaveLength(1);
    expect(snap.removedMcpServers.map((s) => s.name)).toEqual(["grounding-mcp"]);
  });

  it("also deregisters an owned+registered MCP server from the live registry (exact argv asserted, not just the shared-helper proxy)", async () => {
    const pristine = { theme: "dark" };
    const backupSource = path.join(homeDir, "settings.json.pre-harness-2026-05-11");
    fs.writeFileSync(backupSource, `${JSON.stringify(pristine, null, 2)}\n`);
    writeSettings({ theme: "dark" });
    writeRegistry({
      mcpServers: {
        "grounding-mcp": { command: "node", args: ["server.js"] },
        "foreign-mcp": { command: "node" },
      },
    });

    const calls: string[][] = [];
    const r = await uninstall({
      homeDir,
      settingsPath,
      restoreFrom: backupSource,
      mcpExec: execRecordingRemove(calls),
    });
    if (r.mode !== "restore") throw new Error("expected restore");

    // Only the owned+registered name is touched; the foreign entry is
    // never even a candidate.
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "grounding-mcp"]]);
    expect(r.mcpRegistryRemovals).toEqual([
      { name: "grounding-mcp", status: "removed", message: "" },
    ]);
  });

  it("refuses when the restore source is not valid JSON", async () => {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{ corrupt");
    writeSettings({});
    await expect(uninstall({ homeDir, settingsPath, restoreFrom: bad })).rejects.toThrow(
      /restore source .* is not valid JSON/,
    );
  });

  it("refuses when settings.json does not exist", async () => {
    const src = path.join(tmp, "src.json");
    fs.writeFileSync(src, `${JSON.stringify({ theme: "dark" })}\n`);
    await expect(uninstall({ homeDir, settingsPath, restoreFrom: src })).rejects.toThrow(
      /does not exist; nothing to restore over/,
    );
  });
});

describe("uninstall — gate state + state root (harness-discovery M2)", () => {
  it("inventories and removes .understanding-gate/ under the state root", async () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const gateDir = path.join(homeDir, ".understanding-gate");
    fs.mkdirSync(path.join(gateDir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(gateDir, "reports", "r.json"), "{}\n");
    fs.mkdirSync(path.join(gateDir, "parse-errors"), { recursive: true });

    const listed = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    expect(listed.mode).toBe("list");
    if (listed.mode !== "list") return;
    expect(listed.inventory.gateStateDir).toBe(gateDir);
    // Dry-run leaves it on disk.
    expect(fs.existsSync(gateDir)).toBe(true);

    const r = await uninstall({ homeDir, settingsPath, apply: true, mcpExec: execThrowsIfCalled() });
    expect(r.mode).toBe("apply");
    if (r.mode !== "apply") return;
    expect(r.removedFiles).toContain(gateDir);
    expect(fs.existsSync(gateDir)).toBe(false);
  });

  it("resolves manifest/lock/generated/gate-state from a split state root (migrated installs)", async () => {
    const stateDir = path.join(tmp, ".harness");
    fs.mkdirSync(path.join(stateDir, "harness.generated"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "harness.yaml"), "version: 1\n");
    fs.mkdirSync(path.join(stateDir, ".understanding-gate"), { recursive: true });
    writeSettings({});

    const r = await uninstall({
      homeDir,
      settingsPath,
      stateDir,
      apply: true,
      mcpExec: execThrowsIfCalled(),
    });
    expect(r.mode).toBe("apply");
    if (r.mode !== "apply") return;
    expect(r.inventory.stateDir).toBe(stateDir);
    expect(r.inventory.homeDir).toBe(homeDir);
    expect(r.removedFiles).toContain(path.join(stateDir, "harness.yaml"));
    expect(fs.existsSync(path.join(stateDir, "harness.generated"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, ".understanding-gate"))).toBe(false);
  });

  it("explicit homeDir without stateDir keeps the historic single-root contract", async () => {
    fs.writeFileSync(path.join(homeDir, "harness.yaml"), "version: 1\n");
    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(r.inventory.stateDir).toBe(homeDir);
    expect(r.inventory.manifestPath).toBe(path.join(homeDir, "harness.yaml"));
  });
});

describe("uninstall — real-state-root seatbelt", () => {
  it("refuses to resolve the real state root without explicit overrides (test-leak guard)", async () => {
    const saved = process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    try {
      await expect(uninstall({ settingsPath })).rejects.toThrow(UninstallError);
      await expect(uninstall({ settingsPath })).rejects.toThrow(/refused to fall back/);
    } finally {
      if (saved === undefined) delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
      else process.env.HARNESS_ALLOW_REAL_GENERATED_DIR = saved;
    }
  });
});

// ---------------------------------------------------------------------
// MCP registry deregistration (task d6086441): `claude mcp remove` for
// harness-owned servers actually REGISTERED in the claude CLI's
// user-scope registry (~/.claude.json — here `registryPath`, a temp-dir
// stand-in). Orthogonal to the settings.json `mcpServers` block handled
// above.
// ---------------------------------------------------------------------

describe("uninstall — MCP registry deregistration, dry-run", () => {
  it("lists planned removals with ZERO exec calls", async () => {
    writeRegistry({
      mcpServers: {
        "grounding-mcp": { command: "node", args: ["server.js"] },
        "foreign-mcp": { command: "node", args: ["other.js"] },
      },
    });
    const r = await uninstall({ homeDir, settingsPath, mcpExec: execThrowsIfCalled() });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.inventory.mcpRegistryPath).toBe(registryPath);
    // Owned (default allowlist) + registered -> planned; foreign untouched.
    expect(r.inventory.mcpRegistryServers).toEqual(["grounding-mcp"]);
  });
});

describe("uninstall — MCP registry deregistration, --apply", () => {
  it("removes owned+registered names via exact `claude mcp remove` commands; non-owned stays untouched", async () => {
    writeRegistry({
      mcpServers: {
        "grounding-mcp": { command: "node", args: ["server.js"] },
        "foreign-mcp": { command: "node", args: ["other.js"] },
      },
    });
    const calls: string[][] = [];
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: execRecordingRemove(calls),
    });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(calls).toEqual([["mcp", "remove", "--scope", "user", "grounding-mcp"]]);
    expect(r.mcpRegistryRemovals).toEqual([
      { name: "grounding-mcp", status: "removed", message: "" },
    ]);
  });

  it("attempts no remove for an owned name that is not actually registered", async () => {
    // settings.json declares grounding-mcp owned (drives the settings.json
    // cleanup path), but the LIVE registry only has an unrelated foreign
    // entry — the registry-removal path must never blindly iterate the
    // DEFAULT_OWNED_MCP_SERVERS/manifest allowlist; only names confirmed
    // present via a read-only registry check are candidates.
    writeSettings({ mcpServers: { "grounding-mcp": { command: "g" } } });
    writeRegistry({ mcpServers: { "foreign-mcp": { command: "node" } } });
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: execThrowsIfCalled(),
    });
    if (r.mode !== "apply") throw new Error("expected apply");
    // settings.json cleanup still ran (independent subsystem).
    expect(r.backupPath).not.toBeNull();
    expect(r.inventory.mcpRegistryServers).toEqual([]);
    expect(r.mcpRegistryRemovals).toEqual([]);
  });

  it("with no registry file on disk, attempts no remove", async () => {
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: execThrowsIfCalled(),
    });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(r.inventory.mcpRegistryServers).toEqual([]);
    expect(r.mcpRegistryRemovals).toEqual([]);
  });

  it("CLI missing: warns with copy-pasteable manual commands, no hard fail", async () => {
    writeRegistry({ mcpServers: { "grounding-mcp": { command: "node" } } });
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: execCliMissing(),
    });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(r.mcpRegistryRemovals).toEqual([
      { name: "grounding-mcp", status: "cli-missing", message: "claude CLI not found on PATH" },
    ]);
    const warningsText = r.inventory.warnings.join("\n");
    for (const line of manualRemoveLines(["grounding-mcp"])) {
      expect(warningsText).toContain(line);
    }
  });

  it("registry read error: no remove attempted, warning surfaced (D-002 analogy)", async () => {
    fs.writeFileSync(registryPath, "{ not json");
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: execThrowsIfCalled(),
    });
    if (r.mode !== "apply") throw new Error("expected apply");
    expect(r.inventory.mcpRegistryReadError).not.toBeNull();
    expect(r.inventory.mcpRegistryServers).toEqual([]);
    expect(r.mcpRegistryRemovals).toEqual([]);
    expect(r.inventory.warnings.join("\n")).toMatch(
      /could not read the claude CLI user-scope MCP registry/,
    );
  });

  it("partial success: settings.json cleanup succeeds while one registry remove fails, distinguishably reported", async () => {
    writeSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "harness policy intercept" }] }] },
    });
    writeRegistry({
      mcpServers: {
        "agent-tasks": { command: "a" },
        "grounding-mcp": { command: "g" },
      },
    });
    const calls: string[][] = [];
    const r = await uninstall({
      homeDir,
      settingsPath,
      apply: true,
      mcpExec: execRecordingRemove(calls, {
        "grounding-mcp": { code: 1, stderr: "boom" },
      }),
    });
    if (r.mode !== "apply") throw new Error("expected apply");
    // settings.json cleanup happened (hook group removed -> backup/snapshot written).
    expect(r.backupPath).not.toBeNull();
    expect(r.snapshotPath).not.toBeNull();
    // Per-name outcomes are distinguishable: one removed, one errored.
    expect(r.mcpRegistryRemovals).toEqual([
      { name: "agent-tasks", status: "removed", message: "" },
      { name: "grounding-mcp", status: "error", message: "boom" },
    ]);
    const warningsText = r.inventory.warnings.join("\n");
    expect(warningsText).toMatch(/grounding-mcp: error/);
    expect(warningsText).not.toMatch(/agent-tasks: /);
  });
});

describe("uninstall — MCP registry axis seatbelt (task d6086441 review finding)", () => {
  // Every test here intentionally omits the `homeDir` OPTION to exercise
  // `mcpRegistryAxisAllowed`'s "no explicit override" branch. Since the
  // real (unmocked) fallback would otherwise resolve toward the
  // developer's actual home directory, `homedirOverride.value` (module
  // top) is set to stay inside `tmp` — this does NOT affect the guard
  // itself, which keys off `opts.homeDir` being undefined, not the
  // resolved path.
  afterEach(() => {
    homedirOverride.value = undefined;
  });

  it("blocks the axis entirely (no read, no remove) without --home, mcpExec, or the env flag", async () => {
    homedirOverride.value = tmp;
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const isolatedSettingsPath = path.join(tmp, "isolated-settings.json");
    // Populate what the (mocked) real registry path resolves to, so a
    // guard regression would have an owned+registered name to actually
    // find and remove — proving the block, not just an empty-by-accident
    // result.
    writeRegistry({ mcpServers: { "grounding-mcp": { command: "g" } } });

    const saved = process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    try {
      const r = await uninstall({ stateDir, settingsPath: isolatedSettingsPath, apply: true });
      if (r.mode !== "apply") throw new Error("expected apply");
      expect(r.inventory.mcpRegistryServers).toEqual([]);
      expect(r.mcpRegistryRemovals).toEqual([]);
      expect(r.inventory.warnings.join("\n")).toMatch(
        /skipped the claude CLI user-scope MCP registry check/,
      );
    } finally {
      if (saved === undefined) delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
      else process.env.HARNESS_ALLOW_REAL_GENERATED_DIR = saved;
    }
  });

  it("unlocks the axis via HARNESS_ALLOW_REAL_GENERATED_DIR=1 even without --home (dry-run stays hermetic)", async () => {
    homedirOverride.value = tmp;
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const isolatedSettingsPath = path.join(tmp, "isolated-settings.json");
    writeRegistry({
      mcpServers: {
        "grounding-mcp": { command: "g" },
        "foreign-mcp": { command: "f" },
      },
    });

    const saved = process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    process.env.HARNESS_ALLOW_REAL_GENERATED_DIR = "1";
    try {
      // Dry-run (no --apply): remove is never attempted regardless of the
      // guard — execThrowsIfCalled proves it — only the read-only listing
      // is under test here.
      const r = await uninstall({
        stateDir,
        settingsPath: isolatedSettingsPath,
        mcpExec: execThrowsIfCalled(),
      });
      if (r.mode !== "list") throw new Error("expected list");
      expect(r.inventory.mcpRegistryServers).toEqual(["grounding-mcp"]);
      expect(r.inventory.warnings.join("\n")).not.toMatch(
        /skipped the claude CLI user-scope MCP registry check/,
      );
    } finally {
      if (saved === undefined) delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
      else process.env.HARNESS_ALLOW_REAL_GENERATED_DIR = saved;
    }
  });

  it("unlocks the axis via an explicit --home override, independent of the env flag", async () => {
    const stateDir = path.join(tmp, ".harness-state");
    fs.mkdirSync(stateDir, { recursive: true });
    writeRegistry({ mcpServers: { "grounding-mcp": { command: "g" } } });

    const saved = process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
    try {
      const r = await uninstall({
        homeDir,
        stateDir,
        settingsPath,
        mcpExec: execThrowsIfCalled(),
      });
      if (r.mode !== "list") throw new Error("expected list");
      expect(r.inventory.mcpRegistryServers).toEqual(["grounding-mcp"]);
    } finally {
      if (saved === undefined) delete process.env.HARNESS_ALLOW_REAL_GENERATED_DIR;
      else process.env.HARNESS_ALLOW_REAL_GENERATED_DIR = saved;
    }
  });
});
