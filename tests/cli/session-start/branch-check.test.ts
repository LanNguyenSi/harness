import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionStartBranchCheck } from "../../../src/cli/session-start/branch-check.js";
import { parseManifest, type Manifest } from "../../../src/schema/index.js";

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

function makeRepoFixture(name: string, branch = "main"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-sscb-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

function manifestWithPack(config: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "branch-protection", config }],
  });
}

describe("runSessionStartBranchCheck", () => {
  it("writes `branch:non-protected:<branch>` when the cwd is on a feature branch", async () => {
    const repo = makeRepoFixture("widget-service", "feat/cool");
    const writes: Array<{ sessionId: string; content: string; source: string }> = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartBranchCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "sess-1", cwd: repo })),
      stderr: err,
      manifest: manifestWithPack(),
      writeLedger: async (args) => {
        writes.push(args);
        return { ok: true };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.branch).toBe("feat/cool");
    expect(result.protected).toBe(false);
    expect(result.sessionId).toBe("sess-1");
    expect(writes).toEqual([
      {
        sessionId: "sess-1",
        content: "branch:non-protected:feat/cool",
        source: "harness-session-start-branch-check",
      },
    ]);
    expect(errOut()).toContain("recorded branch:non-protected:feat/cool");
  });

  it("does NOT write a tag when the cwd is on a protected branch (gate stays closed)", async () => {
    const repo = makeRepoFixture("widget-service", "master");
    const writes: string[] = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartBranchCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithPack(),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(result.protected).toBe(true);
    expect(result.branch).toBe("master");
    expect(writes).toEqual([]);
    expect(errOut()).toMatch(/is in the protected list/);
  });

  it("honors the operator's protected_branches override", async () => {
    const repo = makeRepoFixture("svc", "develop");
    const writes: string[] = [];
    const { stream: err } = captureStream();
    // Custom list does NOT include "develop", so an edit on develop should
    // be allowed: producer writes the tag.
    const result = await runSessionStartBranchCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithPack({ protected_branches: ["main", "release/*"] }),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(true);
    expect(result.protected).toBe(false);
    expect(writes).toEqual(["branch:non-protected:develop"]);
  });

  it("treats detached HEAD as protected and leaves the tag unwritten", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-sscb-det-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "detached");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".git", "HEAD"),
      "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
    );
    const writes: string[] = [];
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartBranchCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithPack(),
      writeLedger: async (args) => {
        writes.push(args.content);
        return { ok: true };
      },
    });
    expect(result.wrote).toBe(false);
    expect(result.protected).toBe(true);
    expect(result.branch).toBe("");
    expect(writes).toEqual([]);
    expect(errOut()).toMatch(/detached HEAD/);
  });

  it("non-blocking on ledger write failure (exit 0 + diagnostic)", async () => {
    const repo = makeRepoFixture("svc", "feat/x");
    const { stream: err, output: errOut } = captureStream();
    const result = await runSessionStartBranchCheck({
      stdin: streamFrom(JSON.stringify({ session_id: "s", cwd: repo })),
      stderr: err,
      manifest: manifestWithPack(),
      writeLedger: async () => ({ ok: false, reason: "mcp timeout" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(false);
    expect(errOut()).toContain("ledger write failed: mcp timeout");
  });

  it("loudly warns when the session id resolved to the literal 'default'", async () => {
    const repo = makeRepoFixture("svc", "feat/x");
    const { stream: err, output: errOut } = captureStream();
    let captured: { sessionId: string } | null = null;
    await runSessionStartBranchCheck({
      // No session_id on stdin, no $CLAUDE_SESSION_ID — forces the
      // resolver into the transcript / "default" fallback.
      stdin: streamFrom(JSON.stringify({ cwd: repo })),
      stderr: err,
      manifest: manifestWithPack(),
      resolveSession: () => "default",
      writeLedger: async (args) => {
        captured = args;
        return { ok: true };
      },
    });
    expect(captured).not.toBeNull();
    expect(errOut()).toMatch(/WARNING: session resolved to the literal "default"/);
  });
});
