import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkApprovalMarker,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/markers.js";
import {
  DELEGATION_MARKER_DIRNAME,
  buildDelegationApprovedBy,
  delegationMarkerIdFor,
  delegationMarkerPathFor,
  hashDelegationCwd,
  parseDelegationApprovedBy,
  verifyDelegation,
  writeDelegationMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";
import {
  getOrCreateSigningKey,
  sha256Hex,
  signMarker,
  signingKeyPathFor,
} from "../../src/runtime/approval-signing.js";

// Slice 3 of docs/decisions/2026-08-27-ug-auto-mode-approval.md
// (agent-tasks 37ad0b05): the signed delegation artifact and its
// dedicated verifier. Every fixture below uses a real temp generatedDir
// and a real signing key created through the existing operator-side
// helper, so a "valid" delegation here is valid in exactly the sense the
// child's hook will check.

// Read-order / single-read seam for the (a) and (b) fixtures below, task
// 204efc56. `vi.spyOn` cannot target `readRegularFileRejectingSymlink`
// directly: Vitest's ESM module namespace objects are non-configurable, so
// `vi.spyOn(mod, "name")` throws "Module namespace is not configurable" for
// an own-source module (see tests/cli/pack-hook-pre-tool-use-delegate.test.ts's
// own comment on the same limitation, and project memory
// `reference_vitest_spyon_esm_named_export`). The established workaround is a
// call-through `vi.mock` of the module itself, recording every call's path
// so a test can assert both ordering (a call that should never happen did
// not) and count (a call that should happen exactly once did not happen
// twice).
const readRegularFileCallLog = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../../src/io/read-regular-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/io/read-regular-file.js")>();
  return {
    ...actual,
    readRegularFileRejectingSymlink: (filePath: string): ReturnType<
      typeof actual.readRegularFileRejectingSymlink
    > => {
      readRegularFileCallLog.paths.push(filePath);
      return actual.readRegularFileRejectingSymlink(filePath);
    },
  };
});

const CHILD = "child-0000-1111";
const PARENT = "parent-2222-3333";
const TASK = "37ad0b05";

let tmp: string;
let generatedDir: string;
let childCwd: string;

/** Far enough ahead that no test wall-clock can overtake it. */
function futureIso(offsetMs = 60 * 60 * 1000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Write a delegation body with an ARBITRARY approvedBy string, signed with
 * the real key under the real markerId. This is how the "validly signed
 * but its bindings do not parse" fixtures are built: they must pass the
 * signature check and fail at the segment parse, which a hand-rolled
 * unsigned file could never prove.
 */
function writeSignedDelegationWithApprovedBy(childSessionId: string, approvedBy: string): string {
  const filePath = delegationMarkerPathFor(generatedDir, childSessionId);
  const signed = signMarker(generatedDir, delegationMarkerIdFor(childSessionId), {
    approvedAt: new Date().toISOString(),
    approvedBy,
    reportContentHash: null,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

/** Issue a base-shape delegation bound to the child's cwd. Asserts the write itself succeeded. */
function issueCwdDelegation(overrides: { childSessionId?: string; expiresAt?: string } = {}): void {
  const result = writeDelegationMarker({
    generatedDir,
    childSessionId: overrides.childSessionId ?? CHILD,
    parentSessionId: PARENT,
    cwdHash: hashDelegationCwd(childCwd),
    taskId: null,
    expiresAt: overrides.expiresAt ?? futureIso(),
  });
  expect(result.ok).toBe(true);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegation-"));
  generatedDir = path.join(tmp, "harness.generated");
  childCwd = path.join(tmp, "child-cwd");
  fs.mkdirSync(childCwd, { recursive: true });
  // The operator-side act, done explicitly: every test that expects a
  // delegation to be minted needs the key to exist BEFORE the writer runs.
  getOrCreateSigningKey(generatedDir);
  readRegularFileCallLog.paths = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildDelegationApprovedBy / parseDelegationApprovedBy", () => {
  it("round-trips every binding through the signed approvedBy string", () => {
    const cwdHash = hashDelegationCwd(childCwd);
    const reportPathHash = hashDelegationCwd(path.join(tmp, "report.json"));
    const expiresAt = "2026-08-27T12:00:00.000Z";
    const approvedBy = buildDelegationApprovedBy({
      parentSessionId: PARENT,
      cwdHash,
      taskId: TASK,
      expiresAt,
      reportPathHash,
    });
    expect(approvedBy).toBe(
      `delegated:${PARENT};cwd=${cwdHash};task=${TASK};expires=${expiresAt};report=${reportPathHash}`,
    );
    const parsed = parseDelegationApprovedBy(approvedBy);
    expect(parsed).toEqual({
      ok: true,
      value: { parentSessionId: PARENT, cwdHash, taskId: TASK, expiresAt, reportPathHash },
    });
  });

  it("writes the unbound literal for an absent cwd/task and reads it back as null", () => {
    const expiresAt = "2026-08-27T12:00:00.000Z";
    const approvedBy = buildDelegationApprovedBy({
      parentSessionId: PARENT,
      cwdHash: null,
      taskId: null,
      expiresAt,
    });
    expect(approvedBy).toBe(`delegated:${PARENT};cwd=-;task=-;expires=${expiresAt}`);
    const parsed = parseDelegationApprovedBy(approvedBy);
    expect(parsed).toEqual({
      ok: true,
      value: { parentSessionId: PARENT, cwdHash: null, taskId: null, expiresAt },
    });
  });

  it("refuses to build a value that would corrupt the segment encoding", () => {
    const base = { cwdHash: null, taskId: null, expiresAt: "2026-08-27T12:00:00.000Z" };
    expect(() => buildDelegationApprovedBy({ ...base, parentSessionId: "a;cwd=b" })).toThrow(
      /delegation-segment delimiter/,
    );
    expect(() => buildDelegationApprovedBy({ ...base, parentSessionId: "" })).toThrow(/empty/);
    expect(() =>
      buildDelegationApprovedBy({ ...base, parentSessionId: PARENT, expiresAt: "tomorrow" }),
    ).toThrow(/ISO-8601/);
    expect(() =>
      buildDelegationApprovedBy({ ...base, parentSessionId: PARENT, cwdHash: "not-a-digest" }),
    ).toThrow(/sha256/);
    // A literal dash as a task id would round-trip as "no task bound",
    // silently widening the delegation.
    expect(() =>
      buildDelegationApprovedBy({ ...base, parentSessionId: PARENT, taskId: "-" }),
    ).toThrow(/unbound literal/);
  });

  it("refuses to build a delegation whose parent session id carries a control character (review finding F2)", () => {
    const base = { cwdHash: null, taskId: null, expiresAt: "2026-08-27T12:00:00.000Z" };
    expect(() =>
      buildDelegationApprovedBy({ ...base, parentSessionId: "parent\nid" }),
    ).toThrow();
  });

  it.each([
    ["a missing segment", `delegated:${PARENT};cwd=-;task=${TASK}`, /missing "expires"/],
    [
      "a duplicate segment",
      `delegated:${PARENT};cwd=-;task=${TASK};task=other;expires=2026-08-27T12:00:00.000Z`,
      /duplicate "task"/,
    ],
    [
      "an unknown segment",
      `delegated:${PARENT};cwd=-;task=${TASK};expires=2026-08-27T12:00:00.000Z;ttl=9`,
      /unknown delegation segment key/,
    ],
    [
      "an empty value",
      `delegated:${PARENT};cwd=;task=${TASK};expires=2026-08-27T12:00:00.000Z`,
      /empty value for segment/,
    ],
    [
      "a malformed cwd digest",
      `delegated:${PARENT};cwd=deadbeef;task=-;expires=2026-08-27T12:00:00.000Z`,
      /not a sha256/,
    ],
    ["a malformed expiry", `delegated:${PARENT};cwd=-;task=${TASK};expires=soon`, /ISO-8601/],
    [
      "a timezone-less expiry (ambiguous instant)",
      `delegated:${PARENT};cwd=-;task=${TASK};expires=2026-08-27T12:00:00`,
      /ISO-8601/,
    ],
    ["no delegated segment", `cwd=-;task=${TASK};expires=2026-08-27T12:00:00.000Z`, /missing "delegated"/],
    [
      "an empty parent",
      `delegated:;cwd=-;task=${TASK};expires=2026-08-27T12:00:00.000Z`,
      /empty value for segment "delegated"/,
    ],
    [
      "a parent value carrying an '=' (review finding F2)",
      `delegated:a=b;cwd=-;task=${TASK};expires=2026-08-27T12:00:00.000Z`,
      /"delegated" value contains/,
    ],
    [
      "a parent value carrying a control character (review finding F2)",
      `delegated:a\nb;cwd=-;task=${TASK};expires=2026-08-27T12:00:00.000Z`,
      /"delegated" value contains/,
    ],
  ])("refuses %s, with no default filled in", (_label, approvedBy, pattern) => {
    const parsed = parseDelegationApprovedBy(approvedBy);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.reason).toMatch(pattern);
  });

  it("refuses a non-string approvedBy", () => {
    expect(parseDelegationApprovedBy(undefined).ok).toBe(false);
    expect(parseDelegationApprovedBy(null).ok).toBe(false);
    expect(parseDelegationApprovedBy(42).ok).toBe(false);
    expect(parseDelegationApprovedBy("").ok).toBe(false);
  });
});

describe("hashDelegationCwd", () => {
  it("hashes a symlinked path and its target identically (the /tmp case)", () => {
    const linkPath = path.join(tmp, "link-cwd");
    fs.symlinkSync(childCwd, linkPath);
    expect(hashDelegationCwd(linkPath)).toBe(hashDelegationCwd(childCwd));
    expect(hashDelegationCwd(childCwd)).toBe(sha256Hex(fs.realpathSync(childCwd)));
  });

  it("still hashes deterministically for a path that does not exist", () => {
    const absent = path.join(tmp, "gone");
    expect(hashDelegationCwd(absent)).toBe(sha256Hex(path.resolve(absent)));
  });
});

describe("writeDelegationMarker", () => {
  it("writes a signed base-shape delegation under .delegations/, never .approvals/", () => {
    const expiresAt = futureIso();
    const cwdHash = hashDelegationCwd(childCwd);
    const result = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash,
      taskId: null,
      expiresAt,
      now: new Date("2026-08-27T09:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.filePath).toBe(path.join(generatedDir, DELEGATION_MARKER_DIRNAME, CHILD));
    expect(result.markerId).toBe(`delegation-${CHILD}`);
    expect(result.approvedAt).toBe("2026-08-27T09:00:00.000Z");

    const body = JSON.parse(fs.readFileSync(result.filePath, "utf8")) as Record<string, unknown>;
    expect(body["approvedBy"]).toBe(
      `delegated:${PARENT};cwd=${cwdHash};task=-;expires=${expiresAt}`,
    );
    // The base shape binds no report: `null` is the accepted "nothing to
    // bind" value the signing tuple already carries.
    expect(body["reportContentHash"]).toBeNull();
    expect(typeof body["signature"]).toBe("string");
    expect(fs.existsSync(path.join(generatedDir, ".approvals", CHILD))).toBe(false);
    // Mode 0600, like every other marker write (review finding F-mode).
    expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
  });

  it("key absent refuses without creating a key", () => {
    // A generatedDir the operator never initialized: no
    // `.approval-signing.key`. Minting here would mean the delegation
    // path itself performed the operator-side act of creating the key.
    const bare = path.join(tmp, "uninitialized.generated");
    const result = writeDelegationMarker({
      generatedDir: bare,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt: futureIso(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("signing-key-absent");
    expect(fs.existsSync(signingKeyPathFor(bare))).toBe(false);
    expect(fs.existsSync(path.join(bare, DELEGATION_MARKER_DIRNAME, CHILD))).toBe(false);
  });

  it("refuses half a report binding (path hash without content hash, and the reverse)", () => {
    const common = {
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt: futureIso(),
    };
    const pathOnly = writeDelegationMarker({
      ...common,
      reportPathHash: hashDelegationCwd(path.join(tmp, "report.json")),
    });
    expect(pathOnly.ok).toBe(false);
    const contentOnly = writeDelegationMarker({ ...common, reportContentHash: sha256Hex("x") });
    expect(contentOnly.ok).toBe(false);
    expect(fs.existsSync(path.join(generatedDir, DELEGATION_MARKER_DIRNAME, CHILD))).toBe(false);

    // A reportContentHash that is not a sha256 digest is refused too
    // (review finding F5): reportPathHash was already shape-checked, but
    // reportContentHash was accepted verbatim before this fix.
    const malformedContentHash = writeDelegationMarker({
      ...common,
      reportPathHash: hashDelegationCwd(path.join(tmp, "report.json")),
      reportContentHash: "NOT-A-DIGEST",
    });
    expect(malformedContentHash.ok).toBe(false);
    if (malformedContentHash.ok) throw new Error("unreachable");
    expect(malformedContentHash.reason).toBe("invalid-input");
    expect(fs.existsSync(path.join(generatedDir, DELEGATION_MARKER_DIRNAME, CHILD))).toBe(false);
  });

  it("refuses a malformed child session id instead of escaping the delegations directory", () => {
    const result = writeDelegationMarker({
      generatedDir,
      childSessionId: "../escape",
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt: futureIso(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid-input");
  });
});

describe("verifyDelegation", () => {
  it("accepts a valid cwd-bound delegation and reports the parent linkage", () => {
    const expiresAt = futureIso();
    issueCwdDelegation({ expiresAt });
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.parentSessionId).toBe(PARENT);
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.boundCwdHash).toBe(hashDelegationCwd(childCwd));
    expect(result.boundTaskId).toBeNull();
    expect(result.reportPathHash).toBeUndefined();
  });

  it("accepts the fallback shape when the launcher report matches by path AND content", () => {
    const reportPath = path.join(tmp, "launcher-report.json");
    const reportBody = JSON.stringify({ report: "child understanding" });
    fs.writeFileSync(reportPath, reportBody);
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(reportPath),
      reportContentHash: sha256Hex(reportBody),
    });
    expect(written.ok).toBe(true);

    const ok = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.reportPathHash).toBe(hashDelegationCwd(reportPath));
    expect(ok.boundTaskId).toBe(TASK);

    // Same bytes, a path the parent did not sign: WHERE is part of the binding.
    const copyPath = path.join(tmp, "child-chosen-copy.json");
    fs.writeFileSync(copyPath, reportBody);
    const movedPath = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: copyPath,
    });
    expect(movedPath.ok).toBe(false);
    if (movedPath.ok) throw new Error("unreachable");
    expect(movedPath.reason).toBe("report_path_mismatch");

    // Right path, rewritten content: WHAT is part of the binding too.
    fs.writeFileSync(reportPath, `${reportBody} tampered`);
    const tampered = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) throw new Error("unreachable");
    expect(tampered.reason).toBe("report_content_mismatch");

    // The fallback shape with no report offered at all is a refusal, not a
    // fall-through to the base shape.
    const noReport = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
    });
    expect(noReport.ok).toBe(false);
    if (noReport.ok) throw new Error("unreachable");
    expect(noReport.reason).toBe("report_path_mismatch");
  });

  it("a report-bound delegation whose launcher report file is absent is refused as report_missing, not report_content_mismatch, on a non-realpathed temp root", () => {
    // `tmp` here is `beforeEach`'s plain `mkdtempSync` result, unrealpathed:
    // on macOS that sits under a symlink (`os.tmpdir()` -> `/var/...` ->
    // `/private/var/...`). `reportPath` is never written, at bind time or
    // verify time, so `hashDelegationCwd`'s missing-path fallback
    // (`path.resolve`) runs identically both times and the path hash
    // always agrees here, realpathed root or not: this fixture does not
    // exercise the realpath/fallback divergence (see the staged-then-
    // deleted fixture below for that). Measured: the pre-fix code read
    // the file, got kind `missing`, and mapped that straight to
    // `report_content_mismatch`; there was no `report_missing` reason to
    // land on.
    const reportPath = path.join(tmp, "never-written-report.json");
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(reportPath),
      reportContentHash: sha256Hex("never written"),
    });
    expect(written.ok).toBe(true);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("report_missing");
  });

  it("a report-bound delegation whose launcher report file is absent is refused as report_missing on a realpathed temp root too", () => {
    // The mirror-image fixture: realpathing the root up front (the way
    // the hook test suite does) removes the platform ambiguity entirely,
    // and the reason must still land on `report_missing`. Measured: the
    // pre-fix reason here was also `report_content_mismatch`, same as the
    // non-realpathed sibling above, since `reportPath` is never written
    // at bind or verify time either, so the path hash always agreed
    // (realpathed or not) and the old code fell through to the read
    // failing. Neither of these two fixtures exercises the realpath
    // divergence itself; the staged-then-deleted fixture below does.
    const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegation-real-")));
    try {
      const realGeneratedDir = path.join(realRoot, "harness.generated");
      const realChildCwd = path.join(realRoot, "child-cwd");
      fs.mkdirSync(realChildCwd, { recursive: true });
      getOrCreateSigningKey(realGeneratedDir);
      const reportPath = path.join(realRoot, "never-written-report.json");
      const written = writeDelegationMarker({
        generatedDir: realGeneratedDir,
        childSessionId: CHILD,
        parentSessionId: PARENT,
        cwdHash: hashDelegationCwd(realChildCwd),
        taskId: TASK,
        expiresAt: futureIso(),
        reportPathHash: hashDelegationCwd(reportPath),
        reportContentHash: sha256Hex("never written"),
      });
      expect(written.ok).toBe(true);

      const result = verifyDelegation({
        generatedDir: realGeneratedDir,
        childSessionId: CHILD,
        cwd: realChildCwd,
        taskId: TASK,
        launcherReportPath: reportPath,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("report_missing");
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("a report STAGED at bind time then deleted before verify is report_missing, not report_path_mismatch, on a symlinked temp root", () => {
    // This is the fixture the two "never written" tests above cannot be:
    // there, the path hash always agreed because the file never existed
    // at either point in time, so `hashDelegationCwd` took the same
    // `path.resolve` fallback both times regardless of platform. Here the
    // report file genuinely EXISTS at bind time, so `hashDelegationCwd`
    // resolves it through `fs.realpathSync` (which, under `tmp`'s
    // symlinked root on macOS, differs from the un-realpathed literal
    // path). It is then deleted before verify, so the verify-time hash
    // falls back to `path.resolve` on the same un-realpathed literal
    // path, and the two disagree: pre-fix (no existence probe before the
    // path hash) that mismatch surfaced as `report_path_mismatch`. Post
    // fix, the existence probe runs first and reports `report_missing`
    // regardless of what the (now moot) path hash would have said.
    const reportPath = path.join(tmp, "staged-then-deleted-report.json");
    const reportBody = "staged report body";
    fs.writeFileSync(reportPath, reportBody);
    const reportPathHash = hashDelegationCwd(reportPath); // bind-time: file exists, realpathSync resolves.
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash,
      reportContentHash: sha256Hex(reportBody),
    });
    expect(written.ok).toBe(true);

    fs.rmSync(reportPath);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath, // verify-time: file gone, path.resolve fallback.
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("report_missing");
  });

  it("a SYMLINK at the conventional report path is not report_missing", () => {
    // Existence alone decides `report_missing`; an lstat sees a symlink
    // as "something is there" and lets verification continue past the
    // existence probe. Measured: `hashDelegationCwd`'s `realpathSync`
    // follows the symlink to its target when computing the verify-time
    // hash, which the bind-time hash (taken when nothing sat at
    // `reportPath` yet, so it used the `path.resolve` fallback on the
    // literal symlink path) does not match; the mismatch is caught at the
    // path-hash step, so the reason is `report_path_mismatch`, not
    // `report_missing` and not `report_content_mismatch`. Either way, the
    // point this fixture pins is that it is not `report_missing`.
    const reportPath = path.join(tmp, "symlinked-report.json");
    const reportBody = "real report body";
    const realTargetPath = path.join(tmp, "symlink-target.json");
    fs.writeFileSync(realTargetPath, reportBody);
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(reportPath),
      reportContentHash: sha256Hex(reportBody),
    });
    expect(written.ok).toBe(true);
    fs.symlinkSync(realTargetPath, reportPath);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toBe("report_missing");
    expect(result.reason).toBe("report_path_mismatch");
  });

  it("a DIRECTORY at the conventional report path is not report_missing", () => {
    // Same shape as the symlink case: an lstat sees a directory as
    // "something is there", so it is not `report_missing`; the full read
    // later refuses the non-regular file and it lands on
    // `report_content_mismatch`.
    const reportPath = path.join(tmp, "directory-report.json");
    fs.mkdirSync(reportPath);
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(reportPath),
      reportContentHash: sha256Hex("irrelevant"),
    });
    expect(written.ok).toBe(true);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toBe("report_missing");
    expect(result.reason).toBe("report_content_mismatch");
  });

  it("a bound report path with no reportContentHash and an absent file is report_missing, not report_content_mismatch", () => {
    // `writeDelegationMarker` itself refuses to mint a half-binding (path
    // hash without a content hash; see the "refuses half a report
    // binding" test above), so this hand-signs the marker the way the
    // unparseable-bindings fixtures do, to reach the verify-side
    // defensive branch a well-formed writer can never produce. The
    // existence probe runs before ANY of the binding-shape checks, so an
    // absent file at a bound path is always `report_missing` regardless
    // of whether a content hash was ever bound; only the "no report path
    // offered at all" case (no
    // path to check existence for) stays `report_path_mismatch`.
    const reportPath = path.join(tmp, "half-bound-absent-report.json");
    const approvedBy = buildDelegationApprovedBy({
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(reportPath),
    });
    writeSignedDelegationWithApprovedBy(CHILD, approvedBy);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("report_missing");
  });

  it("never reads the report's bytes when the path hash mismatches (read order pinned)", () => {
    // A mutant that hoists the full read above the path hash, while
    // leaving its `kind` check intact, would still
    // pass every existing assertion on `result.reason` here (the read's
    // "symlink"/"not-regular" kinds are not at play; the file is a plain
    // regular file the read would succeed on, and nothing downstream
    // re-checks whether the read happened before or after the hash). Only
    // a direct assertion on call order catches that reordering.
    const boundPath = path.join(tmp, "bound-report.json");
    const actualPath = path.join(tmp, "actual-report.json");
    fs.writeFileSync(actualPath, "the child never sees these bytes checked");
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(boundPath), // bound to a DIFFERENT path than offered below.
      reportContentHash: sha256Hex("irrelevant, the path hash never lets this get checked"),
    });
    expect(written.ok).toBe(true);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: actualPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("report_path_mismatch");
    expect(readRegularFileCallLog.paths).not.toContain(actualPath);
  });

  it("reads the report's bytes exactly once on the ok path", () => {
    // The single-read property the module header and the inline comment
    // above the read both claim ("no second read, no second trust
    // decision") but nothing previously pinned by a call count.
    const reportPath = path.join(tmp, "single-read-report.json");
    const reportBody = "counted exactly once";
    fs.writeFileSync(reportPath, reportBody);
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash: hashDelegationCwd(reportPath),
      reportContentHash: sha256Hex(reportBody),
    });
    expect(written.ok).toBe(true);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
      launcherReportPath: reportPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.reportContent).toBe(reportBody);
    expect(readRegularFileCallLog.paths.filter((p) => p === reportPath)).toHaveLength(1);
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.geteuid === "function" && process.geteuid() === 0),
  )("an EACCES containing directory yields report_missing with the new detail wording", () => {
    // Skipped as root: root bypasses directory permission bits entirely,
    // so `lstat` would succeed and the fixture would not exercise the
    // EACCES arm at all. Skipped on Windows: chmod-based permission
    // denial does not apply there.
    const lockedDir = path.join(tmp, "locked-dir");
    fs.mkdirSync(lockedDir);
    const reportPath = path.join(lockedDir, "report.json");
    fs.writeFileSync(reportPath, "unreachable once the directory is locked");
    const reportPathHash = hashDelegationCwd(reportPath); // computed while still readable.
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(childCwd),
      taskId: TASK,
      expiresAt: futureIso(),
      reportPathHash,
      reportContentHash: sha256Hex("irrelevant"),
    });
    expect(written.ok).toBe(true);

    fs.chmodSync(lockedDir, 0o000); // no execute bit: lstat on a child path now fails EACCES.
    try {
      const result = verifyDelegation({
        generatedDir,
        childSessionId: CHILD,
        cwd: childCwd,
        taskId: TASK,
        launcherReportPath: reportPath,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("report_missing");
      expect(result.detail).toContain("nothing could be stat'ed at");
      expect(result.detail).toContain("EACCES");
    } finally {
      fs.chmodSync(lockedDir, 0o755); // restore before afterEach's recursive rmSync.
    }
  });

  it("a DANGLING symlink at the conventional report path (realpathed root) is report_content_mismatch, not report_missing", () => {
    // A RESOLVABLE symlink is caught at the path-hash step
    // (`report_path_mismatch`, pinned above); a DANGLING symlink's
    // `realpathSync` fails at BOTH bind and verify time, so
    // `hashDelegationCwd` falls back to `path.resolve` on the literal
    // symlink path both times and the path hash agrees. It only fails
    // later, at the reader's own symlink rejection.
    const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ug-delegation-dangling-")));
    try {
      const realGeneratedDir = path.join(realRoot, "harness.generated");
      const realChildCwd = path.join(realRoot, "child-cwd");
      fs.mkdirSync(realChildCwd, { recursive: true });
      getOrCreateSigningKey(realGeneratedDir);
      const reportPath = path.join(realRoot, "dangling-report.json");
      fs.symlinkSync(path.join(realRoot, "never-created-target.json"), reportPath);
      const reportPathHash = hashDelegationCwd(reportPath); // realpathSync fails (ENOENT); falls back to path.resolve.
      const written = writeDelegationMarker({
        generatedDir: realGeneratedDir,
        childSessionId: CHILD,
        parentSessionId: PARENT,
        cwdHash: hashDelegationCwd(realChildCwd),
        taskId: TASK,
        expiresAt: futureIso(),
        reportPathHash,
        reportContentHash: sha256Hex("irrelevant, the read rejects the symlink before hashing"),
      });
      expect(written.ok).toBe(true);

      const result = verifyDelegation({
        generatedDir: realGeneratedDir,
        childSessionId: CHILD,
        cwd: realChildCwd,
        taskId: TASK,
        launcherReportPath: reportPath,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).not.toBe("report_missing");
      expect(result.reason).not.toBe("report_path_mismatch");
      expect(result.reason).toBe("report_content_mismatch");
    } finally {
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("expired delegation is refused", () => {
    // One second in the past, every other binding valid: the expiry check
    // is the only thing standing between this fixture and an `ok` result.
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    issueCwdDelegation({ expiresAt });
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
    expect(result.detail).toMatch(/expired at/);
  });

  it("an unusable injected clock fails closed, not open (review finding F1)", () => {
    // `now: new Date("not-a-date")` makes `.getTime()` return NaN, and NaN
    // fails every `<=` comparison. Without an explicit `Number.isFinite`
    // guard, `expiresMs <= NaN` is `false`, which would make an already
    // long-expired delegation read as unexpired: an unusable clock must
    // never be the reason a check comes back open.
    issueCwdDelegation({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
      now: new Date("not-a-date"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
    expect(result.detail).toMatch(/unusable/);
  });

  it("unsigned delegation is refused", () => {
    const filePath = delegationMarkerPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Structurally perfect body, valid bindings, no `signature`/`alg`:
    // exactly what a write primitive without the key can produce.
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(
        {
          approvedAt: new Date().toISOString(),
          approvedBy: buildDelegationApprovedBy({
            parentSessionId: PARENT,
            cwdHash: hashDelegationCwd(childCwd),
            taskId: null,
            expiresAt: futureIso(),
          }),
          reportContentHash: null,
        },
        null,
        2,
      )}\n`,
    );
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("forged");
  });

  it("refuses a delegation whose signature was minted for another child session", () => {
    const otherChild = "child-9999-8888";
    issueCwdDelegation({ childSessionId: otherChild });
    const donor = delegationMarkerPathFor(generatedDir, otherChild);
    const target = delegationMarkerPathFor(generatedDir, CHILD);
    fs.copyFileSync(donor, target);

    // The donor still verifies under its own id ...
    expect(
      verifyDelegation({ generatedDir, childSessionId: otherChild, cwd: childCwd, taskId: null }).ok,
    ).toBe(true);
    // ... and the copy does not, because the markerId is signed.
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("forged");
  });

  it("refuses a delegation bound to a different cwd, and one with no cwd offered", () => {
    const otherCwd = path.join(tmp, "other-cwd");
    fs.mkdirSync(otherCwd, { recursive: true });
    issueCwdDelegation();

    const wrong = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: otherCwd,
      taskId: null,
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error("unreachable");
    expect(wrong.reason).toBe("cwd_mismatch");

    const none = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: null,
      taskId: null,
    });
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error("unreachable");
    expect(none.reason).toBe("cwd_mismatch");
  });

  it("accepts a cwd-bound delegation when the child reports the symlinked spelling", () => {
    const linkPath = path.join(tmp, "link-cwd");
    fs.symlinkSync(childCwd, linkPath);
    // The parent binds the symlinked spelling; the child reports the real
    // one. Both canonicalize to the same directory, which is the whole
    // point of hashing the realpath.
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: hashDelegationCwd(linkPath),
      taskId: null,
      expiresAt: futureIso(),
    });
    expect(written.ok).toBe(true);
    expect(
      verifyDelegation({ generatedDir, childSessionId: CHILD, cwd: childCwd, taskId: null }).ok,
    ).toBe(true);
    expect(
      verifyDelegation({ generatedDir, childSessionId: CHILD, cwd: linkPath, taskId: null }).ok,
    ).toBe(true);
  });

  it("refuses a delegation bound to a different task, and one with no task offered", () => {
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: null,
      taskId: TASK,
      expiresAt: futureIso(),
    });
    expect(written.ok).toBe(true);

    const wrong = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: "deadbeef",
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error("unreachable");
    expect(wrong.reason).toBe("task_mismatch");

    const none = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error("unreachable");
    expect(none.reason).toBe("task_mismatch");
  });

  it("accepts a task-only delegation even when the caller has no cwd", () => {
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: null,
      taskId: TASK,
      expiresAt: futureIso(),
    });
    expect(written.ok).toBe(true);
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: null,
      taskId: TASK,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.boundCwdHash).toBeNull();
    expect(result.boundTaskId).toBe(TASK);
  });

  it("refuses a delegation that binds neither a cwd nor a task", () => {
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: CHILD,
      parentSessionId: PARENT,
      cwdHash: null,
      taskId: null,
      expiresAt: futureIso(),
    });
    // The writer deliberately mints it; the verifier is what refuses an
    // unbound pre-authorization.
    expect(written.ok).toBe(true);
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("no_binding");
  });

  it.each([
    ["a missing segment", `delegated:${PARENT};cwd=-;task=${TASK}`],
    ["a duplicate segment", `delegated:${PARENT};cwd=-;cwd=-;task=${TASK};expires=2099-01-01T00:00:00.000Z`],
    ["an unknown segment", `delegated:${PARENT};cwd=-;task=${TASK};expires=2099-01-01T00:00:00.000Z;ttl=1h`],
  ])("refuses a validly signed delegation carrying %s", (_label, approvedBy) => {
    writeSignedDelegationWithApprovedBy(CHILD, approvedBy);
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: TASK,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // Signed, so not forged; unreadable bindings, so not a default either.
    expect(result.reason).toBe("unparseable");
  });

  it("a symlink at the delegation path is unreadable, not missing or forged (review finding F3)", () => {
    const filePath = delegationMarkerPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const targetPath = path.join(tmp, "symlink-target");
    fs.writeFileSync(targetPath, "not a delegation body");
    fs.symlinkSync(targetPath, filePath);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unreadable");
  });

  it("a directory at the delegation path is unreadable, not missing or forged (review finding F3)", () => {
    const filePath = delegationMarkerPathFor(generatedDir, CHILD);
    fs.mkdirSync(filePath, { recursive: true });

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("unreadable");
  });

  it("a body that is not JSON at all is forged, not unreadable or unparseable (review finding F3)", () => {
    const filePath = delegationMarkerPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not json at all", { mode: 0o600 });

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("forged");
  });

  it("a JSON array body is forged, not unreadable or unparseable (review finding F3)", () => {
    const filePath = delegationMarkerPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]), { mode: 0o600 });

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("forged");
  });

  it("reports a missing delegation as missing, not as anything weaker", () => {
    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("missing");
  });

  it("creates no signing key while verifying: a delegation on a keyless machine is refused, and the key is still absent afterwards", () => {
    // The never-create rule (ADR threat model (b) item 5) is not only a
    // WRITE-path rule. `verifyMarkerSignature` obtains the key through
    // `getOrCreateSigningKey`, which treats a missing key as a case to
    // REPAIR and generates one, so without an explicit precheck a mere
    // gate-time read would perform the operator-side act of minting the
    // key on a machine that never had one. Fixture: a genuinely signed
    // delegation body (signed here, where the key does exist) copied into
    // a generatedDir that has no key at all.
    const bare = path.join(tmp, "keyless.generated");
    issueCwdDelegation();
    const body = fs.readFileSync(delegationMarkerPathFor(generatedDir, CHILD), "utf8");
    const barePath = delegationMarkerPathFor(bare, CHILD);
    fs.mkdirSync(path.dirname(barePath), { recursive: true });
    fs.writeFileSync(barePath, body, { mode: 0o600 });
    expect(fs.existsSync(signingKeyPathFor(bare))).toBe(false);

    const result = verifyDelegation({
      generatedDir: bare,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // "We could not check", not "we checked and it is a forgery".
    expect(result.reason).toBe("unreadable");
    expect(result.detail).toMatch(/signing key absent/);
    expect(fs.existsSync(signingKeyPathFor(bare))).toBe(false);
  });

  it("refuses a malformed child session id instead of throwing out of the gate", () => {
    const result = verifyDelegation({
      generatedDir,
      childSessionId: "../escape",
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("missing");
    expect(result.detail).toMatch(/invalid childSessionId/);
  });
});

describe("delegations and approvals never cross over", () => {
  it("a delegation copied into .approvals/ is not an approval, and is no longer a delegation either", () => {
    issueCwdDelegation();
    const delegationPath = delegationMarkerPathFor(generatedDir, CHILD);
    const misplaced = path.join(generatedDir, ".approvals", CHILD);
    fs.mkdirSync(path.dirname(misplaced), { recursive: true });
    fs.copyFileSync(delegationPath, misplaced);
    fs.rmSync(delegationPath);

    // The session-marker reader sees a file signed under the wrong
    // markerId: a forgery, never an approval.
    const asApproval = checkApprovalMarker(generatedDir, CHILD);
    expect(asApproval.matched).toBe(false);
    expect(asApproval.forged).toBe(true);

    // And the delegation verifier only ever reads `.delegations/`.
    const asDelegation = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(asDelegation.ok).toBe(false);
    if (asDelegation.ok) throw new Error("unreachable");
    expect(asDelegation.reason).toBe("missing");
  });

  it("an approval marker copied into .delegations/ is not a delegation", () => {
    writeApprovalMarker(generatedDir, CHILD, {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
    });
    const approvalPath = path.join(generatedDir, ".approvals", CHILD);
    const misplaced = delegationMarkerPathFor(generatedDir, CHILD);
    fs.mkdirSync(path.dirname(misplaced), { recursive: true });
    fs.copyFileSync(approvalPath, misplaced);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: CHILD,
      cwd: childCwd,
      taskId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // Signed for markerId `<sid>`, checked against `delegation-<sid>`.
    expect(result.reason).toBe("forged");
    // The real approval is untouched by any of this.
    expect(checkApprovalMarker(generatedDir, CHILD).matched).toBe(true);
  });
});
