// harness b56d95d3: the active-claim path read is three-way. A node there
// that cannot be read as a claim (a FIFO, a directory, an oversized or
// malformed file, a link that does not resolve) is REFUSED, not "no claim":
// reading it as absent let a session approval bound to "no claim" match.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REFUSED_CLAIM_BINDING,
} from "../../src/policy-packs/builtin/understanding-before-execution/active-claim.js";
import {
  activeClaimPathFor,
  checkActiveClaimApprovalMarker,
  checkSessionApprovalMarker,
  claimTaskIdOrNull,
  readActiveClaim,
  writeActiveClaim,
  writeApprovalMarker,
  writeTaskApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";

let tmp: string;
let generatedDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "active-claim-refused-"));
  generatedDir = path.join(tmp, "harness.generated");
  fs.mkdirSync(generatedDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const claimPath = (): string => activeClaimPathFor(generatedDir);
const SESSION = "sess-claim-refused";

/** Each way something unreadable can sit at the claim path. */
const REFUSED_SHAPES: Array<[string, () => void]> = [
  ["a directory", () => fs.mkdirSync(claimPath())],
  ["a FIFO", () => execFileSync("mkfifo", [claimPath()])],
  ["malformed content (a path-traversal id)", () => fs.writeFileSync(claimPath(), "../escape\n")],
  ["a file over the read cap", () => {
    fs.writeFileSync(claimPath(), "task-1\n");
    fs.truncateSync(claimPath(), 2 * 1024 * 1024);
  }],
  ["a dangling symlink", () => fs.symlinkSync(path.join(tmp, "never-created"), claimPath())],
  ["a self-looping symlink", () => fs.symlinkSync(claimPath(), claimPath())],
];

describe.skipIf(process.platform === "win32")("readActiveClaim: claim / absent / refused", () => {
  it("a well-formed id is a claim", () => {
    writeActiveClaim(generatedDir, "task-123");
    expect(readActiveClaim(generatedDir)).toEqual({ kind: "claim", taskId: "task-123" });
  });

  it.each([
    ["no file", () => undefined],
    ["an empty file", () => fs.writeFileSync(claimPath(), "")],
    ["a whitespace-only file", () => fs.writeFileSync(claimPath(), " \n\t\n")],
    ["a generated dir that does not exist", () => fs.rmSync(generatedDir, { recursive: true })],
    // `<file>/active-claim` fails with ENOTDIR: nothing can be claimed there.
    ["a generated dir that is a regular file (ENOTDIR)", () => {
      fs.rmSync(generatedDir, { recursive: true });
      fs.writeFileSync(generatedDir, "not a directory\n");
    }],
  ])("%s is absent", (_label, setup) => {
    setup();
    expect(readActiveClaim(generatedDir)).toEqual({ kind: "absent" });
  });

  it.each(REFUSED_SHAPES)("%s is refused, never absent", (_label, setup) => {
    setup();
    const read = readActiveClaim(generatedDir);
    expect(read.kind).toBe("refused");
    expect(claimTaskIdOrNull(read)).toBeNull();
  });

  // A claim that is THERE but cannot be opened is not "no claim": an
  // unreadable file and a generated directory that cannot be searched are
  // both refused (the `EACCES` is neither `ENOENT` nor `ENOTDIR`). Root
  // ignores permission bits, so these two cannot be constructed as root.
  it.skipIf(process.getuid?.() === 0)("a claim file with no read permission (chmod 000) is refused", () => {
    fs.writeFileSync(claimPath(), "task-9\n");
    fs.chmodSync(claimPath(), 0o000);
    try {
      const read = readActiveClaim(generatedDir);
      expect(read.kind).toBe("refused");
      expect(claimTaskIdOrNull(read)).toBeNull();
    } finally {
      fs.chmodSync(claimPath(), 0o600);
    }
  });

  it.skipIf(process.getuid?.() === 0)("a generated directory that cannot be searched is refused, even with a claim inside", () => {
    fs.writeFileSync(claimPath(), "task-9\n");
    fs.chmodSync(generatedDir, 0o600);
    try {
      const read = readActiveClaim(generatedDir);
      expect(read.kind).toBe("refused");
      expect(claimTaskIdOrNull(read)).toBeNull();
    } finally {
      fs.chmodSync(generatedDir, 0o755);
    }
  });
});

describe.skipIf(process.platform === "win32")("the session marker binding fails closed on a refused claim", () => {
  function approveNow(): void {
    writeApprovalMarker(generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
  }

  it.each(REFUSED_SHAPES)(
    "a marker bound to NO claim does not match while %s sits at the claim path",
    (_label, setup) => {
      approveNow(); // nothing claimed: the marker binds to null
      expect(checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true })).toMatchObject({
        matched: true,
      });

      setup();
      const check = checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true });
      expect(check).toMatchObject({ matched: false, bindingRefused: true, expired: false, forged: false });
      expect(check.detail).toMatch(/active claim could not be read/);
    },
  );

  it("a marker written WHILE the claim path is refused binds to nothing, so it never matches once the path is cleared or repaired", () => {
    fs.mkdirSync(claimPath());
    approveNow();
    const marker = JSON.parse(
      fs.readFileSync(path.join(generatedDir, ".approvals", SESSION), "utf8"),
    ) as { claimTaskId: string };
    expect(marker.claimTaskId).toBe(REFUSED_CLAIM_BINDING);

    // Still refused.
    expect(checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true }).matched).toBe(false);
    // Cleared to absent: a null-bound marker would match here, this one must not.
    fs.rmdirSync(claimPath());
    const cleared = checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true });
    expect(cleared).toMatchObject({ matched: false, bindingRefused: true });
    expect(cleared.detail).toMatch(/unreadable active claim/);
    // Repaired to a real claim: still not bound to it.
    writeActiveClaim(generatedDir, "task-9");
    expect(checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true }).matched).toBe(false);
  });

  it("control: a marker bound to NO claim still matches while no claim is recorded", () => {
    approveNow();
    expect(checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true })).toMatchObject({
      matched: true,
      bindingRefused: false,
    });
  });

  it("control: a marker bound to a task matches while that task's claim is readable", () => {
    writeActiveClaim(generatedDir, "task-5");
    approveNow();
    expect(checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: true }).matched).toBe(true);
  });

  it("the binding is not applied under approval_lifecycle mode: session (documented contract)", () => {
    approveNow();
    fs.mkdirSync(claimPath());
    expect(checkSessionApprovalMarker(generatedDir, SESSION, { taskBinding: false }).matched).toBe(true);
  });

  it("the task-scoped check does not match on a refused claim and says why", () => {
    writeTaskApprovalMarker(generatedDir, "task-5", {
      approvedAt: new Date().toISOString(),
      approvedBy: "test-operator",
    });
    writeActiveClaim(generatedDir, "task-5");
    expect(checkActiveClaimApprovalMarker(generatedDir).matched).toBe(true);

    fs.rmSync(claimPath());
    fs.mkdirSync(claimPath());
    const check = checkActiveClaimApprovalMarker(generatedDir);
    expect(check.matched).toBe(false);
    expect(check.detail).toMatch(/active-claim could not be read/);
  });
});
