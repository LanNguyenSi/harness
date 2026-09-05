// Tests for the auto-approval doctor listing + last-N metric (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1,
// agent-tasks 74b4b17d, "Audit and doctor"). Every fixture writes plain
// JSON marker bodies directly (no HMAC signing): the listing is an
// audit surface, not a security check, and never verifies a marker's
// signature (that stays `checkApprovalMarker`'s job at gate time).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import {
  buildUgAutoApprovals,
  DEFAULT_RECENT_SESSIONS,
} from "../../src/cli/doctor/ug-auto-approvals.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempGeneratedDir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-auto-approvals-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return path.join(home, "harness.generated");
}

function writeMarker(generatedDir: string, name: string, body: unknown): void {
  const dir = path.join(generatedDir, ".approvals");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
}

describe("buildUgAutoApprovals — pure function", () => {
  it("no .approvals/ directory: approvalsDirPresent false, everything zero", () => {
    const generatedDir = tempGeneratedDir();
    const result = buildUgAutoApprovals(generatedDir, { recentSessions: 20 });
    expect(result).toEqual({
      approvalsDirPresent: false,
      windowSize: 20,
      autoApprovedCount: 0,
      byMode: {},
      byHarness: {},
      entries: [],
      unreadableCount: 0,
    });
  });

  it("a symlinked .approvals/ root reads as absent, even when it points at markers", () => {
    const generatedDir = tempGeneratedDir();
    writeMarker(generatedDir, "sess-auto", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    const approvalsDir = path.join(generatedDir, ".approvals");
    const outsideDir = `${approvalsDir}-outside`;
    fs.renameSync(approvalsDir, outsideDir);
    fs.symlinkSync(outsideDir, approvalsDir, "dir");

    expect(buildUgAutoApprovals(generatedDir, { recentSessions: 20 })).toEqual({
      approvalsDirPresent: false,
      windowSize: 20,
      autoApprovedCount: 0,
      byMode: {},
      byHarness: {},
      entries: [],
      unreadableCount: 0,
    });
  });

  it("counts only the auto marker among an auto + human + task + branch-protection marker (P1 target)", () => {
    const generatedDir = tempGeneratedDir();
    writeMarker(generatedDir, "sess-auto", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    writeMarker(generatedDir, "sess-human", {
      approvedAt: "2026-08-27T09:00:00.000Z",
      approvedBy: "harness-approve-cli",
    });
    // Newest of all four, but must be skipped by name prefix, not by
    // the window: proves the task-marker filter runs before windowing.
    writeMarker(generatedDir, "task-abc123", {
      approvedAt: "2026-08-27T11:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    writeMarker(generatedDir, "branch-protection-xyz", {
      approvedAt: "2026-08-27T08:00:00.000Z",
      approvedBy: "harness-approve-cli",
    });

    const result = buildUgAutoApprovals(generatedDir, { recentSessions: 20 });
    expect(result.approvalsDirPresent).toBe(true);
    expect(result.autoApprovedCount).toBe(1);
    expect(result.byMode).toEqual({ bypassPermissions: 1 });
    expect(result.byHarness).toEqual({ "claude-code": 1 });
    expect(result.entries).toEqual([
      {
        sessionId: "sess-auto",
        mode: "bypassPermissions",
        harness: "claude-code",
        approvedAt: "2026-08-27T10:00:00.000Z",
      },
    ]);
    expect(result.unreadableCount).toBe(0);
  });

  it("N=1 window: the newest marker (human) excludes the older auto marker from the count (P3 target)", () => {
    const generatedDir = tempGeneratedDir();
    writeMarker(generatedDir, "sess-auto", {
      approvedAt: "2026-08-27T09:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    writeMarker(generatedDir, "sess-human", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "harness-approve-cli",
    });

    const result = buildUgAutoApprovals(generatedDir, { recentSessions: 1 });
    expect(result.autoApprovedCount).toBe(0);
    expect(result.byMode).toEqual({});
    expect(result.entries).toEqual([]);

    // Sanity: the SAME fixture at N=2 does count the auto marker, so the
    // above zero is genuinely the window's doing, not a broken fixture.
    const wide = buildUgAutoApprovals(generatedDir, { recentSessions: 2 });
    expect(wide.autoApprovedCount).toBe(1);
  });

  it("an unparseable marker body is counted as unreadable, not as an auto approval, and never crashes", () => {
    const generatedDir = tempGeneratedDir();
    writeMarker(generatedDir, "sess-auto", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    const dir = path.join(generatedDir, ".approvals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sess-corrupt"), "not json{{{", "utf8");
    // A marker with a non-string approvedAt is unreadable too (no
    // timestamp to sort by).
    writeMarker(generatedDir, "sess-no-timestamp", { approvedBy: "harness-approve-cli" });

    const result = buildUgAutoApprovals(generatedDir, { recentSessions: 20 });
    expect(result.autoApprovedCount).toBe(1);
    expect(result.unreadableCount).toBe(2);
  });

  it("multiple modes and multiple harnesses each get their own breakdown entry", () => {
    const generatedDir = tempGeneratedDir();
    writeMarker(generatedDir, "sess-a", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    writeMarker(generatedDir, "sess-b", {
      approvedAt: "2026-08-27T09:00:00.000Z",
      approvedBy: "auto-mode:codex:full-auto",
    });
    const result = buildUgAutoApprovals(generatedDir, { recentSessions: 20 });
    expect(result.autoApprovedCount).toBe(2);
    expect(result.byMode).toEqual({ bypassPermissions: 1, "full-auto": 1 });
    expect(result.byHarness).toEqual({ "claude-code": 1, codex: 1 });
  });

  it("defaults to a window of 20 when recentSessions is not overridden by the caller", () => {
    expect(DEFAULT_RECENT_SESSIONS).toBe(20);
  });
});

let doctorCleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of doctorCleanups) c();
  doctorCleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ug-auto-approvals-fixture-"));
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

describe("doctor — ug auto-approvals (Environment section)", () => {
  it("renders the listing and rolls no warnings when the pack is enabled and an auto marker exists", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    writeMarker(path.join(home, "harness.generated"), "sess-auto", {
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
    });

    expect(report.ugAutoApprovals).toBeDefined();
    expect(report.ugAutoApprovals?.autoApprovedCount).toBe(1);

    const text = format(report);
    expect(text).toContain(
      `ℹ auto approvals in the last ${DEFAULT_RECENT_SESSIONS} sessions: 1 (bypassPermissions: 1)`,
    );
    expect(text).toContain("sess-auto  bypassPermissions  2026-08-27T10:00:00.000Z");
  });

  it("renders the zero-count line (no parenthetical) when .approvals/ exists but has no session markers", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    fs.mkdirSync(path.join(home, "harness.generated", ".approvals"), { recursive: true });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    const text = format(report);
    expect(text).toContain(`ℹ auto approvals in the last ${DEFAULT_RECENT_SESSIONS} sessions: 0`);
    expect(text).not.toContain("bypassPermissions");
  });

  it("does not render or add the section when .approvals/ is absent entirely", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugAutoApprovals?.approvalsDirPresent).toBe(false);
    const text = format(report);
    expect(text).not.toMatch(/\nEnvironment\n/);
  });

  it("is absent from the report when the understanding-before-execution pack is not declared, even with an auto marker on disk", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITHOUT_PACK });
    writeMarker(path.join(home, "harness.generated"), "sess-auto", {
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
    });

    expect(report.ugAutoApprovals).toBeUndefined();
    const text = format(report);
    expect(text).not.toContain("auto approvals in the last");
  });

  it("--recent-sessions is honored end-to-end through doctor()", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    writeMarker(path.join(home, "harness.generated"), "sess-auto", {
      approvedAt: "2026-08-27T09:00:00.000Z",
      approvedBy: "auto-mode:claude-code:bypassPermissions",
    });
    writeMarker(path.join(home, "harness.generated"), "sess-human", {
      approvedAt: "2026-08-27T10:00:00.000Z",
      approvedBy: "harness-approve-cli",
    });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      recentSessions: 1,
    });

    expect(report.ugAutoApprovals?.windowSize).toBe(1);
    expect(report.ugAutoApprovals?.autoApprovedCount).toBe(0);
  });

  it("doctor() throws for an invalid recentSessions (n < 1)", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_PACK });
    await expect(
      doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        versionProbe: () => null,
        pathEnv: "",
        npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
        envOverride: {},
        recentSessions: 0,
      }),
    ).rejects.toThrow(/recentSessions must be an integer >= 1/);
  });
});
