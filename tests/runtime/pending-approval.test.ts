import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENERATED_DIRNAME,
  PENDING_APPROVAL_BASENAME,
  clearPendingApproval,
  pendingApprovalPath,
  readPendingApproval,
  resolveGeneratedDir,
  writePendingApproval,
} from "../../src/runtime/pending-approval.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pending-approval-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveGeneratedDir", () => {
  it("places harness.generated/ next to the manifest by default", () => {
    expect(resolveGeneratedDir({ manifestPath: "/home/u/.claude/harness.yaml" })).toBe(
      path.join("/home/u/.claude", GENERATED_DIRNAME),
    );
  });

  it("honours an explicit homeDir override regardless of manifest path", () => {
    expect(
      resolveGeneratedDir({ homeDir: "/tmp/h", manifestPath: "/elsewhere/harness.yaml" }),
    ).toBe(path.join("/tmp/h", GENERATED_DIRNAME));
  });
});

describe("pendingApprovalPath", () => {
  it("joins the staging basename onto the generated dir", () => {
    expect(pendingApprovalPath("/x/harness.generated")).toBe(
      path.join("/x/harness.generated", PENDING_APPROVAL_BASENAME),
    );
  });
});

describe("writePendingApproval / readPendingApproval round-trip", () => {
  it("writes the session id and reads it back", () => {
    writePendingApproval(tmp, "sess-abc");
    expect(readPendingApproval(tmp)).toBe("sess-abc");
  });

  it("creates the generated dir if it does not exist yet", () => {
    const nested = path.join(tmp, "harness.generated");
    expect(fs.existsSync(nested)).toBe(false);
    writePendingApproval(nested, "sess-xyz");
    expect(readPendingApproval(nested)).toBe("sess-xyz");
  });

  it("overwrites a previously staged id (latest block wins)", () => {
    writePendingApproval(tmp, "sess-old");
    writePendingApproval(tmp, "sess-new");
    expect(readPendingApproval(tmp)).toBe("sess-new");
  });

  it("trims the trailing newline and surrounding whitespace on read", () => {
    fs.writeFileSync(pendingApprovalPath(tmp), "  sess-padded \n");
    expect(readPendingApproval(tmp)).toBe("sess-padded");
  });
});

describe("readPendingApproval — absent / empty", () => {
  it("returns null when the file does not exist", () => {
    expect(readPendingApproval(tmp)).toBeNull();
  });

  it("returns null when the file is empty", () => {
    fs.writeFileSync(pendingApprovalPath(tmp), "");
    expect(readPendingApproval(tmp)).toBeNull();
  });

  it("returns null when the file is whitespace-only", () => {
    fs.writeFileSync(pendingApprovalPath(tmp), "  \n\t\n");
    expect(readPendingApproval(tmp)).toBeNull();
  });
});

describe("clearPendingApproval", () => {
  it("removes the staging file", () => {
    writePendingApproval(tmp, "sess-1");
    expect(readPendingApproval(tmp)).toBe("sess-1");
    clearPendingApproval(tmp);
    expect(readPendingApproval(tmp)).toBeNull();
    expect(fs.existsSync(pendingApprovalPath(tmp))).toBe(false);
  });

  it("is a no-op (does not throw) when the file is already gone", () => {
    expect(() => clearPendingApproval(tmp)).not.toThrow();
  });
});
