import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareToPeer,
  formatSnapshotAge,
  parseSnapshotJson,
  runSessionStartToolchainParity,
  type ToolchainSnapshot,
} from "../../../src/cli/session-start/toolchain-parity.js";
import { HermeticSpawnViolationError } from "../../../src/runtime/hermetic-spawn-guard.js";
import { parseManifest, type Manifest } from "../../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function manifestWithConfig(config: Record<string, unknown> = {}): Manifest {
  return parseManifest({ version: 1, toolchain_parity: config });
}

function writeSnapshotFile(dir: string, fileName: string, snapshot: Partial<ToolchainSnapshot> & { profile: string; timestamp: string }): void {
  const full: ToolchainSnapshot = {
    schemaVersion: 1,
    npmGlobals: {},
    mcpServers: [],
    ...snapshot,
  };
  fs.writeFileSync(path.join(dir, fileName), `${JSON.stringify(full, null, 2)}\n`, "utf8");
}

const NOW = new Date("2026-07-22T12:00:00.000Z");

// A "does nothing surprising" set of local collectors: a happy-path node/npm
// pair plus empty OW-Kit/MCP results, used as the base for tests that only
// care about ONE dimension of drift. Individual tests override what they
// need via spread.
function baseCollectors() {
  return {
    now: NOW,
    runNodeVersion: async () => ({ ok: true as const, version: "v22.1.0" }),
    runNpmGlobals: async () => ({ ok: true as const, packages: { "@lannguyensi/harness": "0.41.0" } }),
    readOwKitVersion: () => ({ version: "0.12.0" }),
    readMcpServerNames: () => ({ names: ["agent-tasks", "grounding-mcp"] }),
  };
}

describe("ToolchainParitySchema — manifest parsing", () => {
  it("defaults to disabled with no fields when the block is absent entirely", () => {
    const m = parseManifest({ version: 1 });
    expect(m.toolchain_parity.enabled).toBe(false);
    expect(m.toolchain_parity.machine_state_dir).toBeUndefined();
    expect(m.toolchain_parity.profile).toBeUndefined();
    expect(m.toolchain_parity.workspace_root).toBeUndefined();
  });

  it("parses an explicit enabled config with all fields", () => {
    const m = manifestWithConfig({
      enabled: true,
      machine_state_dir: "/tmp/machine-state",
      profile: "mac-mini",
      workspace_root: "/repo",
    });
    expect(m.toolchain_parity).toEqual({
      enabled: true,
      machine_state_dir: "/tmp/machine-state",
      profile: "mac-mini",
      workspace_root: "/repo",
    });
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() => manifestWithConfig({ enabled: true, bogus_key: 1 })).toThrow();
  });
});

describe("formatSnapshotAge", () => {
  it("formats sub-minute ages as 'just now'", () => {
    expect(formatSnapshotAge(0)).toBe("just now");
    expect(formatSnapshotAge(59_999)).toBe("just now");
  });
  it("formats minutes below an hour", () => {
    expect(formatSnapshotAge(60_000)).toBe("1m");
    expect(formatSnapshotAge(59 * 60_000)).toBe("59m");
  });
  it("formats hours below 48h", () => {
    expect(formatSnapshotAge(60 * 60_000)).toBe("1h");
    expect(formatSnapshotAge(47 * 60 * 60_000)).toBe("47h");
  });
  it("formats days at/above 48h", () => {
    expect(formatSnapshotAge(48 * 60 * 60_000)).toBe("2d");
    expect(formatSnapshotAge(72 * 60 * 60_000)).toBe("3d");
  });
});

describe("parseSnapshotJson", () => {
  const valid = JSON.stringify({
    profile: "peer-a",
    timestamp: "2026-07-22T11:00:00.000Z",
    node: "v22.1.0",
    npmGlobals: { foo: "1.0.0" },
    owKitVersion: "0.12.0",
    mcpServers: ["agent-tasks"],
  });

  it("parses a well-formed snapshot", () => {
    const r = parseSnapshotJson(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.profile).toBe("peer-a");
      expect(r.snapshot.node).toBe("v22.1.0");
      expect(r.snapshot.npmGlobals).toEqual({ foo: "1.0.0" });
      expect(r.snapshot.mcpServers).toEqual(["agent-tasks"]);
    }
  });

  it("rejects invalid JSON", () => {
    const r = parseSnapshotJson("{not valid json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not valid JSON/);
  });

  it("rejects a JSON array (not an object)", () => {
    const r = parseSnapshotJson("[]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a JSON object/);
  });

  it("rejects a missing/empty profile", () => {
    const r = parseSnapshotJson(JSON.stringify({ timestamp: "2026-07-22T11:00:00.000Z" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/profile/);
  });

  it("rejects a missing/invalid timestamp", () => {
    const r = parseSnapshotJson(JSON.stringify({ profile: "peer-a", timestamp: "not-a-date" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/timestamp/);
  });

  it("degrades malformed optional fields to empty instead of rejecting the whole file", () => {
    const r = parseSnapshotJson(
      JSON.stringify({
        profile: "peer-a",
        timestamp: "2026-07-22T11:00:00.000Z",
        npmGlobals: "not-an-object",
        mcpServers: "not-an-array",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.npmGlobals).toEqual({});
      expect(r.snapshot.mcpServers).toEqual([]);
    }
  });
});

describe("compareToPeer", () => {
  const localBase: ToolchainSnapshot = {
    schemaVersion: 1,
    profile: "local",
    timestamp: NOW.toISOString(),
    node: "v22.1.0",
    npmGlobals: { pkg: "1.0.0" },
    owKitVersion: "0.12.0",
    mcpServers: ["agent-tasks"],
  };

  it("reports no drift for identical snapshots", () => {
    const peer: ToolchainSnapshot = { ...localBase, profile: "peer" };
    const result = compareToPeer(localBase, peer, NOW);
    expect(result.drift).toEqual([]);
    expect(result.peerProfile).toBe("peer");
  });

  it("flags a node-version mismatch", () => {
    const peer: ToolchainSnapshot = { ...localBase, profile: "peer", node: "v20.0.0" };
    const result = compareToPeer(localBase, peer, NOW);
    expect(result.drift.map((d) => d.kind)).toEqual(["node"]);
    expect(result.drift[0]?.message).toMatch(/local v22\.1\.0 vs peer peer v20\.0\.0/);
  });

  it("does NOT flag node drift when either side never collected it", () => {
    const localNoNode: ToolchainSnapshot = { ...localBase, node: undefined };
    const peer: ToolchainSnapshot = { ...localBase, profile: "peer", node: "v20.0.0" };
    const result = compareToPeer(localNoNode, peer, NOW);
    expect(result.drift.some((d) => d.kind === "node")).toBe(false);
  });

  it("flags an OW-Kit version mismatch", () => {
    const peer: ToolchainSnapshot = { ...localBase, profile: "peer", owKitVersion: "0.11.0" };
    const result = compareToPeer(localBase, peer, NOW);
    expect(result.drift.map((d) => d.kind)).toEqual(["ow_kit"]);
  });

  it("flags npm package version/missing drift in both directions", () => {
    const peer: ToolchainSnapshot = {
      ...localBase,
      profile: "peer",
      npmGlobals: { pkg: "0.9.0", "peer-only": "2.0.0" },
    };
    const local: ToolchainSnapshot = { ...localBase, npmGlobals: { pkg: "1.0.0", "local-only": "3.0.0" } };
    const result = compareToPeer(local, peer, NOW);
    const kinds = result.drift.map((d) => d.kind).sort();
    expect(kinds).toEqual(["npm_package_missing_local", "npm_package_missing_peer", "npm_package_version"]);
  });

  it("does NOT flag npm drift when either side's npmGlobals collection errored", () => {
    const local: ToolchainSnapshot = { ...localBase, npmGlobalsError: "npm not on PATH" };
    const peer: ToolchainSnapshot = { ...localBase, profile: "peer", npmGlobals: { other: "9.9.9" } };
    const result = compareToPeer(local, peer, NOW);
    expect(result.drift.some((d) => d.kind.startsWith("npm_package"))).toBe(false);
  });

  it("flags mcp server presence drift in both directions", () => {
    const peer: ToolchainSnapshot = { ...localBase, profile: "peer", mcpServers: ["grounding-mcp"] };
    const result = compareToPeer(localBase, peer, NOW);
    const kinds = result.drift.map((d) => d.kind).sort();
    expect(kinds).toEqual(["mcp_missing_local", "mcp_missing_peer"]);
  });

  it("computes snapshot age from the peer's timestamp", () => {
    const peer: ToolchainSnapshot = {
      ...localBase,
      profile: "peer",
      timestamp: new Date(NOW.getTime() - 90 * 60_000).toISOString(),
    };
    const result = compareToPeer(localBase, peer, NOW);
    expect(result.ageMs).toBe(90 * 60_000);
  });
});

describe("runSessionStartToolchainParity — unconfigured", () => {
  it("skips cleanly and never touches disk when toolchain_parity is absent", async () => {
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: parseManifest({ version: 1 }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.reason).toMatch(/not configured/);
    expect(errOut()).toMatch(/not configured/);
  });
});

describe("runSessionStartToolchainParity — no peers", () => {
  it("creates the machine-state dir, writes its own snapshot, and reports nothing to compare", async () => {
    const parent = tmpDir("harness-tcp-nopeer-");
    const machineStateDir = path.join(parent, "nested", "machine-state");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: machineStateDir, profile: "solo-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.peersCompared).toBe(0);
    expect(result.reason).toMatch(/no peer snapshots found/);
    expect(errOut()).toMatch(/no peer snapshots found/);
    // mkdir -p happened, and the own snapshot was written.
    expect(fs.existsSync(path.join(machineStateDir, "solo-machine.json"))).toBe(true);
    const own = JSON.parse(fs.readFileSync(path.join(machineStateDir, "solo-machine.json"), "utf8"));
    expect(own.profile).toBe("solo-machine");
    expect(own.node).toBe("v22.1.0");
  });
});

describe("runSessionStartToolchainParity — ok (no drift)", () => {
  it("writes toolchain-parity:ok and leaves the peer file byte-identical", async () => {
    const dir = tmpDir("harness-tcp-ok-");
    writeSnapshotFile(dir, "peer-a.json", {
      profile: "peer-a",
      timestamp: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const peerRawBefore = fs.readFileSync(path.join(dir, "peer-a.json"), "utf8");

    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.peersCompared).toBe(1);
    expect(result.driftCount).toBe(0);
    expect(writes).toEqual([
      { sessionId: "sess-1", content: "toolchain-parity:ok", source: "harness-session-start-toolchain-parity" },
    ]);
    expect(errOut()).toContain("ok against peer-a");
    expect(errOut()).toContain("recorded toolchain-parity:ok");

    // AC2: peer file must be byte-identical after the run (own-writes-only).
    expect(fs.readFileSync(path.join(dir, "peer-a.json"), "utf8")).toBe(peerRawBefore);
    // Own snapshot was written, and only the own file.
    expect(fs.existsSync(path.join(dir, "local-machine.json"))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(["local-machine.json", "peer-a.json"]);
  });
});

describe("runSessionStartToolchainParity — drift", () => {
  it("reports one result line + one warn line per drift item, and the aggregate drift count in the ledger fact", async () => {
    const dir = tmpDir("harness-tcp-drift-");
    writeSnapshotFile(dir, "peer-b.json", {
      profile: "peer-b",
      timestamp: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      node: "v20.9.0",
      npmGlobals: { "@lannguyensi/harness": "0.40.0", "peer-only-pkg": "2.0.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["grounding-mcp"],
    });

    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      now: NOW,
      runNodeVersion: async () => ({ ok: true as const, version: "v22.1.0" }),
      runNpmGlobals: async () => ({
        ok: true as const,
        packages: { "@lannguyensi/harness": "0.41.0", "local-only-pkg": "1.0.0" },
      }),
      readOwKitVersion: () => ({ version: "0.13.0" }),
      readMcpServerNames: () => ({ names: ["agent-tasks"] }),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });

    // node + ow_kit + npm-version + npm-missing-peer + npm-missing-local +
    // mcp-missing-peer + mcp-missing-local = 7.
    expect(result.driftCount).toBe(7);
    expect(result.peersCompared).toBe(1);
    expect(writes).toEqual([
      { sessionId: "sess-1", content: "toolchain-parity:drift:7", source: "harness-session-start-toolchain-parity" },
    ]);
    const out = errOut();
    expect(out).toContain("drift:7 against peer-b");
    expect(out).toMatch(/drift — node version: local v22\.1\.0 vs peer peer-b v20\.9\.0/);
    expect(out).toMatch(/drift — orchestrator-workflow kit version: local 0\.13\.0 vs peer peer-b 0\.12\.0/);
    expect(out).toMatch(/drift — npm global `@lannguyensi\/harness`: local 0\.41\.0 vs peer peer-b 0\.40\.0/);
    expect(out).toMatch(/drift — npm global `local-only-pkg`: local 1\.0\.0, missing on peer peer-b/);
    expect(out).toMatch(/drift — npm global `peer-only-pkg`: missing locally, peer peer-b has 2\.0\.0/);
    expect(out).toMatch(/drift — mcp server `agent-tasks`: registered locally, missing on peer peer-b/);
    expect(out).toMatch(/drift — mcp server `grounding-mcp`: missing locally, registered on peer peer-b/);
  });
});

describe("runSessionStartToolchainParity — corrupt peer file", () => {
  it("skips a corrupt peer file (logs it) but still compares against the remaining valid ones", async () => {
    const dir = tmpDir("harness-tcp-corrupt-");
    fs.writeFileSync(path.join(dir, "broken.json"), "{not valid json", "utf8");
    writeSnapshotFile(dir, "peer-ok.json", {
      profile: "peer-ok",
      timestamp: new Date(NOW.getTime() - 1 * 60_000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });

    const writes: string[] = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });

    expect(result.wrote).toBe(true);
    expect(result.peersCompared).toBe(1);
    expect(result.driftCount).toBe(0);
    expect(writes).toEqual(["toolchain-parity:ok"]);
    expect(errOut()).toMatch(/peer snapshot broken\.json is corrupt/);
    // The corrupt file itself must be left untouched.
    expect(fs.readFileSync(path.join(dir, "broken.json"), "utf8")).toBe("{not valid json");
  });

  it("reports 'no comparable peer snapshots' when every peer file is corrupt", async () => {
    const dir = tmpDir("harness-tcp-allcorrupt-");
    fs.writeFileSync(path.join(dir, "broken.json"), "not json at all", "utf8");

    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });

    expect(result.wrote).toBe(false);
    expect(result.peersCompared).toBe(0);
    expect(result.reason).toMatch(/no comparable peer snapshots/);
    expect(errOut()).toMatch(/no comparable peer snapshots/);
  });
});

describe("runSessionStartToolchainParity — ledger writer fallback", () => {
  it("reports 'grounding-mcp not declared' when no writeLedger is injected and the manifest has none", async () => {
    const dir = tmpDir("harness-tcp-nogrounding-");
    writeSnapshotFile(dir, "peer-a.json", {
      profile: "peer-a",
      timestamp: NOW.toISOString(),
      node: "v22.1.0",
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      readOwKitVersion: () => ({}),
      readMcpServerNames: () => ({ names: [] }),
      runNpmGlobals: async () => ({ ok: true as const, packages: {} }),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
    });
    expect(result.wrote).toBe(false);
    expect(errOut()).toContain("grounding-mcp not declared");
  });
});

describe("runSessionStartToolchainParity — spawn failures degrade, never throw", () => {
  it("still writes a snapshot and compares when node/npm collection fails", async () => {
    const dir = tmpDir("harness-tcp-collectfail-");
    writeSnapshotFile(dir, "peer-a.json", {
      profile: "peer-a",
      timestamp: NOW.toISOString(),
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      now: NOW,
      runNodeVersion: async () => ({ ok: false as const, reason: "`node` not on PATH" }),
      runNpmGlobals: async () => ({ ok: false as const, reason: "`npm ls -g` timed out after 4000ms" }),
      readOwKitVersion: () => ({}),
      readMcpServerNames: () => ({ names: [] }),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.driftCount).toBe(0);
    expect(errOut()).toContain("node --version: `node` not on PATH");
    expect(errOut()).toContain("npm ls -g: `npm ls -g` timed out after 4000ms");
    const own = JSON.parse(fs.readFileSync(path.join(dir, "local-machine.json"), "utf8"));
    expect(own.node).toBeUndefined();
    expect(own.nodeError).toBe("`node` not on PATH");
  });
});

describe("real node/npm spawn guard (hermetic-spawn-guard.ts)", () => {
  it("refuses a real `node --version` spawn when runNodeVersion is not injected", async () => {
    const dir = tmpDir("harness-tcp-guard-node-");
    await expect(
      runSessionStartToolchainParity({
        stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
        manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      }),
    ).rejects.toThrow(HermeticSpawnViolationError);
    await expect(
      runSessionStartToolchainParity({
        stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
        manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      }),
    ).rejects.toThrow(/Refusing to spawn a REAL "node --version"/);
  });

  it("refuses a real `npm ls -g` spawn when runNpmGlobals is not injected (runNodeVersion injected)", async () => {
    const dir = tmpDir("harness-tcp-guard-npm-");
    await expect(
      runSessionStartToolchainParity({
        runNodeVersion: async () => ({ ok: true as const, version: "v22.1.0" }),
        stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
        manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      }),
    ).rejects.toThrow(/Refusing to spawn a REAL "npm ls -g --depth=0 --json"/);
  });
});
