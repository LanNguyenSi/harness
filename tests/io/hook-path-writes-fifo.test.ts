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
// What each block pins: the stay-in-scope audit log, the lock target and the
// signing key's rotate path are pinned end to end (a FIFO at the path, a
// bounded child). The adoption-ledger blocks pin the whole append including
// its friendlier `lstat` refusal, which is what a FIFO or symlink placed
// BEFORE the call hits; the open's own defence (a node swapped in after the
// `lstat`) cannot be reached by a plain FIFO, so it is pinned at the site,
// with the open flags recorded, in
// `hook-path-write-sites.test.ts`. The last describe block holds the shared
// helper's own FIFO cases, including the one with a reader attached.

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

describe.skipIf(process.platform === "win32")("stay-in-scope: a FIFO at the audit log path fails the append, never waits", () => {
  const SCOPE_SCRIPT = `
const [, modPath, schemaPath, logPath, genDir] = process.argv;
const { Readable, Writable } = await import("node:stream");
const mod = await import(modPath);
const { parseManifest } = await import(schemaPath);
let err = "";
const stderr = new Writable({ write(c, _e, cb) { err += c; cb(); } });
const manifest = parseManifest({ version: 1, policy_packs: [{ name: "understanding-before-execution", enabled: true, config: { stay_in_scope: {
  enabled: true,
  tools: ["mcp__demo_tasks__create"],
  label_markers: ["review-followup"],
  description_markers: ["Review follow-up:"],
  description_window: { marker: "## Context", contains: "review", max_chars: 80 },
  parent_reference_pattern: "Parent work: #([0-9]+)",
  parent_url_pattern: "https://example\\.test/[^\\s]+/work/[0-9]+",
  messages: { reminder: "r", second_order: "s" },
} } }] });
const result = await mod.runPackHookStayInScopeCli({
  manifest, generatedDir: genDir, logPath, env: {}, stderr,
  stdin: Readable.from([JSON.stringify({ tool_name: "mcp__demo_tasks__create", tool_input: { labels: ["review-followup"], description: "d" } })]),
});
process.stdout.write(JSON.stringify({ result, stderr: err }));
`;
  function runScope(logPath: string): ChildRun {
    return runChild(SCOPE_SCRIPT, [
      distUrl("cli/pack/hook-stay-in-scope.js"),
      distUrl("schema/index.js"),
      logPath,
      path.join(tmp, "generated"),
    ]);
  }

  it("control: a regular audit log is appended to", () => {
    const log = path.join(tmp, "audit.jsonl");
    fs.writeFileSync(log, "");
    const run = runScope(log);
    expectBounded(run);
    expect((run.value as { result: { logged: boolean } }).result.logged).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toMatch(/"matchedRule":"label"/);
  });

  it("a FIFO at the audit log path is reported as a failed append within the bound", () => {
    const log = path.join(tmp, "audit.jsonl");
    mkfifo(log);
    const run = runScope(log);
    expectBounded(run);
    const out = run.value as { result: { logged: boolean }; stderr: string };
    expect(out.result.logged).toBe(false);
    expect(out.stderr).toMatch(/audit append FAILED/);
  });
});

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

describe.skipIf(process.platform === "win32")("approval signing key: rewriting a key never opens a FIFO blocking", () => {
  const MOD = "runtime/approval-signing.js";

  it("control: rotating over a regular key replaces it with a 0600 key", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".approval-signing.key"), "short");
    const run = callInChild(MOD, "rotateSigningKey", [dir]);
    expectBounded(run);
    expect((run.value as { ok: { created: boolean } }).ok.created).toBe(true);
    expect(fs.statSync(path.join(dir, ".approval-signing.key")).size).toBeGreaterThanOrEqual(32);
  });

  it("a FIFO at the key path makes the rewrite throw within the bound", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    mkfifo(path.join(dir, ".approval-signing.key"));
    const run = callInChild(MOD, "rotateSigningKey", [dir]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "ENXIO" } });
  });

  it("a truncated regular key is repaired in place", () => {
    const dir = path.join(tmp, "gen");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".approval-signing.key"), "short");
    const run = callInChild(MOD, "getOrCreateSigningKey", [dir]);
    expectBounded(run);
    expect((run.value as { ok: { created: boolean } }).ok.created).toBe(true);
    expect(fs.statSync(path.join(dir, ".approval-signing.key")).size).toBeGreaterThanOrEqual(32);
  });
});

describe.skipIf(process.platform === "win32")("delegation adoption ledger: the append refuses a FIFO or a symlink at its path", () => {
  const MOD = "cli/pack/hook-pre-tool-use.js";
  const ledgerFile = (): string => path.join(tmp, "gen", ".delegation-adoptions", "child-1");

  it("control: an entry id is appended to a regular ledger file (mode 0600 on creation)", () => {
    fs.mkdirSync(path.join(tmp, "gen"));
    expect(callInChild(MOD, "recordAdoptedEntry", [path.join(tmp, "gen"), "child-1", "uuid:a"]).value).toEqual({ ok: { ok: true } });
    expectBounded(callInChild(MOD, "recordAdoptedEntry", [path.join(tmp, "gen"), "child-1", "uuid:b"]));
    expect(fs.readFileSync(ledgerFile(), "utf8")).toBe("uuid:a\nuuid:b\n");
    expect(fs.statSync(ledgerFile()).mode & 0o777).toBe(0o600);
  });

  it("a FIFO at the ledger path is refused within the bound", () => {
    fs.mkdirSync(path.join(tmp, "gen", ".delegation-adoptions"), { recursive: true });
    mkfifo(ledgerFile());
    const run = callInChild(MOD, "recordAdoptedEntry", [path.join(tmp, "gen"), "child-1", "uuid:a"]);
    expectBounded(run);
    expect(run.value).toMatchObject({ ok: { ok: false } });
  });

  it("a symlink at the ledger path is refused and its target is left untouched", () => {
    fs.mkdirSync(path.join(tmp, "gen", ".delegation-adoptions"), { recursive: true });
    const target = path.join(tmp, "elsewhere");
    fs.writeFileSync(target, "keep\n");
    fs.symlinkSync(target, ledgerFile());
    const run = callInChild(MOD, "recordAdoptedEntry", [path.join(tmp, "gen"), "child-1", "uuid:a"]);
    expectBounded(run);
    expect(run.value).toMatchObject({ ok: { ok: false } });
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
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

  it("control: write replaces and append appends, on a regular file", () => {
    const file = path.join(tmp, "f");
    fs.writeFileSync(file, "old content that is longer\n");
    expectBounded(callInChild(MOD, "writeRegularFileNonBlocking", [file, "new\n"]));
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");
    expectBounded(callInChild(MOD, "appendRegularFileNonBlocking", [file, "more\n"]));
    expect(fs.readFileSync(file, "utf8")).toBe("new\nmore\n");
  });

  it("write: a FIFO with no reader throws ENXIO within the bound", () => {
    const fifo = path.join(tmp, "fifo");
    mkfifo(fifo);
    const run = callInChild(MOD, "writeRegularFileNonBlocking", [fifo, "x"]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "ENXIO" } });
  });

  it("append: a FIFO with no reader throws ENXIO within the bound", () => {
    const fifo = path.join(tmp, "fifo");
    mkfifo(fifo);
    const run = callInChild(MOD, "appendRegularFileNonBlocking", [fifo, "x"]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "ENXIO" } });
  });

  it.each(["writeRegularFileNonBlocking", "appendRegularFileNonBlocking"])(
    "%s: a FIFO WITH a reader is refused by the descriptor type check, nothing reaches the pipe",
    (fn) => {
      const fifo = path.join(tmp, "fifo");
      mkfifo(fifo);
      const run = runChild(HELD_READER_SCRIPT, [distUrl(MOD), fifo, fn]);
      expectBounded(run);
      expect(run.value).toEqual({ threw: { code: "E_NOT_REGULAR" }, leaked: 0 });
    },
  );

  it("exclusive create: anything already at the path is EEXIST, a FIFO included", () => {
    const fifo = path.join(tmp, "fifo");
    mkfifo(fifo);
    const run = callInChild(MOD, "writeRegularFileNonBlocking", [fifo, "x", { create: "exclusive" }]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "EEXIST" } });
  });

  it("append with noFollow: a symlink at the path is refused (ELOOP), the target untouched", () => {
    const target = path.join(tmp, "target");
    fs.writeFileSync(target, "keep\n");
    const link = path.join(tmp, "link");
    fs.symlinkSync(target, link);
    const run = callInChild(MOD, "appendRegularFileNonBlocking", [link, "x\n", { noFollow: true }]);
    expectBounded(run);
    expect(run.value).toMatchObject({ threw: { code: "ELOOP" } });
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
  });
});
