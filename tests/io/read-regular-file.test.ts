import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// `vi.spyOn` cannot target `fs.readFileSync` directly: Node's builtin
// module namespace is non-configurable in ESM ("Cannot redefine
// property"), the same limitation
// tests/policy-packs/understanding-before-execution-delegation.test.ts's
// own header documents for `readRegularFileRejectingSymlink`. `vi.mock`
// with a call-through wrapper is the established workaround: it records
// every `readFileSync` call so the probe test below can assert zero.
const readFileSyncCallLog = vi.hoisted(() => ({
  calls: 0,
  openFlags: [] as number[],
  readSyncCalls: 0,
  // When set, `readSync` throws (a read failure after a good open and fstat).
  failReadSync: false,
  // When set, `fstatSync` reports this size for a descriptor's stats, as if
  // the file had been smaller when the size check ran than when it is read.
  fstatSizeOverride: null as number | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const flags = args[1];
      if (typeof flags === "number") readFileSyncCallLog.openFlags.push(flags);
      return actual.openSync(...args);
    }) as typeof actual.openSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncCallLog.calls += 1;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      readFileSyncCallLog.readSyncCalls += 1;
      if (readFileSyncCallLog.failReadSync) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
      return actual.readSync(...args);
    }) as typeof actual.readSync,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      const st = actual.fstatSync(...args);
      const size = readFileSyncCallLog.fstatSizeOverride;
      if (size === null || !("size" in st)) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size });
    }) as typeof actual.fstatSync,
  };
});

import {
  MAX_REGULAR_FILE_READ_BYTES,
  probePathPresence,
  readRegularFileRejectingSymlink,
} from "../../src/io/read-regular-file.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILT_READER = path.join(REPO_ROOT, "dist", "io", "read-regular-file.js");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-regular-file-"));
  readFileSyncCallLog.failReadSync = false;
  readFileSyncCallLog.fstatSizeOverride = null;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readRegularFileRejectingSymlink", () => {
  it("returns ok + utf8 content for a regular file", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, '{"a":1}', "utf8");
    expect(readRegularFileRejectingSymlink(p)).toEqual({
      kind: "ok",
      content: '{"a":1}',
    });
  });

  it("returns missing for an absent path", () => {
    expect(readRegularFileRejectingSymlink(path.join(tmp, "nope"))).toEqual({
      kind: "missing",
    });
  });

  it("REJECTS a symlink even when it points at a regular file (agent-tasks/d39f160e)", () => {
    const target = path.join(tmp, "real.json");
    fs.writeFileSync(target, "{}", "utf8");
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(target, link);
    expect(readRegularFileRejectingSymlink(link)).toEqual({ kind: "symlink" });
  });

  it("returns not-regular for a directory", () => {
    const dir = path.join(tmp, "a-dir");
    fs.mkdirSync(dir);
    expect(readRegularFileRejectingSymlink(dir)).toEqual({
      kind: "not-regular",
    });
  });

  it("returns unreadable when the file exists but the read fails", () => {
    const p = path.join(tmp, "no-read.json");
    fs.writeFileSync(p, "{}", "utf8");
    fs.chmodSync(p, 0o000);
    // Root can read regardless of mode; skip the assertion there so CI
    // containers running as root do not false-fail.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "unreadable" });
  });
});

describe("readRegularFileRejectingSymlink: one descriptor, never a blocking open", () => {
  it("opens read-only with O_NOFOLLOW and O_NONBLOCK (where the platform has them)", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    readFileSyncCallLog.openFlags.length = 0;
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "ok", content: "{}" });
    expect(readFileSyncCallLog.openFlags).toHaveLength(1);
    const flags = readFileSyncCallLog.openFlags[0] as number;
    expect(flags & fs.constants.O_ACCMODE).toBe(fs.constants.O_RDONLY);
    expect(flags & (fs.constants.O_NONBLOCK ?? 0)).toBe(fs.constants.O_NONBLOCK ?? 0);
    expect(flags & (fs.constants.O_NOFOLLOW ?? 0)).toBe(fs.constants.O_NOFOLLOW ?? 0);
    // Guards the two checks above against a platform where both are 0.
    expect(flags & (fs.constants.O_NOCTTY ?? 0)).toBe(fs.constants.O_NOCTTY ?? 0);
    if (process.platform !== "win32") {
      expect(fs.constants.O_NONBLOCK).toBeGreaterThan(0);
      expect(fs.constants.O_NOFOLLOW).toBeGreaterThan(0);
      expect(fs.constants.O_NOCTTY).toBeGreaterThan(0);
    }
  });

  it("returns missing when a parent path component is a regular file (ENOTDIR)", () => {
    const file = path.join(tmp, "plain.json");
    fs.writeFileSync(file, "{}", "utf8");
    expect(readRegularFileRejectingSymlink(path.join(file, "child"))).toEqual({ kind: "missing" });
  });

  it("returns symlink for a dangling symlink", () => {
    const link = path.join(tmp, "dangling.json");
    fs.symlinkSync(path.join(tmp, "never-created.json"), link);
    expect(readRegularFileRejectingSymlink(link)).toEqual({ kind: "symlink" });
  });
});

describe("readRegularFileRejectingSymlink: size bound", () => {
  it("reads a file of exactly the cap in full", () => {
    const p = path.join(tmp, "at-cap.json");
    const body = "a".repeat(MAX_REGULAR_FILE_READ_BYTES);
    fs.writeFileSync(p, body, "utf8");
    const read = readRegularFileRejectingSymlink(p);
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" && read.content === body).toBe(true);
  });

  it("refuses a file one byte over the cap as unreadable", () => {
    const p = path.join(tmp, "over-cap.json");
    fs.writeFileSync(p, "a".repeat(MAX_REGULAR_FILE_READ_BYTES + 1), "utf8");
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "unreadable" });
  });

  it("refuses a 2 GiB sparse file at once, without reading a byte of it", () => {
    const p = path.join(tmp, "sparse.json");
    fs.writeFileSync(p, "");
    fs.truncateSync(p, 2 * 1024 * 1024 * 1024);
    readFileSyncCallLog.readSyncCalls = 0;
    const started = Date.now();
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "unreadable" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSyncCallLog.readSyncCalls).toBe(0);
  });

  it("stops reading one byte past the cap when fstat reported a small size (a file that grew)", () => {
    const p = path.join(tmp, "grown.json");
    fs.writeFileSync(p, "a".repeat(3 * MAX_REGULAR_FILE_READ_BYTES), "utf8");
    readFileSyncCallLog.fstatSizeOverride = 10;
    readFileSyncCallLog.readSyncCalls = 0;
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "unreadable" });
    // 64 KiB chunks, the last one cut to cap + 1: 17 reads, never the 48 a
    // read to EOF would take.
    expect(readFileSyncCallLog.readSyncCalls).toBeGreaterThan(0);
    expect(readFileSyncCallLog.readSyncCalls).toBeLessThanOrEqual(
      Math.ceil((MAX_REGULAR_FILE_READ_BYTES + 1) / (64 * 1024)),
    );
  });

  it("returns unreadable when the read itself fails", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    readFileSyncCallLog.failReadSync = true;
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "unreadable" });
  });
});

// The descriptor is released on every outcome. The count of open descriptors
// is measured through /dev/fd, which lists the descriptors of this process
// (the directory read itself holds one, the same one before and after), so a
// reader that leaked one per call would show up as a growing count.
describe.skipIf(process.platform === "win32")("readRegularFileRejectingSymlink: the descriptor is closed", () => {
  const CALLS = 25;

  function openDescriptorCount(): number {
    return fs.readdirSync("/dev/fd").length;
  }

  function leakedBy(call: () => unknown): number {
    call(); // warm any lazily opened internal descriptor first
    const before = openDescriptorCount();
    for (let i = 0; i < CALLS; i++) call();
    return openDescriptorCount() - before;
  }

  it("ok", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    expect(leakedBy(() => expect(readRegularFileRejectingSymlink(p).kind).toBe("ok"))).toBe(0);
  });

  it("not-regular (a directory)", () => {
    const dir = path.join(tmp, "a-dir");
    fs.mkdirSync(dir);
    expect(leakedBy(() => expect(readRegularFileRejectingSymlink(dir).kind).toBe("not-regular"))).toBe(0);
  });

  it("not-regular (a FIFO with no writer)", () => {
    const fifo = path.join(tmp, "marker.fifo");
    execFileSync("mkfifo", [fifo]);
    expect(leakedBy(() => expect(readRegularFileRejectingSymlink(fifo).kind).toBe("not-regular"))).toBe(0);
  });

  it("unreadable (over the cap)", () => {
    const p = path.join(tmp, "sparse.json");
    fs.writeFileSync(p, "");
    fs.truncateSync(p, 2 * 1024 * 1024 * 1024);
    expect(leakedBy(() => expect(readRegularFileRejectingSymlink(p).kind).toBe("unreadable"))).toBe(0);
  });

  it("unreadable (the read fails)", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    readFileSyncCallLog.failReadSync = true;
    expect(leakedBy(() => expect(readRegularFileRejectingSymlink(p).kind).toBe("unreadable"))).toBe(0);
  });

  it("the counter really counts: an unclosed descriptor shows up", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    const held: number[] = [];
    try {
      expect(leakedBy(() => held.push(fs.openSync(p, "r")))).toBe(CALLS);
    } finally {
      for (const fd of held) fs.closeSync(fd);
    }
  });
});

// A FIFO with no writer makes a blocking open() wait forever, so the reader
// runs in a child process here: the measurement is "returned within the
// bound", and a regression shows up as a killed child, not a hung test
// worker. The child loads the built module, so `npm run build` must have
// run against the current sources first (same prerequisite as the hook
// subprocess suites).
describe.skipIf(process.platform === "win32")(
  "readRegularFileRejectingSymlink: FIFO at the path is refused without blocking",
  () => {
    const BOUND_MS = 10_000;

    function readInChild(target: string): { timedOut: boolean; ms: number; stdout: string; stderr: string } {
      const started = Date.now();
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(pathToFileURL(BUILT_READER).href)});` +
            "process.stdout.write(JSON.stringify(m.readRegularFileRejectingSymlink(process.argv[1])));",
          target,
        ],
        { encoding: "utf8", timeout: BOUND_MS, killSignal: "SIGKILL" },
      );
      return {
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
        ms: Date.now() - started,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    it("a FIFO with no writer returns not-regular within the bound", () => {
      const fifo = path.join(tmp, "marker.fifo");
      execFileSync("mkfifo", [fifo]);
      const run = readInChild(fifo);
      expect(run.timedOut).toBe(false);
      expect(run.ms).toBeLessThan(BOUND_MS);
      expect(JSON.parse(run.stdout)).toEqual({ kind: "not-regular" });
    });

    it("a symlink to a FIFO returns symlink within the bound", () => {
      const fifo = path.join(tmp, "marker.fifo");
      execFileSync("mkfifo", [fifo]);
      const link = path.join(tmp, "link.json");
      fs.symlinkSync(fifo, link);
      const run = readInChild(link);
      expect(run.timedOut).toBe(false);
      expect(run.ms).toBeLessThan(BOUND_MS);
      expect(JSON.parse(run.stdout)).toEqual({ kind: "symlink" });
    });
  },
);

describe("probePathPresence", () => {
  it("returns present for a regular file", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    expect(probePathPresence(p)).toEqual({ kind: "present" });
  });

  it("returns present for a resolvable symlink", () => {
    const target = path.join(tmp, "real.json");
    fs.writeFileSync(target, "{}", "utf8");
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(target, link);
    expect(probePathPresence(link)).toEqual({ kind: "present" });
  });

  it("returns present for a dangling symlink", () => {
    const link = path.join(tmp, "dangling.json");
    fs.symlinkSync(path.join(tmp, "never-created.json"), link);
    expect(probePathPresence(link)).toEqual({ kind: "present" });
  });

  it("returns present for a directory", () => {
    const dir = path.join(tmp, "a-dir");
    fs.mkdirSync(dir);
    expect(probePathPresence(dir)).toEqual({ kind: "present" });
  });

  it("returns missing for an absent path", () => {
    expect(probePathPresence(path.join(tmp, "nope"))).toEqual({ kind: "missing" });
  });

  it("never reads the file's bytes", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, "{}", "utf8");
    const before = readFileSyncCallLog.calls;
    expect(probePathPresence(p)).toEqual({ kind: "present" });
    expect(readFileSyncCallLog.calls).toBe(before);
  });
});
