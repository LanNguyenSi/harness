// `harness approve understanding` against planted entries in the reports
// directory (agent-tasks 1ccfe922). The directory is writable by the gated
// agent, so an oversized report, a FIFO or a symlink must make the operator
// command refuse, naming the file, within a bound: no marker, no ledger tag,
// no report flip, and never a crash from reading the entry in full.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveUnderstanding,
  rewriteReportApproved,
} from "../../src/cli/approve/understanding.js";
import { EX_FAIL, HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  APPROVAL_MARKER_DIRNAME,
  MAX_HASHED_REPORT_BYTES,
  canonicalReportHash,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest } from "../../src/schema/index.js";

// A pass-through of the runtime module whose reader, hasher and listing a test
// can replace for one call site, so the races that need a swap between two
// reads of the same path (listing, validation re-read, final hash) are
// reproducible: the real reads inside the module itself are never replaced,
// only the ones approve makes through its import.
const overrides = vi.hoisted(() => ({
  read: null as null | ((filePath: string, opts?: { noFollow?: boolean }) => unknown),
  hash: null as null | ((filePath: string, opts?: { noFollow?: boolean }) => unknown),
  list: null as null | ((dir: string, opts?: { refuseSymlinks?: boolean }) => unknown),
}));

vi.mock("../../src/policy-packs/builtin/understanding-before-execution-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/policy-packs/builtin/understanding-before-execution-runtime.js")
    >();
  return {
    ...actual,
    readReportFileBounded: (filePath: string, opts?: { noFollow?: boolean }) =>
      overrides.read !== null ? overrides.read(filePath, opts) : actual.readReportFileBounded(filePath, opts),
    hashReportFile: (filePath: string, opts?: { noFollow?: boolean }) =>
      overrides.hash !== null ? overrides.hash(filePath, opts) : actual.hashReportFile(filePath, opts),
    listPersistedReportsBoundedWithSkips: (dir: string, opts?: { refuseSymlinks?: boolean }) =>
      overrides.list !== null
        ? overrides.list(dir, opts)
        : actual.listPersistedReportsBoundedWithSkips(dir, opts),
  };
});

// The unmocked module, for the tests that let a call through once and fail the next.
const actualRuntime = await vi.importActual<
  typeof import("../../src/policy-packs/builtin/understanding-before-execution-runtime.js")
>("../../src/policy-packs/builtin/understanding-before-execution-runtime.js");
const realHashReportFile = actualRuntime.hashReportFile;
const realList = actualRuntime.listPersistedReportsBoundedWithSkips;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_JS = path.join(REPO_ROOT, "dist", "cli", "main.js");

const SESSION = "sess-planted";
const OVER_CAP = " ".repeat(2 * 1024 * 1024);
// Far past anything a read-in-full could survive; created sparse, so it
// costs no disk, and only a bounded reader finishes quickly.
const SPARSE_BYTES = 400 * 1024 * 1024;

let tmp: string;
let reportsDir: string;
let generatedDir: string;
let outsideDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-planted-"));
  reportsDir = path.join(tmp, "reports");
  generatedDir = path.join(tmp, "harness.generated");
  outsideDir = path.join(tmp, "outside");
  for (const d of [reportsDir, outsideDir]) fs.mkdirSync(d, { recursive: true });
  savedEnv = {};
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  overrides.read = null;
  overrides.hash = null;
  overrides.list = null;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function pendingBody(createdAt: string): Record<string, unknown> {
  return {
    sessionId: SESSION,
    approvalStatus: "pending",
    createdAt,
    content: "the understanding the operator reviewed",
  };
}

function writeValidReport(name = "r1.json"): string {
  const full = path.join(reportsDir, name);
  fs.writeFileSync(full, JSON.stringify(pendingBody("2026-05-07T07:00:00.000Z")));
  return full;
}

function sparse(file: string, bytes: number): void {
  const fd = fs.openSync(file, "w");
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/** Plant one hostile entry; returns its path inside the reports directory. */
interface Plant {
  name: string;
  plant: () => string;
  /** What the refusal says about the entry. */
  reason: RegExp;
}

const PLANTS: Plant[] = [
  {
    name: "a 2 MiB report that is valid JSON for the session",
    plant: () => {
      const p = path.join(reportsDir, "zz-oversized.json");
      fs.writeFileSync(p, JSON.stringify(pendingBody("2026-05-07T07:59:00.000Z")) + OVER_CAP);
      return p;
    },
    reason: new RegExp(`over the ${MAX_HASHED_REPORT_BYTES}-byte cap`),
  },
  {
    name: "a 2 MiB file that is not JSON at all",
    plant: () => {
      const p = path.join(reportsDir, "zz-junk.json");
      fs.writeFileSync(p, "x".repeat(2 * 1024 * 1024));
      return p;
    },
    reason: /over the \d+-byte cap/,
  },
  {
    name: "a sparse 400 MiB file",
    plant: () => {
      const p = path.join(reportsDir, "zz-huge.json");
      sparse(p, SPARSE_BYTES);
      return p;
    },
    reason: /over the \d+-byte cap/,
  },
  {
    name: "a FIFO",
    plant: () => {
      const p = path.join(reportsDir, "zz-fifo.json");
      execFileSync("mkfifo", [p]);
      return p;
    },
    reason: /not a regular file/,
  },
  {
    name: "a directory named like a report",
    plant: () => {
      const p = path.join(reportsDir, "zz-dir.json");
      fs.mkdirSync(p);
      return p;
    },
    reason: /not a regular file/,
  },
  {
    name: "a symlink to an outside, in-cap report for the session",
    plant: () => {
      const target = path.join(outsideDir, "real.json");
      fs.writeFileSync(target, JSON.stringify(pendingBody("2026-05-07T07:59:00.000Z")));
      const p = path.join(reportsDir, "zz-link.json");
      fs.symlinkSync(target, p);
      return p;
    },
    reason: /symbolic link/,
  },
  {
    name: "a symlink to an outside sparse 400 MiB file",
    plant: () => {
      const target = path.join(outsideDir, "huge");
      sparse(target, SPARSE_BYTES);
      const p = path.join(reportsDir, "zz-link-huge.json");
      fs.symlinkSync(target, p);
      return p;
    },
    reason: /symbolic link/,
  },
  {
    name: "a symlink to a FIFO",
    plant: () => {
      const target = path.join(outsideDir, "pipe");
      execFileSync("mkfifo", [target]);
      const p = path.join(reportsDir, "zz-link-fifo.json");
      fs.symlinkSync(target, p);
      return p;
    },
    reason: /symbolic link/,
  },
];

function markerFiles(): string[] {
  try {
    return fs.readdirSync(path.join(generatedDir, APPROVAL_MARKER_DIRNAME));
  } catch {
    return [];
  }
}

describe("approveUnderstanding with a planted reports-directory entry", () => {
  it.each(PLANTS)(
    "refuses naming the file, within a bound, and writes nothing: $name",
    async (plant) => {
      const valid = writeValidReport();
      const validBefore = fs.readFileSync(valid, "utf8");
      const planted = plant.plant();
      const ledgerCalls: string[] = [];

      const started = Date.now();
      let thrown: unknown;
      try {
        await approveUnderstanding({
          manifest: parseManifest({ version: 1 }),
          session: SESSION,
          reportsDir,
          generatedDir,
          now: new Date("2026-05-07T08:00:00Z"),
          approvedBy: "test-suite",
          ledgerAdd: async (sessionId, content) => {
            ledgerCalls.push(`${sessionId}:${content}`);
            return { ok: true };
          },
        });
      } catch (err) {
        thrown = err;
      }
      const elapsedMs = Date.now() - started;

      expect(thrown, "approve must refuse").toBeInstanceOf(HarnessExitError);
      const err = thrown as HarnessExitError;
      expect(err.exitCode).toBe(EX_FAIL);
      expect(err.message).toContain(planted);
      expect(err.message).toMatch(plant.reason);
      expect(elapsedMs).toBeLessThan(5_000);
      expect(markerFiles()).toEqual([]);
      expect(ledgerCalls).toEqual([]);
      expect(fs.readFileSync(valid, "utf8")).toBe(validBefore);
    },
    15_000,
  );

  it("--force does not override the refusal", async () => {
    writeValidReport();
    const planted = PLANTS[0]!.plant();
    await expect(
      approveUnderstanding({
        manifest: parseManifest({ version: 1 }),
        session: SESSION,
        reportsDir,
        generatedDir,
        force: true,
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(planted);
    expect(markerFiles()).toEqual([]);
  });

  it("refuses when the session id would come from the newest-report fallback", async () => {
    writeValidReport();
    const planted = PLANTS.find((p) => p.name === "a FIFO")!.plant();
    await expect(
      approveUnderstanding({
        manifest: parseManifest({ version: 1 }),
        reportsDir,
        generatedDir,
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(planted);
    expect(markerFiles()).toEqual([]);
  });

  it("a regular in-cap report still signs a marker bound to its canonical hash", async () => {
    const valid = writeValidReport();
    const body = pendingBody("2026-05-07T07:00:00.000Z");
    const result = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      now: new Date("2026-05-07T08:00:00Z"),
      approvedBy: "test-suite",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.marker.ok).toBe(true);
    expect(result.persistedReport.ok).toBe(true);
    if (!result.marker.ok) return;
    const marker = JSON.parse(fs.readFileSync(result.marker.filePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(marker["reportContentHash"]).toBe(canonicalReportHash(body));
    expect((JSON.parse(fs.readFileSync(valid, "utf8")) as Record<string, unknown>)["approvalStatus"]).toBe(
      "approved",
    );
  });
});

describe("rewriteReportApproved reads by path through the bounded reader", () => {
  it("refuses an oversized report instead of re-reading it in full", () => {
    const p = path.join(reportsDir, "swapped.json");
    fs.writeFileSync(p, JSON.stringify(pendingBody("2026-05-07T07:00:00.000Z")) + OVER_CAP);
    const before = fs.readFileSync(p, "utf8");
    expect(() =>
      rewriteReportApproved(p, "2026-05-07T08:00:00.000Z", "test-suite", SESSION),
    ).toThrow(/over the \d+-byte cap/);
    expect(fs.readFileSync(p, "utf8")).toBe(before);
  });
});

describe("harness approve understanding (built CLI) with a planted entry", () => {
  it.each([PLANTS[0]!, PLANTS[2]!, PLANTS[3]!, PLANTS[5]!])(
    "exits non-zero within the bound, names the file, writes no marker: $name",
    (plant) => {
      const configPath = path.join(tmp, "harness.yaml");
      fs.writeFileSync(configPath, "version: 1\n");
      writeValidReport();
      const planted = plant.plant();
      const childEnv = { ...process.env };
      for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID"]) {
        delete childEnv[k];
      }
      childEnv["HARNESS_HOME"] = path.join(tmp, "home");
      childEnv["UNDERSTANDING_GATE_REPORT_DIR"] = reportsDir;

      const started = Date.now();
      const run = spawnSync(
        "node",
        [MAIN_JS, "approve", "understanding", "--session", SESSION, "--config", configPath],
        { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: childEnv },
      );
      const elapsedMs = Date.now() - started;

      expect((run.error as NodeJS.ErrnoException | undefined)?.code).not.toBe("ETIMEDOUT");
      expect(run.status).toBe(EX_FAIL);
      expect(run.stderr).toContain(planted);
      expect(run.stderr).toMatch(plant.reason);
      expect(elapsedMs).toBeLessThan(20_000);
      expect(markerFiles()).toEqual([]);
      expect(fs.existsSync(path.join(tmp, "harness.generated", APPROVAL_MARKER_DIRNAME))).toBe(false);
    },
    45_000,
  );
});

describe("approveUnderstanding when a report changes between its reads", () => {
  const TOO_LARGE = {
    ok: false as const,
    reason: "too-large" as const,
    detail: "2097152 bytes, over the 1048576-byte cap for hashing its content",
  };

  async function approve(
    force: boolean,
    ledgerCalls: string[],
  ): ReturnType<typeof approveUnderstanding> {
    return approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      now: new Date("2026-05-07T08:00:00Z"),
      approvedBy: "test-suite",
      ...(force ? { force: true } : {}),
      ledgerAdd: async (sessionId, content) => {
        ledgerCalls.push(`${sessionId}:${content}`);
        return { ok: true };
      },
    });
  }

  it.each([false, true])(
    "the validation re-read fails (swapped for an oversized file, force=%s): validation is enforced, no marker, no ledger call",
    async (force) => {
      const valid = writeValidReport();
      const before = fs.readFileSync(valid, "utf8");
      const reads: Array<{ filePath: string; noFollow: boolean | undefined }> = [];
      overrides.read = (filePath, opts) => {
        reads.push({ filePath, noFollow: opts?.noFollow });
        return TOO_LARGE;
      };
      const ledgerCalls: string[] = [];

      const result = await approve(force, ledgerCalls);

      expect(reads).toEqual([{ filePath: valid, noFollow: true }]);
      expect(result.validation).toMatchObject({ ok: false, field: "report", enforced: true });
      expect(result.marker.ok).toBe(false);
      expect(result.persistedReport.ok).toBe(false);
      expect(markerFiles()).toEqual([]);
      expect(ledgerCalls).toEqual([]);
      expect(fs.readFileSync(valid, "utf8")).toBe(before);
    },
  );

  it.each([
    ["too-large", TOO_LARGE],
    ["not-regular", { ok: false as const, reason: "not-regular" as const, detail: "not a regular file" }],
    ["unreadable", { ok: false as const, reason: "unreadable" as const, detail: "could not be read (EIO)" }],
    ["grew", { ok: false as const, reason: "grew" as const, detail: "grew while being read" }],
  ])(
    "the validation hash fails with %s: enforced under --force, no marker, no ledger call",
    async (_reason, failure) => {
      writeValidReport();
      overrides.hash = () => failure;
      const ledgerCalls: string[] = [];

      const result = await approve(true, ledgerCalls);

      expect(result.validation).toMatchObject({ ok: false, field: "report", enforced: true });
      expect(markerFiles()).toEqual([]);
      expect(ledgerCalls).toEqual([]);
    },
  );

  it("a report swapped for an oversized file after validation is refused under --force, before any write", async () => {
    const valid = writeValidReport();
    const before = fs.readFileSync(valid, "utf8");
    const hashCalls: Array<{ noFollow: boolean | undefined }> = [];
    overrides.hash = (filePath, opts) => {
      hashCalls.push({ noFollow: opts?.noFollow });
      return hashCalls.length === 1 ? realHashReportFile(filePath, opts) : TOO_LARGE;
    };
    const ledgerCalls: string[] = [];

    let thrown: unknown;
    try {
      await approve(true, ledgerCalls);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HarnessExitError);
    expect((thrown as HarnessExitError).exitCode).toBe(EX_FAIL);
    expect((thrown as HarnessExitError).message).toContain(valid);
    expect(hashCalls).toEqual([{ noFollow: true }, { noFollow: true }]);
    expect(markerFiles()).toEqual([]);
    expect(ledgerCalls).toEqual([]);
    expect(fs.readFileSync(valid, "utf8")).toBe(before);
  });

  it("--force still signs an unbound marker for a content reason (a report nested too deeply)", async () => {
    writeValidReport();
    overrides.hash = (_filePath, _opts) => ({
      ok: false,
      reason: "too-deep",
      detail: "nested too deeply to hash its content",
    });
    const ledgerCalls: string[] = [];

    const result = await approve(true, ledgerCalls);

    expect(result.validation).toMatchObject({ ok: false, field: "report", enforced: false });
    expect(result.marker.ok).toBe(true);
    if (!result.marker.ok) return;
    const marker = JSON.parse(fs.readFileSync(result.marker.filePath, "utf8")) as Record<string, unknown>;
    expect(marker["reportContentHash"]).toBeNull();
  });

  it("a report content failure without --force is still refused", async () => {
    writeValidReport();
    overrides.hash = () => ({ ok: false, reason: "too-deep", detail: "nested too deeply to hash its content" });
    const ledgerCalls: string[] = [];

    const result = await approve(false, ledgerCalls);

    expect(result.validation).toMatchObject({ ok: false, field: "report", enforced: true });
    expect(markerFiles()).toEqual([]);
  });

  it("an entry planted between the two listings is refused, naming it", async () => {
    writeValidReport();
    const late = path.join(reportsDir, "late-planted.json");
    const listOpts: Array<{ refuseSymlinks: boolean | undefined }> = [];
    overrides.list = (dir, opts) => {
      listOpts.push({ refuseSymlinks: opts?.refuseSymlinks });
      const real = realList(dir, opts);
      if (listOpts.length < 2) return real;
      return {
        reports: real.reports,
        skipped: [{ filePath: late, reason: "too-large", detail: TOO_LARGE.detail }],
      };
    };
    const ledgerCalls: string[] = [];

    let thrown: unknown;
    try {
      await approve(false, ledgerCalls);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HarnessExitError);
    expect((thrown as HarnessExitError).message).toContain(late);
    expect(markerFiles()).toEqual([]);
    expect(ledgerCalls).toEqual([]);
  });

  it("both listings refuse symbolic links", async () => {
    writeValidReport();
    const listOpts: Array<{ refuseSymlinks: boolean | undefined }> = [];
    overrides.list = (dir, opts) => {
      listOpts.push({ refuseSymlinks: opts?.refuseSymlinks });
      return realList(dir, opts);
    };

    const result = await approve(false, []);

    expect(result.marker.ok).toBe(true);
    expect(listOpts).toEqual([{ refuseSymlinks: true }, { refuseSymlinks: true }]);
  });
});

describe("approveUnderstanding renders a hostile file name safely", () => {
  // ESC (OSC 52 clipboard write, a line erase), BEL, CR and LF (a forged
  // line), DEL and a C1 control (U+009B is a one-byte CSI on some terminals).
  const HOSTILE =
    "\u001b]52;c;ZWNobyBwd25lZA==\u0007\u001b[2K\rmarker: OK fake\nline2\u007f\u009b.json";

  function rawControlCodes(text: string): number[] {
    return [...text]
      .map((ch) => ch.charCodeAt(0))
      .filter((c) => (c < 0x20 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f));
  }

  it("the refusal names the entry as an escaped literal: no raw control byte, no forged line", async () => {
    writeValidReport();
    const planted = path.join(reportsDir, HOSTILE);
    sparse(planted, 2 * 1024 * 1024);

    let thrown: unknown;
    try {
      await approveUnderstanding({
        manifest: parseManifest({ version: 1 }),
        session: SESSION,
        reportsDir,
        generatedDir,
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HarnessExitError);
    const message = (thrown as HarnessExitError).message;
    expect(rawControlCodes(message)).toEqual([]);
    expect(message).toContain("\\u001b]52;c;ZWNobyBwd25lZA==\\u0007\\u001b[2K\\rmarker: OK fake\\nline2\\u007f\\u009b.json");
    // The LF inside the name did not start a line of its own.
    expect(message.split("\n").some((l) => l.startsWith("line2") || l.startsWith("marker: OK"))).toBe(false);
    expect(markerFiles()).toEqual([]);
  });

  it("the parse-error path in the no-report reason is escaped too", async () => {
    const parseErrorsDir = path.join(tmp, "parse-errors");
    fs.mkdirSync(parseErrorsDir, { recursive: true });
    const hostileLog = path.join(parseErrorsDir, `${SESSION}-${HOSTILE.replace(/\.json$/, "")}.log`);
    fs.writeFileSync(hostileLog, JSON.stringify({ sessionId: SESSION, message: "rejected" }));
    const result = await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir,
      generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    const reason = result.persistedReport.ok ? "" : result.persistedReport.reason;
    expect(reason).toMatch(/latest parse-error at /);
    expect(reason).toContain("\\u001b]52;c;ZWNobyBwd25lZA==");
    expect(rawControlCodes(reason)).toEqual([]);
  });
});
