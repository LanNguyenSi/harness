import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import type { LedgerEntry } from "../../src/policies/index.js";
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

function makeRepoFixture(name: string, branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-hook-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  return repo;
}

function manifestWithPack(config: Record<string, unknown> = {}, enabled = true): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "branch-protection", config, enabled }],
  });
}

function makeLedgerEntry(content: string, ageMs = 0, id = "1"): LedgerEntry {
  return {
    id,
    content,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
  };
}

const NOW = new Date("2026-05-16T12:00:00Z");
function ledgerAt(content: string, minutesAgo = 0, id = "1"): LedgerEntry {
  return {
    id,
    content,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

function eventJson(over: Partial<{ session_id: string; tool_name: string; cwd: string }> = {}): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: over.session_id ?? "sess-1",
    tool_name: over.tool_name ?? "Write",
    cwd: over.cwd ?? "/tmp",
  });
}

describe("runPackHookBranchProtectionCli — allow paths", () => {
  it("allows when the cwd's branch is NOT in the protected list", async () => {
    const repo = makeRepoFixture("svc", "feat/cool");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/not in the protected list/);
  });

  it("allows on a protected branch when a fresh branch:non-protected tag exists", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      // Tag written 2 minutes ago — well within the 5m window.
      ledgerQuery: async () => [ledgerAt("branch:non-protected:feat/cool ready:true", 2)],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/fresh producer tag/);
  });

  it("allows on a protected branch when an explicit branch-protection-ack override exists (any age)", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      // The ack tag was written 8 hours ago — irrelevant to the override path.
      ledgerQuery: async () => [
        ledgerAt("branch-protection-ack:hotfix prod", 60 * 8, "ack-1"),
      ],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/ACK override active/);
  });

  it("allows when the pack is enabled:false (gate is opt-in)", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack({}, false),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/enabled:false/);
  });
});

describe("runPackHookBranchProtectionCli — block paths", () => {
  it("blocks on a protected branch with no satisfying ledger tag", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo, tool_name: "Edit" })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      ledgerQuery: async () => [
        // Has the producer tag but it's 20 minutes old (outside the 5m window).
        ledgerAt("branch:non-protected:feat/old", 20),
      ],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.decision).toBe("block");
    expect(envelope.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(envelope.reason).toMatch(/refusing Edit on protected branch "master"/);
    expect(envelope.reason).toMatch(/git checkout -b/);
    expect(envelope.reason).toMatch(/harness session-start branch-check/);
    expect(envelope.reason).toMatch(/branch-protection-ack/);
  });

  it("honors a custom protected_branches list (blocks on develop when extended)", async () => {
    const repo = makeRepoFixture("svc", "develop");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack({ protected_branches: ["develop"] }),
      now: NOW,
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).toContain('"develop"');
    expect(envelope.reason).toContain("Protected branches: develop");
  });

  it("blocks (failsafe) when the ledger is degraded on a protected branch", async () => {
    const repo = makeRepoFixture("svc", "main");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => ({ degraded: "mcp connect refused" }),
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).toMatch(/ledger degraded.*mcp connect refused/);
  });

  it("blocks when stdin yields no resolvable session_id on a protected branch", async () => {
    const repo = makeRepoFixture("svc", "master");
    const savedEnv = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnv;
    });
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      // No session_id field on stdin.
      stdin: streamFrom(JSON.stringify({ tool_name: "Write", cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).toMatch(/no session_id resolvable/);
  });
});

describe("runPackHookBranchProtectionCli — edge cases", () => {
  it("allows outside a git work tree (alternative would block every standalone-script Write)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-noGit-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: root })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/not on a named branch/);
  });

  it("allows when the pack is not declared in the manifest at all", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: parseManifest({ version: 1 }), // No policy_packs.
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/not declared in manifest/);
  });

  it("does not classify a `policy_decision` audit row as a satisfying tag", async () => {
    // The requires evaluator skips policy_decision rows so the same tag
    // it audited doesn't satisfy the gate it was about. The blocker's
    // own evaluator scans content + age only, so an entry that LOOKS
    // like an audit serialization should not unblock the gate. Verify
    // we filter by the producer-tag substring before time-checking.
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      ledgerQuery: async () => [
        // A row that doesn't contain either tag prefix — should not satisfy.
        makeLedgerEntry("policy_decision:no-edit-on-protected-branch outcome:deny", 60_000),
      ],
    });
    expect(result.blocked).toBe(true);
    expect(outBuf()).toContain('"decision":"block"');
  });
});
