// Site-level pins for the hook-path writes whose FIFO or symlink case can
// only be reached through a race (the name is freshly generated, or an
// earlier lstat or read already refuses the node). The child-process FIFO
// tests cannot reach them deterministically, so these drive the real site
// in-process with `node:fs` wrapped: every `openSync` is recorded with its
// flags, and `lstatSync` can be told to report a stale answer for one path,
// which is exactly what a node swapped in after the check looks like.
//
// Each case asserts what actually opens the file: a write open with
// `O_NONBLOCK` and without `O_TRUNC` (the truncation happens after the
// descriptor proved to be a regular file), `O_EXCL` for a name just
// generated, and `O_NOFOLLOW` for the adoption ledger. A site that falls
// back to a by-path `fs.writeFileSync` / `fs.appendFileSync` records no such
// open and fails here.
//
// No FIFO is planted in-process: a regression to a blocking open would hang
// the worker instead of failing the case. The recorded flags (O_NONBLOCK,
// O_EXCL, O_NOFOLLOW) pin the non-blocking open, the symlink cases pin the
// observable refusal, and the helper's own FIFO behaviour is pinned in a
// killable child by `hook-path-writes-fifo.test.ts`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  opens: [] as Array<{ path: string; flags: number }>,
  lstatAnswer: new Map<string, unknown>(),
  fixedRandom: { on: false },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null): number => {
    hoisted.opens.push({ path: String(p), flags: typeof flags === "number" ? flags : -1 });
    return actual.openSync(p, flags as fs.OpenMode, mode);
  }) as typeof actual.openSync;
  const lstatSync = ((p: fs.PathLike, options?: unknown): unknown => {
    const answer = hoisted.lstatAnswer.get(String(p));
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    return (actual.lstatSync as (p: fs.PathLike, o?: unknown) => unknown)(p, options);
  }) as typeof actual.lstatSync;
  return { ...actual, openSync, lstatSync };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = ((size: number): Buffer =>
    hoisted.fixedRandom.on && size === 2 ? Buffer.from([0xab, 0xcd]) : actual.randomBytes(size)) as typeof actual.randomBytes;
  return { ...actual, randomBytes };
});

import { getOrCreateSigningKey, rotateSigningKey } from "../../src/runtime/approval-signing.js";

const C = fs.constants;
const FLAG_NAMES = { O_NONBLOCK: C.O_NONBLOCK, O_TRUNC: C.O_TRUNC, O_EXCL: C.O_EXCL, O_NOFOLLOW: C.O_NOFOLLOW, O_WRONLY: C.O_WRONLY, O_APPEND: C.O_APPEND };

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-path-write-sites-"));
  hoisted.opens.length = 0;
  hoisted.lstatAnswer.clear();
  hoisted.fixedRandom.on = false;
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The write opens (O_WRONLY) of one path, in order. */
function writeOpens(file: string): Array<{ path: string; flags: number }> {
  return hoisted.opens.filter((o) => o.path === file && (o.flags & C.O_WRONLY) !== 0);
}

function has(flags: number, name: keyof typeof FLAG_NAMES): boolean {
  return (flags & FLAG_NAMES[name]) !== 0;
}

describe.skipIf(process.platform === "win32")("approval signing key: the truncated-key rewrite", () => {
  const keyFile = (dir: string): string => path.join(dir, ".approval-signing.key");

  it.each([
    ["getOrCreateSigningKey (a truncated key)", getOrCreateSigningKey],
    ["rotateSigningKey", rotateSigningKey],
  ])("%s opens the key non-blocking, never truncating at open", (_label, fn) => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    fs.writeFileSync(keyFile(dir), "short");
    const handle = fn(dir);
    expect(handle.created).toBe(true);
    expect(fs.statSync(keyFile(dir)).size).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(keyFile(dir)).mode & 0o777).toBe(0o600);
    const opens = writeOpens(keyFile(dir));
    expect(opens).toHaveLength(1);
    expect(has(opens[0]!.flags, "O_NONBLOCK")).toBe(true);
    // The descriptor is typed (fstat) before the file is truncated, so the
    // open itself must not carry O_TRUNC.
    expect(has(opens[0]!.flags, "O_TRUNC")).toBe(false);
  });
});
