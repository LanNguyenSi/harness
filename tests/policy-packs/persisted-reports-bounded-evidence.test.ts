// Task 4b39022f: the hook-time evidence read of the persisted reports
// (`checkPersistedReport`, `expirePersistedReport`) reads every report file
// through `readReportFileBounded`, like the gate-read hash scan. The agent
// can plant files in the reports directory, so a file that is not regular,
// is over the cap or grows while read must be skipped, never blocking the
// hook or running it out of memory. FIFO planting is covered through the
// built CLI with a kill timeout (tests/cli/pack-hook-pre-tool-use-subprocess
// .test.ts); an in-process FIFO read that regressed would hang the suite.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPersistedReport,
  expirePersistedReport,
  listPersistedReports,
  listPersistedReportsBounded,
  MAX_HASHED_REPORT_BYTES,
  readReportFileBounded,
} from "../../src/policy-packs/builtin/understanding-before-execution/persisted-reports.js";

const SESSION = "sess-bounded-evidence";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-bounded-evidence-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function reportJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: SESSION,
    approvalStatus: "approved",
    approvedAt: "2026-10-01T10:05:00.000Z",
    createdAt: "2026-10-01T10:00:00.000Z",
    content: "the understanding the operator reviewed",
    ...overrides,
  });
}

/** A valid report padded with JSON whitespace past the hashing cap. */
function oversizedReportJson(overrides: Record<string, unknown> = {}): string {
  return reportJson(overrides) + " ".repeat(2 * 1024 * 1024);
}

describe("listPersistedReportsBounded", () => {
  it("lists a regular report within the cap exactly as the unbounded listing does", () => {
    fs.writeFileSync(path.join(tmp, "r1.json"), reportJson());
    fs.writeFileSync(path.join(tmp, "r2.json"), reportJson({ createdAt: "2026-10-01T11:00:00.000Z" }));

    expect(listPersistedReportsBounded(tmp)).toEqual(listPersistedReports(tmp));
    expect(listPersistedReportsBounded(tmp).map((r) => path.basename(r.filePath))).toEqual(["r2.json", "r1.json"]);
  });

  it("lists a report of exactly the cap and skips one byte more", () => {
    const json = reportJson();
    fs.writeFileSync(path.join(tmp, "atcap.json"), json + " ".repeat(MAX_HASHED_REPORT_BYTES - json.length));
    fs.writeFileSync(path.join(tmp, "over.json"), json + " ".repeat(MAX_HASHED_REPORT_BYTES - json.length + 1));

    expect(listPersistedReportsBounded(tmp).map((r) => path.basename(r.filePath))).toEqual(["atcap.json"]);
  });

  it("skips a report over the cap that the unbounded listing still sees", () => {
    fs.writeFileSync(path.join(tmp, "big.json"), oversizedReportJson());
    fs.writeFileSync(path.join(tmp, "small.json"), reportJson({ sessionId: "other" }));

    expect(listPersistedReportsBounded(tmp).map((r) => path.basename(r.filePath))).toEqual(["small.json"]);
    // The operator commands rely on this listing to find and refuse or age
    // out an oversized report, so it keeps seeing it.
    expect(
      listPersistedReports(tmp)
        .map((r) => path.basename(r.filePath))
        .sort(),
    ).toEqual(["big.json", "small.json"]);
  });

  it("skips a directory and a dangling symlink named *.json, and lists a symlink to a regular report", () => {
    fs.mkdirSync(path.join(tmp, "dir.json"));
    fs.symlinkSync(path.join(tmp, "nowhere"), path.join(tmp, "dangling.json"));
    fs.writeFileSync(path.join(tmp, "real-target"), reportJson());
    fs.symlinkSync(path.join(tmp, "real-target"), path.join(tmp, "link.json"));

    expect(listPersistedReportsBounded(tmp).map((r) => path.basename(r.filePath))).toEqual(["link.json"]);
  });

  it("returns [] for a missing directory", () => {
    expect(listPersistedReportsBounded(path.join(tmp, "missing"))).toEqual([]);
  });

  it("falls back to the descriptor's modification time for a report with neither createdAt nor a timestamped name", () => {
    const file = path.join(tmp, "plain.json");
    fs.writeFileSync(file, JSON.stringify({ sessionId: SESSION, approvalStatus: "pending" }));
    const when = new Date("2026-09-01T00:00:00.000Z");
    fs.utimesSync(file, when, when);

    expect(listPersistedReportsBounded(tmp)[0]?.createdAtMs).toBe(when.getTime());
    expect(readReportFileBounded(file)).toMatchObject({ ok: true, mtimeMs: when.getTime() });
  });
});

describe("checkPersistedReport reads bounded", () => {
  it("control: a regular approved report within the cap is still reported as claiming approval", () => {
    fs.writeFileSync(path.join(tmp, "r1.json"), reportJson());

    const evidence = checkPersistedReport(tmp, SESSION);

    expect(evidence.claimsApproved).toBe(true);
    expect(evidence.detail).toContain("unsigned persisted-report approval rejected");
  });

  it("an oversized approved report of the session is no evidence: the directory counts as holding no report", () => {
    fs.writeFileSync(path.join(tmp, "big.json"), oversizedReportJson());

    const evidence = checkPersistedReport(tmp, SESSION);

    expect(evidence).toEqual({ claimsApproved: false, detail: `no reports found at ${tmp}`, report: null });
  });

  it("an oversized report does not hide the session's regular report", () => {
    fs.writeFileSync(path.join(tmp, "big.json"), oversizedReportJson({ createdAt: "2026-10-01T12:00:00.000Z" }));
    fs.writeFileSync(path.join(tmp, "r1.json"), reportJson({ approvalStatus: "pending" }));

    const evidence = checkPersistedReport(tmp, SESSION);

    expect(evidence.claimsApproved).toBe(false);
    expect(evidence.detail).toContain("approvalStatus=pending");
    expect(path.basename(evidence.report?.filePath ?? "")).toBe("r1.json");
  });
});

describe("expirePersistedReport reads bounded", () => {
  it("control: a regular approved report within the cap is expired", () => {
    const file = path.join(tmp, "r1.json");
    fs.writeFileSync(file, reportJson());

    const result = expirePersistedReport(tmp, SESSION, new Date("2026-10-01T13:00:00.000Z"), "task-done");

    expect(result).toMatchObject({ ok: true, previousStatus: "approved" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ approvalStatus: "expired", expiredBy: "task-done" });
  });

  it("an oversized approved report is not read, rewritten or expired: no report matched", () => {
    const file = path.join(tmp, "big.json");
    const body = oversizedReportJson();
    fs.writeFileSync(file, body);

    const result = expirePersistedReport(tmp, SESSION);

    expect(result).toEqual({ ok: false, reason: `no reports under ${tmp}` });
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });
});
