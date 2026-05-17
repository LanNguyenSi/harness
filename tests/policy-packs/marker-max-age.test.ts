import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkApprovalMarker,
  parseApprovalLifecycle,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-max-age-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("checkApprovalMarker — max_age freshness (agent-tasks/d8ee60ca)", () => {
  it("returns matched=true when the marker is fresh (within max_age)", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "op",
    });
    const result = checkApprovalMarker(generatedDir, "sess-1", {
      maxAgeMs: 4 * 60 * 60 * 1000,
      now: new Date("2026-05-17T10:00:00Z"), // 2h old
    });
    expect(result.matched).toBe(true);
    expect(result.detail).toMatch(/approved via marker/);
  });

  it("returns matched=false when the marker is older than max_age", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2026-05-17T08:00:00Z",
      approvedBy: "op",
    });
    const result = checkApprovalMarker(generatedDir, "sess-1", {
      maxAgeMs: 4 * 60 * 60 * 1000,
      now: new Date("2026-05-17T13:00:00Z"), // 5h old
    });
    expect(result.matched).toBe(false);
    expect(result.detail).toMatch(/expired/);
    expect(result.detail).toMatch(/age 300m > max 240m/);
  });

  it("treats a marker with unparseable approvedAt as fresh (defensive)", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "not-a-date",
      approvedBy: "op",
    });
    const result = checkApprovalMarker(generatedDir, "sess-1", {
      maxAgeMs: 1000,
      now: new Date(),
    });
    // marker exists, approvedAt is non-empty string so marker is set,
    // but Date.parse returns NaN → freshness skipped, matched=true.
    expect(result.matched).toBe(true);
  });

  it("returns matched=true with no max_age set (legacy contract)", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    writeApprovalMarker(generatedDir, "sess-1", {
      approvedAt: "2020-01-01T00:00:00Z",
      approvedBy: "op",
    });
    // Ancient marker, no maxAgeMs option set: still matched.
    const result = checkApprovalMarker(generatedDir, "sess-1");
    expect(result.matched).toBe(true);
  });
});

describe("parseApprovalLifecycle (agent-tasks/d8ee60ca)", () => {
  function noopStderr(): { lines: string[]; write: (s: string) => void } {
    const lines: string[] = [];
    return { lines, write: (s: string) => lines.push(s) };
  }

  it("returns default lifecycle when config is absent", () => {
    const lc = parseApprovalLifecycle(undefined, null);
    expect(lc.expireOnToolMatch).toEqual([]);
    expect(lc.maxAgeMs).toBeUndefined();
    expect(lc.legacyMode).toBe(false);
  });

  it("returns legacyMode=true when mode = session", () => {
    const lc = parseApprovalLifecycle({ mode: "session" }, null);
    expect(lc.legacyMode).toBe(true);
    expect(lc.expireOnToolMatch).toEqual([]);
  });

  it("parses expire_on_tool_match and max_age", () => {
    const lc = parseApprovalLifecycle(
      {
        expire_on_tool_match: ["A", "B"],
        max_age: "4h",
      },
      null,
    );
    expect(lc.expireOnToolMatch).toEqual(["A", "B"]);
    expect(lc.maxAgeMs).toBe(4 * 60 * 60 * 1000);
    expect(lc.legacyMode).toBe(false);
  });

  it("warns and skips a malformed max_age", () => {
    const err = noopStderr();
    const lc = parseApprovalLifecycle({ max_age: "not-a-duration" }, err);
    expect(lc.maxAgeMs).toBeUndefined();
    expect(err.lines.some((l) => l.includes("max_age ignored"))).toBe(true);
  });

  it("warns and skips a non-array expire_on_tool_match", () => {
    const err = noopStderr();
    const lc = parseApprovalLifecycle({ expire_on_tool_match: "task_finish" }, err);
    expect(lc.expireOnToolMatch).toEqual([]);
    expect(err.lines.some((l) => l.includes("expire_on_tool_match ignored"))).toBe(true);
  });

  it("drops non-string entries from expire_on_tool_match without throwing", () => {
    const lc = parseApprovalLifecycle(
      { expire_on_tool_match: ["valid", 123, null, "another"] },
      null,
    );
    expect(lc.expireOnToolMatch).toEqual(["valid", "another"]);
  });
});
