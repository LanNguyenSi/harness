// The no-O_NOFOLLOW fallback of readRegularFileRejectingSymlink (Windows:
// fs.constants has no O_NOFOLLOW / O_NONBLOCK there). Without the flag the
// open alone would follow a link, so the reader must still refuse a symlink
// and a non-regular node through an lstat before it opens. The module reads
// the constants once at load, so this file mocks fs.constants and imports
// the module fresh.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { O_NOFOLLOW: _nofollow, O_NONBLOCK: _nonblock, ...constants } = actual.constants;
  return { ...actual, constants };
});

const { readRegularFileRejectingSymlink } = await import("../../src/io/read-regular-file.js");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "read-regular-file-no-nofollow-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readRegularFileRejectingSymlink without O_NOFOLLOW / O_NONBLOCK", () => {
  it("the mock really removes the flags", () => {
    expect(fs.constants.O_NOFOLLOW).toBeUndefined();
    expect(fs.constants.O_NONBLOCK).toBeUndefined();
  });

  it("still reads a regular file", () => {
    const p = path.join(tmp, "marker.json");
    fs.writeFileSync(p, '{"a":1}', "utf8");
    expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "ok", content: '{"a":1}' });
  });

  it("still returns missing for an absent path", () => {
    expect(readRegularFileRejectingSymlink(path.join(tmp, "nope"))).toEqual({ kind: "missing" });
  });

  it("still refuses a symlink that points at a regular file", () => {
    const target = path.join(tmp, "real.json");
    fs.writeFileSync(target, "{}", "utf8");
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(target, link);
    expect(readRegularFileRejectingSymlink(link)).toEqual({ kind: "symlink" });
  });

  it("still returns not-regular for a directory", () => {
    const dir = path.join(tmp, "a-dir");
    fs.mkdirSync(dir);
    expect(readRegularFileRejectingSymlink(dir)).toEqual({ kind: "not-regular" });
  });
});
