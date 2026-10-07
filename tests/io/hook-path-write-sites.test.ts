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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
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
    return actual.openSync(p, flags, mode);
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

import { recordAdoptedEntry } from "../../src/cli/pack/hook-pre-tool-use.js";
import { runSessionStartPreflight, type RunPreflightResult } from "../../src/cli/session-start/index.js";
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

describe.skipIf(process.platform === "win32")("delegation adoption ledger: the append after a stale lstat", () => {
  const gen = (): string => path.join(tmp, "gen");
  const ledgerFile = (): string => path.join(gen(), ".delegation-adoptions", "child-1");
  const victim = (): string => path.join(tmp, "victim");

  beforeEach(() => {
    fs.mkdirSync(path.join(gen(), ".delegation-adoptions"), { recursive: true });
    fs.writeFileSync(victim(), "keep\n");
    fs.symlinkSync(victim(), ledgerFile());
  });

  const stale: Array<[string, () => unknown]> = [
    ["absent", () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })],
    ["a regular file", () => fs.statSync(victim())],
  ];

  it.each(stale)(
    "an lstat that reports the path as %s while a symlink sits there: the open refuses it (ELOOP) and the target is untouched",
    (_label, answer) => {
      hoisted.lstatAnswer.set(ledgerFile(), answer());
      const result = recordAdoptedEntry(gen(), "child-1", "uuid:a");
      expect(result.ok).toBe(false);
      expect((result as { detail: string }).detail).toMatch(/ELOOP/);
      expect(fs.readFileSync(victim(), "utf8")).toBe("keep\n");
      const opens = writeOpens(ledgerFile());
      expect(opens).toHaveLength(1);
      expect(has(opens[0]!.flags, "O_NOFOLLOW")).toBe(true);
      expect(has(opens[0]!.flags, "O_NONBLOCK")).toBe(true);
      expect(has(opens[0]!.flags, "O_APPEND")).toBe(true);
    },
  );

  it("an lstat that reports the path as absent while a FIFO sits there: refused at once, nothing blocks", () => {
    fs.rmSync(ledgerFile());
    execFileSync("mkfifo", [ledgerFile()]);
    hoisted.lstatAnswer.set(ledgerFile(), Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = recordAdoptedEntry(gen(), "child-1", "uuid:a");
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toMatch(/ENXIO/);
  });
});

describe.skipIf(process.platform === "win32")("preflight fail log: the write opens exclusively, non-blocking", () => {
  const notReady = async (): Promise<RunPreflightResult> => ({
    ok: true,
    json: { ready: false, confidence: 0.2, checks: [{ name: "x", status: "fail", details: ["boom"] }] },
  });

  function repoFixture(): string {
    const repo = path.join(tmp, "widget-service");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  async function runOnce(repo: string, logDir: string): Promise<{ reason: string | undefined; stderr: string }> {
    let err = "";
    const stderr = new Writable({
      write(chunk, _enc, cb): void {
        err += chunk.toString("utf8");
        cb();
      },
    });
    const result = await runSessionStartPreflight({
      stdin: Readable.from([JSON.stringify({ session_id: "s", cwd: repo })]),
      stderr,
      logDir,
      runPreflight: notReady,
      writeLedger: async () => ({ ok: true }),
    });
    return { reason: result.reason, stderr: err };
  }

  function pinName(): void {
    hoisted.fixedRandom.on = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00.123Z"));
  }

  it("the log file is created with O_EXCL | O_NONBLOCK and without O_TRUNC", async () => {
    const logDir = path.join(tmp, "logs");
    const { reason } = await runOnce(repoFixture(), logDir);
    expect(reason).toContain("; log: ");
    const [file] = fs.readdirSync(logDir);
    const opens = writeOpens(path.join(logDir, file!));
    expect(opens).toHaveLength(1);
    expect(has(opens[0]!.flags, "O_EXCL")).toBe(true);
    expect(has(opens[0]!.flags, "O_NONBLOCK")).toBe(true);
    expect(has(opens[0]!.flags, "O_TRUNC")).toBe(false);
  });

  it("a symlink planted at the generated name fails EEXIST and its target is not written", async () => {
    pinName();
    const logDir = path.join(tmp, "logs");
    const repo = repoFixture();
    // Learn the (now deterministic) generated name from a first run.
    await runOnce(repo, logDir);
    const [name] = fs.readdirSync(logDir);
    expect(name).toBe("preflight-widget-service-2026-10-07T10-00-00-123Z-abcd.json");
    fs.rmSync(path.join(logDir, name!));
    const victim = path.join(tmp, "victim");
    fs.writeFileSync(victim, "keep\n");
    fs.symlinkSync(victim, path.join(logDir, name!));

    const { reason, stderr } = await runOnce(repo, logDir);
    expect(stderr).toContain("preflight fail-log write failed");
    expect(stderr).toContain("EEXIST");
    expect(reason).not.toContain("; log:");
    expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
  });

  it("a FIFO planted at the generated name fails EEXIST without blocking", async () => {
    pinName();
    const logDir = path.join(tmp, "logs");
    const repo = repoFixture();
    await runOnce(repo, logDir);
    const [name] = fs.readdirSync(logDir);
    fs.rmSync(path.join(logDir, name!));
    execFileSync("mkfifo", [path.join(logDir, name!)]);

    const { stderr } = await runOnce(repo, logDir);
    expect(stderr).toContain("preflight fail-log write failed");
    expect(stderr).toContain("EEXIST");
  });
});
