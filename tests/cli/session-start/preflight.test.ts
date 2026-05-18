import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
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

  it("respects stagePendingApproval:null (caller opts out of staging)", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    // No `staged` capture needed: passing null disables the call site
    // entirely, so the default `writePendingApproval` is never invoked
    // and the test passes purely by reaching the assertions below.
    const result = await runSessionStartPreflight({
      stdin: streamFrom(JSON.stringify({ session_id: "sess-no-stage", cwd: repo })),
      stderr: err,
      runPreflight: readyPreflight(0.83),
      writeLedger: async () => ({ ok: true }),
      stagePendingApproval: null,
    });
    expect(result.wrote).toBe(true);
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
