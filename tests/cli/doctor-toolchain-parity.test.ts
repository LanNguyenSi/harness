// Tests for the `harness doctor` toolchain-parity section (task
// 13919613) — the on-demand doctor companion to `harness session-start
// toolchain-parity`. Covers section gating (omitted when the manifest
// doesn't opt in via `toolchain_parity.enabled`), the four scenarios the
// task brief calls out (ok / drift / unconfigured / peer-missing), that
// drift always rolls into warningCount and NEVER errorCount (advisory,
// not a gate), the `--shallow` spawn-skip, the hermetic-spawn-guard on
// the reused real collectors, a corrupt-peer-file degrade, and the
// CR/LF-injection guard the doctor format layer applies to peer-
// controlled strings (mirrors the note()-choke-point defense already
// proven in tests/cli/session-start/toolchain-parity.test.ts). Every
// test that reaches the collection step injects `toolchainParityOptions`
// so no real `node`/`npm` is ever spawned.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { HermeticSpawnViolationError } from "../../src/runtime/hermetic-spawn-guard.js";
import type { ToolchainSnapshot } from "../../src/cli/session-start/toolchain-parity.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-toolchain-parity-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSnapshotFile(
  dir: string,
  fileName: string,
  snapshot: Partial<ToolchainSnapshot> & { profile: string; timestamp: string },
): void {
  const full: ToolchainSnapshot = {
    schemaVersion: 1,
    npmGlobals: {},
    mcpServers: [],
    ...snapshot,
  };
  fs.writeFileSync(path.join(dir, fileName), `${JSON.stringify(full, null, 2)}\n`, "utf8");
}

// Same silencing convention as the other doctor test files: the three
// shipped operator_only kill-switch policies are absent from these
// minimal fixtures, so without this the template-drift check would add
// 3 unrelated errors and swamp this file's own errorCount assertions.
const SILENCE_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

function manifestYaml(machineStateDir: string): string {
  // `memory.router.command` points at a real, always-present executable
  // (`/usr/bin/true`) purely to zero out the unrelated baseline "no
  // memory router declared" warning every doctor test not exercising the
  // Memory section already works around the same way (see "doctor —
  // memory.router min_version" below) — this file's warningCount
  // assertions are about toolchain-parity, not memory.
  return `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}memory:
  router:
    command: [/usr/bin/true]
toolchain_parity:
  enabled: true
  profile: local
  machine_state_dir: ${JSON.stringify(machineStateDir)}
`;
}

const NOW = new Date("2026-08-19T12:00:00.000Z");

// Mirrors baseCollectors() in the session-start test file: a happy-path
// node/npm/OW-Kit/MCP set with no surprises, used as the shared "local
// machine" fixture every ok/drift test compares a peer against.
function baseCollectors() {
  return {
    now: NOW,
    runNodeVersion: async () => ({ ok: true as const, version: "v22.1.0" }),
    runNpmGlobals: async () => ({
      ok: true as const,
      packages: { "@lannguyensi/harness": "0.44.0" },
    }),
    readOwKitVersion: () => ({ version: "0.18.0" }),
    readMcpServerNames: () => ({ names: ["agent-tasks"] }),
  };
}

describe("doctor toolchain-parity — section gating (unconfigured)", () => {
  it("omits the section entirely when toolchain_parity is not enabled", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks: []
policies: []
memory:
  router:
    command: [/usr/bin/true]
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.toolchainParity).toBeUndefined();
    expect(report.warningCount).toBe(0);
    expect(format(report)).not.toContain("Toolchain Parity");
  });
});

describe("doctor toolchain-parity — no peer snapshot", () => {
  it("reports no-peers when enabled but the machine-state dir has no peer files", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      toolchainParityOptions: baseCollectors(),
    });
    expect(report.toolchainParity?.status).toBe("no-peers");
    expect(report.toolchainParity?.peers).toEqual([]);
    expect(report.warningCount).toBe(0);
    expect(report.errorCount).toBe(0);
    const text = format(report);
    expect(text).toContain("Toolchain Parity");
    expect(text).toContain("no peer snapshots found");
  });

  it("reports no-peers when the machine-state dir does not exist yet (no spawn either)", async () => {
    const stateDir = path.join(tmpDir("harness-tp-parent-"), "does-not-exist");
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    // Deliberately NOT injecting toolchainParityOptions: the peer-existence
    // check must run BEFORE any collection, so this resolving (rather than
    // throwing HermeticSpawnViolationError) proves the no-peer short-circuit
    // never reaches the real node/npm collectors.
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.toolchainParity?.status).toBe("no-peers");
  });
});

describe("doctor toolchain-parity — ok", () => {
  it("reports ok, with age and peer label, when the local live snapshot matches a peer", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    writeSnapshotFile(stateDir, "peer-a.json", {
      profile: "peer-a",
      timestamp: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.44.0" },
      owKitVersion: "0.18.0",
      mcpServers: ["agent-tasks"],
    });
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      toolchainParityOptions: baseCollectors(),
    });
    expect(report.toolchainParity?.status).toBe("ok");
    expect(report.toolchainParity?.driftTotal).toBe(0);
    expect(report.toolchainParity?.peers).toHaveLength(1);
    expect(report.toolchainParity?.peers[0]).toMatchObject({
      peerProfile: "peer-a",
      status: "ok",
      driftCount: 0,
      ageLabel: "5m",
    });
    expect(report.warningCount).toBe(0);
    expect(report.errorCount).toBe(0);
    const text = format(report);
    expect(text).toContain("✓ peer-a  ok (snapshot age 5m)");
  });
});

describe("doctor toolchain-parity — drift", () => {
  it("reports drift and rolls it into warningCount, never errorCount", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    writeSnapshotFile(stateDir, "peer-b.json", {
      profile: "peer-b",
      timestamp: new Date(NOW.getTime() - 60_000).toISOString(),
      node: "v18.20.0",
      npmGlobals: { "@lannguyensi/harness": "0.44.0" },
      owKitVersion: "0.18.0",
      mcpServers: ["agent-tasks"],
    });
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      toolchainParityOptions: baseCollectors(),
    });
    expect(report.toolchainParity?.status).toBe("drift");
    expect(report.toolchainParity?.driftTotal).toBe(1);
    expect(report.toolchainParity?.peers[0]?.status).toBe("drift");
    expect(report.toolchainParity?.peers[0]?.driftCount).toBe(1);
    // Mutation probe target 1 (task 13919613): if countDiagnostics ever
    // counted toolchain-parity drift into errorCount instead of
    // warningCount, this pair of assertions is what catches it.
    expect(report.warningCount).toBe(1);
    expect(report.errorCount).toBe(0);
    // Mutation probe target 2: if the reused `compareToPeer` import were
    // swapped for a stub that never reports drift, driftTotal/peers above
    // would silently read 0/"ok" instead of 1/"drift" — these assertions,
    // together with the rendered drift message below, are what catches
    // that neutralization.
    const text = format(report);
    expect(text).toContain("⚠ peer-b  drift:1 (snapshot age 1m)");
    expect(text).toContain("drift — node version: local v22.1.0 vs peer peer-b v18.20.0");
  });
});

describe("doctor toolchain-parity — corrupt peer file", () => {
  it("skips a corrupt peer file, surfacing it as unparseablePeers without touching driftTotal", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    fs.writeFileSync(path.join(stateDir, "corrupt.json"), "{ not valid json", "utf8");
    writeSnapshotFile(stateDir, "peer-a.json", {
      profile: "peer-a",
      timestamp: new Date(NOW.getTime() - 60_000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.44.0" },
      owKitVersion: "0.18.0",
      mcpServers: ["agent-tasks"],
    });
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      toolchainParityOptions: baseCollectors(),
    });
    expect(report.toolchainParity?.status).toBe("ok");
    expect(report.toolchainParity?.unparseablePeers).toEqual(["corrupt"]);
    expect(report.toolchainParity?.driftTotal).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  it("reports no-peers with the corrupt files surfaced when EVERY peer file is unparseable", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    fs.writeFileSync(path.join(stateDir, "corrupt-a.json"), "{ not valid json", "utf8");
    fs.writeFileSync(path.join(stateDir, "corrupt-b.json"), "also not json", "utf8");
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      toolchainParityOptions: baseCollectors(),
    });
    // No parseable peer to compare against -> no-peers, but the corrupt
    // files are still surfaced (not silently dropped), and no diagnostic
    // counter moves.
    expect(report.toolchainParity?.status).toBe("no-peers");
    expect(report.toolchainParity?.unparseablePeers?.sort()).toEqual(["corrupt-a", "corrupt-b"]);
    expect(report.warningCount).toBe(0);
    expect(report.errorCount).toBe(0);
  });
});

describe("doctor toolchain-parity — --shallow", () => {
  it("skips the live collection under --shallow (no real node/npm spawn)", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    writeSnapshotFile(stateDir, "peer-a.json", {
      profile: "peer-a",
      timestamp: NOW.toISOString(),
      node: "v22.1.0",
    });
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    // No toolchainParityOptions injected: --shallow must short-circuit
    // BEFORE the real collectors are ever reached, so this resolving
    // (rather than throwing HermeticSpawnViolationError) is itself part
    // of the proof.
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      shallow: true,
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.toolchainParity?.status).toBe("skipped");
    expect(report.toolchainParity?.peers).toEqual([]);
    expect(report.warningCount).toBe(0);
    const text = format(report);
    expect(text).toContain("Toolchain Parity");
    expect(text).toContain("does not collect a live toolchain snapshot");
  });
});

describe("doctor toolchain-parity — hermetic spawn guard", () => {
  it("throws HermeticSpawnViolationError when a peer exists and no execs are injected", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    writeSnapshotFile(stateDir, "peer-a.json", {
      profile: "peer-a",
      timestamp: NOW.toISOString(),
      node: "v22.1.0",
    });
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    // Non-inert: removing the `assertNoRealSpawnInTests(...)` call from
    // either reused real collector, or bypassing the injectable
    // `runNodeVersion`/`runNpmGlobals` seam in this module, would make
    // this resolve successfully (or hang on a real spawn) instead of
    // rejecting.
    await expect(
      doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        pathEnv: "",
        npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      }),
    ).rejects.toThrow(HermeticSpawnViolationError);
  });
});

describe("doctor toolchain-parity — CR/LF injection guard at the format layer", () => {
  it("a hostile peer.profile with an embedded newline cannot forge a standalone doctor line", async () => {
    const stateDir = tmpDir("harness-tp-state-");
    // Matches the local snapshot on every field (no drift) so the ONLY
    // thing under test is whether the raw profile string can forge its
    // own line — a drift-message vector is already covered by the
    // "drift" describe block above via the SAME compareToPeer message
    // interpolation path.
    const hostileProfile = "evil\n  ✓ FORGED-PEER  ok (snapshot age just now)";
    writeSnapshotFile(stateDir, "peer-hostile.json", {
      profile: hostileProfile,
      timestamp: new Date(NOW.getTime() - 60_000).toISOString(),
      node: "v22.1.0",
      npmGlobals: { "@lannguyensi/harness": "0.44.0" },
      owKitVersion: "0.18.0",
      mcpServers: ["agent-tasks"],
    });
    const home = makeFixture({ "harness.yaml": manifestYaml(stateDir) });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      toolchainParityOptions: baseCollectors(),
    });
    expect(report.toolchainParity?.status).toBe("ok");
    // The structured field itself still carries the raw, un-stripped
    // value (stripping only happens at render time, per this module's
    // `peerLabelFromFileName`/format.ts doc) — the assertion that matters
    // is on the RENDERED text below.
    expect(report.toolchainParity?.peers[0]?.peerProfile).toBe(hostileProfile);
    const text = format(report);
    const lines = text.split("\n");
    // The forged content must never start its own line.
    expect(lines).not.toContain("  ✓ FORGED-PEER  ok (snapshot age just now)");
    // It is still visible (not silently dropped), just neutered onto the
    // single real peer line, CR/LF collapsed to spaces.
    expect(text).toContain("evil   ✓ FORGED-PEER  ok (snapshot age just now)");
  });
});
