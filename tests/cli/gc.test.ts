import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_DAYS, gc } from "../../src/cli/gc/index.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const DAY_MS = 86_400_000;

let tmp: string;
let reportsDir: string;
let parseErrorsDir: string;
let generatedDir: string;
let approvalsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gc-"));
  reportsDir = path.join(tmp, ".understanding-gate", "reports");
  parseErrorsDir = path.join(tmp, ".understanding-gate", "parse-errors");
  generatedDir = path.join(tmp, "harness.generated");
  approvalsDir = path.join(generatedDir, ".approvals");
  for (const d of [reportsDir, parseErrorsDir, approvalsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function writeReport(name: string, body: Record<string, unknown>): string {
  const full = path.join(reportsDir, name);
  fs.writeFileSync(full, `${JSON.stringify(body, null, 2)}\n`);
  return full;
}

function writeAged(dir: string, name: string, agedDays: number): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, "x\n");
  const then = new Date(NOW.getTime() - agedDays * DAY_MS);
  fs.utimesSync(full, then, then);
  return full;
}

function run(opts: Parameters<typeof gc>[0] = {}) {
  return gc({ reportsDir, generatedDir, now: NOW, ...opts });
}

describe("gc — candidate selection", () => {
  it("ages out terminal reports past the retention window, keeps fresh and pending ones", () => {
    const oldApproved = writeReport("old-approved.json", {
      approvalStatus: "approved",
      createdAt: isoDaysAgo(40),
    });
    const oldExpired = writeReport("old-expired.json", {
      approvalStatus: "expired",
      createdAt: isoDaysAgo(35),
    });
    const freshApproved = writeReport("fresh-approved.json", {
      approvalStatus: "approved",
      createdAt: isoDaysAgo(5),
    });
    // Pending is NEVER a candidate, regardless of age.
    const ancientPending = writeReport("ancient-pending.json", {
      approvalStatus: "pending",
      createdAt: isoDaysAgo(300),
    });

    const r = run();
    const files = r.candidates.map((c) => c.filePath).sort();
    expect(files).toEqual([oldApproved, oldExpired].sort());
    expect(r.applied).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.keptCount).toBe(2);
    // Dry-run leaves everything on disk.
    for (const f of [oldApproved, oldExpired, freshApproved, ancientPending]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it("ages out parse-error logs and approval markers by mtime", () => {
    const oldLog = writeAged(parseErrorsDir, "old.log", 45);
    writeAged(parseErrorsDir, "fresh.log", 2);
    const oldMarker = writeAged(approvalsDir, "dead-session-id", 60);
    writeAged(approvalsDir, "live-session-id", 1);

    const r = run();
    const byCategory = (cat: string) =>
      r.candidates.filter((c) => c.category === cat).map((c) => c.filePath);
    expect(byCategory("parse-error")).toEqual([oldLog]);
    expect(byCategory("approval-marker")).toEqual([oldMarker]);
    expect(r.keptCount).toBe(2);
  });

  it("respects a custom retention window", () => {
    writeReport("r.json", { approvalStatus: "approved", createdAt: isoDaysAgo(10) });
    expect(run().candidates).toHaveLength(0);
    expect(run({ retentionDays: 7 }).candidates).toHaveLength(1);
  });

  it("rejects a non-positive retention", () => {
    expect(() => run({ retentionDays: 0 })).toThrow(/positive/);
  });

  it("returns empty results when the state dirs do not exist", () => {
    const r = gc({
      reportsDir: path.join(tmp, "nope", "reports"),
      generatedDir: path.join(tmp, "nope", "generated"),
      now: NOW,
    });
    expect(r.candidates).toEqual([]);
    expect(r.keptCount).toBe(0);
  });
});

describe("gc — apply", () => {
  it("deletes exactly the candidates and reports them", () => {
    const oldApproved = writeReport("old.json", {
      approvalStatus: "approved",
      createdAt: isoDaysAgo(40),
    });
    const pending = writeReport("pending.json", {
      approvalStatus: "pending",
      createdAt: isoDaysAgo(200),
    });
    const oldLog = writeAged(parseErrorsDir, "old.log", 45);
    const oldMarker = writeAged(approvalsDir, "dead", 90);
    const freshMarker = writeAged(approvalsDir, "live", 1);

    const r = run({ apply: true });
    expect(r.applied).toBe(true);
    expect(r.removed.sort()).toEqual([oldApproved, oldLog, oldMarker].sort());
    expect(r.failures).toEqual([]);
    expect(fs.existsSync(oldApproved)).toBe(false);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldMarker)).toBe(false);
    expect(fs.existsSync(pending)).toBe(true);
    expect(fs.existsSync(freshMarker)).toBe(true);
  });

  it("surfaces per-file deletion failures instead of swallowing them", () => {
    // chmod does not stop root (repo precedent: init-detect.test.ts).
    if (process.getuid?.() === 0) return;
    const oldApproved = writeReport("old.json", {
      approvalStatus: "approved",
      createdAt: isoDaysAgo(40),
    });
    // Make the parent dir read-only so unlink fails (POSIX).
    fs.chmodSync(reportsDir, 0o500);
    try {
      const r = run({ apply: true });
      expect(r.removed).toEqual([]);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]?.filePath).toBe(oldApproved);
    } finally {
      fs.chmodSync(reportsDir, 0o700);
    }
  });
});

describe("gc — defaults", () => {
  it("uses the documented default retention", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    const r = run();
    expect(r.retentionDays).toBe(30);
  });
});

describe("gc — non-conventional reports dir", () => {
  it("skips the parse-errors sweep when reportsDir is not .understanding-gate/reports", () => {
    // A custom UNDERSTANDING_GATE_REPORT_DIR can point anywhere; the
    // sibling named parse-errors would then be an unrelated directory.
    const customReports = path.join(tmp, "custom-reports");
    const sibling = path.join(tmp, "parse-errors");
    fs.mkdirSync(customReports, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const innocent = writeAged(sibling, "not-ours.txt", 400);

    const r = gc({ reportsDir: customReports, generatedDir, now: NOW, apply: true });
    expect(r.parseErrorsDir).toBeNull();
    expect(r.candidates.filter((c) => c.category === "parse-error")).toEqual([]);
    expect(fs.existsSync(innocent)).toBe(true);
  });
});

describe("gc — CLI wiring", () => {
  it("rejects a malformed --retention-days with a usage error", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    const { HarnessExitError } = await import("../../src/cli/exit-codes.js");
    let err = "";
    const program = buildProgram({
      stdout: () => {},
      stderr: (s: string) => {
        err += s;
      },
    });
    await expect(
      program.parseAsync(["gc", "--retention-days", "7d"], { from: "user" }),
    ).rejects.toThrow(HarnessExitError);
    expect(err).toMatch(/--retention-days must be a positive number/);
  });

  it("prints a dry-run listing and deletes nothing", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    const old = writeReport("old.json", {
      approvalStatus: "approved",
      createdAt: isoDaysAgo(4000),
    });
    let out = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
    });
    // The action only takes --config; anchor the manifest next to the
    // fixture dirs so reports/generated resolve inside the temp tree.
    fs.writeFileSync(path.join(tmp, "harness.yaml"), "version: 1\n");
    await program.parseAsync(["gc", "--config", path.join(tmp, "harness.yaml")], {
      from: "user",
    });
    expect(out).toMatch(/would remove 1 artifact/);
    expect(out).toMatch(/Dry-run; pass --apply to delete/);
    expect(fs.existsSync(old)).toBe(true);
  });
});
