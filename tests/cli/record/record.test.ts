import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EX_FAIL, EX_USAGE } from "../../../src/cli/exit-codes.js";
import {
  runRecordDogfood,
  runRecordReview,
  runRecordReviewSubagent,
} from "../../../src/cli/record/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

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

/** Create `<tmp>/<name>/.git/HEAD` (+ loose branch ref) and return the work-tree path. */
function makeRepoFixture(name: string, branch = "main"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  const branchRefPath = path.join(repo, ".git", "refs", "heads", ...branch.split("/"));
  fs.mkdirSync(path.dirname(branchRefPath), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(branchRefPath, "abcdef0123456789abcdef0123456789abcdef01\n");
  return repo;
}

/**
 * Create `<tmp>/<name>/.git/HEAD` holding a raw 40-hex sha (no `ref:`
 * prefix) — a detached HEAD, distinct from "no .git at all". Per
 * `resolveGitContext`, a detached HEAD resolves `branch: ""` (there is
 * no branch name to report), which is a DIFFERENT code path through
 * `.git/HEAD` parsing than a missing `.git` directory entirely.
 */
function makeDetachedHeadFixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-detached-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".git", "HEAD"),
    "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
  );
  return repo;
}

function writeOriginHead(repo: string, defaultBranch: string): void {
  fs.mkdirSync(path.join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".git", "refs", "remotes", "origin", "HEAD"),
    `ref: refs/remotes/origin/${defaultBranch}\n`,
  );
}

function writePackedRefs(repo: string, lines: string[]): void {
  fs.writeFileSync(
    path.join(repo, ".git", "packed-refs"),
    `# pack-refs with: peeled fully-peeled sorted\n${lines.join("\n")}\n`,
  );
}

/**
 * Create a real `git worktree add`-shaped linked worktree: a main repo
 * with `refs/remotes/origin/HEAD` + a `.git/worktrees/<name>/commondir`
 * file, and a SEPARATE worktree checkout directory whose `.git` is a
 * FILE (`gitdir: <main>/.git/worktrees/<name>`) rather than a
 * directory. Mirrors real git's split: per-worktree state (HEAD, index)
 * lives under `.git/worktrees/<name>/`; shared state (refs, packed-refs,
 * objects) lives only in the main repo's `.git/`, reachable from the
 * worktree only via `commondir` (task T-004 regression fixture — without
 * `resolveCommonDir` in record/index.ts this always misses and degrades
 * to the "omit with warning" base path).
 */
function makeLinkedWorktreeFixture(defaultBranch = "main"): {
  worktreeCwd: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-wt-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainGitDir = path.join(root, "main-repo", ".git");
  const perWorktreeDir = path.join(mainGitDir, "worktrees", "wt1");
  fs.mkdirSync(path.join(mainGitDir, "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(
    path.join(mainGitDir, "refs", "remotes", "origin", "HEAD"),
    `ref: refs/remotes/origin/${defaultBranch}\n`,
  );
  fs.mkdirSync(perWorktreeDir, { recursive: true });
  // Real git writes this relative to the per-worktree directory itself.
  fs.writeFileSync(path.join(perWorktreeDir, "commondir"), "../..\n");

  const worktreeCwd = path.join(root, "worktree-checkout");
  fs.mkdirSync(worktreeCwd, { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".git"), `gitdir: ${perWorktreeDir}\n`);
  return { worktreeCwd };
}

const okLedger = () => async () => ({ ok: true as const });

describe("harness record review", () => {
  it("writes review:<pr>, review:<branch>, review:<base> plus the summary in one fact", async () => {
    const repo = makeRepoFixture("widget-service", "feature/x");
    writeOriginHead(repo, "main");
    const { stream: err } = captureStream();
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      summary: "looks good, two nits fixed",
      resolveSession: () => "sess-1",
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      content: "review:42 review:feature/x review:main — looks good, two nits fixed",
      sessionId: "sess-1",
      branch: "feature/x",
    });
    expect(writes).toEqual([
      {
        sessionId: "sess-1",
        content: "review:42 review:feature/x review:main — looks good, two nits fixed",
        source: "harness-record-review",
      },
    ]);
  });

  it("resolves the base via packed-refs when the loose origin/HEAD symref is missing", async () => {
    const repo = makeRepoFixture("packed-repo", "feature/y");
    const sha = "1111111111111111111111111111111111111111";
    writePackedRefs(repo, [
      `${sha} refs/remotes/origin/HEAD`,
      `${sha} refs/remotes/origin/develop`,
    ]);
    const { stream: err } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "7",
      summary: "packed-refs base resolution",
      resolveSession: () => "sess-packed",
      writeLedger: okLedger(),
    });
    expect(result.content).toBe(
      "review:7 review:feature/y review:develop — packed-refs base resolution",
    );
  });

  it("resolves the base through a linked worktree's commondir indirection (task T-004 regression)", async () => {
    const { worktreeCwd } = makeLinkedWorktreeFixture("main");
    const { stream: err, output: errOut } = captureStream();
    const result = await runRecordReview({
      cwd: worktreeCwd,
      stderr: err,
      pr: "3",
      branch: "feature/worktree", // explicit override: the per-worktree branch/sha
      // machinery is a separate, pre-existing concern of git-context.ts
      // and out of scope for this fix — only base resolution is under test.
      summary: "linked worktree base resolution",
      resolveSession: () => "sess-wt",
      writeLedger: okLedger(),
    });
    // Without resolveCommonDir, findGitEntry(cwd).gitDir points at the
    // EMPTY per-worktree directory (no refs/remotes/origin/HEAD, no
    // packed-refs there), so this would fall through to the "omit with
    // warning" path and the review:<base> tag would be missing.
    expect(result.content).toBe(
      "review:3 review:feature/worktree review:main — linked worktree base resolution",
    );
    expect(errOut()).not.toContain("could not be resolved");
  });

  it("--base flag overrides the origin/HEAD fallback", async () => {
    const repo = makeRepoFixture("widget-service", "feature/x");
    writeOriginHead(repo, "main");
    const { stream: err } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      base: "release/2.0",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: okLedger(),
    });
    expect(result.content).toBe("review:42 review:feature/x review:release/2.0 — s");
  });

  it("--branch flag overrides the resolved git branch", async () => {
    const repo = makeRepoFixture("widget-service", "feature/x");
    writeOriginHead(repo, "main");
    const { stream: err } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      branch: "override-branch",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: okLedger(),
    });
    expect(result.branch).toBe("override-branch");
    expect(result.content).toBe("review:42 review:override-branch review:main — s");
  });

  it("omits the base tag with a loud stderr warning when origin/HEAD cannot be resolved", async () => {
    const repo = makeRepoFixture("no-origin-repo", "main");
    // No refs/remotes/origin/HEAD, no packed-refs.
    const { stream: err, output: errOut } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "1",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: okLedger(),
    });
    expect(result.content).toBe("review:1 review:main — s");
    expect(result.wrote).toBe(true);
    expect(errOut()).toContain("no --base given and origin/HEAD could not be resolved");
    expect(errOut()).toContain("Pass --base <branch> to record it explicitly");
  });

  it("does NOT warn when --base is given explicitly", async () => {
    const repo = makeRepoFixture("no-origin-repo", "main");
    const { stream: err, output: errOut } = captureStream();
    await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "1",
      base: "trunk",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: okLedger(),
    });
    expect(errOut()).not.toContain("could not be resolved");
  });

  it("rejects an empty summary with EX_USAGE and does not write", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err, output: errOut } = captureStream();
    let wrote = false;
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      summary: "   ",
      resolveSession: () => "sess-1",
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false, content: "" });
    expect(result.reason).toContain("summary must not be empty");
    expect(errOut()).toContain("summary must not be empty");
  });

  it("rejects an empty --pr with EX_USAGE and does not write", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "  ",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: okLedger(),
    });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("--pr must not be empty");
  });

  it("fails with EX_FAIL when no branch is resolvable (not in a git work tree, no --branch)", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-nogit-"));
    cleanups.push(() => fs.rmSync(plain, { recursive: true, force: true }));
    const { stream: err, output: errOut } = captureStream();
    let wrote = false;
    const result = await runRecordReview({
      cwd: plain,
      stderr: err,
      pr: "42",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false, content: "", branch: "" });
    expect(result.reason).toContain("no branch resolvable");
    expect(errOut()).toContain("no branch resolvable");
  });

  it("fails with EX_FAIL on a detached HEAD (raw sha in .git/HEAD, no --branch) with the same specific message", async () => {
    const repo = makeDetachedHeadFixture("detached-repo");
    const { stream: err, output: errOut } = captureStream();
    let wrote = false;
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false, content: "", branch: "" });
    expect(result.reason).toBe(
      "no branch resolvable (cwd is not inside a git work tree, or HEAD is detached); pass --branch <name>",
    );
    expect(errOut()).toContain(
      "no branch resolvable (cwd is not inside a git work tree, or HEAD is detached); pass --branch <name>",
    );
  });

  it("surfaces a failed ledger write without throwing (EX_FAIL, wrote:false)", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err, output: errOut } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      summary: "s",
      resolveSession: () => "sess-1",
      writeLedger: async () => ({ ok: false, reason: "grounding-mcp timeout after 5000ms" }),
    });
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false });
    expect(result.reason).toContain("ledger write failed");
    expect(result.reason).toContain("grounding-mcp timeout after 5000ms");
    expect(errOut()).toContain("grounding-mcp timeout after 5000ms");
  });

  it("reports a manifest load failure when no writeLedger is injected", async () => {
    const repo = makeRepoFixture("repo-cfg");
    const { stream: err, output: errOut } = captureStream();
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      summary: "s",
      configPath: path.join(repo, "does-not-exist.yaml"),
      resolveSession: () => "sess-1",
    });
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false });
    expect(result.reason).toContain("manifest load failed");
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
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "42",
      summary: "s",
      configPath: manifestPath,
      resolveSession: () => "sess-1",
    });
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false });
    expect(result.reason).toContain("grounding-mcp not declared");
    expect(result.reason).toContain("cannot record harness-record-review tag");
    expect(errOut()).toContain("grounding-mcp not declared");
  });

  it("--session overrides the injected resolver's explicit precedence", async () => {
    const repo = makeRepoFixture("repo-sess");
    const { stream: err } = captureStream();
    const writes: string[] = [];
    const result = await runRecordReview({
      cwd: repo,
      stderr: err,
      pr: "1",
      summary: "s",
      session: "from-flag",
      writeLedger: async (args) => {
        writes.push(args.sessionId);
        return { ok: true };
      },
    });
    expect(result.sessionId).toBe("from-flag");
    expect(writes).toEqual(["from-flag"]);
  });
});

describe("harness record review-subagent", () => {
  it("writes review-subagent:<task> + review-subagent:<branch> + verdict, with the optional summary appended", async () => {
    const repo = makeRepoFixture("widget-service", "feature/z");
    const { stream: err } = captureStream();
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const result = await runRecordReviewSubagent({
      cwd: repo,
      stderr: err,
      task: "task-123",
      verdict: "approved with nits",
      summary: "checked edge cases",
      resolveSession: () => "sess-rs",
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      content:
        "review-subagent:task-123 review-subagent:feature/z verdict:approved with nits — checked edge cases",
      sessionId: "sess-rs",
      branch: "feature/z",
    });
    expect(writes).toEqual([
      {
        sessionId: "sess-rs",
        content:
          "review-subagent:task-123 review-subagent:feature/z verdict:approved with nits — checked edge cases",
        source: "harness-record-review-subagent",
      },
    ]);
  });

  it("omits the summary suffix entirely when no summary is given", async () => {
    const repo = makeRepoFixture("widget-service", "feature/z");
    const { stream: err } = captureStream();
    const result = await runRecordReviewSubagent({
      cwd: repo,
      stderr: err,
      task: "task-123",
      verdict: "approved",
      resolveSession: () => "sess-rs",
      writeLedger: okLedger(),
    });
    expect(result.content).toBe("review-subagent:task-123 review-subagent:feature/z verdict:approved");
  });

  it("--branch overrides the resolved git branch", async () => {
    const repo = makeRepoFixture("widget-service", "feature/z");
    const { stream: err } = captureStream();
    const result = await runRecordReviewSubagent({
      cwd: repo,
      stderr: err,
      task: "task-123",
      verdict: "approved",
      branch: "override",
      resolveSession: () => "sess-rs",
      writeLedger: okLedger(),
    });
    expect(result.branch).toBe("override");
    expect(result.content).toContain("review-subagent:override");
  });

  it("rejects an empty --task with EX_USAGE and does not write", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    let wrote = false;
    const result = await runRecordReviewSubagent({
      cwd: repo,
      stderr: err,
      task: "  ",
      verdict: "approved",
      resolveSession: () => "sess-rs",
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("--task must not be empty");
  });

  it("rejects an empty --verdict with EX_USAGE and does not write", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const result = await runRecordReviewSubagent({
      cwd: repo,
      stderr: err,
      task: "task-1",
      verdict: "",
      resolveSession: () => "sess-rs",
      writeLedger: okLedger(),
    });
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false });
    expect(result.reason).toContain("--verdict must not be empty");
  });

  it("fails with EX_FAIL when no branch is resolvable", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "harness-record-rs-nogit-"));
    cleanups.push(() => fs.rmSync(plain, { recursive: true, force: true }));
    const { stream: err, output: errOut } = captureStream();
    const result = await runRecordReviewSubagent({
      cwd: plain,
      stderr: err,
      task: "task-1",
      verdict: "approved",
      resolveSession: () => "sess-rs",
      writeLedger: okLedger(),
    });
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false, branch: "" });
    expect(result.reason).toContain("no branch resolvable");
    expect(errOut()).toContain("no branch resolvable");
  });

  it("surfaces a failed ledger write without throwing", async () => {
    const repo = makeRepoFixture("widget-service");
    const { stream: err } = captureStream();
    const result = await runRecordReviewSubagent({
      cwd: repo,
      stderr: err,
      task: "task-1",
      verdict: "approved",
      resolveSession: () => "sess-rs",
      writeLedger: async () => ({ ok: false, reason: "grounding-mcp exited: boom" }),
    });
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false });
    expect(result.reason).toContain("ledger write failed");
    expect(result.reason).toContain("grounding-mcp exited: boom");
  });
});

describe("harness record dogfood", () => {
  it("writes dogfood:<session> plus the summary", async () => {
    const { stream: err } = captureStream();
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const result = await runRecordDogfood({
      stderr: err,
      summary: "installed, ran CLI happy path, MCP handshake ok",
      resolveSession: () => "sess-df",
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      content: "dogfood:sess-df — installed, ran CLI happy path, MCP handshake ok",
      sessionId: "sess-df",
      branch: "",
    });
    expect(writes).toEqual([
      {
        sessionId: "sess-df",
        content: "dogfood:sess-df — installed, ran CLI happy path, MCP handshake ok",
        source: "harness-record-dogfood",
      },
    ]);
  });

  it("rejects an empty summary with EX_USAGE and does not write", async () => {
    const { stream: err, output: errOut } = captureStream();
    let wrote = false;
    const result = await runRecordDogfood({
      stderr: err,
      summary: "",
      resolveSession: () => "sess-df",
      writeLedger: async () => {
        wrote = true;
        return { ok: true };
      },
    });
    expect(wrote).toBe(false);
    expect(result).toMatchObject({ exitCode: EX_USAGE, wrote: false, content: "" });
    expect(result.reason).toContain("summary must not be empty");
    expect(errOut()).toContain("summary must not be empty");
  });

  it("surfaces a failed ledger write without throwing", async () => {
    const { stream: err, output: errOut } = captureStream();
    const result = await runRecordDogfood({
      stderr: err,
      summary: "s",
      resolveSession: () => "sess-df",
      writeLedger: async () => ({ ok: false, reason: "grounding-mcp timeout after 5000ms" }),
    });
    expect(result).toMatchObject({ exitCode: EX_FAIL, wrote: false });
    expect(result.reason).toContain("ledger write failed");
    expect(errOut()).toContain("grounding-mcp timeout after 5000ms");
  });

  it("falls back to the literal 'default' session id when nothing resolves, and still writes (task T-004)", async () => {
    // Pins the behavior when NO --session flag, NO $CLAUDE_CODE_SESSION_ID /
    // $CLAUDE_SESSION_ID env, and NO discoverable Claude Code transcript
    // exist: the production resolver (runtime/session-id.ts's
    // resolveReadSessionId, already unit-pinned in
    // tests/runtime/session-id.test.ts to fall back to the literal string
    // "default" at its tier-5) is simulated here via the injected seam
    // rather than clearing real env / scanning a real ~/.claude/projects,
    // so this stays hermetic.
    //
    // Consequence for the dogfood-before-release gate: `record dogfood`
    // does NOT treat an unresolvable session as an error — it writes
    // `dogfood:default — <summary>` under sessionId "default" and reports
    // wrote:true. But this fact can effectively never satisfy a REAL
    // session's gate check: intercept.ts scopes the ledger query by the
    // WRITE-path `resolveSessionId(event.session_id)` at the moment
    // `npm publish` / `git tag v*` fires, and a genuine Claude Code
    // PreToolUse hook event always carries a real session_id (a UUID), so
    // that query resolves to the live UUID, not "default" — a
    // `dogfood:default` fact recorded under a DIFFERENT session id is
    // invisible to it. The only way this fact satisfies a gate is if the
    // gate-triggering event's OWN session id ALSO bottoms out at the
    // literal "default" (no event session_id and no env vars set), which
    // does not happen for a live agent session.
    const { stream: err } = captureStream();
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const result = await runRecordDogfood({
      stderr: err,
      summary: "no session available",
      resolveSession: () => "default",
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      content: "dogfood:default — no session available",
      sessionId: "default",
      branch: "",
    });
    expect(writes).toEqual([
      {
        sessionId: "default",
        content: "dogfood:default — no session available",
        source: "harness-record-dogfood",
      },
    ]);
  });

  it("--session flag is used verbatim in both the tag and the ledger write", async () => {
    const { stream: err } = captureStream();
    const result = await runRecordDogfood({
      stderr: err,
      summary: "s",
      session: "explicit-session",
      writeLedger: okLedger(),
    });
    expect(result.sessionId).toBe("explicit-session");
    expect(result.content).toBe("dogfood:explicit-session — s");
  });
});
