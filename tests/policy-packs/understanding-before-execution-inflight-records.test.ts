// Subagent-gate slice 1 (docs/decisions/2026-08-27-ug-auto-mode-approval.md
// "Invariants", "Threat model", "Delegation marker shape"): the signed
// in-flight record and its dedicated verifier. Every fixture below uses a
// real temp generatedDir and a real signing key created through the
// existing operator-side helper, so a "valid" record here is valid in
// exactly the sense a future PreToolUse consumer will check.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperatorMarkerApproval } from "../../src/policy-packs/builtin/understanding-before-execution/task-markers.js";
import {
  DEFAULT_INFLIGHT_STALE_AFTER_MS,
  INFLIGHT_RECORD_DIRNAME,
  clearInflightRecord,
  inflightMarkerIdFor,
  inflightRecordPathFor,
  listInflightRecords,
  rejectMalformedAgentId,
  verifyInflightRecord,
  writeInflightRecord,
} from "../../src/policy-packs/builtin/understanding-before-execution/inflight-records.js";
import { getOrCreateSigningKey, signingKeyPathFor, signMarker } from "../../src/runtime/approval-signing.js";

const SESSION = "sess-0000-1111";
const AGENT = "agent-abc123";

/**
 * Whether the filesystem backing `os.tmpdir()` folds case (macOS's
 * default APFS volume; not Linux ext4). Probed once at module load
 * rather than per-test: the case-variant fixture below only exercises
 * `verifyInflightRecord`'s exact-name check when the underlying path
 * lookup would otherwise resolve a differently-cased request to the same
 * file, so on a case-sensitive filesystem the test is skipped rather
 * than asserted trivially (the request would already miss the file with
 * or without the fix, proving nothing).
 */
const CASE_INSENSITIVE_FS: boolean = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-case-probe-"));
  try {
    fs.writeFileSync(path.join(probeDir, "CaseProbe"), "x");
    return fs.existsSync(path.join(probeDir, "caseprobe"));
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

let tmp: string;
let generatedDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-inflight-"));
  generatedDir = path.join(tmp, "harness.generated");
  // Real key, same as the delegation test suite: a "valid" record here is
  // valid against the exact signing/verification path a consumer uses.
  getOrCreateSigningKey(generatedDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function matchedParent(
  source: "task" | "session" = "session",
  detail = "approved via marker sess-0000-1111",
): OperatorMarkerApproval {
  return { matched: true, source, detail, taskCheckDetail: detail, expired: false, forged: false };
}

function unmatchedParent(): OperatorMarkerApproval {
  return {
    matched: false,
    source: null,
    detail: "no approval marker",
    taskCheckDetail: "no approval marker",
    expired: false,
    forged: false,
  };
}

describe("inflightRecordPathFor: id validation", () => {
  it("builds the expected path for well-formed ids", () => {
    const p = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    expect(p).toBe(path.join(generatedDir, INFLIGHT_RECORD_DIRNAME, SESSION, AGENT));
  });

  it("rejects a malformed sessionId (path separator)", () => {
    expect(() => inflightRecordPathFor(generatedDir, "../escape", AGENT)).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() => inflightRecordPathFor(generatedDir, "", AGENT)).toThrow();
  });

  it("rejects an empty agentId", () => {
    expect(() => rejectMalformedAgentId("")).toThrow();
  });

  it("rejects a literal '.' agentId", () => {
    expect(() => rejectMalformedAgentId(".")).toThrow();
  });

  it("rejects a literal '..' agentId", () => {
    expect(() => rejectMalformedAgentId("..")).toThrow();
  });

  it("rejects an agentId with a leading dot", () => {
    expect(() => rejectMalformedAgentId(".hidden")).toThrow();
  });

  it("rejects an agentId containing a forward slash", () => {
    expect(() => rejectMalformedAgentId("a/b")).toThrow();
  });

  it("rejects an agentId containing a backslash", () => {
    expect(() => rejectMalformedAgentId("a\\b")).toThrow();
  });

  it("rejects an agentId containing a control character", () => {
    expect(() => rejectMalformedAgentId("a\u0000b")).toThrow();
  });

  it("rejects an agentId longer than 128 characters", () => {
    expect(() => rejectMalformedAgentId("a".repeat(129))).toThrow();
  });

  it("accepts an agentId exactly 128 characters long", () => {
    expect(() => rejectMalformedAgentId("a".repeat(128))).not.toThrow();
  });
});

describe("writeInflightRecord", () => {
  it("refuses, writing nothing, when the parent is not matched", () => {
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: unmatchedParent(),
    });
    expect(result).toMatchObject({ ok: false, reason: "parent_not_approved" });
    expect(fs.existsSync(inflightRecordPathFor(generatedDir, SESSION, AGENT))).toBe(false);
  });

  it("writes an atomic, mode-0600 record when the parent is matched (session source)", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent("session"),
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const stat = fs.statSync(result.filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    const body = JSON.parse(fs.readFileSync(result.filePath, "utf8"));
    expect(body).toMatchObject({
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      startedAt: now.toISOString(),
      parentSource: "session",
      approvedBy: "inflight:general-purpose:parent=session",
      reportContentHash: null,
      alg: "hmac-sha256-v1",
    });
    expect(typeof body.signature).toBe("string");
    expect(body.signature.length).toBeGreaterThan(0);
  });

  it("writes parentSource: task when the parent matched via a task marker", () => {
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent("task", "task-scoped marker for active-claim t-1"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const body = JSON.parse(fs.readFileSync(result.filePath, "utf8"));
    expect(body.parentSource).toBe("task");
    expect(body.approvedBy).toBe("inflight:general-purpose:parent=task");
  });

  it("the written record verifies as matched", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(true);
    expect(check.forged).toBe(false);
    expect(check.stale).toBe(false);
    expect(check.detail).toContain(AGENT);
  });
});

describe("verifyInflightRecord", () => {
  it("missing file: matched false, forged false", () => {
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check).toMatchObject({ matched: false, forged: false, stale: false });
  });

  it("symlink at the record path: matched false, detail names it", () => {
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const target = path.join(tmp, "elsewhere.json");
    fs.writeFileSync(target, "{}");
    fs.symlinkSync(target, filePath);
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
    expect(check.detail).toContain("symlink");
  });

  it("a directory sitting at the record path: matched false, detail names it as not a regular file", () => {
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    fs.mkdirSync(filePath, { recursive: true });
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
    expect(check.detail).toContain("not a regular file");
  });

  it("unparsable body: matched false, forged false", () => {
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not json{{{");
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check).toMatchObject({ matched: false, forged: false, stale: false });
  });

  it("a tampered body (signature no longer verifies) is rejected as forged", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    body.approvedBy = "inflight:general-purpose:parent=task"; // tamper one field the signature covers
    fs.writeFileSync(filePath, JSON.stringify(body));
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("a record moved onto a different agent id's path (body unchanged) fails as forged", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });
    const original = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    const movedTo = inflightRecordPathFor(generatedDir, SESSION, "agent-different");
    fs.copyFileSync(original, movedTo);
    const check = verifyInflightRecord(generatedDir, SESSION, "agent-different", { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("body sessionId/agentId edited in place (signature still verifies) is caught by the path-agreement check", () => {
    // Distinct from the "moved" fixture above: the file STAYS at its
    // original, correct path, so the signature (computed over the
    // markerId derived from the REQUESTED ids, which still match the
    // path) verifies fine. Only the explicit body-vs-path equality
    // check catches this: it is the only thing that catches this exact
    // forgery shape, independent of the signature check above.
    const now = new Date("2026-09-05T09:00:00.000Z");
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    body.agentId = "agent-claims-to-be-someone-else";
    fs.writeFileSync(filePath, JSON.stringify(body));
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("a record 25h old (default 24h window) is stale, not matched", () => {
    const startedAt = new Date("2026-09-04T09:00:00.000Z");
    const now = new Date(startedAt.getTime() + 25 * 60 * 60 * 1000);
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now: startedAt,
    });
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
    expect(check.stale).toBe(true);
  });

  it("a record 23h old (default 24h window) is fresh, matched", () => {
    const startedAt = new Date("2026-09-04T09:00:00.000Z");
    const now = new Date(startedAt.getTime() + 23 * 60 * 60 * 1000);
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now: startedAt,
    });
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(true);
    expect(check.stale).toBe(false);
  });

  it("honours a custom staleAfterMs override", () => {
    const startedAt = new Date("2026-09-04T09:00:00.000Z");
    const now = new Date(startedAt.getTime() + 90 * 60 * 1000); // 90 minutes later
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now: startedAt,
    });
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now, staleAfterMs: 60 * 60 * 1000 });
    expect(check.matched).toBe(false);
    expect(check.stale).toBe(true);
  });

  it("recomputes the markerId from the REQUESTED ids, not from anything in the body: a hand-signed record for a different markerId fails as forged", () => {
    const signed = signMarker(generatedDir, inflightMarkerIdFor(SESSION, "some-other-agent"), {
      approvedAt: new Date().toISOString(),
      approvedBy: "inflight:general-purpose:parent=session",
      reportContentHash: null,
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: "general-purpose", ...signed }),
    );
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("an aged record with a refreshed unsigned startedAt is not matched (forged), not silently revived", () => {
    const signedAt = new Date("2026-09-04T09:00:00.000Z"); // 25h before `now` below
    const now = new Date(signedAt.getTime() + 25 * 60 * 60 * 1000);
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now: signedAt,
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Only the UNSIGNED convenience copy is edited; the signed
    // `approvedAt` (and its signature) stay at the original, now-aged
    // instant.
    body.startedAt = now.toISOString();
    fs.writeFileSync(filePath, JSON.stringify(body));
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("a signed approvedAt more than 5 minutes in the future is not matched", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    const approvedAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes ahead
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now: approvedAt,
    });
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
    expect(check.stale).toBe(true);
    expect(check.detail).toContain("future");
  });

  it("a flipped parentSource in the body (signed approvedBy unchanged) is rejected as forged", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent("session"),
      now,
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    body.parentSource = "task"; // approvedBy still says "parent=session"
    fs.writeFileSync(filePath, JSON.stringify(body));
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("a foreign agentType in the body (signed approvedBy unchanged) is rejected as forged", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    body.agentType = "some-other-type"; // approvedBy still says "general-purpose"
    fs.writeFileSync(filePath, JSON.stringify(body));
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT, { now });
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(true);
  });

  it("a signing-key I/O failure is fail-closed but not classified as forged", () => {
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
    const keyPath = signingKeyPathFor(generatedDir);
    fs.rmSync(keyPath, { force: true });
    fs.mkdirSync(keyPath); // directory at the key's path: readFileSync throws EISDIR
    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
    expect(check.detail).toContain("could not be verified");
  });

  it("a symlinked .inflight/ root reads as no record, even holding a valid record (containment, mirrors listInflightRecords)", () => {
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    const inflightDir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME);
    const realDir = `${inflightDir}-real`;
    fs.renameSync(inflightDir, realDir);
    fs.symlinkSync(realDir, inflightDir);

    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
  });

  it("a symlinked SESSION directory reads as no record, even holding a valid record (containment applies to the session dir too, not just the root)", () => {
    // Same containment property as the root-symlink test above, but
    // pinned one level deeper: the lstat loop walks `[rootDir,
    // sessionDir]`, and a mutant that shrinks it to `[rootDir]` only
    // would still pass every other test in this file (none of them
    // symlinks the session directory specifically) while leaving this
    // exact escape open.
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    const sessionDir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME, SESSION);
    const realSessionDir = `${sessionDir}-real`;
    fs.renameSync(sessionDir, realSessionDir);
    fs.symlinkSync(realSessionDir, sessionDir);

    const check = verifyInflightRecord(generatedDir, SESSION, AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    "a case-variant sessionId is classified forged, not absent (asymmetric with the agentId case check, case-insensitive filesystem only)",
    () => {
      // Unlike the agentId segment (its own exact-entry check, see the
      // test above), the session segment inherits `path.join` +
      // `lstatSync`'s ordinary case-insensitive lookup: the lstat below
      // resolves the case-variant path to the SAME directory, so the
      // record is read and its signature is recomputed from the
      // REQUESTED (case-variant) sessionId — which the signed body never
      // matches. The outcome is fail-closed (never `matched: true`)
      // either way, just a less precise diagnostic than the agentId case
      // gets; see verifyInflightRecord's JSDoc on the exact-name check.
      writeInflightRecord({
        generatedDir,
        sessionId: "Sess-Mixed-Case",
        agentId: AGENT,
        agentType: "general-purpose",
        parent: matchedParent(),
      });
      const check = verifyInflightRecord(generatedDir, "sess-mixed-case", AGENT);
      expect(check.matched).toBe(false);
      expect(check.forged).toBe(true);
      // The exact-case request still matches, proving the record itself
      // is intact and it is specifically the case mismatch being caught.
      expect(verifyInflightRecord(generatedDir, "Sess-Mixed-Case", AGENT).matched).toBe(true);
    },
  );

  // Inverse of the test above (review T-003 R3 L4): on a CASE-SENSITIVE
  // filesystem a case-variant sessionId does not even resolve to the
  // same directory, so `sessionDir`'s lstat throws and the outcome is
  // the ordinary "no record" absence — never `forged`, unlike the
  // case-insensitive branch above where the lstat succeeds and the
  // mismatched signature is what trips `forged`. Skipped on this run
  // (macOS/APFS folds case), so it never actually executes here; the
  // fixture below pins the SAME lstat-throws-on-lookup code path on any
  // filesystem by using a sessionId that differs by more than case
  // (guaranteed not to collide under either case sensitivity), so the
  // "absent, not forged" outcome for an unresolvable session directory
  // is still exercised even where the case-sensitive branch itself is
  // skipped.
  it.skipIf(CASE_INSENSITIVE_FS)(
    "a case-variant sessionId reads as no record, never forged (case-sensitive filesystem only)",
    () => {
      writeInflightRecord({
        generatedDir,
        sessionId: "Sess-Mixed-Case",
        agentId: AGENT,
        agentType: "general-purpose",
        parent: matchedParent(),
      });
      const check = verifyInflightRecord(generatedDir, "sess-mixed-case", AGENT);
      expect(check.matched).toBe(false);
      expect(check.forged).toBe(false);
      expect(verifyInflightRecord(generatedDir, "Sess-Mixed-Case", AGENT).matched).toBe(true);
    },
  );

  it("an unresolvable sessionId (no matching directory under any case rule) reads as no record, never forged — pins the same lstat-throw branch the case-sensitive-FS test above exercises via case, run unconditionally since it does not depend on filesystem case sensitivity", () => {
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    // Differs by more than case (an entirely different token), so no
    // filesystem's case-folding rule could ever resolve this to the
    // written session directory: `sessionDir`'s lstat throws exactly the
    // way it would for a case-sensitive FS given a mere case variant.
    const check = verifyInflightRecord(generatedDir, "totally-different-session-id", AGENT);
    expect(check.matched).toBe(false);
    expect(check.forged).toBe(false);
    expect(verifyInflightRecord(generatedDir, SESSION, AGENT).matched).toBe(true);
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    "a case-variant agentId reads as no record, never forged (case-insensitive filesystem only)",
    () => {
      writeInflightRecord({
        generatedDir,
        sessionId: SESSION,
        agentId: "Agent-Mixed-Case",
        agentType: "general-purpose",
        parent: matchedParent(),
      });
      // Same session/leaf path once case-folded by the filesystem, but
      // NOT the exact directory entry `writeInflightRecord` created.
      const check = verifyInflightRecord(generatedDir, SESSION, "agent-mixed-case");
      expect(check.matched).toBe(false);
      expect(check.forged).toBe(false);
      expect(check.detail).toContain("no exact entry named");
      // The exact-case request still matches, proving the record itself
      // is intact and it is specifically the case mismatch being caught.
      expect(verifyInflightRecord(generatedDir, SESSION, "Agent-Mixed-Case").matched).toBe(true);
    },
  );
});

describe("writeInflightRecord: agentType validation", () => {
  it("refuses a malformed agentType, writing nothing", () => {
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "bad type!",
      parent: matchedParent(),
    });
    expect(result).toMatchObject({ ok: false, reason: "malformed_agent_type" });
    expect(fs.existsSync(inflightRecordPathFor(generatedDir, SESSION, AGENT))).toBe(false);
  });

  it("refuses an empty agentType, writing nothing", () => {
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "",
      parent: matchedParent(),
    });
    expect(result).toMatchObject({ ok: false, reason: "malformed_agent_type" });
    expect(fs.existsSync(inflightRecordPathFor(generatedDir, SESSION, AGENT))).toBe(false);
  });

  it("refuses an agentType starting with a non-alphanumeric character, writing nothing", () => {
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "-general-purpose",
      parent: matchedParent(),
    });
    expect(result).toMatchObject({ ok: false, reason: "malformed_agent_type" });
    expect(fs.existsSync(inflightRecordPathFor(generatedDir, SESSION, AGENT))).toBe(false);
  });

  it("accepts a well-formed agentType at the 64-character cap", () => {
    const agentType = `a${"b".repeat(63)}`;
    const result = writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType,
      parent: matchedParent(),
    });
    expect(result.ok).toBe(true);
  });
});

describe("clearInflightRecord", () => {
  it("removes the record and its now-empty session directory", () => {
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    const filePath = inflightRecordPathFor(generatedDir, SESSION, AGENT);
    expect(fs.existsSync(filePath)).toBe(true);
    clearInflightRecord(generatedDir, SESSION, AGENT);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);
  });

  it("leaves a sibling agent's record and the session directory alone", () => {
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: AGENT,
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    writeInflightRecord({
      generatedDir,
      sessionId: SESSION,
      agentId: "agent-sibling",
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    clearInflightRecord(generatedDir, SESSION, AGENT);
    expect(fs.existsSync(inflightRecordPathFor(generatedDir, SESSION, AGENT))).toBe(false);
    expect(fs.existsSync(inflightRecordPathFor(generatedDir, SESSION, "agent-sibling"))).toBe(true);
  });

  it("never throws when the record is already absent", () => {
    expect(() => clearInflightRecord(generatedDir, SESSION, AGENT)).not.toThrow();
  });

  it("never throws for a malformed id", () => {
    expect(() => clearInflightRecord(generatedDir, SESSION, "../escape")).not.toThrow();
  });
});

describe("listInflightRecords", () => {
  it("tolerates a missing .inflight/ directory: empty result", () => {
    const result = listInflightRecords(generatedDir);
    expect(result).toEqual({ total: 0, stale: 0, sessions: [], skipped: [] });
  });

  it("lists records grouped by session, counts total and stale", () => {
    const startedAt = new Date("2026-09-04T09:00:00.000Z");
    const now = new Date(startedAt.getTime() + 25 * 60 * 60 * 1000); // one record now stale
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-a",
      agentId: "agent-1",
      agentType: "general-purpose",
      parent: matchedParent(),
      now: startedAt,
    });
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-a",
      agentId: "agent-2",
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-b",
      agentId: "agent-3",
      agentType: "general-purpose",
      parent: matchedParent(),
      now,
    });

    const result = listInflightRecords(generatedDir, now);
    expect(result.total).toBe(3);
    expect(result.stale).toBe(1);
    expect(result.skipped).toEqual([]);
    const bySession = Object.fromEntries(result.sessions.map((s) => [s.sessionId, s.agentIds.sort()]));
    expect(bySession).toEqual({ "sid-a": ["agent-1", "agent-2"], "sid-b": ["agent-3"] });
  });

  it("counts an unreadable/unparsable entry as skipped, never total or stale", () => {
    const dir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME, "sid-a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent-corrupt"), "not json{{{");
    const result = listInflightRecords(generatedDir);
    expect(result.total).toBe(0);
    expect(result.stale).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("skips filesystem debris (a stray file next to session directories, a symlink)", () => {
    const inflightDir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME);
    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(path.join(inflightDir, ".DS_Store"), "binary junk");
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-a",
      agentId: "agent-1",
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    fs.symlinkSync(
      inflightRecordPathFor(generatedDir, "sid-a", "agent-1"),
      path.join(inflightDir, "sid-a", "agent-symlink"),
    );
    const result = listInflightRecords(generatedDir);
    expect(result.total).toBe(1);
    expect(result.sessions).toEqual([{ sessionId: "sid-a", agentIds: ["agent-1"] }]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2); // .DS_Store + the symlink
  });

  it("keys staleness off the signed approvedAt, not the unsigned startedAt copy", () => {
    const signedAt = new Date("2026-09-04T09:00:00.000Z"); // 25h before `now`
    const now = new Date(signedAt.getTime() + 25 * 60 * 60 * 1000);
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-a",
      agentId: "agent-1",
      agentType: "general-purpose",
      parent: matchedParent(),
      now: signedAt,
    });
    const filePath = inflightRecordPathFor(generatedDir, "sid-a", "agent-1");
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    body.startedAt = now.toISOString(); // unsigned copy refreshed; approvedAt stays aged
    fs.writeFileSync(filePath, JSON.stringify(body));
    const result = listInflightRecords(generatedDir, now);
    expect(result.total).toBe(1);
    expect(result.stale).toBe(1);
  });

  it("counts a future-dated approvedAt (beyond the skew tolerance) as stale", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    const approvedAt = new Date(now.getTime() + 10 * 60 * 1000);
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-a",
      agentId: "agent-1",
      agentType: "general-purpose",
      parent: matchedParent(),
      now: approvedAt,
    });
    const result = listInflightRecords(generatedDir, now);
    expect(result.total).toBe(1);
    expect(result.stale).toBe(1);
  });

  it("a symlinked .inflight/ root reads as absent, even when it points at a directory holding a record", () => {
    writeInflightRecord({
      generatedDir,
      sessionId: "sid-a",
      agentId: "agent-1",
      agentType: "general-purpose",
      parent: matchedParent(),
    });
    const inflightDir = path.join(generatedDir, INFLIGHT_RECORD_DIRNAME);
    const realDir = `${inflightDir}-real`;
    fs.renameSync(inflightDir, realDir);
    fs.symlinkSync(realDir, inflightDir);

    const result = listInflightRecords(generatedDir);
    expect(result).toEqual({ total: 0, stale: 0, sessions: [], skipped: [] });
  });
});
