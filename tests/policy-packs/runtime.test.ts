import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvalMarkerPathFor,
  approvedLedgerTagFor,
  checkApprovalMarker,
  checkPersistedReport,
  clearApprovalMarker,
  defaultReportsDir,
  findLatestReportForSession,
  listPersistedReports,
  REPORTS_DIR_ENV,
  reportsDirForManifest,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-runtime-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeReport(name: string, body: Record<string, unknown>): string {
  const full = path.join(tmp, name);
  fs.writeFileSync(full, `${JSON.stringify(body, null, 2)}\n`);
  return full;
}

describe("approvedLedgerTagFor", () => {
  it("composes the canonical tag with the session id", () => {
    expect(approvedLedgerTagFor("gs-123")).toBe("understanding-approved:gs-123");
  });
});

describe("defaultReportsDir", () => {
  const savedEnv = process.env[REPORTS_DIR_ENV];
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[REPORTS_DIR_ENV];
    else process.env[REPORTS_DIR_ENV] = savedEnv;
  });

  it("returns <cwd>/.understanding-gate/reports when the env var is unset", () => {
    delete process.env[REPORTS_DIR_ENV];
    const dir = defaultReportsDir("/tmp/some-project");
    expect(dir).toBe("/tmp/some-project/.understanding-gate/reports");
  });

  it("honors UNDERSTANDING_GATE_REPORT_DIR over the cwd fallback", () => {
    process.env[REPORTS_DIR_ENV] = "/var/lib/gate-reports";
    expect(defaultReportsDir("/tmp/ignored")).toBe("/var/lib/gate-reports");
  });

  it("ignores an empty env var and uses the cwd fallback", () => {
    process.env[REPORTS_DIR_ENV] = "";
    expect(defaultReportsDir("/tmp/proj")).toBe("/tmp/proj/.understanding-gate/reports");
  });
});

describe("reportsDirForManifest", () => {
  it("anchors to the manifest's directory", () => {
    expect(reportsDirForManifest("/home/u/.claude/harness.yaml")).toBe(
      "/home/u/.claude/.understanding-gate/reports",
    );
  });
  it("works for in-repo manifests too", () => {
    expect(reportsDirForManifest("/repo/proj/harness.yaml")).toBe(
      "/repo/proj/.understanding-gate/reports",
    );
  });
});

describe("listPersistedReports", () => {
  it("returns [] for a missing directory", () => {
    expect(listPersistedReports(path.join(tmp, "nope"))).toEqual([]);
  });

  it("ignores non-JSON files and unparseable JSON", () => {
    fs.writeFileSync(path.join(tmp, "notes.txt"), "not json");
    fs.writeFileSync(path.join(tmp, "broken.json"), "{ garbage");
    writeReport("good.json", { sessionId: "s1", approvalStatus: "pending" });
    const reports = listPersistedReports(tmp);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sessionId).toBe("s1");
  });

  it("orders results by mtime newest-first", () => {
    const a = writeReport("a.json", { sessionId: "old", approvalStatus: "pending" });
    writeReport("b.json", { sessionId: "new", approvalStatus: "pending" });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(a, past, past);
    const reports = listPersistedReports(tmp);
    expect(reports.map((r) => r.sessionId)).toEqual(["new", "old"]);
  });
});

describe("findLatestReportForSession", () => {
  it("returns the matching session, ignoring others", () => {
    const reports = [
      { filePath: "/a", sessionId: "other", approvalStatus: "approved", approvedAt: null },
      { filePath: "/b", sessionId: "wanted", approvalStatus: "pending", approvedAt: null },
    ];
    const r = findLatestReportForSession(reports, "wanted");
    expect(r?.filePath).toBe("/b");
  });

  it("falls back to a sessionless report when no exact match exists", () => {
    const reports = [
      { filePath: "/a", sessionId: "other", approvalStatus: "approved", approvedAt: null },
      { filePath: "/b", sessionId: null, approvalStatus: "pending", approvedAt: null },
    ];
    const r = findLatestReportForSession(reports, "wanted");
    expect(r?.filePath).toBe("/b");
  });

  it("returns null when no match nor sessionless fallback exists", () => {
    const reports = [
      { filePath: "/a", sessionId: "other", approvalStatus: "approved", approvedAt: null },
    ];
    expect(findLatestReportForSession(reports, "wanted")).toBeNull();
  });

  it('tolerantFallback "uncompleted" skips a completed sessionless report (harness/0dce3880)', () => {
    // A stale, finished report (no sessionId, already expired) must not
    // be re-adopted for a fresh session.
    const reports = [
      { filePath: "/stale", sessionId: null, approvalStatus: "expired", approvedAt: null },
    ];
    expect(
      findLatestReportForSession(reports, "wanted", { tolerantFallback: "uncompleted" }),
    ).toBeNull();
    // Default "any" still adopts it (gate-read / expiry back-compat).
    expect(
      findLatestReportForSession(reports, "wanted")?.filePath,
    ).toBe("/stale");
  });

  it('tolerantFallback "uncompleted" still adopts a fresh pending sessionless report', () => {
    const reports = [
      { filePath: "/expired", sessionId: null, approvalStatus: "expired", approvedAt: null },
      { filePath: "/pending", sessionId: null, approvalStatus: "pending", approvedAt: null },
    ];
    expect(
      findLatestReportForSession(reports, "wanted", { tolerantFallback: "uncompleted" })
        ?.filePath,
    ).toBe("/pending");
  });

  it('tolerantFallback "uncompleted" never overrides a strict sessionId match', () => {
    const reports = [
      { filePath: "/exact", sessionId: "wanted", approvalStatus: "approved", approvedAt: null },
      { filePath: "/pending", sessionId: null, approvalStatus: "pending", approvedAt: null },
    ];
    expect(
      findLatestReportForSession(reports, "wanted", { tolerantFallback: "uncompleted" })
        ?.filePath,
    ).toBe("/exact");
  });
});

describe("checkPersistedReport", () => {
  it("reports approved when latest matching report is approved", () => {
    writeReport("ok.json", {
      sessionId: "s1",
      approvalStatus: "approved",
      approvedAt: "2026-05-07T08:00:00Z",
    });
    const r = checkPersistedReport(tmp, "s1");
    expect(r.approved).toBe(true);
    expect(r.detail).toMatch(/approved via persisted report ok\.json/);
  });

  it("reports unapproved when latest matching report is pending", () => {
    writeReport("pending.json", { sessionId: "s1", approvalStatus: "pending" });
    const r = checkPersistedReport(tmp, "s1");
    expect(r.approved).toBe(false);
    expect(r.detail).toMatch(/approvalStatus=pending/);
  });

  it("reports unapproved when no reports exist", () => {
    const r = checkPersistedReport(tmp, "s1");
    expect(r.approved).toBe(false);
    expect(r.detail).toMatch(/no reports found/);
  });

  it("reports unapproved when reports exist but none match the session", () => {
    writeReport("other.json", { sessionId: "different", approvalStatus: "approved" });
    const r = checkPersistedReport(tmp, "s1");
    expect(r.approved).toBe(false);
    expect(r.detail).toMatch(/no report matched session_id=s1/);
  });
});

describe("approvalMarkerPathFor", () => {
  it("composes the canonical marker path under <generatedDir>/.approvals/<sid>", () => {
    expect(approvalMarkerPathFor("/g", "sess-1")).toBe("/g/.approvals/sess-1");
  });
});

describe("writeApprovalMarker / checkApprovalMarker / clearApprovalMarker (agent-tasks/88ca4bb3)", () => {
  it("a written marker is matched by the gate-side check", () => {
    const filePath = writeApprovalMarker(tmp, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "test-operator",
    });
    expect(filePath).toBe(path.join(tmp, ".approvals", "sess-1"));
    const r = checkApprovalMarker(tmp, "sess-1");
    expect(r.matched).toBe(true);
    expect(r.marker).toEqual({
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "test-operator",
    });
    expect(r.detail).toMatch(/approved at 2026-05-15T20:00:00Z by test-operator/);
  });

  it("missing marker returns matched:false with the path in the detail", () => {
    const r = checkApprovalMarker(tmp, "sess-absent");
    expect(r.matched).toBe(false);
    expect(r.detail).toMatch(/no approval marker at/);
    expect(r.detail).toMatch(/sess-absent/);
  });

  it("marker with corrupt JSON body still satisfies the gate by file existence", () => {
    const markerPath = path.join(tmp, ".approvals", "sess-corrupt");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{not-json");
    const r = checkApprovalMarker(tmp, "sess-corrupt");
    expect(r.matched).toBe(true);
    expect(r.marker).toBeNull();
    expect(r.detail).toMatch(/body unreadable/);
  });

  it("symlink at marker path is REJECTED, even pointing at a regular file (agent-tasks/d39f160e)", () => {
    // Defense-in-depth: the agent has no Edit/Write/Bash path to plant
    // a symlink under harness.generated/ today, but the gate's
    // contract is to assume the agent is hostile. lstat + reject is
    // the cheap insurance.
    const realFile = path.join(tmp, "approved.json");
    fs.writeFileSync(
      realFile,
      `${JSON.stringify({ approvedAt: "2026-05-15T20:00:00Z", approvedBy: "evil" })}\n`,
    );
    const markerDir = path.join(tmp, ".approvals");
    fs.mkdirSync(markerDir, { recursive: true });
    const markerPath = path.join(markerDir, "sess-symlink");
    fs.symlinkSync(realFile, markerPath);
    const r = checkApprovalMarker(tmp, "sess-symlink");
    expect(r.matched).toBe(false);
    expect(r.detail).toMatch(/symlink, refusing for safety/);
    expect(r.marker).toBeNull();
  });

  it("non-file (e.g. directory) at marker path is rejected", () => {
    fs.mkdirSync(path.join(tmp, ".approvals", "sess-dir"), { recursive: true });
    const r = checkApprovalMarker(tmp, "sess-dir");
    expect(r.matched).toBe(false);
    expect(r.detail).toMatch(/not a regular file/);
  });

  it("clearApprovalMarker removes an existing marker; is a no-op when absent", () => {
    writeApprovalMarker(tmp, "sess-1", {
      approvedAt: "2026-05-15T20:00:00Z",
      approvedBy: "test-operator",
    });
    expect(checkApprovalMarker(tmp, "sess-1").matched).toBe(true);
    clearApprovalMarker(tmp, "sess-1");
    expect(checkApprovalMarker(tmp, "sess-1").matched).toBe(false);
    // No-op on already-missing.
    clearApprovalMarker(tmp, "sess-1");
    expect(checkApprovalMarker(tmp, "sess-1").matched).toBe(false);
  });
});
