import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `vi.spyOn` cannot target `fs.readFileSync` directly: Node's builtin
// module namespace is non-configurable in ESM ("Cannot redefine
// property"), the same limitation
// tests/policy-packs/understanding-before-execution-delegation.test.ts's
// own header documents for `readRegularFileRejectingSymlink`. `vi.mock`
// with a call-through wrapper is the established workaround: it records
// every `readFileSync` call so the probe test below can assert zero.
const readFileSyncCallLog = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncCallLog.calls += 1;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

import { probePathPresence, readRegularFileRejectingSymlink } from "../../src/io/read-regular-file.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-regular-file-"));
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
