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

describe("verifyApprovedReportHash", () => {
  const approved = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...base(),
    sessionId: SESSION,
    approvalStatus: "approved",
    ...extra,
  });

  it("is ok for a null marker hash whatever the report says", () => {
    writeReport("r.json", approved({ currentUnderstanding: "anything" }));
    expect(verifyApprovedReportHash(tmp, SESSION, null)).toEqual({ ok: true });
  });

  it("is ok when the approved report hashes to the marker's hash", () => {
    writeReport("r.json", approved());
    expect(verifyApprovedReportHash(tmp, SESSION, canonicalReportHash(base()))).toEqual({ ok: true });
  });

  it("denies a differing approved report with a reason naming the file and the fix", () => {
    const filePath = writeReport("r.json", approved({ currentUnderstanding: "swapped" }));
    const result = verifyApprovedReportHash(tmp, SESSION, canonicalReportHash(base()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.filePath).toBe(filePath);
      expect(result.detail).toBe(
        "approved report r.json does not match the content the approval marker was signed for; re-run `harness approve understanding`",
      );
    }
  });

  it("is ok when there is no report, or the selected report is not approved", () => {
    expect(verifyApprovedReportHash(tmp, SESSION, "deadbeef")).toEqual({ ok: true });
    writeReport("r.json", approved({ approvalStatus: "pending", currentUnderstanding: "swapped" }));
    expect(verifyApprovedReportHash(tmp, SESSION, "deadbeef")).toEqual({ ok: true });
    writeReport("e.json", approved({ approvalStatus: "expired", createdAt: "2026-10-02T00:00:00.000Z" }));
    expect(verifyApprovedReportHash(tmp, SESSION, "deadbeef")).toEqual({ ok: true });
  });

  it("looks only at the report selected for the session, not at another session's approved report", () => {
    writeReport("other.json", approved({ sessionId: "sess-other", currentUnderstanding: "swapped" }));
    expect(verifyApprovedReportHash(tmp, SESSION, canonicalReportHash(base()))).toEqual({ ok: true });
  });
});
