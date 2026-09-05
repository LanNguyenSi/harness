import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvalMarkerPathFor,
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
    expect(result.expired).toBe(false);
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
    // `expired:true` (as opposed to a missing/never-approved marker) is
    // the signal task 6e888423's recovery-git-commit exemption keys off.
    expect(result.expired).toBe(true);
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
    expect(result.expired).toBe(false);
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
    expect(result.expired).toBe(false);
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

  // --- expire_on_bash_match (harness/f54e0ecb) ----------------------------

  it("defaults expire_on_bash_match to empty when absent", () => {
    const lc = parseApprovalLifecycle({ expire_on_tool_match: ["A"] }, null);
    expect(lc.expireOnBashMatch).toEqual([]);
  });

  it("compiles expire_on_bash_match string[] to RegExp[]", () => {
    const lc = parseApprovalLifecycle(
      {
        expire_on_bash_match: ["^gh pr (merge|close)\\b", "^git push origin (master|main)\\b"],
      },
      null,
    );
    expect(lc.expireOnBashMatch).toHaveLength(2);
    expect(lc.expireOnBashMatch[0]?.test("gh pr merge 42")).toBe(true);
    expect(lc.expireOnBashMatch[0]?.test("git status")).toBe(false);
    expect(lc.expireOnBashMatch[1]?.test("git push origin master")).toBe(true);
  });

  it("warns and skips a non-array expire_on_bash_match", () => {
    const err = noopStderr();
    const lc = parseApprovalLifecycle({ expire_on_bash_match: "^gh pr merge" }, err);
    expect(lc.expireOnBashMatch).toEqual([]);
    expect(err.lines.some((l) => l.includes("expire_on_bash_match ignored"))).toBe(true);
  });

  it("drops empty and non-string entries from expire_on_bash_match", () => {
    const lc = parseApprovalLifecycle(
      { expire_on_bash_match: ["valid", "", 123, null, "^also-valid"] },
      null,
    );
    expect(lc.expireOnBashMatch).toHaveLength(2);
    expect(lc.expireOnBashMatch[0]?.source).toBe("valid");
    expect(lc.expireOnBashMatch[1]?.source).toBe("^also-valid");
  });

  it("warns on an invalid regex pattern but keeps the others", () => {
    const err = noopStderr();
    const lc = parseApprovalLifecycle(
      { expire_on_bash_match: ["[unclosed-character-class", "^gh pr merge\\b"] },
      err,
    );
    expect(lc.expireOnBashMatch).toHaveLength(1);
    expect(lc.expireOnBashMatch[0]?.source).toBe("^gh pr merge\\b");
    expect(err.lines.some((l) => l.includes("expire_on_bash_match entry ignored"))).toBe(true);
  });

  it("legacy mode (mode: session) zeroes both lists", () => {
    const lc = parseApprovalLifecycle(
      {
        mode: "session",
        expire_on_tool_match: ["A"],
        expire_on_bash_match: ["^gh"],
      },
      null,
    );
    expect(lc.legacyMode).toBe(true);
    expect(lc.expireOnToolMatch).toEqual([]);
    expect(lc.expireOnBashMatch).toEqual([]);
  });

  it("mode: session keeps max_age as a TTL safety net (task 496660c5)", () => {
    // Before this fix, the mode-session branch returned early and never
    // looked at max_age at all, so `{ mode: "session", max_age: "4h" }`
    // silently dropped the TTL — a session-scoped install had no way to
    // force re-approval on a schedule.
    const lc = parseApprovalLifecycle({ mode: "session", max_age: "4h" }, null);
    expect(lc.legacyMode).toBe(true);
    expect(lc.maxAgeMs).toBe(4 * 60 * 60 * 1000);
    expect(lc.expireOnToolMatch).toEqual([]);
    expect(lc.expireOnBashMatch).toEqual([]);
  });

  it("mode: session warns on an invalid max_age exactly like the boundary-lifecycle branch", () => {
    const err = noopStderr();
    const lc = parseApprovalLifecycle(
      { mode: "session", max_age: "not-a-duration" },
      err,
    );
    expect(lc.legacyMode).toBe(true);
    expect(lc.maxAgeMs).toBeUndefined();
    expect(err.lines.some((l) => l.includes("max_age ignored"))).toBe(true);
  });

  it("mode: session's invalid-max_age warning is byte-identical to the boundary branch's, not merely similar (task 496660c5 review finding)", () => {
    // Both branches call the same `parseMaxAge` helper on the same
    // invalid input; this pins that the two call sites produce the
    // EXACT same stderr line, not just a matching substring. A future
    // change that special-cases one branch's wording (e.g. naming
    // "mode: session" in the warning) would pass every other test in
    // this file yet break this one.
    const sessionErr = noopStderr();
    parseApprovalLifecycle({ mode: "session", max_age: "not-a-duration" }, sessionErr);
    const boundaryErr = noopStderr();
    parseApprovalLifecycle({ max_age: "not-a-duration" }, boundaryErr);
    expect(sessionErr.lines).toEqual(boundaryErr.lines);
  });
});

describe("approvalMarkerPathFor — sessionId validation (H5)", () => {
  it("rejects a traversal-shaped sessionId (../../etc)", () => {
    expect(() => approvalMarkerPathFor("/tmp/gen", "../../etc")).toThrow(
      /path-separator or traversal/,
    );
  });

  it("rejects a sessionId with a forward slash (a/b)", () => {
    expect(() => approvalMarkerPathFor("/tmp/gen", "a/b")).toThrow(
      /path-separator or traversal/,
    );
  });

  it("rejects a sessionId that is only (..)", () => {
    expect(() => approvalMarkerPathFor("/tmp/gen", "..")).toThrow(
      /path-separator or traversal/,
    );
  });

  it("rejects an empty sessionId", () => {
    expect(() => approvalMarkerPathFor("/tmp/gen", "")).toThrow(/empty or blank/);
  });

  it("rejects a whitespace-only sessionId", () => {
    expect(() => approvalMarkerPathFor("/tmp/gen", "   ")).toThrow(/empty or blank/);
  });

  it("passes a valid UUID-style sessionId and returns the expected path", () => {
    const result = approvalMarkerPathFor(
      "/tmp/gen",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result).toBe("/tmp/gen/.approvals/a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("gate read path fails CLOSED on a malformed sessionId (returns matched:false, does not throw)", () => {
    // The gate must block (matched:false), not throw out of the hook, which
    // the top-level handler would turn into a non-blocking exit that lets the
    // gated tool proceed. Regression guard for the read-path fail-open.
    expect(() => checkApprovalMarker("/tmp/gen", "../../etc")).not.toThrow();
    const result = checkApprovalMarker("/tmp/gen", "../../etc");
    expect(result.matched).toBe(false);
    expect(result.detail).toMatch(/invalid sessionId/);
  });
});
