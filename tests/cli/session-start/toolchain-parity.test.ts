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
    expect(m.toolchain_parity.stale_after_days).toBeUndefined();
  });

  it("parses an explicit enabled config with all fields", () => {
    const m = manifestWithConfig({
      enabled: true,
      machine_state_dir: "/tmp/machine-state",
      profile: "mac-mini",
      workspace_root: "/repo",
      stale_after_days: 14,
    });
    expect(m.toolchain_parity).toEqual({
      enabled: true,
      machine_state_dir: "/tmp/machine-state",
      profile: "mac-mini",
      workspace_root: "/repo",
      stale_after_days: 14,
    });
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() => manifestWithConfig({ enabled: true, bogus_key: 1 })).toThrow();
  });

  it("rejects a non-positive or non-finite stale_after_days", () => {
    expect(() => manifestWithConfig({ enabled: true, stale_after_days: 0 })).toThrow();
    expect(() => manifestWithConfig({ enabled: true, stale_after_days: -1 })).toThrow();
    // Task c1b5ade5 R2, finding 5: `.positive()` alone accepts `Infinity`
    // (reachable via YAML `.inf`), which silently turns the staleness
    // check into a permanent no-op (`ageMs > Infinity` is never true).
    expect(() => manifestWithConfig({ enabled: true, stale_after_days: Infinity })).toThrow();
  });

  it("still accepts a fractional stale_after_days", () => {
    const m = manifestWithConfig({ enabled: true, stale_after_days: 0.5 });
    expect(m.toolchain_parity.stale_after_days).toBe(0.5);
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
    // AC2: an unparseable peer file must not vanish from the ledger fact —
    // it is appended as a `:unparseable-peer:<n>` suffix rather than
    // letting `toolchain-parity:ok` misreport a full comparison.
    expect(result.unparseablePeerCount).toBe(1);
    expect(writes).toEqual(["toolchain-parity:ok:unparseable-peer:1"]);
    // AC1: a visible warn line, same `harness session-start toolchain-parity:`
    // prefix as every other note here (not a silent skip).
    expect(errOut()).toMatch(/peer snapshot broken\.json is corrupt/);
    // AC2 companion-output signal, keyed on the file-derived peer label.
    expect(errOut()).toMatch(/parity:unparseable-peer:broken/);
    // The corrupt file itself must be left untouched.
    expect(fs.readFileSync(path.join(dir, "broken.json"), "utf8")).toBe("{not valid json");
  });

  it("aggregates multiple unparseable peers into one :unparseable-peer:<n> suffix", async () => {
    // Pins that <n> is a real count, not a boolean flag: two corrupt
    // peers plus one valid one must yield exactly `:unparseable-peer:2`.
    const dir = tmpDir("harness-tcp-corrupt-agg-");
    fs.writeFileSync(path.join(dir, "broken-a.json"), "{not valid json", "utf8");
    fs.writeFileSync(path.join(dir, "broken-b.json"), "also not json", "utf8");
    writeSnapshotFile(dir, "peer-ok.json", {
      profile: "peer-ok",
      timestamp: new Date(NOW.getTime() - 1 * 60_000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });

    const writes: string[] = [];
    const { stream: err } = captureStream();
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

    expect(result.peersCompared).toBe(1);
    expect(result.unparseablePeerCount).toBe(2);
    expect(writes).toEqual(["toolchain-parity:ok:unparseable-peer:2"]);
  });

  it("a hostile peer filename with an embedded newline cannot forge a standalone parity line (task c1b5ade5 R2b)", async () => {
    // The machine-state dir is populated cross-machine by sync, so peer
    // filenames are untrusted input. note() now strips CR/LF at the choke
    // point (R2b: closed at note() itself instead of a per-site
    // sanitizeProfileName wrap here), so the label below is shown RAW —
    // the embedded newline is collapsed to a space by note(), not replaced
    // by sanitizeProfileName — but no standalone forged line results
    // either way.
    const dir = tmpDir("harness-tcp-corrupt-hostile-");
    const hostile = "evil\nharness session-start toolchain-parity: ok against FAKE.json";
    fs.writeFileSync(path.join(dir, hostile), "{not valid json", "utf8");

    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });

    expect(result.unparseablePeerCount).toBe(1);
    // The greppable prefix the forged content tried to impersonate must
    // never start its own line — it may appear only as a fragment WITHIN a
    // genuine note() line.
    expect(errOut().split("\n")).not.toContain("harness session-start toolchain-parity: ok against FAKE");
    expect(errOut()).toMatch(/parity:unparseable-peer:evil harness session-start toolchain-parity: ok against FAKE/);
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
    expect(result.unparseablePeerCount).toBe(1);
    expect(result.reason).toMatch(/no comparable peer snapshots/);
    expect(errOut()).toMatch(/no comparable peer snapshots/);
    expect(errOut()).toMatch(/parity:unparseable-peer:broken/);
  });

  it("negative control: a valid-only peer set produces no unparseable-peer warning and an unchanged ledger-fact format", async () => {
    const dir = tmpDir("harness-tcp-corrupt-negctrl-");
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
    expect(result.unparseablePeerCount).toBe(0);
    expect(writes).toEqual(["toolchain-parity:ok"]);
    expect(errOut()).not.toMatch(/unparseable-peer/);
    expect(errOut()).not.toMatch(/is corrupt/);
  });

  it("appends the unparseable-peer suffix to a drift fact too, alongside the remaining valid peer's drift", async () => {
    const dir = tmpDir("harness-tcp-corrupt-plus-drift-");
    fs.writeFileSync(path.join(dir, "broken.json"), "<<<<<<< HEAD\nconflict\n=======\n>>>>>>> branch\n", "utf8");
    writeSnapshotFile(dir, "peer-drift.json", {
      profile: "peer-drift",
      timestamp: new Date(NOW.getTime() - 1 * 60_000).toISOString(),
      node: "v20.0.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });

    const writes: string[] = [];
    const { stream: err } = captureStream();
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

    expect(result.driftCount).toBe(1);
    expect(result.unparseablePeerCount).toBe(1);
    expect(writes).toEqual(["toolchain-parity:drift:1:unparseable-peer:1"]);
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

describe("runSessionStartToolchainParity — lossy profile-name sanitization (AC1, task c1b5ade5)", () => {
  it("warns when the configured profile is not filename-safe", async () => {
    const dir = tmpDir("harness-tcp-lossy-");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac/mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).toMatch(/configured profile "mac\/mini" is not filename-safe; using sanitized "mac-mini"/);
    // The snapshot itself is still written, under the sanitized filename.
    expect(fs.existsSync(path.join(dir, "mac-mini.json"))).toBe(true);
  });

  it("negative control: does NOT warn when the configured profile is already filename-safe", async () => {
    const dir = tmpDir("harness-tcp-nolossy-");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac-mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).not.toMatch(/is not filename-safe/);
  });

  it("flags a collision when the sanitized filename already holds a DIFFERENT profile's snapshot", async () => {
    const dir = tmpDir("harness-tcp-lossy-collide-");
    // Pre-seed the sanitized target filename with a snapshot belonging to a
    // DIFFERENT profile: sanitizeProfileName("mac/mini") === "mac-mini",
    // the same target this run's own write is about to use, so this run's
    // write is about to silently overwrite what looks like a peer's file.
    writeSnapshotFile(dir, "mac-mini.json", {
      profile: "mac-mini",
      timestamp: NOW.toISOString(),
      node: "v20.0.0",
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac/mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).toMatch(
      /WARNING: sanitized filename "mac-mini\.json" collides with an existing snapshot for a DIFFERENT profile \("mac-mini"\)/,
    );
  });

  it("flags a collision even when THIS machine's own profile is already filename-safe (task c1b5ade5 R2, finding 2: safe overwrites lossy)", async () => {
    // Finding 2: the collision read used to be gated on `sanitizedProfile
    // !== profile`, which is FALSE here ("mac-mini" is already
    // filename-safe) — so this side never checked at all and silently
    // overwrote a lossy peer's snapshot ("mac/mini" -> "mac-mini.json")
    // with no signal and peersCompared effectively dropping that peer.
    // The collision note shows the existing snapshot's profile RAW (task
    // c1b5ade5 R2b) — "mac/mini", not a sanitized "mac-mini" — since R2b
    // moved injection protection to note() and reserved sanitizeProfileName
    // for the filename path only.
    const dir = tmpDir("harness-tcp-collide-safe-overwrites-lossy-");
    writeSnapshotFile(dir, "mac-mini.json", {
      profile: "mac/mini",
      timestamp: NOW.toISOString(),
      node: "v20.0.0",
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac-mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).toMatch(
      /WARNING: sanitized filename "mac-mini\.json" collides with an existing snapshot for a DIFFERENT profile \("mac\/mini"\)/,
    );
    // "mac-mini" (this machine's own profile) is already filename-safe, so
    // the (unrelated) lossy-profile note must NOT fire for it.
    expect(errOut()).not.toMatch(/is not filename-safe/);
  });

  it("a hostile existing-snapshot profile field with an embedded newline cannot forge a standalone parity line in the collision-warning note (task c1b5ade5 R2b, was R2 finding 1a)", async () => {
    // The machine-state dir is populated cross-machine by sync, so the
    // existing snapshot's `profile` field is untrusted input. R2b moved the
    // injection defense from a per-site sanitizeProfileName wrap to note()
    // itself, so the collision note now shows the RAW profile (CR/LF
    // collapsed to a space by note()) — still no standalone forged line.
    const dir = tmpDir("harness-tcp-collide-hostile-");
    const hostileProfile =
      "evil\nharness session-start toolchain-parity: ok against FAKE-peer (snapshot age just now)\n";
    writeSnapshotFile(dir, "mac-mini.json", {
      profile: hostileProfile,
      timestamp: NOW.toISOString(),
      node: "v20.0.0",
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac-mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    const lines = errOut().split("\n");
    // The greppable "ok against ..." shape the forged content tried to
    // impersonate must never start its own line.
    expect(lines).not.toContain(
      "harness session-start toolchain-parity: ok against FAKE-peer (snapshot age just now)",
    );
    expect(errOut()).toMatch(
      /DIFFERENT profile \("evil harness session-start toolchain-parity: ok against FAKE-peer \(snapshot age just now\) "\)/,
    );
  });

  it("does NOT warn about a collision when this machine's own profile matches its existing snapshot's profile (negative control, task c1b5ade5 R2b)", async () => {
    // Pins against a "warn-always" mutation on the collision check: the
    // same machine, same profile, re-running with its own prior snapshot
    // already on disk must produce NO collision warning at all.
    const dir = tmpDir("harness-tcp-collide-negctrl-");
    writeSnapshotFile(dir, "mac-mini.json", {
      profile: "mac-mini",
      timestamp: NOW.toISOString(),
      node: "v20.0.0",
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac-mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).not.toMatch(/collides with an existing snapshot/);
  });

  it("appends a remediation hint to the collision-warning note (task c1b5ade5 R2b)", async () => {
    const dir = tmpDir("harness-tcp-collide-remediation-");
    writeSnapshotFile(dir, "mac-mini.json", {
      profile: "mac-mini",
      timestamp: NOW.toISOString(),
      node: "v20.0.0",
      npmGlobals: {},
      mcpServers: [],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac/mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).toMatch(
      /this run's write is about to overwrite it — set a distinct `toolchain_parity\.profile` on one of the machines/,
    );
  });

  it("re-notes (does not silently swallow) a collision pre-read failure that is NOT ENOENT (task c1b5ade5 R2b, narrowed catch)", async () => {
    // A directory at the sanitized target path throws EISDIR on read,
    // never ENOENT — the narrowed catch must re-note this one line instead
    // of silently skipping it the way a genuinely-absent file does.
    const dir = tmpDir("harness-tcp-collide-eisdir-");
    fs.mkdirSync(path.join(dir, "mac-mini.json"));
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "mac-mini" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).toMatch(/could not check for a profile-name collision on mac-mini\.json/);
  });
});

describe("runSessionStartToolchainParity — defensive catches (AC2, task c1b5ade5)", () => {
  it("degrades to exit 0 with a note when the injected session resolver throws", async () => {
    const dir = tmpDir("harness-tcp-resolvesession-throw-");
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
      resolveSession: () => {
        throw new Error("boom: transcript discovery exploded");
      },
      stdin: streamFrom(JSON.stringify({ cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("default");
    expect(errOut()).toMatch(/session id resolution failed: boom: transcript discovery exploded/);
    // The rest of the run still completes normally: own snapshot written,
    // peer compared, ledger recorded — a session-resolution throw must not
    // abort collection or comparison.
    expect(result.wrote).toBe(true);
    expect(fs.existsSync(path.join(dir, "local-machine.json"))).toBe(true);
  });

  it("reports sessionSource 'default', not 'stdin' (task c1b5ade5 R2, finding 3), when stdin DID carry a session_id but the resolver still throws", async () => {
    // Same throwing resolver as the test above, but this time the stdin
    // event DOES carry a session_id — the pre-fix ternary computed
    // sessionSource purely from event.session_id's presence, so it still
    // reported "stdin" even though sessionId was actually the fallback
    // "default" (the resolver never returned). That both misrepresents the
    // ledger fact's provenance and suppresses the AC5 "default" warning.
    const dir = tmpDir("harness-tcp-resolvesession-throw-withid-");
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
      resolveSession: () => {
        throw new Error("boom: transcript discovery exploded");
      },
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("default");
    expect(result.sessionSource).toBe("default");
    expect(result.wrote).toBe(true);
    expect(errOut()).toMatch(/WARNING: session resolved to the literal "default"/);
  });

  it("degrades to exit 0 with a note when the injected writeLedger REJECTS instead of resolving", async () => {
    const dir = tmpDir("harness-tcp-writeledger-reject-");
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
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => {
        throw new Error("grounding-mcp connection reset");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.reason).toMatch(/ledger write threw: grounding-mcp connection reset/);
    expect(errOut()).toMatch(/ledger write threw: grounding-mcp connection reset/);
  });
});

describe("runSessionStartToolchainParity — configurable staleness threshold (AC3, task c1b5ade5)", () => {
  it("adds a stale-peer warning, without inflating drift, when a peer's age exceeds stale_after_days", async () => {
    const dir = tmpDir("harness-tcp-stale-");
    writeSnapshotFile(dir, "peer-old.json", {
      profile: "peer-old",
      timestamp: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days old
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
      manifest: manifestWithConfig({
        enabled: true,
        machine_state_dir: dir,
        profile: "local-machine",
        stale_after_days: 7,
      }),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.driftCount).toBe(0);
    expect(writes).toEqual(["toolchain-parity:ok"]);
    expect(errOut()).toMatch(/peer peer-old snapshot is stale \(age 10d, exceeds the configured 7d threshold\)/);
  });

  it("boundary (task c1b5ade5 R2, finding 6): no note exactly AT the threshold, a note one ms past it", async () => {
    // Pins the strict `>` operator in `comparison.ageMs > staleAfterMs`: a
    // mutation to `>=` must turn the first assertion here red.
    const dir = tmpDir("harness-tcp-stale-boundary-");
    const staleAfterMs = 7 * 24 * 60 * 60 * 1000;

    // Exactly at the threshold: NOT stale.
    writeSnapshotFile(dir, "peer-exact.json", {
      profile: "peer-exact",
      timestamp: new Date(NOW.getTime() - staleAfterMs).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: errAt, output: errAtOut } = captureStream();
    const resultAt = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: errAt,
      manifest: manifestWithConfig({
        enabled: true,
        machine_state_dir: dir,
        profile: "local-machine",
        stale_after_days: 7,
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(resultAt.exitCode).toBe(0);
    expect(errAtOut()).not.toMatch(/is stale/);

    // One ms past the threshold: stale.
    const dir2 = tmpDir("harness-tcp-stale-boundary-over-");
    writeSnapshotFile(dir2, "peer-over.json", {
      profile: "peer-over",
      timestamp: new Date(NOW.getTime() - staleAfterMs - 1).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: errOver, output: errOverOut } = captureStream();
    const resultOver = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: errOver,
      manifest: manifestWithConfig({
        enabled: true,
        machine_state_dir: dir2,
        profile: "local-machine",
        stale_after_days: 7,
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(resultOver.exitCode).toBe(0);
    expect(errOverOut()).toMatch(/peer peer-over snapshot is stale/);
  });

  it("a hostile peer profile field with an embedded newline cannot forge a standalone line anywhere in output, including the stale-peer note (task c1b5ade5 R2b, was R2 finding 1b)", async () => {
    // R2b closes the injection defense at note() itself (CR/LF stripped
    // once, for every note() call), so — unlike the R2-era per-site
    // sanitizeProfileName wrap this replaces — this is no longer confined
    // to protecting ONE site's own line: a hostile `profile` on a peer
    // that ALSO drifts (or, as here, matches exactly and is merely stale)
    // reaches BOTH the "ok against" note (comparison.peerProfile,
    // previously the reviewer's still-open vector 1) and this stale-peer
    // note through the same `comparison` object, and neither can forge a
    // standalone line now.
    const dir = tmpDir("harness-tcp-stale-hostile-");
    const hostileProfile =
      "evil\nharness session-start toolchain-parity: ok against FAKE-peer (snapshot age just now)\n";
    writeSnapshotFile(dir, "peer-hostile.json", {
      profile: hostileProfile,
      timestamp: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days old
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({
        enabled: true,
        machine_state_dir: dir,
        profile: "local-machine",
        stale_after_days: 7,
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    const lines = errOut().split("\n");
    expect(lines).not.toContain(
      "harness session-start toolchain-parity: ok against FAKE-peer (snapshot age just now)",
    );
    expect(errOut()).toMatch(
      /peer evil harness session-start toolchain-parity: ok against FAKE-peer \(snapshot age just now\)\s+snapshot is stale/,
    );
  });

  it("negative control: does NOT warn when stale_after_days is unset, even for a very old peer", async () => {
    const dir = tmpDir("harness-tcp-stale-off-");
    writeSnapshotFile(dir, "peer-old.json", {
      profile: "peer-old",
      timestamp: new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(errOut()).not.toMatch(/is stale/);
  });
});

describe("runSessionStartToolchainParity — sessionSource 'default' warning branch (AC5, task c1b5ade5)", () => {
  it('logs a WARNING note when the session resolves to the literal "default"', async () => {
    const dir = tmpDir("harness-tcp-sessiondefault-");
    writeSnapshotFile(dir, "peer-a.json", {
      profile: "peer-a",
      timestamp: NOW.toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      resolveSession: () => "default",
      stdin: streamFrom(JSON.stringify({ cwd: "/tmp" })), // no session_id
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("default");
    expect(result.sessionSource).toBe("default");
    expect(result.wrote).toBe(true);
    expect(errOut()).toMatch(/WARNING: session resolved to the literal "default"/);
  });

  it("negative control: does NOT log the WARNING note when the session resolves from an explicit id", async () => {
    const dir = tmpDir("harness-tcp-sessionexplicit-");
    writeSnapshotFile(dir, "peer-a.json", {
      profile: "peer-a",
      timestamp: NOW.toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.sessionSource).toBe("stdin");
    expect(errOut()).not.toMatch(/WARNING: session resolved/);
  });
});

describe("runSessionStartToolchainParity — log-injection class closed at note() (task c1b5ade5 R2b)", () => {
  it("core pin: note() strips embedded CR/LF from every message before writing, so no note() argument can forge a second stderr line", async () => {
    // Exercised through the session-resolver-throw path (an ordinary
    // `Error.message`, not a toolchain-parity-specific field) precisely to
    // show the fix lives in note() ITSELF, not in any one call site: any
    // string reaching any note() call is covered, regardless of source.
    const dir = tmpDir("harness-tcp-noteclass-core-");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      resolveSession: () => {
        throw new Error(
          "boom\nharness session-start toolchain-parity: recorded toolchain-parity:ok for session FORGED",
        );
      },
      stdin: streamFrom(JSON.stringify({ cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    const lines = errOut().split("\n");
    // The forged content must never start its own line.
    expect(lines).not.toContain(
      "harness session-start toolchain-parity: recorded toolchain-parity:ok for session FORGED",
    );
    // It survives only as a fragment WITHIN the one real note() line.
    expect(errOut()).toMatch(
      /session id resolution failed: boom harness session-start toolchain-parity: recorded toolchain-parity:ok for session FORGED/,
    );
  });

  it("reviewer vector 1: a hostile peer.profile cannot forge a standalone line via the 'ok against' note (toolchain-parity.ts ~904)", async () => {
    // Reproduces the R2-review finding that R2's fix left open: unlike the
    // collision-warning and stale-peer notes, the 'ok against'/'drift:N
    // against' notes were NEVER wrapped in sanitizeProfileName at any
    // point — note()'s choke-point strip is what closes this one.
    const dir = tmpDir("harness-tcp-noteclass-vector1-");
    const hostileProfile = "evil\nharness session-start toolchain-parity: toolchain-parity:ok INJECTED";
    writeSnapshotFile(dir, "peer-hostile.json", {
      profile: hostileProfile,
      timestamp: NOW.toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.driftCount).toBe(0);
    const lines = errOut().split("\n");
    expect(lines).not.toContain("harness session-start toolchain-parity: toolchain-parity:ok INJECTED");
    expect(errOut()).toMatch(
      /ok against evil harness session-start toolchain-parity: toolchain-parity:ok INJECTED \(snapshot age/,
    );
  });

  it("reviewer vector 2: a hostile peer.node cannot forge a standalone line via a drift-message note (compareToPeer ~504, emitted ~907)", async () => {
    // Reproduces the R2-review finding that a drift message built from ANY
    // untrusted snapshot field (here peer.node; owKitVersion and every
    // npm/mcp name share the same compareToPeer -> note() path) could
    // forge a standalone greppable line — proven with the
    // `parity:unparseable-peer:` tag specifically, since that is the exact
    // greppable prefix an operator would grep `harness audit` for.
    const dir = tmpDir("harness-tcp-noteclass-vector2-");
    const hostileNode = "v20.0.0\nharness session-start toolchain-parity: parity:unparseable-peer:INJECTED";
    writeSnapshotFile(dir, "peer-b.json", {
      profile: "peer-b",
      timestamp: NOW.toISOString(),
      node: hostileNode,
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, machine_state_dir: dir, profile: "local-machine" }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.driftCount).toBeGreaterThan(0);
    const lines = errOut().split("\n");
    expect(lines).not.toContain("harness session-start toolchain-parity: parity:unparseable-peer:INJECTED");
    expect(errOut()).toMatch(
      /drift — node version: local v22\.1\.0 vs peer peer-b v20\.0\.0 harness session-start toolchain-parity: parity:unparseable-peer:INJECTED/,
    );
  });

  it("label coherence: a peer's name is shown identically in the 'ok against' note and the stale-peer note (task c1b5ade5 R2b)", async () => {
    // "café-mini" is a legitimate, non-ASCII profile name — not hostile.
    // Before this round, the "ok against"/"drift:N against" notes always
    // showed peer profiles RAW while the stale-peer note ran the SAME
    // field through sanitizeProfileName (a FILENAME escaper), so a
    // non-ASCII peer could show up spelled two different ways within one
    // run. Both sites are raw now, so the spelling matches.
    const dir = tmpDir("harness-tcp-noteclass-coherence-");
    writeSnapshotFile(dir, "peer-cafe.json", {
      profile: "café-mini",
      timestamp: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days old
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.41.0" },
      owKitVersion: "0.12.0",
      mcpServers: ["agent-tasks", "grounding-mcp"],
    });
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartToolchainParity({
      ...baseCollectors(),
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: "/tmp" })),
      stderr: err,
      manifest: manifestWithConfig({
        enabled: true,
        machine_state_dir: dir,
        profile: "local-machine",
        stale_after_days: 7,
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.driftCount).toBe(0);
    expect(errOut()).toMatch(/ok against café-mini \(snapshot age/);
    expect(errOut()).toMatch(/peer café-mini snapshot is stale/);
  });
});
