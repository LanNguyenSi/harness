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
  env?: NodeJS.ProcessEnv;
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
    // Hermetic: no SOLUTION_VERDICT_ID unless a case opts in, so the env knob
    // never leaks in from the runner's real environment.
    env: over.env ?? {},
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

describe("completion-gate — production resolution path (no injected manifest/claim)", () => {
  // Regression guard: in production the hook command is the bare
  // `harness pack hook solution-acceptance` (no --config), so generatedDir
  // and the active-claim id must resolve from the loaded manifest base, not
  // from opts.configPath. This test injects NEITHER manifest, generatedDir,
  // nor activeClaim — only a homeDir whose harness.generated/active-claim and
  // harness.yaml are on disk, exactly as `harness apply` would leave them.
  function makeHome(activeClaim: string | null): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sa-home-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(home, "harness.yaml"),
      "version: 1\npolicy_packs:\n  - name: solution-acceptance\n    source: builtin\n    enabled: true\n",
    );
    const gen = path.join(home, "harness.generated");
    fs.mkdirSync(gen, { recursive: true });
    if (activeClaim !== null) fs.writeFileSync(path.join(gen, "active-claim"), `${activeClaim}\n`);
    return home;
  }

  async function runProd(home: string, verdictDir: string, cwd: string) {
    const stdout = captureStream();
    const stderr = captureStream();
    const res = await runPackHookSolutionAcceptanceCli({
      stdin: streamFrom(JSON.stringify({ session_id: "s", tool_name: TASK_FINISH, cwd })),
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd,
      verdictDir,
      homeDir: home,
      env: {},
    });
    return { res, out: stdout.output() };
  }

  it("ALLOWS when active-claim + a ready verdict resolve purely from the manifest base", async () => {
    const { res, out } = await runProd(
      makeHome(TASK),
      verdictDirWith(TASK, { head: HEAD, ready: true }),
      repoAtHead(HEAD),
    );
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("BLOCKS (fail-closed) when the manifest base resolves but no active-claim file exists", async () => {
    const { res, out } = await runProd(
      makeHome(null),
      verdictDirWith(TASK, { head: HEAD }),
      repoAtHead(HEAD),
    );
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/no active-claim/);
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

describe("completion-gate — solo / non-agent-tasks verdict id (SOLUTION_VERDICT_ID)", () => {
  const SOLO = "solo-verdict";

  it("ALLOWS via SOLUTION_VERDICT_ID when no active-claim but a ready verdict exists at HEAD", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: HEAD, ready: true }),
      activeClaim: null,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("HEAD-gates the env id: BLOCKS a stale verdict for the SOLUTION_VERDICT_ID", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: OTHER, ready: true }),
      activeClaim: null,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/stale/);
  });

  it("active-claim takes precedence over SOLUTION_VERDICT_ID (env cannot redirect a claimed task)", async () => {
    // The only verdict on disk is for the env id; the active claim is TASK.
    // Claim-first means the gate looks up TASK (finds nothing) and BLOCKS,
    // proving the env did NOT override the claim.
    const { res } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: HEAD, ready: true }),
      activeClaim: TASK,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(true);
  });

  it("ALLOWS on the active-claim verdict even when SOLUTION_VERDICT_ID points elsewhere (env ignored when a claim resolves)", async () => {
    // Positive proof of claim-first: the claimed task TASK has a ready verdict
    // at HEAD; SOLUTION_VERDICT_ID names SOLO, which has NO verdict on disk. If
    // the env participated, the gate would block; it ALLOWS, so the claim won.
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(TASK, { head: HEAD, ready: true }),
      activeClaim: TASK,
      env: { SOLUTION_VERDICT_ID: SOLO },
    });
    expect(res.blocked).toBe(false);
    expect(out).toBe("");
  });

  it("BLOCKS (fail-closed) when SOLUTION_VERDICT_ID is malformed and there is no active-claim", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(SOLO, { head: HEAD, ready: true }),
      activeClaim: null,
      env: { SOLUTION_VERDICT_ID: ".." },
    });
    expect(res.blocked).toBe(true);
    expect(JSON.parse(out).reason).toMatch(/SOLUTION_VERDICT_ID/);
  });

  it("fail-closed message names both task_start and SOLUTION_VERDICT_ID when neither source resolves", async () => {
    const { res, out } = await run({
      cwd: repoAtHead(HEAD),
      verdictDir: verdictDirWith(null),
      activeClaim: null,
      env: {},
    });
    expect(res.blocked).toBe(true);
    const reason = JSON.parse(out).reason as string;
    expect(reason).toMatch(/no active-claim/);
    expect(reason).toMatch(/SOLUTION_VERDICT_ID/);
    expect(reason).toMatch(/task_start/);
  });
});
