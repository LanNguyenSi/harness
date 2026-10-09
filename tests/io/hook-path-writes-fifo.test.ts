// A by-path write on a hook path must never block on a FIFO past the hook's
// budget, which the runtime treats as an allow (task b56d95d3, the write-side
// counterpart of bounded-hook-reads-fifo.test.ts). `fs.writeFileSync` /
// `fs.appendFileSync` open the path blocking: a FIFO with no reader holds the
// call until one shows up.
//
// Every case runs the BUILT module in a child process under a SIGKILL
// timeout, so a regression to a blocking open shows up as a killed child, not
// as a hung worker. Each FIFO case has a control case against a regular file
// through the same child, so a case cannot pass because the module path or
// export name was wrong.
//
// What each block pins: the lock target is pinned end to end (a FIFO at the
// path, a bounded child). The last describe block holds the shared helper's
// own FIFO cases, including the one with a reader attached.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distUrl, expectBounded, mkfifo, runChild, type ChildRun } from "../_helpers/fifo-child.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-path-writes-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CALL_SCRIPT = `
const [, modPath, fn, rawArgs] = process.argv;
const mod = await import(modPath);
try {
  const out = await mod[fn](...JSON.parse(rawArgs));
  process.stdout.write(JSON.stringify({ ok: out === undefined ? null : out }));
} catch (err) {
  process.stdout.write(JSON.stringify({ threw: { name: err && err.name, code: err && err.code } }));
}
`;

function callInChild(modRel: string, fn: string, args: unknown[]): ChildRun {
  return runChild(CALL_SCRIPT, [distUrl(modRel), fn, JSON.stringify(args)]);
}

describe.skipIf(process.platform === "win32")("lock target: creating it never follows a link or waits on a FIFO", () => {
  const LOCK_SCRIPT = `
const [, modPath, target] = process.argv;
const mod = await import(modPath);
try {
  await mod.withFileLock(target, async () => { process.stdout.write(JSON.stringify({ ran: true })); }, { retries: 0 });
} catch (err) {
  process.stdout.write(JSON.stringify({ threw: { name: err && err.name, code: err && err.code } }));
}
`;
  function runLock(target: string): ChildRun {
    return runChild(LOCK_SCRIPT, [distUrl("io/lock.js"), target]);
  }

  it("control: an absent lock target is created empty and the callback runs", () => {
    const target = path.join(tmp, "harness.lock-target");
    const run = runLock(target);
    expectBounded(run);
    expect(run.value).toEqual({ ran: true });
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("a FIFO at the lock target does not hold the call", () => {
    const target = path.join(tmp, "harness.lock-target");
    mkfifo(target);
    const run = runLock(target);
    expectBounded(run);
  });

  it("a dangling symlink at the lock target is not written through to its target", () => {
    const victim = path.join(tmp, "victim");
    const target = path.join(tmp, "harness.lock-target");
    fs.symlinkSync(victim, target);
    const run = runLock(target);
    expectBounded(run);
    expect(fs.existsSync(victim)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("write helper: the one non-blocking open every hook-path write stands on", () => {
  const MOD = "io/write-regular-file.js";
  const HELD_READER_SCRIPT = `
const [, modPath, fifo, fn] = process.argv;
const fs = await import("node:fs");
const mod = await import(modPath);
// A reader attached: the non-blocking write open now SUCCEEDS, so only the
// descriptor type check stands between the write and the pipe.
const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
try {
  mod[fn](fifo, "payload\\n");
  process.stdout.write(JSON.stringify({ wrote: true }));
} catch (err) {
  const buf = Buffer.alloc(64);
  let got = 0;
  try { got = fs.readSync(reader, buf, 0, 64, null); } catch {}
  process.stdout.write(JSON.stringify({ threw: { code: err && err.code }, leaked: got }));
}
`;

  it("control: write replaces the content of a regular file", () => {
    const file = path.join(tmp, "f");
    fs.writeFileSync(file, "old content that is longer\n");
    expectBounded(callInChild(MOD, "writeRegularFileNonBlocking", [file, "new\n"]));
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
  });

  it("write: a FIFO with no reader throws ENXIO within the bound", () => {
    const fifo = path.join(tmp, "fifo");
    mkfifo(fifo);
    const run = callInChild(MOD, "writeRegularFileNonBlocking", [fifo, "x"]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "ENXIO" } });
  });

  it("write: a FIFO WITH a reader is refused by the descriptor type check, nothing reaches the pipe", () => {
    const fifo = path.join(tmp, "fifo");
    mkfifo(fifo);
    const run = runChild(HELD_READER_SCRIPT, [distUrl(MOD), fifo, "writeRegularFileNonBlocking"]);
    expectBounded(run);
    expect(run.value).toEqual({ threw: { code: "E_NOT_REGULAR" }, leaked: 0 });
  });

  it("exclusive create: anything already at the path is EEXIST, a FIFO included", () => {
    const fifo = path.join(tmp, "fifo");
    mkfifo(fifo);
    const run = callInChild(MOD, "writeRegularFileNonBlocking", [fifo, "x", { create: "exclusive" }]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "EEXIST" } });
  });

  it("write with noFollow: a symlink at the path is refused (ELOOP), the target untouched", () => {
    const target = path.join(tmp, "target");
    fs.writeFileSync(target, "keep\n");
    const link = path.join(tmp, "link");
    fs.symlinkSync(target, link);
    const run = callInChild(MOD, "writeRegularFileNonBlocking", [link, "x\n", { noFollow: true }]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "ELOOP" } });
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
  });
});
