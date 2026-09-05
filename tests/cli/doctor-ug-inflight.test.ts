// Tests for the in-flight-subagent-records doctor metric
// (subagent-gate slice 1, docs/decisions/2026-08-27-ug-auto-mode-approval.md
// "Invariants", "Threat model", "Delegation marker shape"). Mirrors
// tests/cli/doctor-ug-delegations.test.ts's own shape: fixtures write
// plain JSON bodies directly (no HMAC signing) since this is an audit
// surface, never a security check.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { buildUgInflight } from "../../src/cli/doctor/ug-inflight.js";
import { buildLastApply, writeLastApply } from "../../src/io/last-apply.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempGeneratedDir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-inflight-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return path.join(home, "harness.generated");
}

function writeInflight(
  generatedDir: string,
  sessionId: string,
  agentId: string,
  startedAt: string,
): void {
  const dir = path.join(generatedDir, ".inflight", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, agentId),
    JSON.stringify({
      sessionId,
      agentId,
      agentType: "general-purpose",
      startedAt,
      parentSource: "session",
      parentDetail: "approved via marker sess-1",
      approvedAt: startedAt,
      approvedBy: "inflight:general-purpose:parent=session",
      reportContentHash: null,
      alg: "hmac-sha256-v1",
      signature: "deadbeef",
    }),
    "utf8",
  );
}

const NOW = new Date("2026-09-05T10:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 1 * 3_600_000).toISOString(); // 1h old
const STALE = new Date(NOW.getTime() - 25 * 3_600_000).toISOString(); // 25h old

describe("buildUgInflight: pure function", () => {
  it("no .inflight/ directory: inflightDirPresent false, everything zero", () => {
    const generatedDir = tempGeneratedDir();
    const result = buildUgInflight(generatedDir);
    expect(result).toEqual({ inflightDirPresent: false, total: 0, stale: 0, skipped: 0 });
  });

  it("an empty .inflight/ directory (present, no files): inflightDirPresent true, everything zero", () => {
    const generatedDir = tempGeneratedDir();
    fs.mkdirSync(path.join(generatedDir, ".inflight"), { recursive: true });
    const result = buildUgInflight(generatedDir);
    expect(result).toEqual({ inflightDirPresent: true, total: 0, stale: 0, skipped: 0 });
  });

  it("2 records with 1 stale: total 2, stale 1", () => {
    const generatedDir = tempGeneratedDir();
    writeInflight(generatedDir, "sid-1", "agent-fresh", FRESH);
    writeInflight(generatedDir, "sid-1", "agent-stale", STALE);
    const result = buildUgInflight(generatedDir, { now: NOW });
    expect(result).toEqual({ inflightDirPresent: true, total: 2, stale: 1, skipped: 0 });
  });

  it("a record that is not valid JSON is skipped, never counted, never crashes", () => {
    const generatedDir = tempGeneratedDir();
    const dir = path.join(generatedDir, ".inflight", "sid-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent-corrupt"), "not json{{{", "utf8");
    const result = buildUgInflight(generatedDir, { now: NOW });
    expect(result).toEqual({ inflightDirPresent: true, total: 0, stale: 0, skipped: 1 });
  });
});

let doctorCleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of doctorCleanups) c();
  doctorCleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-inflight-fixture-"));
  doctorCleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

const SILENCE_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

const MANIFEST_WITH_PACK = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
`;

const MANIFEST_WITHOUT_PACK = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
`;

describe("doctor: ug in-flight records (Environment section)", () => {
  it("renders 0 records: informational (ℹ), no parenthetical", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    fs.mkdirSync(path.join(home, "harness.generated", ".inflight"), { recursive: true });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: NOW,
    });

    expect(report.ugInflight).toEqual({ inflightDirPresent: true, total: 0, stale: 0, skipped: 0 });
    const text = format(report);
    expect(text).toContain("ℹ in-flight subagent records on disk: 0 (0 stale)");
  });

  it("renders the Environment section on .inflight/ alone: no auto-approvals, no delegations, no drift content", async () => {
    // Isolates the visibility gate's `.inflight/` clause in format.ts:
    // every OTHER thing that can force the Environment section open
    // (bin warn, modeEnv, auto-approve mode, bypass, `.approvals/`,
    // `.delegations/`, settings drift) is silenced here, including the
    // "no apply snapshot" drift note the other tests in this file don't
    // bother clearing. Without a clean `.last-apply` snapshot that note
    // alone would keep the section open regardless of the `.inflight/`
    // clause, masking a mutant that drops it.
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    const generatedDir = path.join(home, "harness.generated");
    writeInflight(generatedDir, "sid-1", "agent-1", FRESH);
    writeLastApply(generatedDir, buildLastApply({}));

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: NOW,
    });

    expect(report.ugAutoApprovals?.approvalsDirPresent).toBe(false);
    expect(report.ugDelegations?.delegationsDirPresent).toBe(false);
    expect(report.settingsDrift).toEqual({ notes: [], warnings: [] });
    const text = format(report);
    expect(text).toContain("ℹ in-flight subagent records on disk: 1 (0 stale)");
  });

  it("renders 2 records with 1 stale, informational (ℹ), adds no warning of its own", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    const generatedDir = path.join(home, "harness.generated");
    writeInflight(generatedDir, "sid-1", "agent-fresh", FRESH);
    writeInflight(generatedDir, "sid-1", "agent-stale", STALE);

    const baseline = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: NOW,
    });

    expect(baseline.ugInflight).toEqual({ inflightDirPresent: true, total: 2, stale: 1, skipped: 0 });
    const text = format(baseline);
    expect(text).toContain("ℹ in-flight subagent records on disk: 2 (1 stale)");
  });

  it("does not render the line, and ugInflight is undefined, when .inflight/ is absent entirely", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugInflight).toEqual({ inflightDirPresent: false, total: 0, stale: 0, skipped: 0 });
    const text = format(report);
    expect(text).not.toContain("in-flight subagent records");
  });

  it("is absent from the report when the understanding-before-execution pack is not declared, even with a record on disk", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITHOUT_PACK });
    writeInflight(path.join(home, "harness.generated"), "sid-1", "agent-1", FRESH);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugInflight).toBeUndefined();
    const text = format(report);
    expect(text).not.toContain("in-flight subagent records");
  });

  it("a record on disk never touches the .approvals/ scan (ugAutoApprovals unaffected)", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    writeInflight(path.join(home, "harness.generated"), "sid-1", "agent-fresh", FRESH);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: NOW,
    });

    expect(report.ugInflight).toEqual({ inflightDirPresent: true, total: 1, stale: 0, skipped: 0 });
    // No `.approvals/` directory was ever created in this fixture: an
    // in-flight record living under the SIBLING `.inflight/` directory
    // must not make the approvals scan think there is anything to read.
    expect(report.ugAutoApprovals).toMatchObject({ approvalsDirPresent: false });
  });

  it("a symlinked .inflight/ reads as absent: inflightDirPresent false, everything zero", () => {
    const generatedDir = tempGeneratedDir();
    const outsideDir = path.join(path.dirname(generatedDir), "outside-inflight");
    const outsideSessionDir = path.join(outsideDir, "sid-1");
    fs.mkdirSync(outsideSessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideSessionDir, "agent-stale"),
      JSON.stringify({
        sessionId: "sid-1",
        agentId: "agent-stale",
        agentType: "general-purpose",
        startedAt: STALE,
        approvedAt: STALE,
      }),
      "utf8",
    );
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(generatedDir, ".inflight"));

    const result = buildUgInflight(generatedDir, { now: NOW });
    expect(result).toEqual({ inflightDirPresent: false, total: 0, stale: 0, skipped: 0 });
  });
});
