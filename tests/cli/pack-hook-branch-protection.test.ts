import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runPackHookBranchProtectionCli } from "../../src/cli/pack/hook-branch-protection.js";
import { writeBranchProtectionMarker } from "../../src/policy-packs/builtin/branch-protection-runtime.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

function makeGeneratedDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-gen-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

const NOW = new Date("2026-05-16T12:00:00Z");
function ledgerAt(content: string, minutesAgo = 0, id = "1"): LedgerEntry {
  return {
    id,
    content,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

function eventJson(
  over: Partial<{
    session_id: string;
    tool_name: string;
    cwd: string;
    tool_input: Record<string, unknown>;
  }> = {},
): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: over.session_id ?? "sess-1",
    tool_name: over.tool_name ?? "Write",
    cwd: over.cwd ?? "/tmp",
    ...(over.tool_input !== undefined && { tool_input: over.tool_input }),
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

  it("allows on a protected branch when the operator-only override MARKER exists (audit finding #39)", async () => {
    const repo = makeRepoFixture("svc", "master");
    const generatedDir = makeGeneratedDir();
    // Operator-written marker (canonical override signal). Mirrors what
    // `harness approve branch-protection --session sess-1` writes.
    writeBranchProtectionMarker(generatedDir, "sess-1", {
      approvedAt: NOW.toISOString(),
      approvedBy: "operator",
    });
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo, session_id: "sess-1" })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      generatedDir,
      now: NOW,
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/override marker active/);
  });

  it("BLOCKS on a protected branch when only an agent-writable branch-protection-ack ledger tag exists (no marker) — audit finding #39", async () => {
    // The ledger tag is reachable by the agent via its own ledger_add MCP
    // access, so it is no longer a trusted override. Without the
    // operator-only marker the gate must still refuse.
    const repo = makeRepoFixture("svc", "master");
    const generatedDir = makeGeneratedDir();
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo, session_id: "sess-1" })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      generatedDir,
      now: NOW,
      // A fresh ack tag — would have satisfied the pre-#39 override path.
      ledgerQuery: async () => [
        ledgerAt("branch-protection-ack:hotfix prod", 1, "ack-1"),
      ],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.decision).toBe("block");
    // The now-untrusted ledger ack is echoed in the diagnostic for audit,
    // but did not open the gate.
    expect(result.diagnostic).toMatch(/no longer satisfies the gate/);
  });

  it("does not let one session's override marker unblock a different session", async () => {
    const repo = makeRepoFixture("svc", "master");
    const generatedDir = makeGeneratedDir();
    // Marker written for sess-OTHER, but the event is sess-1.
    writeBranchProtectionMarker(generatedDir, "sess-OTHER", {
      approvedAt: NOW.toISOString(),
      approvedBy: "operator",
    });
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo, session_id: "sess-1" })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      generatedDir,
      now: NOW,
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    expect(JSON.parse(outBuf()).decision).toBe("block");
  });

  it("allows a Write whose target path is outside any git repo, even from a protected-branch cwd", async () => {
    const repo = makeRepoFixture("svc", "master");
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bp-memory-"));
    cleanups.push(() => fs.rmSync(memoryDir, { recursive: true, force: true }));
    const target = path.join(memoryDir, "feedback_thing.md");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_name: "Write", tool_input: { file_path: target } }),
      ),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/target is not on a named branch/);
  });

  it("allows a Write whose target is in a different repo on a NON-protected branch, even when cwd is on a protected branch", async () => {
    const cwdRepo = makeRepoFixture("svc-on-master", "master");
    const otherRepo = makeRepoFixture("svc-on-feat", "feat/cool");
    const target = path.join(otherRepo, "src/index.ts");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(
        eventJson({ cwd: cwdRepo, tool_name: "Edit", tool_input: { file_path: target } }),
      ),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/not in the protected list/);
  });

  it("falls back to cwd for tools without a single target path (e.g. Bash) — and allows when cwd's branch is unprotected", async () => {
    const repo = makeRepoFixture("svc", "feat/cool");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_name: "Bash", tool_input: { command: "ls" } }),
      ),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/not in the protected list/);
  });

  it("treats a relative file_path as relative to cwd (so a Write to './src/x.ts' in cwd-repo still gates on cwd-repo's branch)", async () => {
    const repo = makeRepoFixture("svc", "feat/cool");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(
        eventJson({
          cwd: repo,
          tool_name: "Write",
          tool_input: { file_path: "./src/index.ts" },
        }),
      ),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(false);
    expect(outBuf()).toBe("");
    expect(result.diagnostic).toMatch(/not in the protected list/);
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

  it("blocks a Write to a file inside the cwd's repo when both are on a protected branch (no regression)", async () => {
    const repo = makeRepoFixture("svc", "master");
    const target = path.join(repo, "src/index.ts");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(
        eventJson({ cwd: repo, tool_name: "Write", tool_input: { file_path: target } }),
      ),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/refusing Write on protected branch "master"/);
  });

  it("blocks a Write when the TARGET path is in a different repo that is ALSO on a protected branch (gate follows target, not cwd)", async () => {
    const cwdRepo = makeRepoFixture("svc-feat", "feat/cool");
    const targetRepo = makeRepoFixture("svc-prod", "master");
    const target = path.join(targetRepo, "src/index.ts");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(
        eventJson({ cwd: cwdRepo, tool_name: "Edit", tool_input: { file_path: target } }),
      ),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/refusing Edit on protected branch "master"/);
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
    const savedCodeEnv = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnv;
      if (savedCodeEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = savedCodeEnv;
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

  it("resolves session_id from $CLAUDE_CODE_SESSION_ID when stdin omits it (task 6562b9f6)", async () => {
    const repo = makeRepoFixture("svc", "master");
    const savedEnv = process.env.CLAUDE_SESSION_ID;
    const savedCodeEnv = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "code-env-sess-bp";
    cleanups.push(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = savedEnv;
      if (savedCodeEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = savedCodeEnv;
    });
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(JSON.stringify({ tool_name: "Write", cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      ledgerQuery: async () => [],
    });
    // The "no session_id resolvable" branch must NOT fire — env fallback supplied it.
    if (result.blocked) {
      const envelope = JSON.parse(outBuf());
      expect(envelope.reason).not.toMatch(/no session_id resolvable/);
    }
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

  it("rejects a `policy_decision` row whose serialized content embeds the producer tag (substring pollution)", async () => {
    // policy_decision rows can incidentally carry the same tag they
    // audit (e.g. an engine-recorded denial referencing this very
    // pack's ledger_tag). Mirrors the filter in src/policies/requires.ts.
    // Without this filter, any past denied decision against
    // branch-protection would unblock the next gate evaluation.
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack(),
      now: NOW,
      ledgerQuery: async () => [
        // Row carries the literal producer tag in its content AND is
        // fresh, but is a policy_decision audit record — must NOT
        // satisfy the gate.
        {
          id: "pd-1",
          content: '{"ledgerTag":"branch:non-protected","outcome":"deny"}',
          createdAt: recent,
          type: "policy_decision",
        },
        // Legacy backstop: pre-Phase-5-#4 rows lack a type field but
        // carry the policy_decision: prefix in content. Same rejection.
        {
          id: "pd-legacy",
          content: "policy_decision:branch:non-protected outcome:deny",
          createdAt: recent,
        },
        // Same for the ack prefix — a denied decision referencing the
        // ack tag should not flip the override on.
        {
          id: "pd-ack",
          content: '{"ledgerTag":"branch-protection-ack","outcome":"deny"}',
          createdAt: recent,
          type: "policy_decision",
        },
      ],
    });
    expect(result.blocked).toBe(true);
    expect(outBuf()).toContain('"decision":"block"');
  });

  it("blocks (failsafe) when the manifest cannot be loaded", async () => {
    // Manifest unresolvable: we can't know if the pack is enabled or
    // what the protected list is. The blocker must refuse rather than
    // silently allow, with a clear hint pointing at the failure.
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err, output: errOut } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson()),
      stdout: out,
      stderr: err,
      // Point at a manifest path that does not exist. loadManifest()
      // throws HarnessExitError for ENOENT; the blocker catches and
      // forces a block.
      configPath: "/nonexistent/path/harness.yaml",
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    expect(envelope.decision).toBe("block");
    expect(envelope.reason).toMatch(/manifest load failed/);
    expect(errOut()).toMatch(/refusing on failsafe/);
  });
});

describe("runPackHookBranchProtectionCli — agent-facing ux (agent-tasks/9806d4f8)", () => {
  // When config.ux is declared, the deny envelope the agent sees
  // becomes the plain-language { cannot, required, run } shape with
  // ${BRANCH} substituted, and the legacy "branch-protection:
  // refusing ... + Protected branches: ..." vocabulary is suppressed.
  // The stderr BLOCK diagnostic keeps the engine-vocabulary reason
  // (`detail` argument) for operator audit.
  const UX = {
    cannot: "You cannot edit files on protected branch ${BRANCH} yet.",
    required: ["a checkout of a non-protected branch (current `${BRANCH}` is protected)"],
    run: ["git checkout -b feat/<your-task>", "harness session-start branch-check"],
  };

  it("emits the verbatim agent-facing block with ${BRANCH} substituted", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    const result = await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack({ ux: UX }),
      ledgerQuery: async () => [],
    });
    expect(result.blocked).toBe(true);
    const envelope = JSON.parse(outBuf());
    const expected = [
      "You cannot edit files on protected branch master yet.",
      "",
      "Required:",
      "- a checkout of a non-protected branch (current `master` is protected)",
      "",
      "Run:",
      "  git checkout -b feat/<your-task>",
      "  harness session-start branch-check",
    ].join("\n");
    expect(envelope.reason).toBe(expected);
    expect(envelope.hookSpecificOutput.permissionDecisionReason).toBe(expected);
  });

  it("does not leak legacy engine vocabulary to the agent surface when ux is declared", async () => {
    const repo = makeRepoFixture("svc", "main");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack({ ux: UX }),
      ledgerQuery: async () => [],
    });
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).not.toContain("branch-protection: refusing");
    expect(envelope.reason).not.toContain("Protected branches:");
    expect(envelope.reason).not.toContain("Override (use sparingly)");
    expect(envelope.reason).not.toMatch(/ledger/i);
  });

  it("keeps the engine-vocabulary BLOCK reason on stderr (operator audit surface)", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out } = captureStream();
    const { stream: err, output: errOut } = captureStream();
    await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack({ ux: UX }),
      ledgerQuery: async () => [],
    });
    expect(errOut()).toMatch(/BLOCK — no fresh branch:non-protected tag/);
  });

  it("falls back to the legacy envelope when ux is missing", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err } = captureStream();
    await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      manifest: manifestWithPack({}),
      ledgerQuery: async () => [],
    });
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).toContain("branch-protection: refusing");
    expect(envelope.reason).toContain("Protected branches:");
  });

  it("logs to stderr and falls back to the legacy envelope when config.ux is malformed", async () => {
    const repo = makeRepoFixture("svc", "master");
    const { stream: out, output: outBuf } = captureStream();
    const { stream: err, output: errOut } = captureStream();
    await runPackHookBranchProtectionCli({
      stdin: streamFrom(eventJson({ cwd: repo })),
      stdout: out,
      stderr: err,
      // Empty required array violates min(1)
      manifest: manifestWithPack({ ux: { cannot: "x", required: [], run: ["y"] } }),
      ledgerQuery: async () => [],
    });
    expect(errOut()).toMatch(/config\.ux ignored/);
    const envelope = JSON.parse(outBuf());
    expect(envelope.reason).toContain("branch-protection: refusing");
  });
});
