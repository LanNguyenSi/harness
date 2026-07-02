// Deterministic, uid-independent coverage of the `unreadable` kind: the
// chmod-000 variant in read-regular-file.test.ts cannot assert under root
// (root reads regardless of mode), so this file force-throws readFileSync
// via a call-through partial mock while lstatSync stays real.

import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }),
  };
});

// Import AFTER the mock declaration so the modules resolve the mocked fs.
const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
const { readRegularFileRejectingSymlink } = await import("../../src/io/read-regular-file.js");
const { checkApprovalMarker } = await import(
  "../../src/policy-packs/builtin/understanding-before-execution-runtime.js"
);

function makeTmp(): string {
  return fsActual.mkdtempSync(path.join(os.tmpdir(), "read-unreadable-"));
}

describe("readRegularFileRejectingSymlink — unreadable kind (read failure after good lstat)", () => {
  it("returns unreadable when readFileSync throws on an existing regular file", () => {
    const tmp = makeTmp();
    try {
      const p = path.join(tmp, "marker.json");
      fsActual.writeFileSync(p, "{}", "utf8");
      expect(readRegularFileRejectingSymlink(p)).toEqual({ kind: "unreadable" });
    } finally {
      fsActual.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gate semantic: an existing-but-unreadable approval marker still SATISFIES the gate", () => {
    const tmp = makeTmp();
    try {
      const markerDir = path.join(tmp, ".approvals");
      fsActual.mkdirSync(markerDir, { recursive: true });
      fsActual.writeFileSync(
        path.join(markerDir, "sess-unreadable"),
        '{"approvedAt":"2026-07-02T00:00:00.000Z","approvedBy":"operator"}',
        "utf8",
      );
      const r = checkApprovalMarker(tmp, "sess-unreadable");
      expect(r.matched).toBe(true);
      expect(r.marker).toBeNull();
      expect(r.detail).toMatch(/body unreadable/);
    } finally {
      fsActual.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
