import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runPackHookPostMergeGateRecordCli } from "../../src/cli/pack/hook-post-merge-gate-record.js";
import { MERGED_TAG_PREFIX } from "../../src/policy-packs/builtin/post-merge-gate-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

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

function makeRepoFixture(name: string, branch: string, sha: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-record-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  const refPath = path.join(repo, ".git", "refs", "heads", branch);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(refPath, `${sha}\n`);
  return repo;
}

const SHA = "a".repeat(40);

function eventJson(
  over: Partial<{
    session_id: string;
    tool_name: string;
    cwd: string;
    tool_input: Record<string, unknown>;
    tool_output: unknown;
  }> = {},
): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: over.session_id ?? "sess-1",
    tool_name: over.tool_name ?? "Bash",
    cwd: over.cwd ?? "/tmp",
    tool_input: over.tool_input ?? { command: "gh pr merge" },
    ...(over.tool_output !== undefined && { tool_output: over.tool_output }),
  });
}

function manifestNoPolicyPacks(): Manifest {
  return parseManifest({ version: 1 });
}

describe("runPackHookPostMergeGateRecordCli — writes on confirmed success", () => {
  it("writes the merged fact when exit_code is exactly 0", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const { stream: err } = captureStream();
    let written: { sessionId: string; content: string; source: string } | undefined;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 0, stdout: "merged", stderr: "" } })),
      stderr: err,
      manifest: manifestNoPolicyPacks(),
      now: new Date("2026-07-23T00:00:00.000Z"),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(written).toBeDefined();
    expect(written?.content).toContain(`${MERGED_TAG_PREFIX}:svc:feat/cool:${SHA}`);
    expect(written?.content).toContain("at:2026-07-23T00:00:00.000Z");
    expect(written?.sessionId).toBe("sess-1");
  });

  it("extracts the PR number when present in the command", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let written: { content: string } | undefined;
    await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_input: { command: "gh pr merge --squash 42" },
          tool_output: { exit_code: 0 },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async (args) => {
        written = args;
        return { ok: true };
      },
    });
    expect(written?.content).toContain("pr:42");
  });
});

describe("runPackHookPostMergeGateRecordCli — no fact on anything but confirmed success", () => {
  it("writes nothing when exit_code is non-zero", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 1, stderr: "conflict" } })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/not a confirmed success/);
  });

  it("writes nothing when tool_output has an unexpected/unknown shape", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_output: { exitCode: 0 /* wrong key name */ } }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/unresolvable \(unexpected tool_output shape\)/);
  });

  // Coordinator review follow-up (post-merge-gate): the decisions doc
  // explicitly names `tool_response` as an alternate payload shape a
  // future Claude Code version (or a differently-shimmed adapter) could
  // send instead of `tool_output`. The runtime unit test only covers
  // `extractExitCode` in isolation; this pins the SAME defensive behavior
  // at the full CLI level — a complete, otherwise well-formed event whose
  // exit-code payload lives under `tool_response` instead of `tool_output`
  // must still write NO fact (no special-casing ever reads tool_response).
  it("writes nothing when the payload uses tool_response instead of tool_output (documented alternate-shape variant)", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: "sess-1",
          tool_name: "Bash",
          cwd: repo,
          tool_input: { command: "gh pr merge" },
          tool_response: { exit_code: 0, stdout: "Merged", stderr: "" },
        }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/unresolvable \(unexpected tool_output shape\)/);
  });

  it("writes nothing when tool_output is entirely absent", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-1",
        tool_name: "Bash",
        cwd: repo,
        tool_input: { command: "gh pr merge" },
      })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when the command did not match gh pr merge", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_input: { command: "gh pr create" }, tool_output: { exit_code: 0 } }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when the tool is not Bash", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_name: "Write", tool_output: { exit_code: 0 } }),
      ),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when malformed event JSON is piped", async () => {
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom("{not json"),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
  });

  it("writes nothing when the git context is unresolvable (outside a git work tree)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pmg-record-noGit-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: root, tool_output: { exit_code: 0 } })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/cannot resolve git context/);
  });

  it("writes nothing when no session id is resolvable", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const savedEnv = process.env.CLAUDE_SESSION_ID;
    const savedCodeEnv = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnv;
      if (savedCodeEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = savedCodeEnv;
    });
    let calls = 0;
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: repo,
        tool_input: { command: "gh pr merge" },
        tool_output: { exit_code: 0 },
      })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(calls).toBe(0);
    expect(result.diagnostic).toMatch(/no session_id resolvable/);
  });

  it("writes nothing (fails open, no throw) when the manifest fails to load", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 0 } })),
      stderr: captureStream().stream,
      configPath: "/nonexistent/path/harness.yaml",
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.diagnostic).toMatch(/manifest load failed/);
  });

  it("writes nothing (no throw) when the ledger write fails", async () => {
    const repo = makeRepoFixture("svc", "feat/cool", SHA);
    const result = await runPackHookPostMergeGateRecordCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_output: { exit_code: 0 } })),
      stderr: captureStream().stream,
      manifest: manifestNoPolicyPacks(),
      writeLedger: async () => ({ ok: false, reason: "mcp connect refused" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(result.diagnostic).toMatch(/mcp connect refused/);
  });
});
