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
let permissionModeObservationsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gc-"));
  reportsDir = path.join(tmp, ".understanding-gate", "reports");
  parseErrorsDir = path.join(tmp, ".understanding-gate", "parse-errors");
  generatedDir = path.join(tmp, "harness.generated");
  approvalsDir = path.join(generatedDir, ".approvals");
  delegationsDir = path.join(generatedDir, ".delegations");
  adoptionLedgerDir = path.join(generatedDir, ".delegation-adoptions");
  permissionModeObservationsDir = path.join(generatedDir, ".permission-mode-observations");
  for (const d of [
    reportsDir,
    parseErrorsDir,
    approvalsDir,
    delegationsDir,
    adoptionLedgerDir,
    permissionModeObservationsDir,
  ]) {
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

/** A ledger whose own mtime is aged to `agedDays` before NOW, independent of any delegation. */
function writeAgedLedger(sid: string, agedDays: number, entries: string[] = ["entry-1"]): string {
  const full = writeLedger(sid, entries);
  const then = new Date(NOW.getTime() - agedDays * DAY_MS);
  fs.utimesSync(full, then, then);
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

describe("gc - delegations", () => {
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

    // No delegation file at all for this session: orphaned, and old
    // enough on its own to clear the retention window.
    const orphanedLedger = writeAgedLedger("no-delegation-sid", 40);

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

  it("keeps a brand-new orphaned adoption ledger, removes one older than the cutoff (F1)", () => {
    // No delegation marker at all for either session id: both are
    // "orphaned" by marker-absence. The command's own description and
    // listing header both promise "older than the retention window",
    // so age must gate this branch too, not just marker absence.
    const freshOrphan = writeAgedLedger("fresh-orphan-sid", 1);
    const oldOrphan = writeAgedLedger("old-orphan-sid", 40);

    const r = run();
    const byCategory = r.candidates.filter((c) => c.category === "delegation").map((c) => c.filePath);
    expect(byCategory).toEqual([oldOrphan]);
    expect(byCategory).not.toContain(freshOrphan);
    expect(fs.existsSync(freshOrphan)).toBe(true);
    expect(fs.existsSync(oldOrphan)).toBe(true); // dry-run: nothing deleted yet

    const applied = run({ apply: true });
    expect(applied.removed).toEqual([oldOrphan]);
    expect(fs.existsSync(freshOrphan)).toBe(true);
    expect(fs.existsSync(oldOrphan)).toBe(false);
  });

  it("ignores non-session-id filesystem debris in both delegation dirs (F2)", () => {
    fs.writeFileSync(path.join(delegationsDir, ".DS_Store"), "junk");
    fs.writeFileSync(path.join(delegationsDir, "notes.txt"), "junk");
    fs.writeFileSync(path.join(adoptionLedgerDir, ".DS_Store"), "junk");
    fs.writeFileSync(path.join(adoptionLedgerDir, "notes.txt"), "junk");
    // notes.txt is not session-id shaped (contains a dot), .DS_Store starts
    // with a dot: neither matches SESSION_ID_BASENAME_RE.

    const r = run({ apply: true });
    const delegationResults = [
      ...r.candidates.filter((c) => c.category === "delegation"),
      ...r.unparseable,
    ];
    expect(delegationResults).toEqual([]);
    expect(fs.existsSync(path.join(delegationsDir, ".DS_Store"))).toBe(true);
    expect(fs.existsSync(path.join(delegationsDir, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(adoptionLedgerDir, ".DS_Store"))).toBe(true);
    expect(fs.existsSync(path.join(adoptionLedgerDir, "notes.txt"))).toBe(true);
  });

  it("counts kept delegations and ledgers into keptCount (F3)", () => {
    // One expired marker (candidate), one valid marker (kept), one
    // unparseable marker (kept). One ledger tied to the valid marker
    // (kept), one fresh orphaned ledger (kept), one old orphaned ledger
    // (candidate).
    writeDelegation("expired-sid", isoDaysAgo(40));
    writeDelegation("valid-sid", new Date(NOW.getTime() + 5 * DAY_MS).toISOString());
    const badJson = path.join(delegationsDir, "bad-json-sid");
    fs.writeFileSync(badJson, "not json at all\n");

    writeLedger("valid-sid");
    writeAgedLedger("fresh-orphan-sid", 1);
    writeAgedLedger("old-orphan-sid", 40);

    const r = run();
    // kept: valid marker, unparseable marker, valid-sid's ledger, fresh
    // orphan ledger = 4. Reports/parse-errors/approvals dirs are empty
    // in this test's fixture, so gc's overall keptCount is exactly this.
    expect(r.keptCount).toBe(4);
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

  it("a symlinked delegation marker is unparseable, never deleted (F4)", () => {
    const target = path.join(tmp, "outside-target.json");
    fs.writeFileSync(
      target,
      `${JSON.stringify({ markerId: "x", approvedAt: isoDaysAgo(1), approvedBy: "irrelevant" }, null, 2)}\n`,
    );
    const symlinkSid = "symlinked-sid";
    const symlinkPath = path.join(delegationsDir, symlinkSid);
    fs.symlinkSync(target, symlinkPath);

    const r = run({ apply: true });
    expect(r.unparseable.some((u) => u.filePath === symlinkPath)).toBe(true);
    expect(r.candidates.some((c) => c.filePath === symlinkPath)).toBe(false);
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("a symlinked orphaned adoption ledger is unlinked without touching its target (F4)", () => {
    const target = path.join(tmp, "outside-ledger-target.txt");
    fs.writeFileSync(target, "entry-1\n");
    const then = new Date(NOW.getTime() - 40 * DAY_MS);
    fs.utimesSync(target, then, then); // aged: statSync on the symlink follows to this mtime
    const symlinkSid = "symlinked-orphan-sid";
    const symlinkPath = path.join(adoptionLedgerDir, symlinkSid);
    fs.symlinkSync(target, symlinkPath);
    // No delegation marker for this session id: orphaned.

    const r = run({ apply: true });
    expect(r.removed).toContain(symlinkPath);
    expect(fs.existsSync(symlinkPath)).toBe(false); // the symlink itself is gone
    expect(fs.existsSync(target)).toBe(true); // the target file it pointed to survives
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

describe("gc - permission-mode observations (task 8f637efd review round 2 F5)", () => {
  it("ages out a stale observation by mtime, keeps a fresh one", () => {
    const stale = writeAged(permissionModeObservationsDir, "stale-sid", 45);
    const fresh = writeAged(permissionModeObservationsDir, "fresh-sid", 1);

    const r = run();
    const byCategory = r.candidates.filter((c) => c.category === "permission-mode-observation");
    expect(byCategory.map((c) => c.filePath)).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(true); // dry-run: nothing deleted yet
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("apply removes exactly the aged observation, keeps the fresh one on disk", () => {
    const stale = writeAged(permissionModeObservationsDir, "stale-sid", 45);
    const fresh = writeAged(permissionModeObservationsDir, "fresh-sid", 1);

    const r = run({ apply: true });
    expect(r.removed).toContain(stale);
    expect(r.removed).not.toContain(fresh);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("dry-run lists the stale observation as a candidate but deletes nothing", () => {
    const stale = writeAged(permissionModeObservationsDir, "stale-sid", 45);

    const r = run();
    expect(r.applied).toBe(false);
    expect(r.candidates.some((c) => c.filePath === stale)).toBe(true);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it("reports permissionModeObservationsDir in the result", () => {
    const r = run();
    expect(r.permissionModeObservationsDir).toBe(permissionModeObservationsDir);
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

  it("surfaces the unparseable-delegation stderr block and lists both delegation dirs as swept (F4)", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    fs.writeFileSync(path.join(delegationsDir, "bad-json-sid"), "not json at all\n");
    let out = "";
    let err = "";
    const program = buildProgram({
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    });
    fs.writeFileSync(path.join(tmp, "harness.yaml"), "version: 1\n");
    await program.parseAsync(["gc", "--config", path.join(tmp, "harness.yaml")], {
      from: "user",
    });
    expect(err).toMatch(/1 delegation file\(s\) could not be parsed and were left in place/);
    expect(err).toMatch(/bad-json-sid/);
    expect(out).toMatch(/\.delegations/);
    expect(out).toMatch(/\.delegation-adoptions/);
    expect(out).toMatch(/\.permission-mode-observations/);
  });
});
