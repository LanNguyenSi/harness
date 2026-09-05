import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeActiveClaim } from "../../src/policy-packs/builtin/understanding-before-execution/active-claim.js";
import {
  checkApprovalMarker,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/markers.js";
import {
  checkOperatorApprovalMarkers,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/task-markers.js";
import {
  hashDelegationCwd,
  verifyDelegation,
  writeDelegationMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution/delegation-markers.js";
import { getOrCreateSigningKey } from "../../src/runtime/approval-signing.js";

let tmp: string;
let generatedDir: string;
let childCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-marker-containment-"));
  generatedDir = path.join(tmp, "harness.generated");
  childCwd = path.join(tmp, "child-cwd");
  fs.mkdirSync(childCwd, { recursive: true });
  getOrCreateSigningKey(generatedDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function replaceRootWithSymlink(root: string): string {
  const outside = `${root}-outside`;
  fs.renameSync(root, outside);
  fs.symlinkSync(outside, root, "dir");
  return outside;
}

describe("understanding-gate authority root containment", () => {
  it("refuses a validly signed session marker reachable only through a symlinked .approvals root", () => {
    writeApprovalMarker(generatedDir, "session-1", {
      approvedAt: "2026-09-05T09:00:00.000Z",
      approvedBy: "operator",
    });
    const approvalsDir = path.join(generatedDir, ".approvals");
    replaceRootWithSymlink(approvalsDir);

    const result = checkApprovalMarker(generatedDir, "session-1");
    expect(result).toMatchObject({ matched: false, forged: false, expired: false, marker: null });
    expect(result.detail).toMatch(/containment refusal/);
    expect(result.detail).toContain(approvalsDir);
  });

  it("refuses a validly signed task marker reachable only through a symlinked .approvals root", () => {
    writeActiveClaim(generatedDir, "task-1");
    writeTaskApprovalMarker(generatedDir, "task-1", {
      approvedAt: "2026-09-05T09:00:00.000Z",
      approvedBy: "operator",
    });
    const approvalsDir = path.join(generatedDir, ".approvals");
    replaceRootWithSymlink(approvalsDir);

    const result = checkOperatorApprovalMarkers(generatedDir, "session-1", {});
    expect(result).toMatchObject({ matched: false, source: null, forged: false, expired: false });
    expect(result.taskCheckDetail).toMatch(/containment refusal/);
  });

  it("refuses a validly signed delegation reachable only through a symlinked .delegations root", () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const written = writeDelegationMarker({
      generatedDir,
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      cwdHash: hashDelegationCwd(childCwd),
      taskId: null,
      expiresAt,
    });
    expect(written.ok).toBe(true);
    const delegationsDir = path.join(generatedDir, ".delegations");
    replaceRootWithSymlink(delegationsDir);

    const result = verifyDelegation({
      generatedDir,
      childSessionId: "child-1",
      cwd: childCwd,
      taskId: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "missing" });
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toMatch(/containment refusal/);
    expect(result.detail).toContain(delegationsDir);
  });
});
