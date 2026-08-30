// Direct unit tests for permission-mode-observations.ts's read/write pair
// (task 8f637efd, review round 2: the reviewer listed these as cheap
// tests missing from the CLI-level hook tests in
// tests/cli/pack-hook-pre-tool-use-permission-mode-observation.test.ts).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listPermissionModeObservations,
  permissionModeObservationPathFor,
  recordPermissionModeObservation,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";

let tmp: string;
let generatedDir: string;
let obsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-perm-mode-obs-unit-"));
  generatedDir = path.join(tmp, "harness.generated");
  obsDir = path.join(generatedDir, ".permission-mode-observations");
  fs.mkdirSync(obsDir, { recursive: true });
});

afterEach(() => {
  // Restore permissions before rmSync so cleanup itself does not fail.
  try {
    fs.chmodSync(generatedDir, 0o700);
  } catch {
    // generatedDir may already be gone or never chmod'd; ignore.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeObservation(sessionId: string, body: unknown): string {
  const full = path.join(obsDir, sessionId);
  fs.writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  return full;
}

describe("listPermissionModeObservations: read-path robustness (review round 2)", () => {
  it("skips a symlinked entry silently: not counted as an entry or as unreadable", () => {
    const target = path.join(tmp, "outside.json");
    fs.writeFileSync(
      target,
      JSON.stringify({
        sessionId: "outside-sid",
        permissionMode: "bypassPermissions",
        observedAt: "2026-08-29T10:00:00.000Z",
      }),
    );
    fs.symlinkSync(target, path.join(obsDir, "symlinked-sid"));

    const result = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(result.dirPresent).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.unreadableCount).toBe(0);
  });

  it("skips a non-regular entry (a directory) silently: not counted as an entry or as unreadable", () => {
    fs.mkdirSync(path.join(obsDir, "a-directory-not-a-file"));

    const result = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(result.entries).toEqual([]);
    expect(result.unreadableCount).toBe(0);
  });

  it("counts malformed JSON as unreadable, not as an entry", () => {
    writeObservation("bad-json-sid", "not json at all {{{");

    const result = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(result.entries).toEqual([]);
    expect(result.unreadableCount).toBe(1);
  });

  it("counts valid JSON missing a required field as unreadable, not as an entry", () => {
    writeObservation("missing-field-sid", { sessionId: "missing-field-sid", observedAt: "2026-08-29T10:00:00.000Z" });

    const result = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(result.entries).toEqual([]);
    expect(result.unreadableCount).toBe(1);
  });

  it("a good observation alongside a symlink and a malformed one: only the good one is an entry, only the malformed one counts as unreadable", () => {
    writeObservation("good-sid", {
      sessionId: "good-sid",
      permissionMode: "bypassPermissions",
      observedAt: "2026-08-29T10:00:00.000Z",
    });
    writeObservation("bad-sid", "{not valid json");
    const target = path.join(tmp, "outside2.json");
    fs.writeFileSync(target, "{}");
    fs.symlinkSync(target, path.join(obsDir, "symlinked-sid"));

    const result = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(result.entries.map((e) => e.sessionId)).toEqual(["good-sid"]);
    expect(result.unreadableCount).toBe(1);
  });
});

describe("recordPermissionModeObservation: fail-open on write errors (review round 2)", () => {
  it("an unwritable generatedDir warns exactly once on stderr and never throws", () => {
    // chmod does not stop root (repo precedent: tests/cli/gc.test.ts).
    if (process.getuid?.() === 0) return;
    // Make generatedDir itself read-only so atomicWriteFile's mkdirSync
    // (recursive, creating .permission-mode-observations/ under it, since
    // this test starts from a FRESH generatedDir with no obs dir yet)
    // fails.
    const freshGeneratedDir = path.join(tmp, "fresh-generated");
    fs.mkdirSync(freshGeneratedDir, { recursive: true });
    fs.chmodSync(freshGeneratedDir, 0o500);

    let stderrCalls = 0;
    let lastMessage = "";
    const stderr = {
      write(s: string): boolean {
        stderrCalls += 1;
        lastMessage = s;
        return true;
      },
    };

    expect(() => {
      recordPermissionModeObservation(freshGeneratedDir, "sess-unwritable", "bypassPermissions", stderr);
    }).not.toThrow();

    expect(stderrCalls).toBe(1);
    expect(lastMessage).toContain("failed to write permission-mode observation");
    expect(lastMessage).toContain("sess-unwritable");

    fs.chmodSync(freshGeneratedDir, 0o700);
    expect(fs.existsSync(permissionModeObservationPathFor(freshGeneratedDir, "sess-unwritable"))).toBe(false);
  });
});
