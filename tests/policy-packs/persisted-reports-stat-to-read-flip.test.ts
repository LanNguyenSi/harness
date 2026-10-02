// Task 4b39022f: the hook-time reads of files the gated agent can write (the
// persisted reports and the parse-error logs) must not decide what a path IS
// with a stat and then read the path. A symlink to a regular file that is
// retargeted to a FIFO between the two used to hang the read (measured as a
// nondeterministic 4/20 and 1/20 in the built hooks). This test makes the
// window deterministic: every stat-like call on the planted entry sees a
// symlink to the regular file, and right after it returns a symlink to a FIFO
// is swapped over the entry. The bounded readers open the entry once
// (non-blocking), type it with fstat on the descriptor and read through that,
// so they see the FIFO as "not a regular file" and skip it; a stat followed by
// a path read would read the FIFO instead, however many stats came before. A
// spawned writer feeds the FIFO valid-looking content, so such a regression
// fails the assertion rather than hanging the worker. A safe variant (lstat,
// then the bounded read) must still pass: the test pins the behaviour (the
// FIFO is never read), not "never stat".

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  beforeStat: null as null | ((p: string) => void),
  onStat: null as null | ((p: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const wrap =
    <F extends (...a: never[]) => unknown>(fn: F): F =>
    ((...args: Parameters<F>) => {
      hook.beforeStat?.(String(args[0]));
      const result = fn(...args);
      hook.onStat?.(String(args[0]));
      return result;
    }) as F;
  const mod = {
    ...orig,
    statSync: wrap(orig.statSync),
    lstatSync: wrap(orig.lstatSync),
    existsSync: wrap(orig.existsSync),
    accessSync: wrap(orig.accessSync),
  };
  return { ...mod, default: mod };
});

import * as fs from "node:fs";
import { findLatestParseError } from "../../src/cli/approve/understanding.js";
import { listPersistedReportsBounded } from "../../src/policy-packs/builtin/understanding-before-execution/persisted-reports.js";

let writer: ChildProcess | undefined;
let tmp: string | undefined;

afterEach(() => {
  hook.beforeStat = null;
  hook.onStat = null;
  writer?.kill("SIGKILL");
  writer = undefined;
  if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/**
 * A directory holding `entry`, a symlink to a regular file with
 * `regularContent`, plus a FIFO that a writer feeds `fifoContent`. Every
 * stat-like call on `entry` sees the regular file; right after it returns, a
 * symlink to the FIFO is swapped over the entry.
 */
function plantFlip(
  dirName: string,
  entryName: string,
  regularContent: string,
  fifoContent: string,
): { dir: string; entry: string } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-flip-"));
  const dir = path.join(tmp, dirName);
  fs.mkdirSync(dir);
  const regular = path.join(tmp, "regular-target");
  fs.writeFileSync(regular, regularContent);
  const pipe = path.join(tmp, "pipe");
  execFileSync("mkfifo", [pipe]);
  const entry = path.join(dir, entryName);
  fs.symlinkSync(regular, entry);
  const point = (target: string): void => {
    const link = path.join(tmp as string, "flip-link");
    fs.symlinkSync(target, link);
    fs.renameSync(link, entry);
  };
  hook.beforeStat = (p) => {
    if (p === entry) point(regular);
  };
  hook.onStat = (p) => {
    if (p === entry) point(pipe);
  };
  writer = spawn("sh", ["-c", 'printf "%s" "$1" > "$2"', "sh", fifoContent, pipe], {
    stdio: "ignore",
    timeout: 10_000,
  });
  return { dir, entry };
}

describe("an entry flipped to a FIFO after a stat is never read as the FIFO", () => {
  it("report listing: the FIFO's approved content is never listed", () => {
    const { dir } = plantFlip(
      "reports",
      "a.json",
      JSON.stringify({ sessionId: "s", approvalStatus: "pending", createdAt: "2026-10-01T10:00:00.000Z" }),
      JSON.stringify({ sessionId: "s", approvalStatus: "approved", createdAt: "2026-10-01T11:00:00.000Z" }),
    );

    const listed = listPersistedReportsBounded(dir);

    expect(listed.some((r) => r.approvalStatus === "approved")).toBe(false);
  });

  it("parse-error log lookup: the FIFO's header is never read as the session's parse error", () => {
    const header = (note: string): string =>
      `${JSON.stringify({ sessionId: "s", message: note })}\n--- raw ---\nthe agent's last message`;
    const { dir } = plantFlip("parse-errors", "a.log", "not a header of the session", header("FROM-THE-FIFO"));

    const found = findLatestParseError(dir, "s");

    expect(found).toBeNull();
  });
});
