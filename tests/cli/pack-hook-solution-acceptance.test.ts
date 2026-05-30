import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runPackHookSolutionAcceptanceCli } from "../../src/cli/pack/hook-solution-acceptance.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const HEAD = "f30767afdc14013a48cd0c024a82213f2f63855a";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const TASK = "task-42";

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

/** A temp git work tree whose HEAD resolves to `sha`. */
function repoAtHead(sha: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-gate-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/work\n");
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "work"), `${sha}\n`);
  return repo;
}

function verdictDirWith(id: string | null, opts: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-verdicts-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (id !== null) {
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        head: HEAD,
        ready: true,
        confidence: 0.9,
        blockers: [],
        timestamp: "2026-05-30T00:00:00.000Z",
        source: "preflight",
        ...opts,
      }),
    );
  }
  return dir;
}

function manifest(enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "solution-acceptance", enabled, config: {} }],
  });
}

const TASK_FINISH = "mcp__agent-tasks__task_finish";

async function run(over: {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  cwd: string;
  verdictDir: string;
  activeClaim?: string | null;
  manifest?: Manifest;
}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const res = await runPackHookSolutionAcceptanceCli({
    stdin: streamFrom(
      JSON.stringify({
        session_id: "sess-1",
        tool_name: over.toolName ?? TASK_FINISH,
        cwd: over.cwd,
        ...(over.toolInput !== undefined && { tool_input: over.toolInput }),
      }),
    ),
    stdout: stdout.stream,
    stderr: stderr.stream,
    cwd: over.cwd,
    verdictDir: over.verdictDir,
    activeClaim: over.activeClaim !== undefined ? over.activeClaim : TASK,
    manifest: over.manifest ?? manifest(),
  });
  return { res, out: stdout.output(), err: stderr.output() };
}

describe("completion-gate — decision matrix", () => {
  it("ALLOWS a completion verb when a ready verdict exists at the current HEAD", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: true }),
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("BLOCKS when no verdict exists", async () => {
    const { res, out } = await run({ cwd: repoAtHead(HEAD), verdictDir: verdictDirWith(null) });
    expect(res.blocked).toBe(true);
    const env = JSON.parse(out);
    expect(env.decision).toBe("block");
    expect(env.reason).toMatch(/no solution-acceptance verdict/);
  });

  it("BLOCKS a not-ready verdict and surfaces the blockers", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { ready: false, blockers: ["2 tests failing"] }),
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/not ready: 2 tests failing/);
  });

  it("BLOCKS a verdict recorded at a different HEAD (drift)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: OTHER, ready: true }),
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/stale/);
  });

  it("BLOCKS when the current HEAD is unresolvable (not a git work tree)", async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "sa-nonrepo-"));
    cleanups.push(() => fs.rmSync(nonRepo, { recursive: true, force: true }));
    const { res } = await run({ cwd: nonRepo, verdictDir: verdictDirWith(TASK, { head: HEAD }) });
    expect(res.blocked).toBe(true);
  });

  it("BLOCKS (fail-closed) when there is no active-claim task id", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD }),
      activeClaim: null,
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/no active-claim/);
  });

  it("keys the verdict on the active-claim id, not the session id", async () => {
    // The marker is written for "other-task" but the active claim is TASK,
    // so the gate must look up TASK (find nothing) and BLOCK.
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith("other-task", { head: HEAD }),
      activeClaim: TASK,
    });
    expect(res.blocked).toBe(true);
  });
});

describe("completion-gate — scoping", () => {
  it("ALLOWS when the pack is disabled", async () => {
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      manifest: manifest(false),
    });
    expect(res.blocked).toBe(false);
  });

  it("ALLOWS a non-completion tool (Bash that is not push/merge)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      toolName: "Bash",
      toolInput: { command: "git status" },
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("GATES a `git push` Bash command (blocks with no verdict)", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      toolName: "Bash",
      toolInput: { command: "git push origin work" },
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/no solution-acceptance verdict/);
  });

  it("GATES `gh pr merge` and ALLOWS it once a ready verdict is present", async () => {
    const dir = verdictDirWith(TASK, { head: HEAD, ready: true });
    const blocked = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      toolName: "Bash",
      toolInput: { command: "gh pr merge 7 --squash" },
    });
    expect(blocked.res.blocked).toBe(true);
    const allowed = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: dir,
      toolName: "Bash",
      toolInput: { command: "gh pr merge 7 --squash" },
    });
    expect(allowed.res.blocked).toBe(false);
  });
});
