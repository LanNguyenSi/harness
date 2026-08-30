import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_DAYS, gc } from "../../src/cli/gc/index.js";
import { buildDelegationApprovedBy } from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const DAY_MS = 86_400_000;

let tmp: string;
let reportsDir: string;
let parseErrorsDir: string;
let generatedDir: string;
let approvalsDir: string;
let delegationsDir: string;
let adoptionLedgerDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gc-"));
  reportsDir = path.join(tmp, ".understanding-gate", "reports");
  parseErrorsDir = path.join(tmp, ".understanding-gate", "parse-errors");
  generatedDir = path.join(tmp, "harness.generated");
  approvalsDir = path.join(generatedDir, ".approvals");
  delegationsDir = path.join(generatedDir, ".delegations");
  adoptionLedgerDir = path.join(generatedDir, ".delegation-adoptions");
  for (const d of [reportsDir, parseErrorsDir, approvalsDir, delegationsDir, adoptionLedgerDir]) {
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

/** A minimal, unsigned delegation marker: gc reads `approvedBy` only, never a signature. */
function writeDelegation(sid: string, expiresAt: string): string {
  const full = path.join(delegationsDir, sid);
  const approvedBy = buildDelegationApprovedBy({
    parentSessionId: "parent-sid",
    cwdHash: null,
    taskId: null,
    expiresAt,
  });
  fs.writeFileSync(
    full,
    `${JSON.stringify({ markerId: `delegation-${sid}`, approvedAt: isoDaysAgo(1), approvedBy }, null, 2)}\n`,
  );
  return full;
}

function writeLedger(sid: string, entries: string[] = ["entry-1"]): string {
  const full = path.join(adoptionLedgerDir, sid);
  fs.writeFileSync(full, `${entries.join("\n")}\n`);
  return full;
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

describe("gc — delegations", () => {
  it("ages out delegation markers expired past the grace window, keeps valid and recently-expired ones", () => {
    // Expired well past the 30d default grace: a candidate.
    const wayExpired = writeDelegation("way-expired-sid", isoDaysAgo(40));
    // Expired, but only 1 day ago: still within grace, kept.
    const recentlyExpired = writeDelegation("recently-expired-sid", isoDaysAgo(1));
    // Not yet expired at all: kept.
    const stillValid = writeDelegation(
      "still-valid-sid",
      new Date(NOW.getTime() + 5 * DAY_MS).toISOString(),
    );

    const r = run();
    const byCategory = r.candidates.filter((c) => c.category === "delegation").map((c) => c.filePath);
    expect(byCategory).toEqual([wayExpired]);
    expect(r.applied).toBe(false);
    for (const f of [wayExpired, recentlyExpired, stillValid]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it("removes an adoption ledger only when its delegation is absent or expired past grace, keeps it while the delegation is still valid", () => {
    writeDelegation("valid-sid", new Date(NOW.getTime() + 5 * DAY_MS).toISOString());
    const validLedger = writeLedger("valid-sid");

    writeDelegation("expired-sid", isoDaysAgo(40));
    const expiredLedger = writeLedger("expired-sid");

    // No delegation file at all for this session: orphaned.
    const orphanedLedger = writeLedger("no-delegation-sid");

    const r = run({ apply: true });
    expect(fs.existsSync(validLedger)).toBe(true);
    expect(fs.existsSync(expiredLedger)).toBe(false);
    expect(fs.existsSync(orphanedLedger)).toBe(false);
    expect(r.removed).toEqual(
      expect.arrayContaining([
        path.join(delegationsDir, "expired-sid"),
        expiredLedger,
        orphanedLedger,
      ]),
    );
  });

  it("reports an unparseable delegation file without ever deleting it (or its ledger)", () => {
    const badJson = path.join(delegationsDir, "bad-json-sid");
    fs.writeFileSync(badJson, "not json at all\n");
    const badSegments = path.join(delegationsDir, "bad-segments-sid");
    fs.writeFileSync(
      badSegments,
      `${JSON.stringify({ markerId: "delegation-bad-segments-sid", approvedAt: isoDaysAgo(1), approvedBy: "garbage" }, null, 2)}\n`,
    );
    const ledgerForBad = writeLedger("bad-json-sid");

    const r = run({ apply: true });
    const unparseablePaths = r.unparseable.map((u) => u.filePath).sort();
    expect(unparseablePaths).toEqual([badJson, badSegments].sort());
    for (const u of r.unparseable) {
      expect(u.category).toBe("delegation");
    }
    // Never deleted, dry-run or apply.
    expect(fs.existsSync(badJson)).toBe(true);
    expect(fs.existsSync(badSegments)).toBe(true);
    // Its ledger sibling is kept too: gc cannot prove the delegation is dead.
    expect(fs.existsSync(ledgerForBad)).toBe(true);
    expect(r.candidates.some((c) => c.filePath === badJson || c.filePath === badSegments)).toBe(
      false,
    );
  });

  it("dry-run lists delegation candidates but deletes nothing", () => {
    const expired = writeDelegation("expired-sid", isoDaysAgo(40));
    const expiredLedger = writeLedger("expired-sid");

    const r = run();
    expect(r.applied).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.candidates.some((c) => c.filePath === expired)).toBe(true);
    expect(r.candidates.some((c) => c.filePath === expiredLedger)).toBe(true);
    expect(fs.existsSync(expired)).toBe(true);
    expect(fs.existsSync(expiredLedger)).toBe(true);
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
