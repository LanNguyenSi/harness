// Phase 7 #6 — `harness approve risk` CLI verb tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveRisk } from "../../src/cli/approve/risk.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import { makeManifest } from "../_helpers/manifest.js";
import type { McpServer } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
// Hermetic env hygiene: the harness CI shell, the operator's interactive
// shell, and the Claude Code session that runs `vitest` may each export
// any of the session-id env vars. Clear all three before AND after so a
// test that doesn't touch env never inherits one accidentally.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-approve-risk-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GROUNDING_MCP: McpServer = {
  name: "grounding-mcp",
  command: ["node", "/fake/grounding.js"],
  enabled: true,
} as McpServer;

const manifestWithGrounding = () => makeManifest({ mcps: [GROUNDING_MCP] });

describe("approveRisk — happy path", () => {
  it("writes the risk-approved:<session> ledger tag for an explicit --session", async () => {
    const calls: Array<{ sessionId: string; content: string }> = [];
    const result = await approveRisk({
      session: "sess-xyz",
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async (sessionId, content) => {
        calls.push({ sessionId, content });
        return { ok: true };
      },
    });
    expect(result.sessionId).toBe("sess-xyz");
    expect(result.sessionSource).toBe("flag");
    expect(result.ledger).toEqual({ ok: true, tag: "risk-approved:sess-xyz" });
    expect(calls).toEqual([
      { sessionId: "sess-xyz", content: "risk-approved:sess-xyz" },
    ]);
  });

  it("resolves the session from $CLAUDE_CODE_SESSION_ID when no flag is given", async () => {
    // $CLAUDE_CODE_SESSION_ID is the variable Claude Code itself exports
    // into the agent shell. Before task 058b31a3 the resolver only read
    // $CLAUDE_SESSION_ID, so an arg-less `harness approve risk` from
    // inside a Claude Code session silently fell through to the
    // .pending-approval tier even though the env tier would have
    // resolved cleanly. Read first now.
    process.env.CLAUDE_CODE_SESSION_ID = "claude-code-sess";
    const result = await approveRisk({
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("claude-code-sess");
    expect(result.sessionSource).toBe("env-claude-code");
    expect(result.ledger.tag).toBe("risk-approved:claude-code-sess");
  });

  it("resolves the session from $CLAUDE_SESSION_ID when no flag is given", async () => {
    process.env.CLAUDE_SESSION_ID = "env-sess";
    const result = await approveRisk({
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("env-sess");
    expect(result.sessionSource).toBe("env-claude");
    expect(result.ledger.tag).toBe("risk-approved:env-sess");
  });

  it("resolves the session from $CODEX_SESSION_ID when only Codex env is set", async () => {
    process.env.CODEX_SESSION_ID = "codex-sess";
    const result = await approveRisk({
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("codex-sess");
    expect(result.sessionSource).toBe("env-codex");
  });

  it("env precedence: $CLAUDE_CODE_SESSION_ID > $CLAUDE_SESSION_ID > $CODEX_SESSION_ID", async () => {
    // A dual-export environment (operator hand-set CLAUDE_SESSION_ID
    // before the runtime also set CLAUDE_CODE_SESSION_ID, or has both
    // Claude + Codex shells) takes the canonical Claude Code var first.
    // The CLI annotates the source in stdout so a wrong pick is visible.
    process.env.CLAUDE_CODE_SESSION_ID = "claude-code-sess";
    process.env.CLAUDE_SESSION_ID = "legacy-claude-sess";
    process.env.CODEX_SESSION_ID = "codex-sess";
    const result = await approveRisk({
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("claude-code-sess");
    expect(result.sessionSource).toBe("env-claude-code");
  });

  it("env precedence: $CLAUDE_SESSION_ID > $CODEX_SESSION_ID when no claude-code var", async () => {
    process.env.CLAUDE_SESSION_ID = "legacy-claude-sess";
    process.env.CODEX_SESSION_ID = "codex-sess";
    const result = await approveRisk({
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("legacy-claude-sess");
    expect(result.sessionSource).toBe("env-claude");
  });

  it("--session beats every env var", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "claude-code-sess";
    process.env.CLAUDE_SESSION_ID = "legacy-claude-sess";
    process.env.CODEX_SESSION_ID = "codex-sess";
    const result = await approveRisk({
      session: "flag-sess",
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("flag-sess");
    expect(result.sessionSource).toBe("flag");
  });

  it("resolves the session from the staged .pending-approval file", async () => {
    const generatedDir = tmpGeneratedDir();
    fs.writeFileSync(
      path.join(generatedDir, ".pending-approval"),
      "staged-sess",
      "utf8",
    );
    const result = await approveRisk({
      generatedDir,
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sessionId).toBe("staged-sess");
    expect(result.sessionSource).toBe("pending-approval");
  });
});

describe("approveRisk — degraded + error paths", () => {
  it("surfaces a degraded ledger result when grounding-mcp is not declared", async () => {
    const result = await approveRisk({
      session: "sess-1",
      generatedDir: tmpGeneratedDir(),
      manifest: makeManifest({}), // no grounding-mcp
    });
    expect(result.sessionId).toBe("sess-1");
    expect(result.ledger.ok).toBe(false);
    expect(result.ledger.tag).toBe("risk-approved:sess-1");
    expect(result.ledger.reason).toMatch(/grounding-mcp/);
  });

  it("surfaces the ledger writer's failure reason", async () => {
    const result = await approveRisk({
      session: "sess-1",
      generatedDir: tmpGeneratedDir(),
      manifest: manifestWithGrounding(),
      ledgerAdd: async () => ({ ok: false, reason: "ledger unreachable" }),
    });
    expect(result.ledger).toEqual({
      ok: false,
      tag: "risk-approved:sess-1",
      reason: "ledger unreachable",
    });
  });

  it("throws EX_FAIL when no session id can be resolved", async () => {
    let caught: unknown;
    try {
      await approveRisk({
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
    // The error must name every accepted env var so an operator inside
    // any runtime can fix the call themselves.
    expect(msg).toContain("$CLAUDE_CODE_SESSION_ID");
    expect(msg).toContain("$CLAUDE_SESSION_ID");
    expect(msg).toContain("$CODEX_SESSION_ID");
  });
});
