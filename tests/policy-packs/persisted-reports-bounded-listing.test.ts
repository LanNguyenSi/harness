// These tests pin the bounded directory listing (`listDirNamesBounded`) and
// the bounded report reads (`listPersistedReportsBoundedWithSkips`,
// `readReportFileBounded`, `verifyApprovedReportHash`, `findLatestParseError`)
// that `harness approve understanding` and the persisted-report core still
// use. They were restored (with their fs-call counters and fixtures) from the
// deleted tests/cli/pack-hook-bounded-dir-reads.test.ts, whose hook-driven
// blocks went away with the understanding-gate hook verbs (task 7890cd34);
// the blocks below drive the kept pack-core functions directly.
//
// The original file's header (tasks 169e6286 / aa6f6570), for the bound
// itself: every full-directory read on the bounded path is bounded by entry
// count and by bytes, so a reports directory (or a parse-errors directory)
// with many planted entries cannot push one call past its budget; past the
// entry bound a reader opens nothing, and it fails closed. The assertions
// count opens, stats, bytes read and directory reads on the fs layer (a
// call-through `vi.mock` of `node:fs`), never wall time.

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsCounts = vi.hoisted(() => ({
  prefixes: [] as string[],
  opens: 0,
  stats: 0,
  /** Bytes returned by `readSync` on descriptors opened under a watched prefix. */
  bytes: 0,
  /** Entries `Dir.readSync` yielded (and the final null) for watched directories. */
  dirReads: 0,
  dirsOpened: 0,
  dirsClosed: 0,
  /** `readdirSync` calls on watched directories (a whole-directory listing). */
  readdirs: 0,
  fds: new Set<number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const watched = (p: unknown): boolean =>
    typeof p === "string" && fsCounts.prefixes.some((prefix) => p.startsWith(prefix));
  const mod = {
    ...orig,
    openSync: ((...args: Parameters<typeof orig.openSync>) => {
      const isWatched = watched(args[0]);
      if (isWatched) fsCounts.opens += 1;
      const fd = orig.openSync(...args);
      if (isWatched) fsCounts.fds.add(fd);
      return fd;
    }) as typeof orig.openSync,
    closeSync: ((fd: number) => {
      fsCounts.fds.delete(fd);
      return orig.closeSync(fd);
    }) as typeof orig.closeSync,
    readSync: ((fd: number, ...rest: unknown[]) => {
      const n = (orig.readSync as (...a: unknown[]) => number)(fd, ...rest);
      if (fsCounts.fds.has(fd)) fsCounts.bytes += n;
      return n;
    }) as typeof orig.readSync,
    opendirSync: ((...args: Parameters<typeof orig.opendirSync>) => {
      const dir = orig.opendirSync(...args);
      if (!watched(args[0])) return dir;
      fsCounts.dirsOpened += 1;
      return new Proxy(dir, {
        get(target, prop) {
          if (prop === "readSync") {
            return (): fs.Dirent | null => {
              fsCounts.dirReads += 1;
              return target.readSync();
            };
          }
          if (prop === "closeSync") {
            return (): void => {
              fsCounts.dirsClosed += 1;
              target.closeSync();
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    }) as typeof orig.opendirSync,
    readdirSync: ((...args: Parameters<typeof orig.readdirSync>) => {
      if (watched(args[0])) fsCounts.readdirs += 1;
      return (orig.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof orig.readdirSync,
    statSync: ((...args: Parameters<typeof orig.statSync>) => {
      if (watched(args[0])) fsCounts.stats += 1;
      return orig.statSync(...args);
    }) as typeof orig.statSync,
    lstatSync: ((...args: Parameters<typeof orig.lstatSync>) => {
      if (watched(args[0])) fsCounts.stats += 1;
      return orig.lstatSync(...args);
    }) as typeof orig.lstatSync,
  };
  return { ...mod, default: mod };
});

import * as fs from "node:fs";
import { approveUnderstanding, findLatestParseError } from "../../src/cli/approve/understanding.js";
import {
  canonicalReportHashOfFile,
  listDirNamesBounded,
  listPersistedReportsBoundedWithSkips,
  MAX_HOOK_LISTING_ENTRIES,
  readReportFileBounded,
  verifyApprovedReportHash,
  type ReadBudget,
} from "../../src/policy-packs/builtin/understanding-before-execution/persisted-reports.js";
import { parseManifest } from "../../src/schema/index.js";


// The bound written out, not read from the constant, so raising the constant
// fails a test instead of silently growing what the tests plant.
const BOUND = 8192;
// Planting thousands of entries takes seconds on a loaded machine.
const PLANTED_DIR_TEST_TIMEOUT_MS = 60_000;
const SESSION = "01998f2a-bounded-reads-1";

let tmp: string;
let generatedDir: string;
let reportsDir: string;
let parseErrorsDir: string;
let sessionsDir: string;
let transcriptPath: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"] as const;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ug-bounded-reads-")));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "reports");
  parseErrorsDir = path.join(tmp, "parse-errors");
  sessionsDir = path.join(tmp, "sessions");
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  fs.mkdirSync(sessionsDir, { recursive: true });
  transcriptPath = path.join(sessionsDir, `rollout-2026-10-04T00-00-00-${SESSION}.jsonl`);
  fs.writeFileSync(transcriptPath, "");
  fsCounts.prefixes = [];
  resetCounts();
});

afterEach(() => {
  fsCounts.prefixes = [];
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

/** A structurally valid `grill_me` report body (the auto path validates it). */
function pendingReportBody(sessionId: string, createdAt: string): Record<string, unknown> {
  return {
    sessionId,
    approvalStatus: "pending",
    createdAt,
    mode: "grill_me",
    currentUnderstanding: "the bounded directory reads under test",
    priorArt: ["searched the repo for an existing entry bound; the hash scan budget is reused"],
  };
}

function writePendingReport(name = "2026-10-04T10-00-00-000Z-report-aaaa1111.json"): void {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, name),
    `${JSON.stringify(pendingReportBody(SESSION, "2026-10-04T10:00:00.000Z"), null, 2)}\n`,
  );
}

/** Plant `count` tiny `*.json` entries that sort newer than every timestamped report name. */
function plantJsonEntries(count: number): void {
  fs.mkdirSync(reportsDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(reportsDir, `z-entry-${String(i).padStart(6, "0")}.json`), "{}");
  }
}

/** Plant `count` realistic reports of other sessions, older than the session's own report. */
function plantOtherSessionReports(count: number): void {
  fs.mkdirSync(reportsDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(
      path.join(reportsDir, `2026-01-01T00-00-00-${String(i).padStart(5, "0")}.json`),
      JSON.stringify(pendingReportBody(`other-${i}`, "2026-01-01T00:00:00.000Z")),
    );
  }
}

function plantLogEntries(count: number): void {
  fs.mkdirSync(parseErrorsDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(parseErrorsDir, `z-log-${String(i).padStart(6, "0")}.log`), "{}");
  }
}

function writeSessionParseErrorLog(): void {
  fs.mkdirSync(parseErrorsDir, { recursive: true });
  fs.writeFileSync(
    path.join(parseErrorsDir, "2026-10-04T09-00-00-000Z-parse-error.log"),
    `${JSON.stringify({
      sessionId: SESSION,
      message: "report did not parse",
      malformedSections: ["priorArt"],
    })}\n--- raw ---\nthe agent's last message\n`,
  );
}

interface Counted<T> {
  value: T;
  opens: number;
  stats: number;
  /** Bytes read through descriptors opened under the watched directories. */
  bytes: number;
  /** Entries the watched directory listings yielded (plus each listing's final null). */
  dirReads: number;
  dirsOpened: number;
  dirsClosed: number;
  /** `readdirSync` calls under the watched directories. */
  readdirs: number;
}

function resetCounts(): void {
  fsCounts.opens = 0;
  fsCounts.stats = 0;
  fsCounts.bytes = 0;
  fsCounts.dirReads = 0;
  fsCounts.dirsOpened = 0;
  fsCounts.dirsClosed = 0;
  fsCounts.readdirs = 0;
  fsCounts.fds.clear();
}

/** Count the fs calls the callback makes under the reports and parse-errors directories (or under `prefixes`). */
async function counted<T>(
  fn: () => Promise<T> | T,
  prefixes: string[] = [reportsDir, parseErrorsDir],
): Promise<Counted<T>> {
  resetCounts();
  fsCounts.prefixes = prefixes;
  try {
    const value = await fn();
    return {
      value,
      opens: fsCounts.opens,
      stats: fsCounts.stats,
      bytes: fsCounts.bytes,
      dirReads: fsCounts.dirReads,
      dirsOpened: fsCounts.dirsOpened,
      dirsClosed: fsCounts.dirsClosed,
      readdirs: fsCounts.readdirs,
    };
  } finally {
    fsCounts.prefixes = [];
  }
}

// The byte budget written out (32 MiB) and the per-file cap (1 MiB), not read
// from the constants, so changing either fails a test.
const BYTE_BUDGET = 32 * 1024 * 1024;
const FILE_CAP = 1024 * 1024;

describe("shared bound", () => {
  it("is the hash scan's budget over its per-entry floor: 8192 entries", () => {
    expect(MAX_HOOK_LISTING_ENTRIES).toBe(BOUND);
  });

  it("listDirNamesBounded: exactly at the bound lists, one past it lists nothing and says truncated", () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(reportsDir, `e${i}.json`), "{}");
    fs.writeFileSync(path.join(reportsDir, "ignored.txt"), "x");
    const atBound = listDirNamesBounded(reportsDir, ".json", 4);
    expect(atBound.truncated).toBe(false);
    expect(atBound.names.sort()).toEqual(["e0.json", "e1.json", "e2.json", "e3.json"]);
    expect(listDirNamesBounded(reportsDir, ".json", 3)).toEqual({ names: [], truncated: true });
    // A missing directory lists nothing and is not "too large".
    expect(listDirNamesBounded(path.join(tmp, "absent"), ".json", 3)).toEqual({
      names: [],
      truncated: false,
    });
  });

  it("listPersistedReportsBoundedWithSkips: maxEntries opens nothing past the bound, no option reads everything", async () => {
    plantOtherSessionReports(5);
    const bounded = await counted(async () => listPersistedReportsBoundedWithSkips(reportsDir, { maxEntries: 4 }));
    expect(bounded.value).toEqual({
      reports: [],
      skipped: [],
      truncated: true,
      truncatedKind: "entries",
      truncatedDetail: expect.stringMatching(
        /^holds more than 8192 \*\.json entries, or more than 16384 entries of any name, more than the gate reads; remove /,
      ),
    });
    expect(bounded.opens).toBe(0);
    const atBound = listPersistedReportsBoundedWithSkips(reportsDir, { maxEntries: 5 });
    expect(atBound.truncated).toBe(false);
    expect(atBound.reports).toHaveLength(5);
    const unbounded = listPersistedReportsBoundedWithSkips(reportsDir);
    expect(unbounded.truncated).toBe(false);
    expect(unbounded.reports).toHaveLength(5);
  });

  it("listDirNamesBounded: the listing stops after maxEntries + 1 matching names instead of reading the whole directory", async () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(reportsDir, `e${i}.json`), "{}");
    const past = await counted(() => listDirNamesBounded(reportsDir, ".json", 3));
    expect(past.value).toEqual({ names: [], truncated: true });
    // Four matching names cross the bound of three; the other 46 are never read.
    expect(past.dirReads).toBe(4);
    // The handle is closed on the early return.
    expect(past.dirsOpened).toBe(1);
    expect(past.dirsClosed).toBe(1);
    // Within the bound the whole directory is read, to its end (3 names + the final null).
    fs.rmSync(reportsDir, { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(reportsDir, `e${i}.json`), "{}");
    const within = await counted(() => listDirNamesBounded(reportsDir, ".json", 3));
    expect(within.value.truncated).toBe(false);
    expect(within.value.names).toHaveLength(3);
    expect(within.dirReads).toBe(4);
    expect(within.dirsClosed).toBe(within.dirsOpened);
  });

  it("listDirNamesBounded: a directory of many non-matching names fails closed after twice the bound, however few match", async () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(reportsDir, `junk${i}.txt`), "x");
    fs.writeFileSync(path.join(reportsDir, "only.json"), "{}");
    const past = await counted(() => listDirNamesBounded(reportsDir, ".json", 3));
    expect(past.value).toEqual({ names: [], truncated: true });
    // Twice the bound (6) iterated, then one more entry crosses it.
    expect(past.dirReads).toBe(7);
    expect(past.dirsClosed).toBe(past.dirsOpened);
    // The same directory under a roomy scan cap lists its one match.
    expect(listDirNamesBounded(reportsDir, ".json", 3, 1000)).toEqual({
      names: ["only.json"],
      truncated: false,
    });
  });

  it("findLatestParseError: maxEntries yields no parse error past the bound without a stat or an open, and the bounded lookup still finds the log at the bound", async () => {
    writeSessionParseErrorLog();
    plantLogEntries(4);
    const past = await counted(async () => findLatestParseError(parseErrorsDir, SESSION, { maxEntries: 4 }));
    expect(past.value).toBeNull();
    expect(past.opens).toBe(0);
    expect(past.stats).toBe(0);
    const atBound = findLatestParseError(parseErrorsDir, SESSION, { maxEntries: 5 });
    expect(atBound?.malformedSections).toEqual(["priorArt"]);
    // The operator command passes no bound.
    expect(findLatestParseError(parseErrorsDir, SESSION)?.malformedSections).toEqual(["priorArt"]);
  });
});

describe("listing order", () => {
  it("listDirNamesBounded returns the matching names in ascending byte order, whatever order they were created in", () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    // Created in neither sorted nor reverse-sorted order. The last two names
    // separate byte order (the fs.readdirSync order) from JavaScript's default
    // UTF-16 code-unit sort: the UTF-8 encoding of U+1F600 starts with byte
    // 0xf0 and sorts after U+FB01 (leading byte 0xef), while its first
    // surrogate (0xd83d) sorts before 0xfb01 by code units. No two names
    // differ only in case, so a case-insensitive filesystem keeps all of them.
    const created = [
      "m.json",
      "Z.json",
      "a.json",
      "_x.json",
      "10.json",
      "9.json",
      "b.json",
      "é.json",
      "\u{1F600}.json",
      "ﬁ.json",
    ];
    for (const name of created) fs.writeFileSync(path.join(reportsDir, name), "{}");
    fs.writeFileSync(path.join(reportsDir, "c.txt"), "x");
    const expected = [
      "10.json",
      "9.json",
      "Z.json",
      "_x.json",
      "a.json",
      "b.json",
      "m.json",
      "é.json",
      "ﬁ.json",
      "\u{1F600}.json",
    ];
    expect(listDirNamesBounded(reportsDir, ".json", BOUND)).toEqual({ names: expected, truncated: false });
    // The unbounded listing the operator commands use keeps the same order.
    expect(listDirNamesBounded(reportsDir, ".json", Number.POSITIVE_INFINITY).names).toEqual(expected);
  });
});

// The per-entry floor written out (4 KiB), not read from the constant.
const ENTRY_FLOOR = 4096;

describe("readReportFileBounded: the per-entry floor is charged for an entry it does not read", () => {
  it("a FIFO is refused unread and costs the floor", () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    const fifo = path.join(reportsDir, "pipe.json");
    execFileSync("mkfifo", [fifo]);
    const budget: ReadBudget = { spent: 0 };
    expect(readReportFileBounded(fifo, { budget })).toMatchObject({ ok: false, reason: "not-regular" });
    expect(budget.spent).toBe(ENTRY_FLOOR);
  });

  it("a file over the read cap is refused unread and costs the floor, not its size", async () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    const big = path.join(reportsDir, "big.json");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, FILE_CAP + 1);
    const budget: ReadBudget = { spent: 0 };
    const read = await counted(() => readReportFileBounded(big, { budget }));
    expect(read.value).toMatchObject({ ok: false, reason: "too-large" });
    expect(read.bytes).toBe(0);
    expect(budget.spent).toBe(ENTRY_FLOOR);
  });

  it("an entry whose open fails costs the floor: a dangling symlink, followed or refused, and a vanished path", () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    const dangling = path.join(reportsDir, "dangling.json");
    fs.symlinkSync(path.join(tmp, "nowhere.json"), dangling);
    const followed: ReadBudget = { spent: 0 };
    expect(readReportFileBounded(dangling, { budget: followed })).toMatchObject({ ok: false, reason: "unreadable" });
    expect(followed.spent).toBe(ENTRY_FLOOR);
    const refused: ReadBudget = { spent: 0 };
    expect(readReportFileBounded(dangling, { noFollow: true, budget: refused })).toMatchObject({
      ok: false,
      reason: "not-regular",
    });
    expect(refused.spent).toBe(ENTRY_FLOOR);
    const vanished: ReadBudget = { spent: 0 };
    expect(readReportFileBounded(path.join(reportsDir, "gone.json"), { budget: vanished })).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(vanished.spent).toBe(ENTRY_FLOOR);
  });

  it("floor charges alone spend the budget: once they reach it, the next entry is not opened", async () => {
    fs.mkdirSync(reportsDir, { recursive: true });
    const fifo = path.join(reportsDir, "pipe.json");
    execFileSync("mkfifo", [fifo]);
    const dangling = path.join(reportsDir, "dangling.json");
    fs.symlinkSync(path.join(tmp, "nowhere.json"), dangling);
    const report = path.join(reportsDir, "report.json");
    fs.writeFileSync(report, "{}");
    // Two floors short of the budget: the FIFO and the failed open spend it.
    const budget: ReadBudget = { spent: BYTE_BUDGET - 2 * ENTRY_FLOOR };
    expect(readReportFileBounded(fifo, { budget }).ok).toBe(false);
    expect(readReportFileBounded(dangling, { budget }).ok).toBe(false);
    expect(budget.spent).toBe(BYTE_BUDGET);
    const next = await counted(() => readReportFileBounded(report, { budget }));
    expect(next.value).toMatchObject({ ok: false, reason: "over-budget" });
    expect(next.opens).toBe(0);
  });
});

// The hash scan (a signed marker is present): it lists the reports directory
// through the same early-stopping listing as the four readers above, so planted
// names cost a bounded number of directory reads, and it fails closed past the
// bound. The selection inside the bound is unchanged: newest name first, within
// the byte budget.
const REPORT_NAME = "2026-10-04T10-00-00-000Z-report-aaaa1111.json";
const SCAN_ENTRY_BOUND_DETAIL =
  /no report in the reports directory could be checked against the content the session approval marker was signed for \(the reports directory \S+ holds more than 8192 \*\.json entries, or more than 16384 entries of any name, more than the gate reads; remove /;

/** Write the pending report and approve it, so a signed marker names its content hash. */
async function approveSessionReport(): Promise<string> {
  writePendingReport(REPORT_NAME);
  const approve = await approveUnderstanding({
    manifest: parseManifest({ version: 1 }),
    session: SESSION,
    reportsDir,
    generatedDir,
    ledgerAdd: async () => ({ ok: true }),
  });
  expect(approve.marker.ok).toBe(true);
  return path.join(reportsDir, REPORT_NAME);
}

describe("verifyApprovedReportHash: directory reads of the hash scan (both hooks call it)", () => {
  async function binding(): Promise<{ kind: "session"; reportContentHash: string }> {
    const reportPath = await approveSessionReport();
    const hash = canonicalReportHashOfFile(reportPath);
    expect(hash).not.toBeNull();
    return { kind: "session", reportContentHash: hash as string };
  }

  it(
    "one past the entry bound lists BOUND + 1 entries, opens and stats nothing, never calls readdirSync, closes its handle, and denies",
    async () => {
      const b = await binding();
      plantJsonEntries(BOUND);
      const out = await counted(() => verifyApprovedReportHash(reportsDir, b));
      expect(out.value.ok).toBe(false);
      expect(out.value).toMatchObject({ detail: expect.stringMatching(SCAN_ENTRY_BOUND_DETAIL) });
      // BOUND planted names plus the report: the BOUND + 1st matching name stops the listing.
      expect(out.dirReads).toBe(BOUND + 1);
      expect(out.dirsOpened).toBe(1);
      expect(out.dirsClosed).toBe(1);
      expect(out.readdirs).toBe(0);
      expect(out.opens).toBe(0);
      expect(out.stats).toBe(0);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "exactly at the entry bound (BOUND - 1 planted late names plus the report) the report is found and the check allows",
    async () => {
      const b = await binding();
      plantJsonEntries(BOUND - 1);
      const out = await counted(() => verifyApprovedReportHash(reportsDir, b));
      expect(out.value).toEqual({ ok: true, kind: "session" });
      // The whole directory is listed to its end (BOUND names + the final null).
      expect(out.dirReads).toBe(BOUND + 1);
      expect(out.readdirs).toBe(0);
      // Newest first: every planted late name is opened before the report.
      expect(out.opens).toBe(BOUND);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "a directory of non-matching names fails closed after reading twice the bound plus one, not after listing all of them",
    async () => {
      const b = await binding();
      for (let i = 0; i < 2 * BOUND + 20; i++) {
        fs.writeFileSync(path.join(reportsDir, `junk-${String(i).padStart(6, "0")}.txt`), "");
      }
      const out = await counted(() => verifyApprovedReportHash(reportsDir, b));
      expect(out.value.ok).toBe(false);
      expect(out.dirReads).toBe(2 * BOUND + 1);
      expect(out.readdirs).toBe(0);
      expect(out.opens).toBe(0);
      expect(out.dirsClosed).toBe(out.dirsOpened);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it("a missing reports directory still reads as no report file (allow), not as too large", async () => {
    const b = await binding();
    fs.rmSync(reportsDir, { recursive: true, force: true });
    expect(verifyApprovedReportHash(reportsDir, b)).toEqual({ ok: true, kind: "session" });
  });
});
