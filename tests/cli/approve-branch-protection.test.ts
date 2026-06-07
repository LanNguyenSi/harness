// `harness approve branch-protection` CLI verb tests (audit finding #39).
//
// The verb writes the operator-only override MARKER the branch-protection
// blocker consults, plus a best-effort audit ledger echo. The round-trip
// test pins the security property: the marker (not the agent-writable
// ledger tag) is what opens the gate.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveBranchProtection } from "../../src/cli/approve/branch-protection.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import {
  branchProtectionMarkerName,
  ACK_TAG_PREFIX,
} from "../../src/policy-packs/builtin/branch-protection-runtime.js";
import { APPROVAL_MARKER_DIRNAME } from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { makeManifest } from "../_helpers/manifest.js";
import { parseManifest, type McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

function tmpGeneratedDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-approve-bp-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GROUNDING_MCP: McpServer = {
  name: "grounding-mcp",
  command: ["node", "/fake/grounding.js"],
  enabled: true,
} as McpServer;

const manifestWithGrounding = () => makeManifest({ mcps: [GROUNDING_MCP] });

describe("approveBranchProtection — happy path", () => {
  it("writes the canonical override marker for an explicit --session", async () => {
    const generatedDir = tmpGeneratedDir();
    const result = await approveBranchProtection({
      session: "sess-xyz",
      generatedDir,
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("sess-xyz");
    expect(result.sessionSource).toBe("flag");
    expect(result.marker.ok).toBe(true);
    const expectedPath = path.join(
      generatedDir,
      APPROVAL_MARKER_DIRNAME,
      branchProtectionMarkerName("sess-xyz"),
    );
    expect(result.marker.ok && result.marker.filePath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("records a best-effort audit ledger echo with the operator reason", async () => {
    const calls: Array<{ sessionId: string; content: string }> = [];
    const result = await approveBranchProtection({
      session: "sess-1",
      reason: "hotfix prod",
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async (sessionId, content) => {
        calls.push({ sessionId, content });
        return { ok: true };
      },
    });
    expect(result.ledger).toEqual({ ok: true, tag: `${ACK_TAG_PREFIX}:hotfix prod` });
    expect(calls).toEqual([{ sessionId: "sess-1", content: `${ACK_TAG_PREFIX}:hotfix prod` }]);
  });

  it("resolves the session from $CLAUDE_CODE_SESSION_ID when no flag is given", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "claude-code-sess";
    const result = await approveBranchProtection({
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("claude-code-sess");
    expect(result.sessionSource).toBe("env-claude-code");
  });

  it("resolves the session from the staged .pending-approval file", async () => {
    const generatedDir = tmpGeneratedDir();
    fs.writeFileSync(path.join(generatedDir, ".pending-approval"), "staged-sess", "utf8");
    const result = await approveBranchProtection({
      generatedDir,
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("staged-sess");
    expect(result.sessionSource).toBe("pending-approval");
  });
});

describe("approveBranchProtection — degraded + error paths", () => {
  it("still writes the marker even when the audit ledger write is degraded", async () => {
    // The marker is what unblocks the gate; a missing grounding-mcp must
    // not abort the approval.
    const result = await approveBranchProtection({
      session: "sess-1",
      generatedDir: tmpGeneratedDir(),
      manifest: makeManifest({}), // no grounding-mcp
    });
    expect(result.marker.ok).toBe(true);
    expect(result.ledger.ok).toBe(false);
    expect(result.ledger.reason).toMatch(/grounding-mcp/);
  });

  it("throws EX_FAIL when no session id can be resolved", async () => {
    let caught: unknown;
    try {
      await approveBranchProtection({
        generatedDir: tmpGeneratedDir(),
        manifest: manifestWithGrounding(),
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    expect((caught as HarnessExitError).exitCode).toBe(1);
    const msg = (caught as HarnessExitError).message;
    expect(msg).toMatch(/no session id/);
    expect(msg).toContain("$CLAUDE_CODE_SESSION_ID");
  });
});

describe("approveBranchProtection — round-trip with the blocker", () => {
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
  function makeMasterRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-rt-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "svc");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/master\n");
    return repo;
  }
  const manifestPack = () =>
    parseManifest({ version: 1, policy_packs: [{ name: "branch-protection", config: {}, enabled: true }] });

  it("a marker written by approveBranchProtection opens the gate for that session", async () => {
    const generatedDir = tmpGeneratedDir();
    const repo = makeMasterRepo();
    // 1. Before approval: the gate blocks on master with no marker.
    const before = captureStream();
    await runPackHookBranchProtectionCli({
      stdin: streamFrom(JSON.stringify({ tool_name: "Write", cwd: repo, session_id: "rt-sess" })),
      stdout: before.stream,
      stderr: captureStream().stream,
      manifest: manifestPack(),
      generatedDir,
      ledgerQuery: async () => [],
    }).then((r) => expect(r.blocked).toBe(true));

    // 2. Operator approves via the CLI verb.
    const approved = await approveBranchProtection({
      session: "rt-sess",
      generatedDir,
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(approved.marker.ok).toBe(true);

    // 3. After approval: the same session is allowed.
    const after = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(JSON.stringify({ tool_name: "Write", cwd: repo, session_id: "rt-sess" })),
      stdout: after.stream,
      stderr: captureStream().stream,
      manifest: manifestPack(),
      generatedDir,
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(after.output()).toBe("");
    expect(result.diagnostic).toMatch(/override marker active/);
  });
});
