import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// ── Suite-wide homedir safety net (task a48b9729) ──────────────────────
// The producer's fail-log default is `os.homedir()`-based
// (`~/.harness/logs`). Every not-ready test is REQUIRED to inject a tmp
// `logDir` (see makeLogDirFixture), but a forgotten injection used to
// write into the operator's REAL home. Pin homedir() for this suite's
// whole module graph so that mistake lands in a throwaway tmp home
// instead. The pin lives here (not in a global vitest setup) because the
// default-logDir seam is specific to this suite; everything else in
// node:os stays the real implementation.
// vi.hoisted: the vi.mock factory below is hoisted above all imports, so
// the pinned path must be computed without importing os/fs.
const PINNED_HOME = vi.hoisted(() => {
  const base = (process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "");
  return `${base}/harness-sspf-pinned-home-${process.pid}`;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => PINNED_HOME;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

afterAll(() => {
  fs.rmSync(PINNED_HOME, { recursive: true, force: true });
});

import {
  preflightChildEnv,
  runSessionStartPreflight,
  type RunPreflightResult,
} from "../../../src/cli/session-start/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

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

/** Create `<tmp>/<name>/.git/HEAD` and return the work-tree path. */
function makeRepoFixture(name: string, branch = "main"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

/**
 * Tmp dir for the not-ready fail-log seam (task T-001). Every test that
 * drives the not-ready branch MUST pass this as `logDir` — the producer
 * now persists the raw preflight JSON there, and without an explicit
 * override it would default to (and pollute) the real `~/.harness/logs/`.
 */
function makeLogDirFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-logs-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readyPreflight =
  (confidence = 0.83): ((cwd: string, t: number) => Promise<RunPreflightResult>) =>
  async () => ({ ok: true, json: { ready: true, confidence, checks: [] } });

describe("runSessionStartPreflight", () => {
  it("writes per-repo AND per-branch preflight tags on a ready:true result", async () => {
    const repo = makeRepoFixture("widget-service", "release/2.0");
    const { stream: err, output: errOut } = captureStream();
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const result = await runSessionStartPreflight({
      stdin: streamFrom(
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-9", cwd: repo }),
      ),
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      repo: "widget-service",
      branch: "release/2.0",
      sessionId: "sess-9",
      sessionSource: "stdin",
    });
    // One fact carrying both tags — the requires evaluator substring-
    // matches, so this satisfies both `preflight:${REPO}` (within 1h)
    // and `preflight:${BRANCH}` (within 10m).
    expect(writes).toEqual([
      {
        sessionId: "sess-9",
        content: "preflight:widget-service preflight:release/2.0 ready:true confidence:0.83",
        source: "harness-session-start-preflight",
      },
    ]);
    expect(errOut()).toContain(
      "recorded preflight:widget-service preflight:release/2.0 ready:true",
    );
  });

  it("writes only the per-repo tag on a detached HEAD (no branch)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-det-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "detached-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".git", "HEAD"),
      "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
    );
    const writes: string[] = [];
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.9),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      repo: "detached-repo",
      branch: "",
      sessionId: "s",
      sessionSource: "stdin",
    });
    // Detached HEAD: only the per-repo tag (no branch), but the raw
    // sha is still captured as `head:<sha>` so at_head:true on
    // preflight-before-push works in detached-HEAD reviews / bisects.
    expect(writes).toEqual([
      "preflight:detached-repo ready:true confidence:0.90 head:9fceb02d0ae598e95dc970b74767f19372d61af8",
    ]);
  });

  it("stages .pending-approval as soon as a non-default session id resolves (task 0dbc9549)", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const staged: Array<{ generatedDir: string; sessionId: string }> = [];
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "sess-bootstrap", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async () => ({ ok: true }),
      // Inject homeDir so the staging path resolves under tmp instead of
      // tripping the HARNESS_ALLOW_REAL_GENERATED_DIR loader guard, which
      // would silently degrade the staging branch and break the assertion.
      homeDir: repo,
      stagePendingApproval: (generatedDir, sessionId) => {
        staged.push({ generatedDir, sessionId });
      },
    });
    expect(staged).toHaveLength(1);
    expect(staged[0]?.sessionId).toBe("sess-bootstrap");
    expect(staged[0]?.generatedDir).toMatch(/harness\.generated$/);
  });

  it("does NOT stage .pending-approval when the resolved session id is the literal 'default'", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const staged: string[] = [];
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ cwd: repo })), // no session_id
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async () => ({ ok: true }),
      // Force the discovery tier to fall back to "default" so we hit the
      // sessionSource:"default" branch the guard protects.
      resolveSession: () => "default",
      stagePendingApproval: (_generatedDir, sessionId) => {
        staged.push(sessionId);
      },
    });
    expect(staged).toEqual([]);
  });

  it("swallows .pending-approval write errors (best-effort, must not break the session loop)", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "sess-best-effort", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async () => ({ ok: true }),
      stagePendingApproval: () => {
        throw new Error("disk full");
      },
    });
    // Stage failure must NOT prevent the ledger write or the result from
    // reporting wrote:true — preflight stays the canonical producer for
    // the gate, pending-approval is a convenience side-channel.
    expect(result.wrote).toBe(true);
    expect(result.sessionId).toBe("sess-best-effort");
    expect(result.exitCode).toBe(0);
  });

  it("defaults to no staging when stagePendingApproval is not supplied (no file written, hotfix-0.21.1)", async () => {
    // Library-callers (and the entire vitest suite) MUST get the opt-in
    // default. Tests that don't isolate homeDir would otherwise clobber
    // the operator's real `~/.claude/harness.generated/.pending-approval`
    // on every preflight invocation that triggers vitest via the
    // npm-test agent-preflight check (the v0.21.0 regression).
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-default-off-"));
    cleanups.push(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-default-off-repo-"));
    cleanups.push(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const repo = path.join(repoRoot, "no-stage-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), "version: 1\n");
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      homeDir: tmpHome,
      stdin: streamFrom(JSON.stringify({ session_id: "sess-no-default-stage", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async () => ({ ok: true }),
      // Intentionally NOT setting stagePendingApproval.
    });
    expect(result.wrote).toBe(true);
    const stagedPath = path.join(tmpHome, "harness.generated", ".pending-approval");
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("respects stagePendingApproval:null (explicit opt-out, no file written)", async () => {
    // Isolate generatedDir under a tmp homeDir so we can assert the
    // staging file is NOT created on disk: the null opt-out must bypass
    // the default `writePendingApproval` writer entirely, not just the
    // sink seam.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-null-"));
    cleanups.push(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-null-repo-"));
    cleanups.push(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const repo = path.join(repoRoot, "no-stage-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(tmpHome, "harness.yaml"), "version: 1\n");
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      homeDir: tmpHome,
      stdin: streamFrom(JSON.stringify({ session_id: "sess-no-stage", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async () => ({ ok: true }),
      stagePendingApproval: null,
    });
    expect(result.wrote).toBe(true);
    const stagedPath = path.join(tmpHome, "harness.generated", ".pending-approval");
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("appends `head:<sha>` when resolveGitContext can read the loose ref", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-head-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "headful");
    fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(
      path.join(repo, ".git", "refs", "heads", "main"),
      "abcdef0123456789abcdef0123456789abcdef01\n",
    );
    const writes: string[] = [];
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.7),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(writes).toEqual([
      "preflight:headful preflight:main ready:true confidence:0.70 head:abcdef0123456789abcdef0123456789abcdef01",
    ]);
  });

  it("passes the 60s default subprocess timeout when preflightTimeoutMs is omitted", async () => {
    // Regression for agent-tasks/7265599e: the default used to be 25s,
    // which killed honest preflights on medium-size repos (the live
    // failure was agent-grounding at ~28s). Bumped to 60s so the wrapper
    // covers the realistic ceiling without forcing every operator to
    // pass `--timeout` by hand. Operators still override per-call.
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const seenTimeouts: number[] = [];
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: async (_cwd, timeoutMs) => {
        seenTimeouts.push(timeoutMs);
        return { ok: true, json: { ready: true, confidence: 0.9, checks: [] } };
      },
      writeLedger: async () => ({ ok: true }),
    });
    expect(seenTimeouts).toEqual([60_000]);
  });

  it("honours an explicit preflightTimeoutMs override", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const seenTimeouts: number[] = [];
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      preflightTimeoutMs: 5_000,
      runPreflight: async (_cwd, timeoutMs) => {
        seenTimeouts.push(timeoutMs);
        return { ok: true, json: { ready: true, confidence: 0.9, checks: [] } };
      },
      writeLedger: async () => ({ ok: true }),
    });
    expect(seenTimeouts).toEqual([5_000]);
  });

  it("does NOT write the tag on a ready:false result, so the gate stays closed", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err, output: errOut } = captureStream();
    let wrote = false;
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir: makeLogDirFixture(),
      runPreflight: async () => ({
        ok: true,
        json: {
          ready: false,
          confidence: 0.4,
          checks: [
            { name: "npm-test", status: "fail" },
            { name: "secret-scan", status: "error" },
            { name: "clean-worktree", status: "pass" },
          ],
        },
      }),
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result.wrote).toBe(false);
    expect(result.exitCode).toBe(0);
    const text = errOut();
    expect(text).toContain("preflight not ready (confidence 0.40)");
    expect(text).toContain("failing: npm-test, secret-scan");
    expect(text).toContain("leaving the preflight tag unwritten");
  });

  it("degrades gracefully when the preflight runner is unavailable", async () => {
    const repo = makeRepoFixture("repo-x");
    const { stream: err, output: errOut } = captureStream();
    let wrote = false;
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: async () => ({
        ok: false,
        reason: "`preflight` not on PATH (npm i -g @lannguyensi/agent-preflight)",
      }),
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result).toMatchObject({ exitCode: 0, wrote: false, repo: "repo-x" });
    expect(errOut()).toContain("not on PATH");
  });

  it("skips when the cwd is not inside a git work tree", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-nogit-"));
    cleanups.push(() => fs.rmSync(plain, { recursive: true, force: true }));
    const { stream: err, output: errOut } = captureStream();
    let ranPreflight = false;
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: plain })),
      stderr: err,
      runPreflight: async () => {
        ranPreflight = true;
        return { ok: true, json: { ready: true, confidence: 1 } };
      },
      writeLedger: async () => ({ ok: true }),
    });
    expect(ranPreflight).toBe(false); // bailed before spawning preflight
    expect(result).toEqual({
      exitCode: 0,
      wrote: false,
      repo: "",
      branch: "",
      sessionId: "default",
      sessionSource: "default",
      reason: expect.stringContaining("not inside a git work tree"),
    });
    expect(errOut()).toContain("not inside a git work tree");
  });

  it("surfaces a failed ledger write without throwing", async () => {
    const repo = makeRepoFixture("repo-y");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(),
      writeLedger: async () => ({ ok: false, reason: "grounding-mcp timeout after 5000ms" }),
    });
    expect(result).toMatchObject({ exitCode: 0, wrote: false, repo: "repo-y" });
    expect(result.reason).toContain("ledger write failed");
    expect(errOut()).toContain("grounding-mcp timeout after 5000ms");
  });

  it("handles malformed stdin JSON gracefully (exit 0, no write)", async () => {
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom("{not json"),
      stderr: err,
      runPreflight: readyPreflight(),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result).toMatchObject({ exitCode: 0, wrote: false });
    expect(errOut()).toContain("malformed event JSON");
  });

  it("falls back to a `?` confidence when preflight omits the number", async () => {
    const repo = makeRepoFixture("repo-z", "main");
    const { stream: err } = captureStream();
    const writes: string[] = [];
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: async () => ({ ok: true, json: { ready: true } }),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(writes).toEqual(["preflight:repo-z preflight:main ready:true confidence:?"]);
  });

  it("reports a manifest load failure when no writeLedger is injected", async () => {
    const repo = makeRepoFixture("repo-cfg");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      configPath: path.join(repo, "does-not-exist.yaml"),
      runPreflight: readyPreflight(),
      // writeLedger intentionally not injected — exercise the real
      // manifest-load path, which should fail gracefully here.
    });
    expect(result).toMatchObject({ exitCode: 0, wrote: false, repo: "repo-cfg" });
    expect(errOut()).toContain("manifest load failed");
  });

  it("reports when grounding-mcp is not declared in the manifest", async () => {
    const repo = makeRepoFixture("repo-nomcp");
    const manifestPath = path.join(repo, "harness.yaml");
    fs.writeFileSync(
      manifestPath,
      "version: 1\nhooks: []\npolicies: []\ntools:\n  builtin:\n    known: [Read, Edit]\n",
    );
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      configPath: manifestPath,
      runPreflight: readyPreflight(),
    });
    expect(result).toMatchObject({ exitCode: 0, wrote: false });
    expect(errOut()).toContain("grounding-mcp not declared");
  });
});

describe("runSessionStartPreflight — session-id resolution (task 5e84191b)", () => {
  it("--session flag overrides every other source (sessionSource=flag)", async () => {
    const repo = makeRepoFixture("repo-flag", "main");
    const { stream: err } = captureStream();
    const writes: string[] = [];
    const result = await runSessionStartPreflight({
      // stdin carries a session_id but the explicit flag wins.
      stdin: streamFrom(JSON.stringify({ session_id: "from-stdin", cwd: repo })),
      stderr: err,
      session: "from-flag",
      runPreflight: readyPreflight(0.9),
      writeLedger: async (args) => {
        writes.push(args.sessionId);
        return { ok: true };
      },
    });
    expect(result.sessionId).toBe("from-flag");
    expect(result.sessionSource).toBe("flag");
    expect(writes).toEqual(["from-flag"]);
  });

  it("falls through to the transcript-discovery tier when stdin/env carry no id", async () => {
    const repo = makeRepoFixture("repo-disc", "main");
    const { stream: err } = captureStream();
    const writes: string[] = [];
    const result = await runSessionStartPreflight({
      // No session_id in stdin event.
      stdin: streamFrom(JSON.stringify({ cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.9),
      // Inject the resolver so we don't depend on a real ~/.claude/projects/
      // layout. With no explicit value, the production resolver would walk
      // env → transcripts → default; the injected one returns a discovered id.
      resolveSession: (explicit) =>
        typeof explicit === "string" && explicit.length > 0
          ? explicit
          : "discovered-from-transcripts",
      writeLedger: async (args) => {
        writes.push(args.sessionId);
        return { ok: true };
      },
    });
    expect(result.sessionId).toBe("discovered-from-transcripts");
    expect(result.sessionSource).toBe("transcript");
    expect(writes).toEqual(["discovered-from-transcripts"]);
  });

  it("loud-warns to stderr when the resolved id is the literal 'default'", async () => {
    const repo = makeRepoFixture("repo-default", "main");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ cwd: repo })), // no session_id
      stderr: err,
      runPreflight: readyPreflight(0.9),
      // Resolver returns the literal "default" — simulates a host with no
      // env var and no Claude transcripts (rare, but possible: fresh box,
      // scripted invocation, etc).
      resolveSession: () => "default",
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("default");
    expect(result.sessionSource).toBe("default");
    expect(result.wrote).toBe(true); // tag still landed
    const text = errOut();
    // Both the success-style "recorded" line AND the loud warning are
    // present — that pair is the actionable signal the operator needs.
    expect(text).toContain("recorded preflight:repo-default");
    expect(text).toContain("WARNING: session resolved to the literal \"default\"");
    expect(text).toMatch(/preflight-before-\*\s+gates query the real Claude Code session id/);
  });

  it("a stdin session_id keeps sessionSource=stdin (no warning)", async () => {
    const repo = makeRepoFixture("repo-stdin", "main");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "real-uuid", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.9),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.sessionSource).toBe("stdin");
    expect(errOut()).not.toContain("WARNING");
  });
});

describe("preflightChildEnv", () => {
  it("strips HARNESS_ALLOW_REAL_GENERATED_DIR and keeps everything else, without mutating the input", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HARNESS_ALLOW_REAL_GENERATED_DIR: "1",
      OTHER: "kept",
    };
    const child = preflightChildEnv(parent);
    expect(child).not.toHaveProperty("HARNESS_ALLOW_REAL_GENERATED_DIR");
    expect(child["PATH"]).toBe("/usr/bin");
    expect(child["OTHER"]).toBe("kept");
    // The parent env object is untouched (the launcher still needs the flag).
    expect(parent["HARNESS_ALLOW_REAL_GENERATED_DIR"]).toBe("1");
  });
});

describe("spawnPreflight child env (real spawn, fake binary)", () => {
  // Regression pin for the env-leak false-negative: the launcher sets
  // HARNESS_ALLOW_REAL_GENERATED_DIR=1 for the harness process itself, and
  // an un-scrubbed execFile inherited it into agent-preflight and its
  // nested `npm test` vitest run, where it re-enabled the implicit
  // real-homedir fallback (110 failures with a real pause sentinel
  // present). This drives the REAL spawn path (no runPreflight injection)
  // against a fake `preflight` binary that records its environment.
  it("does not pass HARNESS_ALLOW_REAL_GENERATED_DIR to the preflight child even when the parent has it set", async () => {
    const repo = makeRepoFixture("leak-probe", "main");
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-fakebin-"));
    cleanups.push(() => fs.rmSync(binDir, { recursive: true, force: true }));
    const envDump = path.join(binDir, "child-env.json");
    const fakeBin = path.join(binDir, "preflight");
    fs.writeFileSync(
      fakeBin,
      [
        "#!/bin/sh",
        // Record exactly what the child sees, then emit a not-ready JSON
        // whose failing check carries a details line (also pins the
        // describeNotReady detail surfacing).
        `node -e 'require("fs").writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({ flag: process.env.HARNESS_ALLOW_REAL_GENERATED_DIR ?? null, passthrough: process.env.HARNESS_TEST_PASSTHROUGH ?? null }))'`,
        `printf '%s' '{"ready":false,"confidence":0.74,"checks":[{"name":"npm-test","status":"fail","details":["110 failed | 2941 passed (leak repro)"]}]}'`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const priorPath = process.env["PATH"];
    const priorFlag = process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
    const priorPassthrough = process.env["HARNESS_TEST_PASSTHROUGH"];
    process.env["PATH"] = `${binDir}${path.delimiter}${priorPath ?? ""}`;
    process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = "1";
    process.env["HARNESS_TEST_PASSTHROUGH"] = "yes";
    try {
      const { stream: err, output: errOut } = captureStream();
      const result = await runSessionStartPreflight({
        stdin: streamFrom(
          JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-leak", cwd: repo }),
        ),
        stderr: err,
        logDir: makeLogDirFixture(),
        writeLedger: async () => ({ ok: true }),
      });

      const dumped = JSON.parse(fs.readFileSync(envDump, "utf8")) as {
        flag: string | null;
        passthrough: string | null;
      };
      // The guard flag must NOT reach the child...
      expect(dumped.flag).toBeNull();
      // ...while the rest of the environment passes through unchanged.
      expect(dumped.passthrough).toBe("yes");

      // not-ready path: tag unwritten, and the stderr line now carries the
      // failing check's own detail instead of just its name.
      expect(result.wrote).toBe(false);
      expect(result.reason).toContain("npm-test (110 failed | 2941 passed (leak repro))");
      expect(errOut()).toContain("npm-test (110 failed | 2941 passed (leak repro))");
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
      if (priorFlag === undefined) delete process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"];
      else process.env["HARNESS_ALLOW_REAL_GENERATED_DIR"] = priorFlag;
      if (priorPassthrough === undefined) delete process.env["HARNESS_TEST_PASSTHROUGH"];
      else process.env["HARNESS_TEST_PASSTHROUGH"] = priorPassthrough;
    }
  });
});

describe("describeNotReady robustness (via not-ready reason)", () => {
  // The producer must never throw on malformed subprocess JSON: a
  // SessionStart hook is blocking:false and exits 0 on every path. A
  // non-string details element or message degrades to the bare check
  // name instead of crashing (reviewer finding on task 6ffa5672).
  it("degrades to the bare check name when details/message carry non-string or blank values", async () => {
    const repo = makeRepoFixture("malformed-details", "main");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-mal", cwd: repo }),
      ),
      stderr: err,
      logDir: makeLogDirFixture(),
      runPreflight: async () => ({
        ok: true,
        json: {
          ready: false,
          confidence: 0.5,
          checks: [
            {
              name: "npm-test",
              status: "fail",
              // Deliberately violates the declared string[] shape: this is
              // what the `as PreflightJson` cast can let through at runtime.
              details: [null, 42, "   "] as unknown as string[],
              message: 7 as unknown as string,
            },
            {
              name: "secret-scan",
              status: "fail",
              details: ["  found key in .env.example  "],
            },
          ],
        },
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.wrote).toBe(false);
    // Malformed check: bare name, no throw. Well-formed sibling: trimmed detail.
    expect(result.reason).toContain("failing: npm-test, secret-scan (found key in .env.example)");
    expect(errOut()).toContain("npm-test, secret-scan (found key in .env.example)");
  });
});

describe("not-ready fail-log persistence (task T-001)", () => {
  it("persists the full not-ready JSON pretty-printed and surfaces up to 3 raw detail lines + the log path", async () => {
    const repo = makeRepoFixture("widget-service");
    const logDir = makeLogDirFixture();
    const { stream: err, output: errOut } = captureStream();
    const notReadyJson = {
      ready: false,
      confidence: 0.4,
      checks: [
        {
          name: "npm-test",
          status: "fail",
          // Today's raw-first-10-lines format from agent-preflight.
          details: [
            "FAIL tests/unit/foo.test.ts > suite > case one",
            "FAIL tests/unit/bar.test.ts > suite > case two",
            "FAIL tests/unit/baz.test.ts > suite > case three",
            "FAIL tests/unit/qux.test.ts > suite > case four",
          ],
        },
      ],
    };
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: async () => ({ ok: true, json: notReadyJson }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.wrote).toBe(false);
    expect(result.exitCode).toBe(0);

    const files = fs.readdirSync(logDir);
    expect(files).toHaveLength(1);
    const logFile = files[0]!;
    expect(logFile).toMatch(/^preflight-widget-service-.*\.json$/);
    const logPath = path.join(logDir, logFile);
    const persisted = JSON.parse(fs.readFileSync(logPath, "utf8")) as unknown;
    expect(persisted).toEqual(notReadyJson);

    // Only the first 3 of the 4 detail lines are surfaced in the message.
    expect(result.reason).toContain(
      "npm-test (FAIL tests/unit/foo.test.ts > suite > case one | " +
        "FAIL tests/unit/bar.test.ts > suite > case two | " +
        "FAIL tests/unit/baz.test.ts > suite > case three)",
    );
    expect(result.reason).not.toContain("case four");
    expect(result.reason).toContain(`; log: ${logPath}`);
    expect(errOut()).toContain(`; log: ${logPath}`);
  });

  it("surfaces the companion `full output: <path>` + FAIL-line format (test names appear in the message)", async () => {
    const repo = makeRepoFixture("widget-service");
    const logDir = makeLogDirFixture();
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: async () => ({
        ok: true,
        json: {
          ready: false,
          confidence: 0.55,
          checks: [
            {
              name: "npm-test",
              status: "fail",
              details: [
                "full output: /tmp/agent-preflight/npm-test.log",
                "FAIL tests/unit/widget.test.ts > Widget > renders",
                "FAIL tests/unit/gadget.test.ts > Gadget > mounts",
              ],
            },
          ],
        },
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.reason).toContain("full output: /tmp/agent-preflight/npm-test.log");
    expect(result.reason).toContain("FAIL tests/unit/widget.test.ts > Widget > renders");
    expect(result.reason).toContain("FAIL tests/unit/gadget.test.ts > Gadget > mounts");
  });

  it("rotates the log directory down to the 20 newest preflight-* files, oldest first", async () => {
    const repo = makeRepoFixture("rot-repo");
    const logDir = makeLogDirFixture();
    // 25 pre-existing files with distinct, explicit mtimes (oldest to
    // newest) so rotation order is deterministic regardless of how fast
    // the filesystem's clock ticks during the test run.
    const baseMs = Date.parse("2020-01-01T00:00:00.000Z");
    for (let i = 0; i < 25; i++) {
      const p = path.join(logDir, `preflight-rot-repo-old-${String(i).padStart(2, "0")}.json`);
      fs.writeFileSync(p, "{}");
      const t = new Date(baseMs + i * 1000);
      fs.utimesSync(p, t, t);
    }
    // A file that does NOT match the preflight-* pattern must survive
    // rotation untouched.
    fs.writeFileSync(path.join(logDir, "unrelated.txt"), "keep me");

    const { stream: err } = captureStream();
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: async () => ({
        ok: true,
        json: { ready: false, confidence: 0.3, checks: [{ name: "x", status: "fail" }] },
      }),
      writeLedger: async () => ({ ok: true }),
    });

    const remaining = fs.readdirSync(logDir);
    const preflightFiles = remaining.filter((n) => n.startsWith("preflight-") && n.endsWith(".json"));
    expect(preflightFiles).toHaveLength(20);
    expect(remaining).toContain("unrelated.txt");
    // 25 pre-existing + 1 just-written = 26 total; rotation evicts the 6
    // oldest (old-00..old-05) to get back down to 20. The remaining
    // fixtures and the just-written file all survive.
    for (let i = 0; i < 6; i++) {
      expect(preflightFiles).not.toContain(`preflight-rot-repo-old-${String(i).padStart(2, "0")}.json`);
    }
    for (let i = 6; i < 25; i++) {
      expect(preflightFiles).toContain(`preflight-rot-repo-old-${String(i).padStart(2, "0")}.json`);
    }
  });

  it("does NOT write a fail-log on a ready:true result (unchanged happy path)", async () => {
    const repo = makeRepoFixture("widget-service");
    const logDir = makeLogDirFixture();
    const { stream: err } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: readyPreflight(0.9),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.wrote).toBe(true);
    expect(fs.readdirSync(logDir)).toEqual([]);
  });

  it("does NOT write a fail-log when the preflight runner itself is unavailable (ok:false, no JSON to persist)", async () => {
    const repo = makeRepoFixture("repo-x");
    const logDir = makeLogDirFixture();
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: async () => ({
        ok: false,
        reason: "`preflight` not on PATH (npm i -g @lannguyensi/agent-preflight)",
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.wrote).toBe(false);
    expect(fs.readdirSync(logDir)).toEqual([]);
    expect(errOut()).toContain("not on PATH");
    expect(errOut()).not.toContain("; log:");
  });

  it("degrades gracefully when the log write fails: diagnosis still surfaces, exit code stays 0", async () => {
    const repo = makeRepoFixture("widget-service");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-logfail-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    // Put a REGULAR FILE where the log directory should be, so
    // fs.mkdirSync(logDir, { recursive: true }) throws.
    const logDir = path.join(root, "logs-blocked");
    fs.writeFileSync(logDir, "not a directory");

    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: async () => ({
        ok: true,
        json: {
          ready: false,
          confidence: 0.4,
          checks: [{ name: "npm-test", status: "fail", details: ["some failure"] }],
        },
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    // Diagnosis is still present, just without a log path.
    expect(result.reason).toContain("preflight not ready (confidence 0.40)");
    expect(result.reason).toContain("failing: npm-test (some failure)");
    expect(result.reason).not.toContain("; log:");
    // A dedicated note explains the write failure without throwing.
    expect(errOut()).toContain("preflight fail-log write failed");
  });
});

// ── Fail-log hardening (task a48b9729) ─────────────────────────────────
describe("homedir safety net (suite-wide pin)", () => {
  const notReady = async (): Promise<RunPreflightResult> => ({
    ok: true,
    json: { ready: false, confidence: 0.2, checks: [{ name: "x", status: "fail" }] },
  });

  it("pins os.homedir() to the throwaway tmp home for this suite's module graph", () => {
    expect(os.homedir()).toBe(PINNED_HOME);
    expect(PINNED_HOME).not.toBe("");
  });

  it("NEGATIVE CONTROL: a not-ready run that FORGETS to inject logDir AND homeDir is blocked by the resolvePaths guard, never writes under any home", async () => {
    // Task 80f49922: defaultFailLogDir() now routes through
    // resolvePaths(), so this mistake (no `logDir`, no `homeDir`, no
    // `configPath`) is now caught by the repo-wide throw-on-real-home-dir
    // guard (loader.ts:45-64) BEFORE this suite's os.homedir() pin (task
    // a48b9729, above) would even matter — the guard fires purely on
    // missing homeDir/configPath, independent of what os.homedir()
    // resolves to. persistFailLog is never reached, so nothing lands
    // under PINNED_HOME either; this asserts both.
    const repo = makeRepoFixture("forgotten-injection");
    const { stream: err, output: errOut } = captureStream();
    const pinnedLogDir = path.join(PINNED_HOME, ".harness", "logs");
    // No `logDir` option — exactly the mistake the net exists for.
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      runPreflight: notReady,
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(errOut()).toContain("preflight fail-log write failed");
    expect(errOut()).toContain("resolvePaths refused to fall back");
    expect(result.reason).not.toContain("; log:");
    expect(fs.existsSync(pinnedLogDir)).toBe(false);
  });
});

describe("rotation boundaries (task a48b9729)", () => {
  const failOnce = async (): Promise<RunPreflightResult> => ({
    ok: true,
    json: { ready: false, confidence: 0.3, checks: [{ name: "x", status: "fail" }] },
  });

  /** Seed `n` rotation-eligible files with deterministic ascending mtimes. */
  function seed(logDir: string, n: number): void {
    const baseMs = Date.parse("2020-01-01T00:00:00.000Z");
    for (let i = 0; i < n; i++) {
      const p = path.join(logDir, `preflight-bound-old-${String(i).padStart(2, "0")}.json`);
      fs.writeFileSync(p, "{}");
      const t = new Date(baseMs + i * 1000);
      fs.utimesSync(p, t, t);
    }
  }

  it("exactly 20 files after the write: NO rotation (19 pre-existing + 1 new all survive)", async () => {
    const repo = makeRepoFixture("bound");
    const logDir = makeLogDirFixture();
    seed(logDir, 19);
    const { stream: err } = captureStream();
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: failOnce,
      writeLedger: async () => ({ ok: true }),
    });
    const remaining = fs.readdirSync(logDir).filter((n) => n.startsWith("preflight-") && n.endsWith(".json"));
    expect(remaining).toHaveLength(20);
    // Every seeded file survived — nothing was evicted at exactly the cap.
    for (let i = 0; i < 19; i++) {
      expect(remaining).toContain(`preflight-bound-old-${String(i).padStart(2, "0")}.json`);
    }
  });

  it("21 files after the write: EXACTLY the single oldest is evicted", async () => {
    const repo = makeRepoFixture("bound");
    const logDir = makeLogDirFixture();
    seed(logDir, 20);
    const { stream: err } = captureStream();
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: failOnce,
      writeLedger: async () => ({ ok: true }),
    });
    const remaining = fs.readdirSync(logDir).filter((n) => n.startsWith("preflight-") && n.endsWith(".json"));
    expect(remaining).toHaveLength(20);
    expect(remaining).not.toContain("preflight-bound-old-00.json");
    // old-01..old-19 plus the just-written file all survive.
    for (let i = 1; i < 20; i++) {
      expect(remaining).toContain(`preflight-bound-old-${String(i).padStart(2, "0")}.json`);
    }
    expect(remaining.filter((n) => /^preflight-bound-\d{4}-/.test(n))).toHaveLength(1);
  });
});

describe("hostile repo names stay contained in logDir (task a48b9729)", () => {
  // The task names the spellings '../../etc' and 'a/b'. Those literal
  // strings are UNREACHABLE through the public seam by construction:
  // sanitizeForFilename is module-private, and `repo` arrives as
  // path.basename(findGitEntry(cwd).worktreeRoot) where findGitEntry
  // path.resolve()s its input first — a resolved path's basename can
  // never contain a separator or be a `..` segment. So these tests pin
  // the guarantee those spellings are ABOUT (the fail-log lands as one
  // direct child of logDir, named only from the sanitized
  // [a-zA-Z0-9._-] alphabet) with the closest hostile basenames a real
  // filesystem can produce; sanitizeForFilename stays defense-in-depth
  // behind the resolve+basename structure.
  const failOnce = async (): Promise<RunPreflightResult> => ({
    ok: true,
    json: { ready: false, confidence: 0.1, checks: [{ name: "x", status: "fail" }] },
  });

  async function runWithCwd(cwd: string, logDir: string): Promise<string[]> {
    const { stream: err } = captureStream();
    await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd })),
      stderr: err,
      logDir,
      runPreflight: failOnce,
      writeLedger: async () => ({ ok: true }),
    });
    return fs.readdirSync(logDir);
  }

  it("a dots-only repo basename ('...') stays a plain name segment inside logDir", async () => {
    // '...' is a legal directory name and the closest creatable relative
    // of the '../../etc' spelling. '.' is in the safe alphabet, so it
    // survives sanitization — as a name fragment, never a path hop.
    const repo = makeRepoFixture("...");
    // A dedicated, private parent (NOT the shared os tmpdir) so "did
    // anything land outside logDir" can be asserted exactly rather than
    // prefix-filtered. Filtering the parent listing by the 'preflight-'
    // prefix (the prior version of this test) could never catch a real
    // escape: the whole filename is ONE path segment joined onto logDir
    // (`${FAIL_LOG_PREFIX}${sanitized}-...`), so a traversal hop is only
    // reachable at all if a '/' survived sanitization inside that segment
    // — and a '..' segment produced that way would pop exactly the
    // segment carrying the 'preflight-' prefix, leaving a surviving
    // sibling entry that does NOT start with 'preflight-' either. Listing
    // the whole private parent closes that blind spot.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sspf-escape-"));
    cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }));
    const logDir = path.join(parent, "logs");

    const files = await runWithCwd(repo, logDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^preflight-\.\.\.-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4}\.json$/);
    expect(fs.statSync(path.join(logDir, files[0]!)).isFile()).toBe(true);
    // logDir must be the parent's ONLY entry: any escapee would show up
    // as a second, sibling entry. NOTE on what this does and does not
    // prove: a real directory basename can never contain '/' on POSIX, so
    // no fixture in this suite (including this one) can drive `repo`
    // through the '/'-survives-sanitization vector described above — that
    // vector is closed by construction (repo is a resolved
    // path.basename(), see the describe-block comment above). This
    // assertion is defense-in-depth against a future change to that
    // construction, not a live sanitizeForFilename mutation catcher; the
    // metacharacter test below (backslash/space/'$' -> '-', pinned via an
    // exact filename match) is what actually goes red if
    // sanitizeForFilename regresses to an identity function.
    expect(fs.readdirSync(parent)).toEqual(["logs"]);
  });

  it("separator- and metacharacter-laden basenames are flattened to the safe alphabet", async () => {
    // `a\\b c$d` IS a legal POSIX directory name (backslash, space, `$`);
    // every non-[a-zA-Z0-9._-] byte must flatten to '-'.
    const repo = makeRepoFixture("a\\b c$d");
    const logDir = makeLogDirFixture();

    const files = await runWithCwd(repo, logDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^preflight-a-b-c-d-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4}\.json$/);
  });
});

describe("sub-ms collision suffix (task a48b9729, the single src change)", () => {
  it("two not-ready persists in the SAME millisecond produce two files, not one overwrite", async () => {
    const repo = makeRepoFixture("same-ms");
    const logDir = makeLogDirFixture();
    // Freeze ONLY Date so both writes compute the identical timestamp —
    // deterministic in both directions: without the 4-hex suffix the
    // second write overwrites the first (1 file), with it both survive.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-16T12:00:00.123Z") });
    try {
      for (let i = 0; i < 2; i++) {
        const { stream: err } = captureStream();
        await runSessionStartPreflight({
          stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
          stderr: err,
          logDir,
          runPreflight: async () => ({
            ok: true,
            json: { ready: false, confidence: 0.2, checks: [{ name: "x", status: "fail" }] },
          }),
          writeLedger: async () => ({ ok: true }),
        });
      }
    } finally {
      vi.useRealTimers();
    }
    const files = fs.readdirSync(logDir);
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f).toMatch(/^preflight-same-ms-2026-08-16T12-00-00-123Z-[0-9a-f]{4}\.json$/);
    }
    expect(files[0]).not.toBe(files[1]);
  });
});

describe("multiple failing checks (task a48b9729)", () => {
  it("caps each failing check at 3 detail lines and joins them under one '; failing:' list", async () => {
    const repo = makeRepoFixture("multi-fail");
    const logDir = makeLogDirFixture();
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      logDir,
      runPreflight: async () => ({
        ok: true,
        json: {
          ready: false,
          confidence: 0.35,
          checks: [
            { name: "npm-test", status: "fail", details: ["t1", "t2", "t3", "t4"] },
            { name: "ok-check", status: "pass" },
            { name: "secret-scan", status: "fail", details: ["s1", "s2", "s3", "s4"] },
            { name: "lint", status: "fail" },
          ],
        },
      }),
      writeLedger: async () => ({ ok: true }),
    });
    expect(result.wrote).toBe(false);
    // ONE '; failing:' list, comma-joined, each failing check capped at
    // its first 3 detail lines; passing checks absent; a details-less
    // failing check degrades to its bare name.
    expect(result.reason).toContain(
      "; failing: npm-test (t1 | t2 | t3), secret-scan (s1 | s2 | s3), lint",
    );
    expect(result.reason).not.toContain("t4");
    expect(result.reason).not.toContain("s4");
    expect(result.reason).not.toContain("ok-check");
    expect((result.reason?.match(/; failing:/g) ?? []).length).toBe(1);
    expect(errOut()).toContain("npm-test (t1 | t2 | t3), secret-scan (s1 | s2 | s3), lint");
  });
});
