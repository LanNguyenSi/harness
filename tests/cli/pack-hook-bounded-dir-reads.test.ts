// Task 169e6286 (split from 805be2af): every full-directory read on the
// PreToolUse hook path is bounded by entry count and by bytes, so a reports
// directory (or a parse-errors directory) with many planted entries, or with a
// few thousand large ones, cannot push one hook call past the 15 s PreToolUse
// budget, which the runtime treats as an allow. The hash scan was bounded by
// 805be2af; this file pins the four other readers:
//   - the evidence read (`checkPersistedReport`), both runtimes
//   - the auto-approval precondition listing (`attemptAutoApproval`), both runtimes
//   - the subagent-delegation lookup, Claude hook only (the Codex hook has none)
//   - the parse-error log lookup (`findLatestParseError`), both runtimes
// Past the entry bound a reader opens nothing, and past the byte budget (32 MiB,
// each entry charged its size or 4 KiB, whichever is larger) it reads no more;
// either way it fails closed: no evidence, the auto-approval declines, the
// delegation capture is skipped, no parse error. The directory listing itself
// stops early (one entry at a time, after the bound is crossed).
//
// The assertions count opens, stats, bytes read and directory reads on the fs
// layer (a call-through `vi.mock` of `node:fs`), never wall time: an unbounded
// reader opens every planted entry, a bounded one opens none past the bound.

import { Readable, Writable } from "node:stream";
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
import { findLatestParseError } from "../../src/cli/approve/understanding.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { checkApprovalMarker } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import {
  delegationMarkerPathFor,
  hashDelegationCwd,
  writeDelegationMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";
import {
  listDirNamesBounded,
  listPersistedReportsBoundedWithSkips,
  MAX_HOOK_LISTING_ENTRIES,
} from "../../src/policy-packs/builtin/understanding-before-execution/persisted-reports.js";
import { getOrCreateSigningKey } from "../../src/runtime/approval-signing.js";
import type { LedgerWriteArgs } from "../../src/runtime/ledger-writer.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// The bound written out, not read from the constant, so raising the constant
// fails a test instead of silently growing what the tests plant.
const BOUND = 8192;
// Planting thousands of entries takes seconds on a loaded machine.
const PLANTED_DIR_TEST_TIMEOUT_MS = 60_000;
// A realistic large directory, well under the bound.
const REALISTIC_ENTRIES = 1000;

const SESSION = "01998f2a-bounded-reads-1";
const CHILD = "child-bounded-4444";
const PARENT = "parent-bounded-1111";

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

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

function plainManifest(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
  });
}

function autoApproveManifest(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        config: {
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["claude-code", "codex"],
            require_report: true,
          },
        },
      },
    ],
  });
}

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
}

function resetCounts(): void {
  fsCounts.opens = 0;
  fsCounts.stats = 0;
  fsCounts.bytes = 0;
  fsCounts.dirReads = 0;
  fsCounts.dirsOpened = 0;
  fsCounts.dirsClosed = 0;
  fsCounts.fds.clear();
}

/** Count the fs calls the callback makes under the reports and parse-errors directories. */
async function counted<T>(fn: () => Promise<T> | T): Promise<Counted<T>> {
  resetCounts();
  fsCounts.prefixes = [reportsDir, parseErrorsDir];
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
    };
  } finally {
    fsCounts.prefixes = [];
  }
}

// The byte budget written out (32 MiB) and the per-file cap (1 MiB), not read
// from the constants, so changing either fails a test.
const BYTE_BUDGET = 32 * 1024 * 1024;
const FILE_CAP = 1024 * 1024;
// Entries well under the count bound whose total size is over the byte budget:
// 60 files of 1,000,000 bytes (the largest single read the cap allows is 1 MiB),
// every one a hard link to one inode, so the fixture costs one file of disk.
const LARGE_LINKS = 60;
const LARGE_FILE_BYTES = 1_000_000;
// One listing reads at most the budget plus the one file in flight.
const ONE_READER_MAX_BYTES = BYTE_BUDGET + FILE_CAP + 1;

/** A JSON object of exactly `LARGE_FILE_BYTES` bytes (one trailing newline). */
function largeJsonBody(fields: Record<string, unknown>): string {
  const head = JSON.stringify({ ...fields, pad: "" });
  const pad = "x".repeat(LARGE_FILE_BYTES - 1 - Buffer.byteLength(head));
  return `${JSON.stringify({ ...fields, pad })}\n`;
}

/** Plant `LARGE_LINKS` hard links to one large file in `dir`, named `<prefix>NNNN<suffix>`. */
function plantLargeLinks(dir: string, prefix: string, suffix: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, `${prefix}0000${suffix}`);
  fs.writeFileSync(original, body);
  for (let i = 1; i < LARGE_LINKS; i++) {
    fs.linkSync(original, path.join(dir, `${prefix}${String(i).padStart(4, "0")}${suffix}`));
  }
}

interface Outcome {
  blocked: boolean;
  source: string;
  detail: string;
  stderr: string;
}

interface Runtime {
  name: string;
  run: (args: { manifest: Manifest; permissionMode?: string }) => Promise<Outcome>;
}

const RUNTIMES: Runtime[] = [
  {
    name: "claude pre-tool-use",
    run: async ({ manifest, permissionMode }) => {
      process.env["CLAUDE_CODE_SESSION_ID"] = SESSION;
      const stderr = bufferStream();
      const stdout = bufferStream();
      const result = await runPackHookPreToolUseCli({
        manifest,
        stdin: readableFromString(
          JSON.stringify({
            session_id: SESSION,
            tool_name: "Edit",
            transcript_path: transcriptPath,
            ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
          }),
        ),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir,
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
        writeLedger: async (_args: LedgerWriteArgs): Promise<{ ok: true }> => ({ ok: true }),
      });
      return {
        blocked: result.blocked,
        source: result.approvalCheck.source,
        detail: result.approvalCheck.detail,
        // The Claude hook delivers the agent-facing block text on stdout.
        stderr: `${stderr.read()}${stdout.read()}`,
      };
    },
  },
  {
    name: "codex codex-pre-tool-use",
    run: async ({ manifest, permissionMode }) => {
      const stderr = bufferStream();
      const result = await runPackHookCodexPreToolUseCli({
        manifest,
        stdin: readableFromString(
          JSON.stringify({
            session_id: SESSION,
            tool_name: "apply_patch",
            transcript_path: transcriptPath,
            ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
          }),
        ),
        stderr: stderr.stream,
        reportsDir,
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
        writeLedger: async (_args: LedgerWriteArgs): Promise<{ ok: true }> => ({ ok: true }),
      });
      return {
        blocked: result.blocked,
        source: result.approvalCheck.source,
        detail: result.approvalCheck.detail,
        stderr: stderr.read(),
      };
    },
  },
];

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

describe.each(RUNTIMES)("bounded directory reads on the hook path: $name", (rt) => {
  it(
    "evidence read: more *.json entries than the bound are not opened (no evidence), the call still blocks",
    async () => {
      writePendingReport();
      plantJsonEntries(BOUND + 1);
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.opens).toBeLessThanOrEqual(BOUND);
      expect(out.opens).toBe(0);
      expect(out.value.stderr).toMatch(/no report evidence read: .* holds more than 8192 \*\.json entries/);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "evidence read: a realistic large directory (1000 other-session reports) is still read and names the pending report",
    async () => {
      plantOtherSessionReports(REALISTIC_ENTRIES);
      writePendingReport();
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).toMatch(/has approvalStatus=pending/);
      expect(out.value.stderr).not.toMatch(/no report evidence read/);
      expect(out.opens).toBeGreaterThan(REALISTIC_ENTRIES);
      expect(out.opens).toBeLessThanOrEqual(BOUND);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "auto-approval listing: more *.json entries than the bound decline the attempt without opening them (fail closed, the gate stays shut)",
    async () => {
      getOrCreateSigningKey(generatedDir);
      writePendingReport();
      plantJsonEntries(BOUND + 1);
      const out = await counted(() =>
        rt.run({ manifest: autoApproveManifest(), permissionMode: "bypassPermissions" }),
      );
      expect(out.value.blocked).toBe(true);
      expect(out.opens).toBeLessThanOrEqual(BOUND);
      expect(out.opens).toBe(0);
      expect(out.value.stderr).toMatch(
        /auto-approval declined: the reports directory holds more than 8192 \*\.json entries/,
      );
      expect(checkApprovalMarker(generatedDir, SESSION).matched).toBe(false);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "auto-approval listing: a realistic large directory (1000 other-session reports) still auto-approves",
    async () => {
      getOrCreateSigningKey(generatedDir);
      plantOtherSessionReports(REALISTIC_ENTRIES);
      writePendingReport();
      const out = await counted(() =>
        rt.run({ manifest: autoApproveManifest(), permissionMode: "bypassPermissions" }),
      );
      expect(out.value.blocked).toBe(false);
      expect(out.value.source).toBe("marker");
      expect(out.opens).toBeLessThanOrEqual(BOUND * 2);
      expect(checkApprovalMarker(generatedDir, SESSION).matched).toBe(true);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "parse-error lookup: more *.log entries than the bound are neither stat-ed nor opened, the block names no parse error",
    async () => {
      writeSessionParseErrorLog();
      plantLogEntries(BOUND + 1);
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.opens).toBeLessThanOrEqual(BOUND);
      expect(out.opens).toBe(0);
      expect(out.stats).toBeLessThanOrEqual(BOUND);
      expect(out.stats).toBe(0);
      expect(out.value.stderr).not.toMatch(/malformed sections/);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "parse-error lookup: a realistic large directory (1000 other logs) is still read and names the malformed section",
    async () => {
      plantLogEntries(REALISTIC_ENTRIES);
      writeSessionParseErrorLog();
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).toMatch(/malformed sections/);
      expect(out.opens).toBeGreaterThan(0);
      expect(out.opens).toBeLessThanOrEqual(BOUND);
      // Positive control for the stat counter the bound tests above assert 0 on:
      // the lookup stats every log it lists (the stat only orders the candidates).
      expect(out.stats).toBeGreaterThanOrEqual(REALISTIC_ENTRIES);
      expect(out.stats).toBeLessThanOrEqual(BOUND);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "evidence read: entries under the count bound but over the byte budget are read only up to the budget (no evidence, the call still blocks)",
    async () => {
      writePendingReport();
      plantLargeLinks(reportsDir, "z-large-", ".json", largeJsonBody({ sessionId: "other" }));
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).toMatch(/no report evidence read: .* holds more than 32 MiB of report data/);
      expect(out.value.stderr).toMatch(/remove non-report or stale \*\.json entries from it by hand/);
      expect(out.value.stderr).not.toMatch(/has approvalStatus=pending/);
      // Without a byte charge all 60 files (60 MB) would be read and parsed.
      expect(out.bytes).toBeLessThanOrEqual(ONE_READER_MAX_BYTES);
      expect(out.opens).toBeLessThan(LARGE_LINKS);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "auto-approval listing: entries under the count bound but over the byte budget decline the attempt (fail closed, the gate stays shut)",
    async () => {
      getOrCreateSigningKey(generatedDir);
      writePendingReport();
      plantLargeLinks(reportsDir, "z-large-", ".json", largeJsonBody({ sessionId: "other" }));
      const out = await counted(() =>
        rt.run({ manifest: autoApproveManifest(), permissionMode: "bypassPermissions" }),
      );
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).toMatch(
        /auto-approval declined: the reports directory holds more than 32 MiB of report data/,
      );
      expect(checkApprovalMarker(generatedDir, SESSION).matched).toBe(false);
      // Two readers each list the reports directory once (the auto-approval
      // precondition, then the evidence read), each within its own budget.
      expect(out.bytes).toBeLessThanOrEqual(2 * ONE_READER_MAX_BYTES);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "parse-error lookup: logs under the count bound but over the byte budget are read only up to the budget, the block names no parse error",
    async () => {
      // The session's own log is the OLDEST, so the lookup reaches it only after
      // the planted logs; the budget is spent before that.
      writeSessionParseErrorLog();
      const own = path.join(parseErrorsDir, "2026-10-04T09-00-00-000Z-parse-error.log");
      fs.utimesSync(own, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
      plantLargeLinks(parseErrorsDir, "z-large-", ".log", largeJsonBody({ sessionId: "other" }));
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).not.toMatch(/malformed sections/);
      expect(out.bytes).toBeLessThanOrEqual(ONE_READER_MAX_BYTES);
      expect(out.opens).toBeLessThan(LARGE_LINKS);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "evidence read: the listing stops once the bound is crossed (no read of the rest of 8193 planted entries)",
    async () => {
      writePendingReport();
      plantJsonEntries(BOUND + 1);
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      // BOUND + 2 *.json entries exist; the listing yields BOUND + 1 of them.
      expect(out.dirReads).toBeLessThanOrEqual(BOUND + 1);
      expect(out.dirsClosed).toBe(out.dirsOpened);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "evidence read: a directory of more non-matching names than twice the bound fails closed after reading twice the bound",
    async () => {
      writePendingReport();
      fs.mkdirSync(reportsDir, { recursive: true });
      for (let i = 0; i < 2 * BOUND + 20; i++) {
        fs.writeFileSync(path.join(reportsDir, `junk-${String(i).padStart(6, "0")}.txt`), "");
      }
      const out = await counted(() => rt.run({ manifest: plainManifest() }));
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).toMatch(/no report evidence read: .* holds more than 8192 \*\.json entries/);
      expect(out.value.stderr).not.toMatch(/has approvalStatus=pending/);
      expect(out.opens).toBe(0);
      expect(out.dirReads).toBeLessThanOrEqual(2 * BOUND + 1);
      expect(out.dirsClosed).toBe(out.dirsOpened);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );
});

// The subagent-delegation lookup lives in the Claude hook only: the Codex hook
// has no delegation path. A valid delegation reaches the lookup, which lists
// the reports directory to see whether the child already has a pending report
// before it scans the child's transcript for one.
describe("bounded directory reads on the hook path: delegation lookup (claude pre-tool-use only)", () => {
  const childReportMarkdown = [
    "# Understanding Report",
    "",
    "**Metadata**",
    "",
    "taskId: t-bounded-reads",
    "mode: grill_me",
    "riskLevel: low",
    "",
    "**Current Understanding**",
    "",
    "The parent delegated this child session and the child must state its own understanding.",
    "",
    "**Intended Outcome**",
    "",
    "The child auto-approves through the delegation plus its own report, never the delegation alone.",
    "",
    "**Derived Todos**",
    "",
    "- capture the report from the session transcript",
    "",
    "**Acceptance Criteria**",
    "",
    "- the minted marker carries the parent linkage",
    "",
    "**Assumptions**",
    "",
    "- the transcript read is the file the payload names",
    "",
    "**Open Questions**",
    "",
    "- none",
    "",
    "**Out Of Scope**",
    "",
    "- the delegate verb itself",
    "",
    "**Risks**",
    "",
    "- the transcript write races the hook",
    "",
    "**Verification Plan**",
    "",
    "- vitest over the real hook entry point",
    "",
    "**Prior Art**",
    "",
    "- searched harness for an existing same-turn capture path; the approve stdin persister is reused",
  ].join("\n");

  let childCwd: string;
  let childTranscript: string;

  function delegationManifest(): Manifest {
    return parseManifest({
      version: 1,
      policy_packs: [
        {
          name: "understanding-before-execution",
          enabled: true,
          config: {
            auto_approve: {
              when: ["bypassPermissions"],
              harnesses: ["claude-code"],
              require_report: true,
            },
          },
        },
      ],
    });
  }

  function setUpDelegation(withReportInTranscript: boolean): void {
    childCwd = path.join(tmp, "child-cwd");
    childTranscript = path.join(tmp, "transcripts", `${CHILD}.jsonl`);
    fs.mkdirSync(childCwd, { recursive: true });
    fs.mkdirSync(path.dirname(childTranscript), { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });
    getOrCreateSigningKey(generatedDir);
    const issued = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(issued.ok).toBe(true);
    expect(fs.existsSync(delegationMarkerPathFor(generatedDir, CHILD))).toBe(true);
    const lines = [
      JSON.stringify({
        type: "user",
        sessionId: CHILD,
        isSidechain: false,
        uuid: "uuid-prompt",
        message: { role: "user", content: "do the task" },
      }),
    ];
    if (withReportInTranscript) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          sessionId: CHILD,
          isSidechain: false,
          uuid: "uuid-report",
          timestamp: "2026-10-04T09:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: childReportMarkdown }] },
        }),
      );
    }
    fs.writeFileSync(childTranscript, `${lines.join("\n")}\n`);
  }

  async function runChild(): Promise<Outcome> {
    process.env["CLAUDE_CODE_SESSION_ID"] = CHILD;
    let t = 2_000_000;
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: delegationManifest(),
      stdin: readableFromString(
        JSON.stringify({
          tool_name: "Edit",
          session_id: CHILD,
          cwd: childCwd,
          transcript_path: childTranscript,
          permission_mode: "default",
        }),
      ),
      stdout: bufferStream().stream,
      stderr: stderr.stream,
      reportsDir,
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      writeLedger: async (_args: LedgerWriteArgs): Promise<{ ok: true }> => ({ ok: true }),
      reportScanClock: {
        now: (): number => t,
        sleep: (ms: number): Promise<void> => {
          t += ms;
          return Promise.resolve();
        },
      },
    });
    return {
      blocked: result.blocked,
      source: result.approvalCheck.source,
      detail: result.approvalCheck.detail,
      stderr: stderr.read(),
    };
  }

  it(
    "more *.json entries than the bound are not opened and the child's report is not captured (fail closed, the child stays blocked)",
    async () => {
      setUpDelegation(true);
      plantJsonEntries(BOUND + 1);
      const out = await counted(runChild);
      expect(out.value.blocked).toBe(true);
      expect(out.opens).toBeLessThanOrEqual(BOUND);
      expect(out.opens).toBe(0);
      expect(out.value.stderr).toMatch(
        /holds more than 8192 \*\.json entries, or more than 16384 entries of any name, more than the gate reads; remove .*; the report for session child-bounded-4444 was not captured/,
      );
      expect(out.value.stderr).not.toMatch(/captured the Understanding Report/);
      expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(false);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "a realistic large directory (1000 other-session reports) still captures the child's report and allows the child",
    async () => {
      setUpDelegation(true);
      plantOtherSessionReports(REALISTIC_ENTRIES);
      const out = await counted(runChild);
      expect(out.value.stderr).toMatch(/captured the Understanding Report for session child-bounded-4444/);
      expect(out.value.blocked).toBe(false);
      expect(out.value.source).toBe("marker");
      expect(out.opens).toBeLessThanOrEqual(BOUND * 2);
      expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(true);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );

  it(
    "entries under the count bound but over the byte budget are read only up to the budget and the child's report is not captured",
    async () => {
      setUpDelegation(true);
      plantLargeLinks(reportsDir, "z-large-", ".json", largeJsonBody({ sessionId: "other" }));
      const out = await counted(runChild);
      expect(out.value.blocked).toBe(true);
      expect(out.value.stderr).toMatch(
        /holds more than 32 MiB of report data, more than the gate reads; remove .*; the report for session child-bounded-4444 was not captured/,
      );
      expect(out.value.stderr).not.toMatch(/captured the Understanding Report/);
      expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(false);
      // Three readers list the reports directory on this call (the evidence
      // read, the delegation lookup, the auto-approval precondition), each
      // within its own budget.
      expect(out.bytes).toBeLessThanOrEqual(3 * ONE_READER_MAX_BYTES);
    },
    PLANTED_DIR_TEST_TIMEOUT_MS,
  );
});
