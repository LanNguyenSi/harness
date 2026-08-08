import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  runSessionStartStaleBaseCheck,
  type StaleBaseCheckArgs,
} from "../../../src/cli/session-start/stale-base-check.js";
import { HermeticSpawnViolationError } from "../../../src/runtime/hermetic-spawn-guard.js";
import { parseManifest, type Manifest } from "../../../src/schema/index.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function manifestWithConfig(config: Record<string, unknown> = {}): Manifest {
  return parseManifest({ version: 1, stale_base_check: config });
}

/** Hand-crafted `.git/HEAD` fixture — no real git needed for pure driver-logic tests. */
function makeRepoFixture(name: string, branch: string): string {
  const root = tmpDir("harness-sbc-fx-");
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

/** Same, plus a `refs/remotes/origin/HEAD` symref for default-branch auto-resolution tests. */
function makeRepoFixtureWithOriginHead(name: string, branch: string, defaultBranch: string): string {
  const repo = makeRepoFixture(name, branch);
  const dir = path.join(repo, ".git", "refs", "remotes", "origin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), `ref: refs/remotes/origin/${defaultBranch}\n`);
  return repo;
}

// ---------------------------------------------------------------------
// Real-git fixture helpers (mirrors tests/cli/pack-hook-post-merge-gate.test.ts's
// squash-merge E2E: real local bare repos, never a real network host).
// ---------------------------------------------------------------------

function gitConfig(dir: string): void {
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

function gitCommitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

function gitRevParse(dir: string, ref = "HEAD"): string {
  return execFileSync("git", ["rev-parse", ref], { cwd: dir, encoding: "utf8" }).trim();
}

/**
 * `HARNESS_ALLOW_REAL_SPAWN=1` is `realCheckStaleBase`'s (and the
 * suite-wide hermetic-spawn-allowlist's) documented escape hatch for "a
 * test that deliberately wants to exercise the REAL spawn path end-to-end"
 * (src/runtime/hermetic-spawn-guard.ts). Every use below targets a LOCAL
 * fixture repo (a bare repo under this file's own tmpdir, or a loopback
 * socket) — never a real network host. Scoped with try/finally so a
 * thrown assertion still restores the prior value.
 */
async function withRealSpawnAllowed<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HARNESS_ALLOW_REAL_SPAWN;
  process.env.HARNESS_ALLOW_REAL_SPAWN = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_ALLOW_REAL_SPAWN;
    else process.env.HARNESS_ALLOW_REAL_SPAWN = prev;
  }
}

// ===========================================================================
// Manifest schema
// ===========================================================================

describe("StaleBaseCheckSchema — manifest parsing", () => {
  it("defaults to disabled with no fields when the block is absent entirely", () => {
    const m = parseManifest({ version: 1 });
    expect(m.stale_base_check.enabled).toBe(false);
    expect(m.stale_base_check.remote).toBeUndefined();
    expect(m.stale_base_check.default_branch).toBeUndefined();
    expect(m.stale_base_check.fetch_timeout_ms).toBeUndefined();
  });

  it("parses an explicit enabled config with all fields", () => {
    const m = manifestWithConfig({
      enabled: true,
      remote: "upstream",
      default_branch: "main",
      fetch_timeout_ms: 5000,
    });
    expect(m.stale_base_check).toEqual({
      enabled: true,
      remote: "upstream",
      default_branch: "main",
      fetch_timeout_ms: 5000,
    });
  });

  it("rejects unknown keys (.strict())", () => {
    expect(() => manifestWithConfig({ enabled: true, bogus_key: 1 })).toThrow();
  });
});

// ===========================================================================
// Driver logic (injected runCheck — no real git, hermetic + fast)
// ===========================================================================

describe("runSessionStartStaleBaseCheck — driver logic", () => {
  it("is opt-in: touches neither git nor the network when not enabled (default off)", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    let checkCalled = false;
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithConfig(), // absent -> enabled:false
      runCheck: async () => {
        checkCalled = true;
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(checkCalled).toBe(false);
    expect(errOut()).toMatch(/not configured/);
    expect(errOut()).toMatch(/no network touched/);
  });

  it("skips (no network) on detached HEAD", async () => {
    const root = tmpDir("harness-sbc-fx-");
    const repo = path.join(root, "detached");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "9fceb02d0ae598e95dc970b74767f19372d61af8\n");
    let checkCalled = false;
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: captureStream().stream,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => {
        checkCalled = true;
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(result.wrote).toBe(false);
    expect(result.branch).toBe("");
    expect(checkCalled).toBe(false);
  });

  it("skips when cwd is not inside a git work tree", async () => {
    const root = tmpDir("harness-sbc-fx-");
    const plain = path.join(root, "not-a-repo");
    fs.mkdirSync(plain, { recursive: true });
    let checkCalled = false;
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: plain })),
      stderr: captureStream().stream,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => {
        checkCalled = true;
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(result.wrote).toBe(false);
    expect(result.repo).toBe("");
    expect(checkCalled).toBe(false);
  });

  it("skips when already on the default branch (nothing to compare a base against)", async () => {
    const repo = makeRepoFixture("svc", "master");
    let checkCalled = false;
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: captureStream().stream,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => {
        checkCalled = true;
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(result.wrote).toBe(false);
    expect(checkCalled).toBe(false);
  });

  it("degrades cleanly (no network attempted) when the default branch cannot be resolved and no override is set", async () => {
    const repo = makeRepoFixture("svc", "task/x"); // no refs/remotes/origin/HEAD
    let checkCalled = false;
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true }), // no default_branch override
      runCheck: async () => {
        checkCalled = true;
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(result.wrote).toBe(false);
    expect(checkCalled).toBe(false);
    expect(errOut()).toMatch(/default branch could not be resolved/);
  });

  it("auto-resolves the default branch NAME from the local origin/HEAD ref (never its sha)", async () => {
    const repo = makeRepoFixtureWithOriginHead("svc", "task/x", "main");
    const captured: StaleBaseCheckArgs[] = [];
    await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: captureStream().stream,
      manifest: manifestWithConfig({ enabled: true }),
      runCheck: async (args) => {
        captured.push(args);
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(captured[0]?.defaultBranch).toBe("main");
    expect(captured[0]?.remote).toBe("origin");
  });

  it("an explicit `default_branch` override wins over origin/HEAD auto-resolution", async () => {
    const repo = makeRepoFixtureWithOriginHead("svc", "task/x", "main");
    const captured: StaleBaseCheckArgs[] = [];
    await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: captureStream().stream,
      manifest: manifestWithConfig({ enabled: true, default_branch: "release/override" }),
      runCheck: async (args) => {
        captured.push(args);
        return { ok: true, aheadCount: 0, behindCount: 0 };
      },
    });
    expect(captured[0]?.defaultBranch).toBe("release/override");
  });

  it("degrades cleanly (exit 0, no block, no fact) when the live check reports offline/no-remote/no-credentials", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    const { stream: err, output: errOut } = captureStream();
    const writes: string[] = [];
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => ({
        ok: false,
        reason: "`git fetch` timed out after 8000ms (remote unreachable or very slow)",
      }),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(writes).toEqual([]);
    expect(errOut()).toMatch(/timed out after 8000ms/);
    expect(errOut()).toMatch(/degrading cleanly/);
    expect(errOut()).toMatch(/not blocking/);
  });

  it("records an `ok` fact and a quiet note when the base is current", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => ({ ok: true, aheadCount: 1, behindCount: 0 }),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(result.behindCount).toBe(0);
    expect(writes).toEqual([
      { sessionId: "s", content: "stale-base:svc:task/x ok base:origin/master", source: "harness-session-start-stale-base-check" },
    ]);
    expect(errOut()).toMatch(/base is current with origin\/master/);
  });

  it("names the concrete commit count, age, and remedy command when the base is behind (AC2)", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    const now = new Date("2026-08-08T12:00:00.000Z");
    const latestIso = "2026-08-08T06:00:00.000Z"; // 6h before "now"
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      now,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => ({
        ok: true,
        aheadCount: 3,
        behindCount: 7,
        remoteSha: "abc123def456abc123def456abc123def456abc",
        latestRemoteCommitIso: latestIso,
      }),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(result.behindCount).toBe(7);
    expect(errOut()).toMatch(/WARNING: this branch's base is 7 commit\(s\) behind origin\/master/);
    expect(errOut()).toMatch(/6h ago/);
    expect(errOut()).toMatch(/this branch itself is 3 commit\(s\) ahead/);
    expect(errOut()).toMatch(/git fetch origin && git rebase origin\/master/);
    expect(writes[0]?.content).toBe(
      "stale-base:svc:task/x behind:7 ahead:3 base:origin/master remote_sha:abc123def456abc123def456abc123def456abc",
    );
  });

  it("non-blocking on ledger write failure (exit 0 + diagnostic)", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => ({ ok: true, aheadCount: 0, behindCount: 1, latestRemoteCommitIso: new Date().toISOString() }),
      writeLedger: async () => ({ ok: false, reason: "mcp timeout" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(errOut()).toContain("ledger write failed: mcp timeout");
  });

  it("degrades cleanly on malformed event JSON", async () => {
    const result = await runSessionStartStaleBaseCheck({
      stdin: streamFrom("{not json"),
      stderr: captureStream().stream,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      runCheck: async () => ({ ok: true, aheadCount: 0, behindCount: 0 }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("default");
  });

  it("loudly warns when the session id resolved to the literal 'default'", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    const { stream: err, output: errOut } = captureStream();
    await runSessionStartStaleBaseCheck({
      stdin: streamFrom(JSON.stringify({ cwd: repo })),
      stderr: err,
      manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      resolveSession: () => "default",
      runCheck: async () => ({ ok: true, aheadCount: 0, behindCount: 1, latestRemoteCommitIso: new Date().toISOString() }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(errOut()).toMatch(/WARNING: session resolved to the literal "default"/);
  });

  it("refuses a real `git fetch` spawn when runCheck is not injected (hermetic guard)", async () => {
    const repo = makeRepoFixture("svc", "task/x");
    await expect(
      runSessionStartStaleBaseCheck({
        stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
        stderr: captureStream().stream,
        manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      }),
    ).rejects.toThrow(HermeticSpawnViolationError);
    await expect(
      runSessionStartStaleBaseCheck({
        stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
        stderr: captureStream().stream,
        manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
      }),
    ).rejects.toThrow(/Refusing to spawn a REAL "git fetch \(stale-base-check\)"/);
  });
});

// ===========================================================================
// Real git (task Vorgehen #1: reproduce the incident, then prove the
// production check detects it). HARNESS_ALLOW_REAL_SPAWN=1 targets ONLY
// local fixture repos / loopback sockets below — never a real network host.
// ===========================================================================

describe("real git — reproduces the incident (task ce3903b0, ea8becf5)", () => {
  it("`git merge-base <branch> origin/<default>` LIES when the local origin ref is stale — the exact trap the incident hit", () => {
    const root = tmpDir("harness-sbc-trap-");
    const bareDir = path.join(root, "origin.git");
    fs.mkdirSync(bareDir);
    execFileSync("git", ["init", "--bare", "-q", "-b", "master"], { cwd: bareDir });

    const cloneDir = path.join(root, "clone");
    execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
    gitConfig(cloneDir);
    fs.writeFileSync(path.join(cloneDir, "README.md"), "hello\n");
    gitCommitAll(cloneDir, "init");
    execFileSync("git", ["push", "-q", "-u", "origin", "master"], { cwd: cloneDir });
    const forkPointSha = gitRevParse(cloneDir);

    // The agent cuts a task branch right at the fork point.
    execFileSync("git", ["checkout", "-q", "-b", "task/x"], { cwd: cloneDir });
    fs.writeFileSync(path.join(cloneDir, "work.txt"), "agent work\n");
    gitCommitAll(cloneDir, "agent work");

    // Meanwhile, a release lands on origin/master via a SEPARATE clone —
    // cloneDir's own refs/remotes/origin/master is never touched, exactly
    // like the "4 days unfetched" incident.
    const releaserDir = path.join(root, "releaser");
    execFileSync("git", ["clone", "-q", bareDir, releaserDir]);
    gitConfig(releaserDir);
    fs.writeFileSync(path.join(releaserDir, "RELEASE.md"), "v0.42.0\n");
    gitCommitAll(releaserDir, "release v0.42.0");
    execFileSync("git", ["push", "-q", "origin", "master"], { cwd: releaserDir });

    // The trap: cloneDir's cached origin/master ref is UNCHANGED...
    expect(gitRevParse(cloneDir, "refs/remotes/origin/master")).toBe(forkPointSha);
    // ...so merge-base (and a rev-list count) against it reports the
    // branch as perfectly current — 0 commits behind. LIE: the real
    // remote has moved. This is the exact false-negative the task's
    // hard constraint forbids relying on.
    const naiveMergeBase = execFileSync("git", ["merge-base", "task/x", "origin/master"], {
      cwd: cloneDir,
      encoding: "utf8",
    }).trim();
    expect(naiveMergeBase).toBe(forkPointSha);
    const naiveBehindCount = execFileSync("git", ["rev-list", "--count", "task/x..origin/master"], {
      cwd: cloneDir,
      encoding: "utf8",
    }).trim();
    expect(naiveBehindCount).toBe("0");
  });

  it(
    "detects the branch is behind the LIVE remote default even though the local origin ref is stale " +
      "(production default runCheck, real `git fetch`, no injection)",
    async () => {
      const root = tmpDir("harness-sbc-incident-");
      const bareDir = path.join(root, "origin.git");
      fs.mkdirSync(bareDir);
      execFileSync("git", ["init", "--bare", "-q", "-b", "master"], { cwd: bareDir });

      const cloneDir = path.join(root, "clone");
      execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
      gitConfig(cloneDir);
      fs.writeFileSync(path.join(cloneDir, "README.md"), "hello\n");
      gitCommitAll(cloneDir, "init");
      execFileSync("git", ["push", "-q", "-u", "origin", "master"], { cwd: cloneDir });
      // The fixture clones an INITIALLY EMPTY bare repo (there is nothing
      // to point a HEAD symref at during `git clone` itself), unlike a
      // real-world clone of an already-populated origin — where `git
      // clone` sets this automatically. `remote set-head -a` reproduces
      // that normal, already-populated-origin state explicitly, so this
      // test genuinely exercises the auto-resolution path
      // (`resolveOriginHeadBase`), not just the `default_branch` override.
      execFileSync("git", ["remote", "set-head", "origin", "-a"], { cwd: cloneDir });

      execFileSync("git", ["checkout", "-q", "-b", "task/x"], { cwd: cloneDir });
      fs.writeFileSync(path.join(cloneDir, "work.txt"), "agent work\n");
      gitCommitAll(cloneDir, "agent work");

      const releaserDir = path.join(root, "releaser");
      execFileSync("git", ["clone", "-q", bareDir, releaserDir]);
      gitConfig(releaserDir);
      for (const n of [1, 2]) {
        fs.writeFileSync(path.join(releaserDir, `RELEASE-${n}.md`), `release ${n}\n`);
        gitCommitAll(releaserDir, `release commit ${n}`);
      }
      execFileSync("git", ["push", "-q", "origin", "master"], { cwd: releaserDir });

      await withRealSpawnAllowed(async () => {
        const { stream: err, output: errOut } = captureStream();
        const writes: Array<{ sessionId: string; content: string; source: string }> = [];
        // No `default_branch` override: `git clone` writes
        // refs/remotes/origin/HEAD itself, so this also exercises the
        // real auto-resolution path end-to-end.
        const result = await runSessionStartStaleBaseCheck({
          stdin: streamFrom(JSON.stringify({ session_id: "sess-incident", cwd: cloneDir })),
          stderr: err,
          manifest: manifestWithConfig({ enabled: true }),
          writeLedger: async (args) => {
            writes.push(args);
            return { ok: true };
          },
        });
        expect(result.exitCode).toBe(0);
        expect(result.wrote).toBe(true);
        expect(result.behindCount).toBe(2);
        expect(writes[0]?.content).toMatch(/^stale-base:clone:task\/x behind:2 ahead:1 base:origin\/master remote_sha:[0-9a-f]{40}$/);
        expect(errOut()).toMatch(/WARNING: this branch's base is 2 commit\(s\) behind origin\/master/);
        expect(errOut()).toMatch(/git fetch origin && git rebase origin\/master/);
      });
    },
  );
});

describe("real git — offline / no-remote / no-credentials degrade cleanly (AC4)", () => {
  it("degrades cleanly (exit 0, no block, no fact) when no such remote is configured", async () => {
    const root = tmpDir("harness-sbc-noremote-");
    const repo = path.join(root, "solo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "task/solo"], { cwd: repo }); // no remote at all
    gitConfig(repo);
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    gitCommitAll(repo, "init");

    await withRealSpawnAllowed(async () => {
      const { stream: err, output: errOut } = captureStream();
      const writes: string[] = [];
      const result = await runSessionStartStaleBaseCheck({
        stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
        stderr: err,
        manifest: manifestWithConfig({ enabled: true, default_branch: "master", fetch_timeout_ms: 3000 }),
        writeLedger: async (args) => {
          writes.push(args.content);
          return { ok: true };
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      expect(writes).toEqual([]);
      expect(errOut()).toMatch(/degrading cleanly/);
      expect(errOut()).toMatch(/not blocking/);
    });
  });

  it("degrades cleanly (exit 0, no block, no fact) when the remote is access-denied (proxy for missing credentials)", async () => {
    const root = tmpDir("harness-sbc-noaccess-");
    const bareDir = path.join(root, "origin.git");
    fs.mkdirSync(bareDir);
    execFileSync("git", ["init", "--bare", "-q", "-b", "master"], { cwd: bareDir });
    const seedDir = path.join(root, "seed");
    execFileSync("git", ["clone", "-q", bareDir, seedDir]);
    gitConfig(seedDir);
    fs.writeFileSync(path.join(seedDir, "f.txt"), "x\n");
    gitCommitAll(seedDir, "init");
    execFileSync("git", ["push", "-q", "-u", "origin", "master"], { cwd: seedDir });

    const repo = path.join(root, "agent-clone");
    execFileSync("git", ["clone", "-q", bareDir, repo]);
    gitConfig(repo);
    execFileSync("git", ["checkout", "-q", "-b", "task/x"], { cwd: repo });

    // Access-denied proxy: chmod 000 blocks the local-path transport the
    // same way a rejected credential blocks an https/ssh transport (both
    // are "the remote refused to hand over refs" from git's point of
    // view). Restored in `finally` so tmp-dir cleanup can still remove it.
    fs.chmodSync(bareDir, 0o000);
    try {
      await withRealSpawnAllowed(async () => {
        const { stream: err, output: errOut } = captureStream();
        const writes: string[] = [];
        const result = await runSessionStartStaleBaseCheck({
          stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
          stderr: err,
          manifest: manifestWithConfig({ enabled: true, default_branch: "master" }),
          writeLedger: async (args) => {
            writes.push(args.content);
            return { ok: true };
          },
        });
        expect(result.exitCode).toBe(0);
        expect(result.wrote).toBe(false);
        expect(writes).toEqual([]);
        expect(errOut()).toMatch(/degrading cleanly/);
      });
    } finally {
      fs.chmodSync(bareDir, 0o700);
    }
  });

  it("degrades cleanly (exit 0, no block, no fact) when the remote hangs (real timeout, loopback-only)", async () => {
    const root = tmpDir("harness-sbc-timeout-");
    const repo = path.join(root, "solo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "task/solo"], { cwd: repo });
    gitConfig(repo);
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    gitCommitAll(repo, "init");

    // Accepts the TCP connection but never writes a byte — git's client
    // blocks waiting for the protocol response, so our configured
    // fetch_timeout_ms is what actually ends the call. Loopback only, no
    // DNS, no real network host.
    const server = net.createServer((socket) => {
      socket.on("error", () => {
        /* client disconnect on kill — expected, not a test failure */
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    cleanups.push(() => server.close());

    await withRealSpawnAllowed(async () => {
      const { stream: err, output: errOut } = captureStream();
      const writes: string[] = [];
      const result = await runSessionStartStaleBaseCheck({
        stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
        stderr: err,
        manifest: manifestWithConfig({
          enabled: true,
          remote: `git://127.0.0.1:${port}/repo.git`,
          default_branch: "master",
          fetch_timeout_ms: 400,
        }),
        writeLedger: async (args) => {
          writes.push(args.content);
          return { ok: true };
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.wrote).toBe(false);
      expect(writes).toEqual([]);
      expect(errOut()).toMatch(/timed out after 400ms/);
      expect(errOut()).toMatch(/degrading cleanly/);
    });
  }, 10_000);
});

// ===========================================================================
// AC3: no network access on the PreToolUse hot path
// ===========================================================================

describe("hot-path isolation (AC3: no network on PreToolUse)", () => {
  it("runtime/intercept.ts (the `harness policy intercept` PreToolUse entrypoint) never references stale-base-check", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src", "runtime", "intercept.ts"), "utf8");
    expect(src).not.toMatch(/stale-base-check/);
    expect(src).not.toMatch(/StaleBaseCheck/);
  });

  it("no file under src/runtime/ IMPORTS stale-base-check (structurally impossible per .dependency-cruiser.cjs's runtime-no-upward-imports rule; this is an independent literal check of the same invariant — a plain mention in a doc comment, e.g. hermetic-spawn-guard.ts naming this module's guarded call site, is not a violation)", () => {
    const runtimeDir = path.join(REPO_ROOT, "src", "runtime");
    const importPattern = /(?:from\s+["'][^"']*stale-base-check[^"']*["']|require\(\s*["'][^"']*stale-base-check[^"']*["']\s*\))/;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(runtimeDir)) {
      if (!name.endsWith(".ts")) continue;
      const text = fs.readFileSync(path.join(runtimeDir, name), "utf8");
      if (importPattern.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
