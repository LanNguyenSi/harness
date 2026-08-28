// Tests for the delegations-on-disk doctor metric (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 3,
// agent-tasks 37ad0b05 T-004, "Audit and doctor"). Every fixture writes
// plain JSON delegation bodies directly (no HMAC signing): like
// `ug-auto-approvals.ts`, this is an audit surface, not a security
// check, and never verifies a marker's signature (that stays the
// dedicated `verifyDelegation` reader's job at gate time).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { buildUgDelegations } from "../../src/cli/doctor/ug-delegations.js";
import { buildDelegationApprovedBy } from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempGeneratedDir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-delegations-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return path.join(home, "harness.generated");
}

function writeDelegation(
  generatedDir: string,
  childSessionId: string,
  approvedBy: string,
  overrides: Record<string, unknown> = {},
): void {
  const dir = path.join(generatedDir, ".delegations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, childSessionId),
    JSON.stringify({
      approvedAt: "2026-08-27T09:00:00.000Z",
      approvedBy,
      reportContentHash: null,
      alg: "hmac-sha256-v1",
      signature: "deadbeef",
      ...overrides,
    }),
    "utf8",
  );
}

function writeApprovalMarker(generatedDir: string, sessionId: string, body: unknown): void {
  const dir = path.join(generatedDir, ".approvals");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId), JSON.stringify(body), "utf8");
}

const VALID_FUTURE = buildDelegationApprovedBy({
  parentSessionId: "parent-1",
  cwdHash: null,
  taskId: "task-1",
  expiresAt: "2099-01-01T00:00:00.000Z",
});

const VALID_EXPIRED = buildDelegationApprovedBy({
  parentSessionId: "parent-1",
  cwdHash: null,
  taskId: "task-1",
  expiresAt: "2020-01-01T00:00:00.000Z",
});

describe("buildUgDelegations: pure function", () => {
  it("no .delegations/ directory: delegationsDirPresent false, everything zero", () => {
    const generatedDir = tempGeneratedDir();
    const result = buildUgDelegations(generatedDir);
    expect(result).toEqual({ delegationsDirPresent: false, total: 0, expired: 0, unreadable: 0 });
  });

  it("one unexpired delegation: total 1, expired 0", () => {
    const generatedDir = tempGeneratedDir();
    writeDelegation(generatedDir, "child-1", VALID_FUTURE);
    const result = buildUgDelegations(generatedDir, { now: new Date("2026-08-27T10:00:00.000Z") });
    expect(result).toEqual({ delegationsDirPresent: true, total: 1, expired: 0, unreadable: 0 });
  });

  it("Q3 mutation-probe fixture: one expired + one valid delegation discriminates the expiry comparison", () => {
    const generatedDir = tempGeneratedDir();
    writeDelegation(generatedDir, "child-valid", VALID_FUTURE);
    writeDelegation(generatedDir, "child-expired", VALID_EXPIRED);
    const result = buildUgDelegations(generatedDir, { now: new Date("2026-08-27T10:00:00.000Z") });
    expect(result).toEqual({ delegationsDirPresent: true, total: 2, expired: 1, unreadable: 0 });
  });

  it("a delegation file that is not valid JSON counts as unreadable, never crashes", () => {
    const generatedDir = tempGeneratedDir();
    const dir = path.join(generatedDir, ".delegations");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "child-corrupt"), "not json{{{", "utf8");
    const result = buildUgDelegations(generatedDir);
    expect(result).toEqual({ delegationsDirPresent: true, total: 1, expired: 0, unreadable: 1 });
  });

  it("a delegation file whose approvedBy fails to parse counts as unreadable", () => {
    const generatedDir = tempGeneratedDir();
    writeDelegation(generatedDir, "child-bad", "not-a-well-formed-approvedby-string");
    const result = buildUgDelegations(generatedDir);
    expect(result).toEqual({ delegationsDirPresent: true, total: 1, expired: 0, unreadable: 1 });
  });

  it("an empty .delegations/ directory (present, no files): delegationsDirPresent true, everything zero", () => {
    const generatedDir = tempGeneratedDir();
    fs.mkdirSync(path.join(generatedDir, ".delegations"), { recursive: true });
    const result = buildUgDelegations(generatedDir);
    expect(result).toEqual({ delegationsDirPresent: true, total: 0, expired: 0, unreadable: 0 });
  });

  it("Q1 mutation-probe fixture: the count comes from .delegations/ only, an .approvals/ marker is never counted", () => {
    const generatedDir = tempGeneratedDir();
    writeDelegation(generatedDir, "child-1", VALID_FUTURE);
    writeApprovalMarker(generatedDir, "sess-auto", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    const result = buildUgDelegations(generatedDir, { now: new Date("2026-08-27T10:00:00.000Z") });
    expect(result).toEqual({ delegationsDirPresent: true, total: 1, expired: 0, unreadable: 0 });
  });
});

let doctorCleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of doctorCleanups) c();
  doctorCleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-delegations-fixture-"));
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

describe("doctor: ug delegations (Environment section)", () => {
  it("renders the listing for an unexpired delegation, informational (ℹ), and adds no warning of its own", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    writeDelegation(path.join(home, "harness.generated"), "child-1", VALID_FUTURE);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: new Date("2026-08-27T10:00:00.000Z"),
    });

    expect(report.ugDelegations).toEqual({
      delegationsDirPresent: true,
      total: 1,
      expired: 0,
      unreadable: 0,
    });

    const text = format(report);
    expect(text).toContain("ℹ delegations on disk: 1 (0 expired, 0 unreadable)");
  });

  it("renders the zero-count line (no parenthetical) when .delegations/ exists but has no files", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    fs.mkdirSync(path.join(home, "harness.generated", ".delegations"), { recursive: true });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    const text = format(report);
    expect(text).toContain("ℹ delegations on disk: 0");
    expect(text).not.toContain("expired");
  });

  it("does not render the line, and ugDelegations reports delegationsDirPresent: false, when .delegations/ is absent entirely", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugDelegations).toEqual({
      delegationsDirPresent: false,
      total: 0,
      expired: 0,
      unreadable: 0,
    });
    const text = format(report);
    expect(text).not.toContain("delegations on disk");
  });

  it("renders as a warning (⚠) and rolls exactly one warning into warningCount when a delegation file is unreadable", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    const generatedDir = path.join(home, "harness.generated");
    writeDelegation(generatedDir, "child-1", VALID_FUTURE);

    const baselineReport = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: new Date("2026-08-27T10:00:00.000Z"),
    });
    expect(baselineReport.ugDelegations?.unreadable).toBe(0);

    fs.writeFileSync(path.join(generatedDir, ".delegations", "child-corrupt"), "not json{{{", "utf8");

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: new Date("2026-08-27T10:00:00.000Z"),
    });

    expect(report.ugDelegations).toEqual({
      delegationsDirPresent: true,
      total: 2,
      expired: 0,
      unreadable: 1,
    });
    // Exactly one warning is attributable to ugDelegations: the same
    // manifest/fixture minus the corrupt file rolled zero.
    expect(report.warningCount).toBe(baselineReport.warningCount + 1);

    const text = format(report);
    expect(text).toContain("⚠ delegations on disk: 2 (0 expired, 1 unreadable)");
  });

  it("is absent from the report when the understanding-before-execution pack is not declared, even with a delegation on disk", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITHOUT_PACK });
    writeDelegation(path.join(home, "harness.generated"), "child-1", VALID_FUTURE);

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugDelegations).toBeUndefined();
    const text = format(report);
    expect(text).not.toContain("delegations on disk");
  });

  it("count comes from .delegations/ only: an .approvals/ session marker never contributes to ugDelegations end-to-end", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    const generatedDir = path.join(home, "harness.generated");
    writeDelegation(generatedDir, "child-1", VALID_FUTURE);
    writeApprovalMarker(generatedDir, "sess-auto", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      now: new Date("2026-08-27T10:00:00.000Z"),
    });

    expect(report.ugDelegations).toEqual({
      delegationsDirPresent: true,
      total: 1,
      expired: 0,
      unreadable: 0,
    });
  });
});
