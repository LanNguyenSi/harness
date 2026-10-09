// Deterministic, uid-independent coverage of the `unreadable` kind: the
// chmod-000 variant in read-regular-file.test.ts cannot assert under root
// (root reads regardless of mode), so this file force-throws the descriptor read
// via a call-through partial mock while lstatSync stays real. The reader
// reads through the opened descriptor with `readSync`, so that is the call
// forced to fail.

import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: vi.fn(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }),
  };
});

// Import AFTER the mock declaration so the modules resolve the mocked fs.
const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
const { readRegularFileBounded } = await import("../../src/io/read-regular-file.js");

function makeTmp(): string {
  return fsActual.mkdtempSync(path.join(os.tmpdir(), "read-unreadable-"));
}

describe("readRegularFileBounded — unreadable kind (read failure after good lstat)", () => {
  it("returns unreadable when the descriptor read throws on an existing regular file", () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, "marker.json");
      fsActual.writeFileSync(p, "{}", "utf8");
      expect(readRegularFileBounded(p)).toEqual({ kind: "unreadable" });
    } finally {
      fsActual.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
