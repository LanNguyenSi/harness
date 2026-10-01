// Canonical report hash (task fa423e9b): the value an approval marker signs as
// `reportContentHash` and both PreToolUse hooks recompute at gate-read time.
// It must be invariant under everything the approval and expiry lifecycles
// rewrite, and sensitive to every content change.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewriteReportApproved } from "../../src/cli/approve/understanding.js";
import {
  canonicalReportHash,
  canonicalReportHashOfFile,
  expirePersistedReport,
  verifyApprovedReportHash,
  type MarkerReportBinding,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";

const SESSION = "sess-canonical";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-canonical-hash-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = (): Record<string, unknown> => ({
  createdAt: "2026-10-01T10:00:00.000Z",
  mode: "grill_me",
  currentUnderstanding: "what the operator reviewed",
  priorArt: ["searched; nothing exists", "second line"],
  nested: { b: 1, a: { y: 2, x: 3 } },
});

function writeReport(name: string, body: Record<string, unknown>): string {
  const filePath = path.join(tmp, name);
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
  return filePath;
}

describe("canonicalReportHash", () => {
  it("is a stable sha256 hex digest", () => {
    expect(canonicalReportHash(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalReportHash(base())).toBe(canonicalReportHash(base()));
  });

  it("does not depend on key order at any depth", () => {
    const reordered = {
      nested: { a: { x: 3, y: 2 }, b: 1 },
      priorArt: ["searched; nothing exists", "second line"],
      currentUnderstanding: "what the operator reviewed",
      mode: "grill_me",
      createdAt: "2026-10-01T10:00:00.000Z",
    };
    expect(canonicalReportHash(reordered)).toBe(canonicalReportHash(base()));
  });

  it("does not depend on key order inside objects nested in arrays", () => {
    const withArrayObjects = (first: Record<string, unknown>): Record<string, unknown> => ({
      ...base(),
      sections: [first, { y: 2, z: { q: 1, p: 2 } }],
    });
    const forward = withArrayObjects({ a: 1, b: 2 });
    // `forward` is [{a,b}, {y, z:{q,p}}]; `reordered` lists the same values with every object's keys in another order.
    const reordered = {
      ...base(),
      sections: [{ b: 2, a: 1 }, { z: { p: 2, q: 1 }, y: 2 }],
    };
    expect(canonicalReportHash(reordered)).toBe(canonicalReportHash(forward));
    // Array ORDER still matters.
    expect(canonicalReportHash({ ...base(), sections: [{ y: 2, z: { q: 1, p: 2 } }, { a: 1, b: 2 }] })).not.toBe(
      canonicalReportHash(forward),
    );
  });

  it.each([
    ["approvalStatus", "approved"],
    ["approvedAt", "2026-10-01T10:05:00.000Z"],
    ["approvedBy", "operator"],
    ["expiredAt", "2026-10-01T11:00:00.000Z"],
    ["expiredBy", "tool:mcp__agent-tasks__task_finish"],
    ["sessionId", SESSION],
  ])("ignores the lifecycle field %s", (field, value) => {
    expect(canonicalReportHash({ ...base(), [field]: value })).toBe(canonicalReportHash(base()));
  });

  it("changes when a content field changes, is added, removed, or an array is reordered", () => {
    const h = canonicalReportHash(base());
    expect(canonicalReportHash({ ...base(), currentUnderstanding: "swapped" })).not.toBe(h);
    expect(canonicalReportHash({ ...base(), extra: true })).not.toBe(h);
    const { mode: _mode, ...withoutMode } = base();
    expect(canonicalReportHash(withoutMode)).not.toBe(h);
    expect(canonicalReportHash({ ...base(), priorArt: ["second line", "searched; nothing exists"] })).not.toBe(h);
    expect(canonicalReportHash({ ...base(), nested: { b: 1, a: { y: 2, x: 4 } } })).not.toBe(h);
  });

  it("keeps a `__proto__` key as data instead of re-parenting the copy", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":1},"a":1}') as Record<string, unknown>;
    expect(canonicalReportHash(parsed)).not.toBe(canonicalReportHash({ a: 1 }));
  });

  it("survives the approval rewrite and a later expiry rewrite of the file", () => {
    const filePath = writeReport("r.json", { ...base(), approvalStatus: "pending" });
    const pendingHash = canonicalReportHashOfFile(filePath);
    expect(pendingHash).toBe(canonicalReportHash(base()));

    rewriteReportApproved(filePath, "2026-10-01T10:05:00.000Z", "operator", SESSION);
    expect(canonicalReportHashOfFile(filePath)).toBe(pendingHash);

    const expired = expirePersistedReport(tmp, SESSION, new Date(), "tool:x");
    expect(expired.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))["approvalStatus"]).toBe("expired");
    expect(canonicalReportHashOfFile(filePath)).toBe(pendingHash);

    // Re-approving an expired report drops the expiry stamp; still the same hash.
    rewriteReportApproved(filePath, "2026-10-01T12:00:00.000Z", "operator", SESSION);
    expect(canonicalReportHashOfFile(filePath)).toBe(pendingHash);
  });
});

describe("canonicalReportHashOfFile", () => {
  it("is null for a missing file, unparseable JSON, and a non-object body", () => {
    expect(canonicalReportHashOfFile(path.join(tmp, "missing.json"))).toBeNull();
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    expect(canonicalReportHashOfFile(bad)).toBeNull();
    const arr = path.join(tmp, "arr.json");
    fs.writeFileSync(arr, "[]");
    expect(canonicalReportHashOfFile(arr)).toBeNull();
  });
});

/** A JSON array value nested `depth` levels deep, built from text: JSON.stringify cannot nest thousands of levels. */
const nestedArray = (depth: number): unknown => JSON.parse(`${"[".repeat(depth)}${"]".repeat(depth)}`);

describe("canonical hashing is total (deeply nested content)", () => {
  it("hashes a report nested 64 levels deep (the report object is level 1) and returns null one level deeper", () => {
    expect(canonicalReportHash({ ...base(), extra: nestedArray(63) })).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalReportHash({ ...base(), extra: nestedArray(64) })).toBeNull();
    expect(canonicalReportHash({ ...base(), extra: { a: { b: nestedArray(62) } } })).toBeNull();
    // A deeply nested lifecycle field is not hashed, so it does not count.
    expect(canonicalReportHash({ ...base(), approvedBy: nestedArray(200) })).toBe(canonicalReportHash(base()));
  });

  it("never throws for a report nested thousands of levels deep, in memory or on disk", () => {
    expect(() => canonicalReportHash({ ...base(), extra: nestedArray(6000) })).not.toThrow();
    expect(canonicalReportHash({ ...base(), extra: nestedArray(6000) })).toBeNull();
    const deep = path.join(tmp, "deep.json");
    fs.writeFileSync(deep, `{"content":${"[".repeat(6000)}${"]".repeat(6000)}}`);
    expect(() => canonicalReportHashOfFile(deep)).not.toThrow();
    expect(canonicalReportHashOfFile(deep)).toBeNull();
  });
});

describe("verifyApprovedReportHash", () => {
  const approved = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...base(),
    sessionId: SESSION,
    approvalStatus: "approved",
    ...extra,
  });
  const task = (hash: string | null): MarkerReportBinding => ({ kind: "task", reportContentHash: hash });
  const session = (hash: string | null): MarkerReportBinding => ({ kind: "session", reportContentHash: hash });
  const MISSING = "no report in the reports directory matches the content the";

  it("is ok for a null marker hash whatever the reports say", () => {
    writeReport("r.json", approved({ currentUnderstanding: "anything" }));
    expect(verifyApprovedReportHash(tmp, session(null))).toEqual({ ok: true, kind: "session" });
  });

  it("is ok when some report hashes to the marker's hash", () => {
    writeReport("r.json", approved());
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base())))).toEqual({
      ok: true,
      kind: "session",
    });
  });

  it("matches a report of ANY session and ANY approvalStatus (the hash excludes the lifecycle fields)", () => {
    writeReport("a.json", approved({ sessionId: "sess-other", approvalStatus: "expired" }));
    expect(verifyApprovedReportHash(tmp, task(canonicalReportHash(base())))).toEqual({ ok: true, kind: "task" });
  });

  it("denies when no report has the signed content, naming the marker kind and the fix, never a file", () => {
    writeReport("r.json", approved({ currentUnderstanding: "swapped" }));
    const result = verifyApprovedReportHash(tmp, task(canonicalReportHash(base())));
    expect(result).toEqual({
      ok: false,
      detail:
        "no report in the reports directory matches the content the task approval marker was signed for " +
        "(the approved report was changed or removed after approval); re-run `harness approve understanding`",
    });
    const sessionResult = verifyApprovedReportHash(tmp, session(canonicalReportHash(base())));
    expect(sessionResult.ok === false && sessionResult.detail).toContain(`${MISSING} session approval marker was signed for`);
  });

  it("finds the signed content among many other reports", () => {
    for (let i = 0; i < 25; i += 1) writeReport(`other-${i}.json`, approved({ currentUnderstanding: `other ${i}` }));
    writeReport("mine.json", approved());
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base())))).toEqual({
      ok: true,
      kind: "session",
    });
  });

  it("denies when report files exist but none parses to the signed content (unparseable rewrite)", () => {
    fs.writeFileSync(path.join(tmp, "r.json"), '{ "currentUnderstanding": "swapped", ');
    expect(verifyApprovedReportHash(tmp, session("deadbeef")).ok).toBe(false);
    fs.writeFileSync(path.join(tmp, "r.json"), "[]");
    expect(verifyApprovedReportHash(tmp, session("deadbeef")).ok).toBe(false);
  });

  it("is ok when the directory has no report file at all (missing, empty, or only non-json files)", () => {
    expect(verifyApprovedReportHash(path.join(tmp, "missing"), session("deadbeef"))).toEqual({
      ok: true,
      kind: "session",
    });
    expect(verifyApprovedReportHash(tmp, session("deadbeef"))).toEqual({ ok: true, kind: "session" });
    fs.writeFileSync(path.join(tmp, "notes.txt"), "x");
    fs.mkdirSync(path.join(tmp, "dir.json"));
    expect(verifyApprovedReportHash(tmp, session("deadbeef"))).toEqual({ ok: true, kind: "session" });
  });

  it("falls back to the fallback binding when the primary content is gone", () => {
    writeReport("mine.json", approved());
    const mine = canonicalReportHash(base());
    expect(verifyApprovedReportHash(tmp, task("deadbeef"), session(mine))).toEqual({ ok: true, kind: "session" });
    // The primary wins when both verify.
    expect(verifyApprovedReportHash(tmp, task(mine), session(mine))).toEqual({ ok: true, kind: "task" });
  });

  it("accepts a null-hash fallback without reading any report", () => {
    writeReport("r.json", approved());
    expect(verifyApprovedReportHash(tmp, task("deadbeef"), session(null))).toEqual({ ok: true, kind: "session" });
  });

  it("denies naming both kinds when neither binding verifies", () => {
    writeReport("r.json", approved());
    const result = verifyApprovedReportHash(tmp, task("aaaa"), session("bbbb"));
    expect(result.ok === false && result.detail).toContain(
      `${MISSING} task and session approval markers were signed for`,
    );
  });

  it("pinned residual: any *.json file with the approved content keeps a match, kept before the edit or re-created after it", () => {
    const original = writeReport("r.json", approved());
    fs.copyFileSync(original, path.join(tmp, "copy.json"));
    writeReport("r.json", approved({ currentUnderstanding: "swapped" }));
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base())))).toEqual({
      ok: true,
      kind: "session",
    });
    // Re-created after the edit, under another session and status, with no copy kept.
    fs.rmSync(path.join(tmp, "copy.json"));
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base()))).ok).toBe(false);
    writeReport("re-created.json", approved({ sessionId: "sess-other", approvalStatus: "pending" }));
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base())))).toEqual({
      ok: true,
      kind: "session",
    });
  });

  it("a deeply nested *.json file in the directory is a file that matches nothing: never throws, never opens the gate on its own", () => {
    fs.writeFileSync(path.join(tmp, "aa-deep.json"), `{"content":${"[".repeat(6000)}${"]".repeat(6000)}}`);
    const signed = canonicalReportHash(base());
    // Only the deep file: report files exist, none carries the signed content.
    expect(() => verifyApprovedReportHash(tmp, session(signed))).not.toThrow();
    expect(verifyApprovedReportHash(tmp, session(signed)).ok).toBe(false);
    // Next to the untouched approved report: still a match.
    writeReport("zz-mine.json", approved());
    expect(verifyApprovedReportHash(tmp, session(signed))).toEqual({ ok: true, kind: "session" });
  });
});
