import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readRegularFileRejectingSymlink } from "../../src/io/read-regular-file.js";

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
