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
  selectReportForSession,
  TOLERANT_FALLBACK_MAX_AGE_MS,
  writeApprovalMarker,
  type PersistedReport,
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

/** In-memory PersistedReport with neutral creation-time defaults. */
function mkReport(over: Partial<PersistedReport>): PersistedReport {
  return {
    filePath: "/r",
    sessionId: null,
    approvalStatus: "pending",
    approvedAt: null,
    createdAt: null,
    createdAtMs: Date.parse("2026-06-10T12:00:00.000Z"),
    ...over,
  };
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

  it("orders results by mtime newest-first when no createdAt is available", () => {
    const a = writeReport("a.json", { sessionId: "old", approvalStatus: "pending" });
    writeReport("b.json", { sessionId: "new", approvalStatus: "pending" });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(a, past, past);
    const reports = listPersistedReports(tmp);
    expect(reports.map((r) => r.sessionId)).toEqual(["new", "old"]);
  });

  it("orders by JSON createdAt over mtime (approval rewrites bump mtime, C1)", () => {
    const older = writeReport("older.json", {
      sessionId: "older",
      approvalStatus: "pending",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    writeReport("newer.json", {
      sessionId: "newer",
      approvalStatus: "pending",
      createdAt: "2026-06-02T00:00:00.000Z",
    });
    // Simulate an approval rewrite: the OLDER-created report gets the
    // NEWEST mtime. mtime ordering would now misreport it as freshest.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(older, future, future);
    const reports = listPersistedReports(tmp);
    expect(reports.map((r) => r.sessionId)).toEqual(["newer", "older"]);
  });

  it("falls back to the filename ISO prefix when the JSON lacks createdAt", () => {
    writeReport("2026-05-24T06-16-39-409Z-slug-abcd1234.json", {
      sessionId: "s1",
      approvalStatus: "pending",
    });
    const reports = listPersistedReports(tmp);
    expect(reports[0]?.createdAt).toBeNull();
    expect(reports[0]?.createdAtMs).toBe(Date.parse("2026-05-24T06:16:39.409Z"));
  });
});

describe("selectReportForSession", () => {
  const NOW = new Date("2026-06-10T12:00:00.000Z");

  it("rejects a sessionId-less candidate older than maxFallbackAgeMs (C1 live repro)", () => {
    const stale = mkReport({
      filePath: "/stale",
      createdAt: "2026-05-24T06:16:39.388Z",
      createdAtMs: Date.parse("2026-05-24T06:16:39.388Z"),
    });
    const sel = selectReportForSession([stale], "fresh-session", {
      tolerantFallback: "uncompleted",
      maxFallbackAgeMs: TOLERANT_FALLBACK_MAX_AGE_MS,
      now: NOW,
    });
    expect(sel.report).toBeNull();
    expect(sel.fallbackAdopted).toBe(false);
    expect(sel.staleRejected.map((r) => r.filePath)).toEqual(["/stale"]);
  });

  it("adopts a fresh sessionId-less candidate within the window and flags the adoption", () => {
    const fresh = mkReport({
      filePath: "/fresh",
      createdAtMs: NOW.getTime() - 60_000,
    });
    const sel = selectReportForSession([fresh], "fresh-session", {
      tolerantFallback: "uncompleted",
      maxFallbackAgeMs: TOLERANT_FALLBACK_MAX_AGE_MS,
      now: NOW,
    });
    expect(sel.report?.filePath).toBe("/fresh");
    expect(sel.fallbackAdopted).toBe(true);
    expect(sel.staleRejected).toEqual([]);
  });

  it("rejects a sessionId-less candidate created in the future beyond the skew tolerance", () => {
    const future = mkReport({
      filePath: "/future",
      createdAtMs: NOW.getTime() + 10 * 60_000,
    });
    const sel = selectReportForSession([future], "fresh-session", {
      tolerantFallback: "uncompleted",
      maxFallbackAgeMs: TOLERANT_FALLBACK_MAX_AGE_MS,
      now: NOW,
    });
    expect(sel.report).toBeNull();
    expect(sel.staleRejected.map((r) => r.filePath)).toEqual(["/future"]);
  });

  it("tolerates small clock skew on a sessionId-less candidate", () => {
    const slightlyAhead = mkReport({
      filePath: "/ahead",
      createdAtMs: NOW.getTime() + 60_000,
    });
    const sel = selectReportForSession([slightlyAhead], "fresh-session", {
      tolerantFallback: "uncompleted",
      maxFallbackAgeMs: TOLERANT_FALLBACK_MAX_AGE_MS,
      now: NOW,
    });
    expect(sel.report?.filePath).toBe("/ahead");
  });

  it("never age-limits a strict sessionId match", () => {
    const exact = mkReport({
      filePath: "/exact",
      sessionId: "wanted",
      createdAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const sel = selectReportForSession([exact], "wanted", {
      maxFallbackAgeMs: 1,
      now: NOW,
    });
    expect(sel.report?.filePath).toBe("/exact");
    expect(sel.fallbackAdopted).toBe(false);
  });

  it("applies no age limit when maxFallbackAgeMs is unset (gate-read back-compat)", () => {
    const old = mkReport({
      filePath: "/old",
      createdAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    expect(findLatestReportForSession([old], "wanted")?.filePath).toBe("/old");
  });
});

describe("findLatestReportForSession", () => {
  it("returns the matching session, ignoring others", () => {
    const reports = [
      mkReport({ filePath: "/a", sessionId: "other", approvalStatus: "approved" }),
      mkReport({ filePath: "/b", sessionId: "wanted" }),
    ];
    const r = findLatestReportForSession(reports, "wanted");
    expect(r?.filePath).toBe("/b");
  });

  it("falls back to a sessionless report when no exact match exists", () => {
    const reports = [
      mkReport({ filePath: "/a", sessionId: "other", approvalStatus: "approved" }),
      mkReport({ filePath: "/b" }),
    ];
    const r = findLatestReportForSession(reports, "wanted");
    expect(r?.filePath).toBe("/b");
  });

  it("returns null when no match nor sessionless fallback exists", () => {
    const reports = [
      mkReport({ filePath: "/a", sessionId: "other", approvalStatus: "approved" }),
    ];
    expect(findLatestReportForSession(reports, "wanted")).toBeNull();
  });

  it('tolerantFallback "uncompleted" skips a completed sessionless report (harness/0dce3880)', () => {
    // A stale, finished report (no sessionId, already expired) must not
    // be re-adopted for a fresh session.
    const reports = [mkReport({ filePath: "/stale", approvalStatus: "expired" })];
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
      mkReport({ filePath: "/expired", approvalStatus: "expired" }),
      mkReport({ filePath: "/pending" }),
    ];
    expect(
      findLatestReportForSession(reports, "wanted", { tolerantFallback: "uncompleted" })
        ?.filePath,
    ).toBe("/pending");
  });

  it('tolerantFallback "uncompleted" never overrides a strict sessionId match', () => {
    const reports = [
      mkReport({ filePath: "/exact", sessionId: "wanted", approvalStatus: "approved" }),
      mkReport({ filePath: "/pending" }),
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
