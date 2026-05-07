import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvedLedgerTagFor,
  checkPersistedReport,
  defaultReportsDir,
  findLatestReportForSession,
  listPersistedReports,
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
  it("returns <cwd>/.understanding-gate/reports", () => {
    const dir = defaultReportsDir("/tmp/some-project");
    expect(dir).toBe("/tmp/some-project/.understanding-gate/reports");
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
