// Canonical report hash (task fa423e9b): the value an approval marker signs as
// `reportContentHash` and both PreToolUse hooks recompute at gate-read time.
// It must be invariant under everything the approval and expiry lifecycles
// rewrite, and sensitive to every content change.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReportHash,
  canonicalReportHashOfFile,
  hashReportFile,
  MAX_HASHED_REPORT_BYTES,
  readReportFileBounded,
  verifyApprovedReportHash,
  type MarkerReportBinding,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { walkContainerDepth } from "../../src/policy-packs/builtin/understanding-before-execution/persisted-reports.js";

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

describe("the depth walk queues containers only", () => {
  it("visits the root plus every array and object, never a scalar", () => {
    const value = { a: [1, 2, 3, "x", null, true], b: { c: [[]], d: "s" }, e: 0 };
    // root, a, b, c, the empty array inside c: five containers; seven scalars are never queued.
    expect(walkContainerDepth(value, 64)).toEqual({ tooDeep: false, visited: 5 });
  });

  it("a scalar-heavy report file under the size cap costs two visits, not one per element", () => {
    const elements = 400_000;
    const parsed = JSON.parse(`{"content":[${"0,".repeat(elements - 1)}0]}`) as Record<string, unknown>;
    expect((parsed["content"] as unknown[]).length).toBe(elements);
    expect(walkContainerDepth(parsed, 64)).toEqual({ tooDeep: false, visited: 2 });
  });

  it("keeps the depth cap: the report object is level 1, 64 levels pass and 65 do not", () => {
    expect(walkContainerDepth({ x: nestedArray(63) }, 64).tooDeep).toBe(false);
    expect(walkContainerDepth({ x: nestedArray(64) }, 64).tooDeep).toBe(true);
  });
});

describe("report files are read bounded by type and size", () => {
  /** A report file of exactly `bytes` bytes: `body` serialised, padded with JSON whitespace. */
  const writePadded = (name: string, body: Record<string, unknown>, bytes: number): string => {
    const json = JSON.stringify(body);
    const filePath = path.join(tmp, name);
    fs.writeFileSync(filePath, json + " ".repeat(bytes - Buffer.byteLength(json)));
    expect(fs.statSync(filePath).size).toBe(bytes);
    return filePath;
  };

  it("caps a hashed report file at 1 MiB, far above a real report", () => {
    expect(MAX_HASHED_REPORT_BYTES).toBe(1048576);
  });

  it("hashes a file of exactly the cap and refuses one byte more without reading it", () => {
    const atCap = writePadded("at-cap.json", base(), MAX_HASHED_REPORT_BYTES);
    expect(hashReportFile(atCap)).toEqual({ ok: true, hash: canonicalReportHash(base()) });
    const overCap = writePadded("over-cap.json", base(), MAX_HASHED_REPORT_BYTES + 1);
    expect(hashReportFile(overCap)).toEqual({
      ok: false,
      reason: "too-large",
      detail: "1048577 bytes, over the 1048576-byte cap for hashing its content",
    });
    expect(canonicalReportHashOfFile(overCap)).toBeNull();
    expect(readReportFileBounded(overCap)).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("hashes a wide but shallow array report within the cap", () => {
    const filePath = path.join(tmp, "wide.json");
    fs.writeFileSync(filePath, `{"content":[${"0,".repeat(400_000)}0]}`);
    expect(fs.statSync(filePath).size).toBeLessThan(MAX_HASHED_REPORT_BYTES);
    const hashed = hashReportFile(filePath);
    expect(hashed.ok).toBe(true);
    expect(hashed.ok && hashed.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses anything that is not a regular file, by the type of the opened descriptor", () => {
    const dir = path.join(tmp, "dir.json");
    fs.mkdirSync(dir);
    expect(hashReportFile(dir)).toEqual({ ok: false, reason: "not-regular", detail: "not a regular file" });
    const device = path.join(tmp, "device.json");
    fs.symlinkSync("/dev/null", device);
    expect(hashReportFile(device)).toEqual({ ok: false, reason: "not-regular", detail: "not a regular file" });
  });

  it("reports a path that cannot be opened as unreadable instead of throwing", () => {
    expect(readReportFileBounded(path.join(tmp, "missing.json"))).toEqual({
      ok: false,
      reason: "unreadable",
      detail: "could not be opened (ENOENT)",
    });
    fs.symlinkSync(path.join(tmp, "nowhere.json"), path.join(tmp, "dangling.json"));
    expect(hashReportFile(path.join(tmp, "dangling.json"))).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("noFollow refuses a symbolic link at the open, whatever it points at; the default still follows", () => {
    const target = path.join(tmp, "real.json");
    fs.writeFileSync(target, JSON.stringify(base()));
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(target, link);
    const refused = { ok: false, reason: "not-regular", detail: "a symbolic link, not a regular file" };
    expect(readReportFileBounded(link, { noFollow: true })).toEqual(refused);
    expect(hashReportFile(link, { noFollow: true })).toEqual(refused);
    expect(canonicalReportHashOfFile(link, { noFollow: true })).toBeNull();
    fs.symlinkSync(path.join(tmp, "nowhere.json"), path.join(tmp, "dangling-link.json"));
    expect(readReportFileBounded(path.join(tmp, "dangling-link.json"), { noFollow: true })).toEqual(refused);
    // Unchanged for every hook read: no option, or the option off, follows the link.
    expect(readReportFileBounded(link)).toMatchObject({ ok: true });
    expect(readReportFileBounded(link, { noFollow: false })).toMatchObject({ ok: true });
    expect(hashReportFile(link)).toEqual({ ok: true, hash: canonicalReportHash(base()) });
    // A regular file is read the same way with the option on.
    expect(hashReportFile(target, { noFollow: true })).toEqual({ ok: true, hash: canonicalReportHash(base()) });
  });

  it("names a JSON body that is not an object and one nested too deeply", () => {
    fs.writeFileSync(path.join(tmp, "arr.json"), "[1]");
    expect(hashReportFile(path.join(tmp, "arr.json"))).toEqual({
      ok: false,
      reason: "not-json-object",
      detail: "not a JSON object",
    });
    fs.writeFileSync(path.join(tmp, "deep.json"), `{"content":${"[".repeat(100)}${"]".repeat(100)}}`);
    expect(hashReportFile(path.join(tmp, "deep.json"))).toEqual({
      ok: false,
      reason: "too-deep",
      detail: "nested too deeply to hash its content",
    });
  });

  it("an oversized copy of the approved content keeps no match: residual (1) covers only files within the cap", () => {
    const signed = canonicalReportHash(base());
    const session: MarkerReportBinding = { kind: "session", reportContentHash: signed };
    writePadded("copy.json", { ...base(), approvalStatus: "approved" }, MAX_HASHED_REPORT_BYTES);
    expect(verifyApprovedReportHash(tmp, session)).toEqual({ ok: true, kind: "session" });
    fs.rmSync(path.join(tmp, "copy.json"));
    writePadded("copy.json", { ...base(), approvalStatus: "approved" }, 2 * MAX_HASHED_REPORT_BYTES);
    expect(verifyApprovedReportHash(tmp, session).ok).toBe(false);
  });

  // The grew check and fstat-on-the-descriptor are defence in depth with no
  // deterministic test; closing the descriptor on every outcome is pinned here.
  it.runIf(fs.existsSync("/dev/fd"))("closes the descriptor on every outcome, success and refusal alike", () => {
    const ok = writePadded("ok.json", base(), 1024);
    const tooLarge = writePadded("big.json", base(), MAX_HASHED_REPORT_BYTES + 1);
    const notRegular = path.join(tmp, "dir.json");
    fs.mkdirSync(notRegular);
    fs.writeFileSync(path.join(tmp, "arr.json"), "[1]");
    fs.writeFileSync(path.join(tmp, "deep.json"), `{"content":${"[".repeat(100)}${"]".repeat(100)}}`);
    const inputs = [ok, tooLarge, notRegular, path.join(tmp, "arr.json"), path.join(tmp, "deep.json")];
    const openDescriptors = (): number => fs.readdirSync("/dev/fd").length;
    const before = openDescriptors();
    for (let round = 0; round < 50; round++) for (const input of inputs) hashReportFile(input);
    expect(openDescriptors()).toBe(before);
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

  it("is ok when the directory has no *.json entry at all (missing, empty, or only non-json names)", () => {
    expect(verifyApprovedReportHash(path.join(tmp, "missing"), session("deadbeef"))).toEqual({
      ok: true,
      kind: "session",
    });
    expect(verifyApprovedReportHash(tmp, session("deadbeef"))).toEqual({ ok: true, kind: "session" });
    fs.writeFileSync(path.join(tmp, "notes.txt"), "x");
    fs.mkdirSync(path.join(tmp, "subdir"));
    expect(verifyApprovedReportHash(tmp, session("deadbeef"))).toEqual({ ok: true, kind: "session" });
  });

  it.each([
    ["a directory", (p: string): void => fs.mkdirSync(p)],
    ["a symlink to a device", (p: string): void => fs.symlinkSync("/dev/null", p)],
    ["a dangling symlink", (p: string): void => fs.symlinkSync(path.join(tmp, "nowhere"), p)],
    ["a file over the size cap", (p: string): void => fs.writeFileSync(p, `{}${" ".repeat(MAX_HASHED_REPORT_BYTES)}`)],
  ])("every *.json entry counts as a report file: %s named *.json, alone, matches nothing and denies", (_kind, plant) => {
    plant(path.join(tmp, "only.json"));
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base())))).toMatchObject({ ok: false });
    // Next to the untouched approved report the same entry changes nothing.
    writeReport("zz-mine.json", approved());
    expect(verifyApprovedReportHash(tmp, session(canonicalReportHash(base())))).toEqual({
      ok: true,
      kind: "session",
    });
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
