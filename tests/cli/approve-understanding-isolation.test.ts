// Hotfix v0.22.0 — pin the test-isolation contract for approveUnderstanding.
//
// Before this hotfix, `approveUnderstanding({ manifest, session, reportsDir })`
// without `generatedDir` or `homeDir` injection resolved generatedDir from
// `resolvePaths()` to the operator's real `~/.claude/harness.generated/` and
// silently wrote `.approvals/<sessionId>` + (since PR #187) `.approvals/task-
// <real-task-id>` into it. The latter is particularly bad: it auto-approved
// whatever task the operator's `active-claim` file pointed to, short-
// circuiting the understanding-gate for the live task.
//
// This pin-test invokes approveUnderstanding against a tmp homeDir and asserts
// that NO writes land under the real `~/.claude/` tree. A future test author
// who forgets to inject `generatedDir`/`homeDir` will be caught here, not in
// the operator's runtime.
//
// Mirrors the preflight-staging-isolation pin from PR #195 (v0.21.1).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmpHome: string;
let realApprovalsBefore: Set<string>;

function listRealApprovals(): Set<string> {
  const dir = path.join(os.homedir(), ".claude", "harness.generated", ".approvals");
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ug-approve-isolation-"));
  realApprovalsBefore = listRealApprovals();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function manifest(): Manifest {
  return parseManifest({ version: 1 });
}

describe("approveUnderstanding isolation (v0.22.0 hotfix)", () => {
  it("writes ONLY under the injected homeDir/generatedDir, never under real ~/.claude/", async () => {
    // Pre-stage a manifest under the tmp homeDir so resolvePaths().base
    // resolves to <tmpHome>/harness.yaml (parallel to the real install).
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), "version: 1\n");
    const generatedDir = path.join(tmpHome, "harness.generated");

    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "isolation-pin-test-sess",
      homeDir: tmpHome,
      generatedDir,
      reportsDir: path.join(tmpHome, "reports"),
      ledgerAdd: async () => ({ ok: true }),
    });

    // The session marker landed under the tmp tree.
    expect(result.marker.ok).toBe(true);
    if (!result.marker.ok) return;
    expect(result.marker.filePath.startsWith(generatedDir)).toBe(true);

    // The real `~/.claude/harness.generated/.approvals/` directory must
    // have the SAME entries as before the call. A new entry here means a
    // future regression has reintroduced the leak.
    const realApprovalsAfter = listRealApprovals();
    const leaked = [...realApprovalsAfter].filter((n) => !realApprovalsBefore.has(n));
    expect(leaked).toEqual([]);
  });

  it("with --task: task marker also stays under the injected tree", async () => {
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), "version: 1\n");
    const generatedDir = path.join(tmpHome, "harness.generated");

    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "isolation-pin-test-sess",
      task: "isolation-pin-test-task",
      homeDir: tmpHome,
      generatedDir,
      reportsDir: path.join(tmpHome, "reports"),
      ledgerAdd: async () => ({ ok: true }),
    });

    const tm = result.taskMarkers[0];
    if (tm === undefined || !tm.ok) {
      throw new Error("expected ok task marker");
    }
    expect(tm.filePath.startsWith(generatedDir)).toBe(true);

    const realApprovalsAfter = listRealApprovals();
    const leaked = [...realApprovalsAfter].filter((n) => !realApprovalsBefore.has(n));
    expect(leaked).toEqual([]);
  });

  it("with an active-claim file under the tmp tree: task marker writes to tmp, not real", async () => {
    // Reproduces the exact scenario that bit the operator in agent-tasks
    // b5a743fc: the test simulates a track-active-claim hook having written
    // active-claim to the tmp tree. approveUnderstanding must read THAT file,
    // not the real one, and write the task marker to the tmp tree.
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), "version: 1\n");
    const generatedDir = path.join(tmpHome, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "active-claim"), "tmp-task-uuid\n");

    const result = await approveUnderstanding({
      manifest: manifest(),
      session: "isolation-pin-test-sess",
      homeDir: tmpHome,
      generatedDir,
      reportsDir: path.join(tmpHome, "reports"),
      ledgerAdd: async () => ({ ok: true }),
    });

    const tm = result.taskMarkers[0];
    if (tm === undefined || !tm.ok) {
      throw new Error("expected ok task marker from active-claim");
    }
    expect(tm.taskId).toBe("tmp-task-uuid");
    expect(tm.source).toBe("active-claim");
    expect(tm.filePath).toBe(
      path.join(generatedDir, ".approvals", "task-tmp-task-uuid"),
    );

    // CRITICAL: no task marker named after a REAL task id (which would mean
    // approveUnderstanding read the operator's real active-claim and wrote
    // a marker for their live task).
    const realApprovalsAfter = listRealApprovals();
    const leaked = [...realApprovalsAfter].filter((n) => !realApprovalsBefore.has(n));
    expect(leaked).toEqual([]);
  });
});
