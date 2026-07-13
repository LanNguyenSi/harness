import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pause, resume, OPERATOR_LEDGER_SESSION } from "../../src/cli/pause/index.js";
import { HarnessExitError } from "../../src/cli/exit-codes.js";
import {
  SENTINEL_BASENAME,
  readSentinel,
  sentinelPath,
} from "../../src/runtime/pause-sentinel.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;
let savedCodex: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pause-cli-"));
  // The refuseIfAgentShell guard reads three env vars; clear all so the
  // dev-host's $CLAUDE_CODE_SESSION_ID (set inside a Claude Code shell)
  // doesn't bleed into tests that pass only claudeSessionIdEnv overrides.
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  savedCodex = process.env.CODEX_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
  if (savedCodex === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = savedCodex;
});

function manifest(): Manifest {
  return parseManifest({ version: 1 });
}

interface LedgerCall {
  sessionId: string;
  content: string;
}

function ledgerStub(): { calls: LedgerCall[]; add: (sessionId: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string }> } {
  const calls: LedgerCall[] = [];
  return {
    calls,
    add: async (sessionId, content) => {
      calls.push({ sessionId, content });
      return { ok: true };
    },
  };
}

describe("pause", () => {
  it("writes a sentinel with the default 15m expiry and records a ledger fact", async () => {
    const led = ledgerStub();
    const now = new Date("2026-05-18T12:00:00.000Z");
    const result = await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now,
      reason: "lockout recovery",
      pausedBy: "tester",
      ledgerAdd: led.add,
    });

    expect(result.alreadyPaused).toBe(false);
    expect(result.sentinelPath).toBe(path.join(tmp, SENTINEL_BASENAME));
    expect(result.sentinel.pausedAt).toBe("2026-05-18T12:00:00.000Z");
    expect(result.sentinel.expiresAt).toBe("2026-05-18T12:15:00.000Z");
    expect(result.sentinel.reason).toBe("lockout recovery");
    expect(result.sentinel.pausedBy).toBe("tester");

    const onDisk = JSON.parse(fs.readFileSync(sentinelPath(tmp), "utf8")) as Record<string, unknown>;
    expect(onDisk.pausedAt).toBe("2026-05-18T12:00:00.000Z");

    expect(result.ledger.ok).toBe(true);
    expect(result.ledger.tag).toBe("harness-paused:2026-05-18T12:00:00.000Z");
    expect(led.calls).toEqual([
      { sessionId: OPERATOR_LEDGER_SESSION, content: "harness-paused:2026-05-18T12:00:00.000Z" },
    ]);
  });

  it("honours --for with shorthand durations", async () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const result = await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now,
      forDuration: "5m",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sentinel.expiresAt).toBe("2026-05-18T12:05:00.000Z");
  });

  it("writes expiresAt:null when --indefinite with the accept-flag", async () => {
    const result = await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      indefinite: true,
      acceptNoAutoResume: true,
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.sentinel.expiresAt).toBeNull();
  });

  it("refuses --indefinite without the accept-flag", async () => {
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeSessionIdEnv: "",
        indefinite: true,
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(HarnessExitError);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("refuses to run when CLAUDE_SESSION_ID is set (agent shell)", async () => {
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeSessionIdEnv: "sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell/i);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("refuses to run when CLAUDE_CODE_SESSION_ID is set (the var Claude Code exports)", async () => {
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeCodeSessionIdEnv: "code-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell.*CLAUDE_CODE_SESSION_ID/is);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("refuses to run when CODEX_SESSION_ID is set (Codex agent shell)", async () => {
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        codexSessionIdEnv: "codex-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell.*CODEX_SESSION_ID/is);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("does not recommend the `! ` prefix, which does not work (task cf1fde6d)", async () => {
    // The `! ` channel inherits this session's env AND its non-TTY stdin
    // (verified live, see docs/okf/pause-vs-gate-kill-switch.md), so it
    // trips this exact check. The old advice told the operator to do the
    // one thing that cannot work; assert it is gone and replaced with
    // honest guidance.
    let caught: unknown;
    try {
      await pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeCodeSessionIdEnv: "code-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const message = (caught as HarnessExitError).message;
    // The old wording recommended the prefix as the fix; assert that
    // specific recommendation is gone (not merely that "! " is unmentioned:
    // the new message legitimately explains why `! ` does not work).
    expect(message).not.toMatch(/in Claude Code: prefix the command with `! `/);
    expect(message).toMatch(/Do not prefix with `! `/);
    expect(message).toMatch(/terminal OUTSIDE this agent session/i);
    expect(message).toMatch(/inherit/i);
  });

  it("--i-am-the-operator does NOT bypass the agent-shell check (only refuseIfNonTTY)", async () => {
    // The brief's key untested invariant: pairing iAmTheOperator:true with
    // a set agent-session env var must still refuse. --i-am-the-operator
    // only ever lifts the non-TTY refusal; if an agent could pass it to
    // also clear the agent-shell check, the whole guard would be a no-op
    // for exactly the attacker who has Bash access.
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: false,
        iAmTheOperator: true,
        claudeCodeSessionIdEnv: "code-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell.*CLAUDE_CODE_SESSION_ID/is);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("refuseIfNonTTY warns that an agent asking for --i-am-the-operator IS the attack", async () => {
    let caught: unknown;
    try {
      await pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: false,
        claudeSessionIdEnv: "",
        ledgerAdd: async () => ({ ok: true }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessExitError);
    const message = (caught as HarnessExitError).message;
    expect(message).toMatch(/an agent ever asks YOU to pass this flag/i);
    expect(message).toMatch(/IS the attack/);
  });

  it("allows pause when all three agent-session env vars are empty/absent", async () => {
    await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      claudeCodeSessionIdEnv: "",
      codexSessionIdEnv: "",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(tmp))).toBe(true);
  });

  it("refuses non-TTY stdin without --i-am-the-operator", async () => {
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: false,
        claudeSessionIdEnv: "",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/non-TTY/i);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });

  it("allows non-TTY stdin with --i-am-the-operator", async () => {
    await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: false,
      iAmTheOperator: true,
      claudeSessionIdEnv: "",
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(tmp))).toBe(true);
  });

  it("rejects invalid --for durations as usage errors", async () => {
    await expect(
      pause({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeSessionIdEnv: "",
        forDuration: "five minutes",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/invalid duration/);
  });

  it("flags alreadyPaused when a prior sentinel exists", async () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now,
      ledgerAdd: async () => ({ ok: true }),
    });
    const second = await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now: new Date("2026-05-18T12:01:00.000Z"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(second.alreadyPaused).toBe(true);
  });

  it("surfaces a ledger-write failure as a degraded result without blocking the sentinel", async () => {
    const result = await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      ledgerAdd: async () => ({ ok: false, reason: "ledger offline" }),
    });
    expect(result.ledger.ok).toBe(false);
    expect(result.ledger.reason).toBe("ledger offline");
    expect(fs.existsSync(sentinelPath(tmp))).toBe(true);
  });
});

describe("resume", () => {
  it("deletes the sentinel + records a ledger fact", async () => {
    await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now: new Date("2026-05-18T12:00:00.000Z"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(fs.existsSync(sentinelPath(tmp))).toBe(true);

    const led = ledgerStub();
    const result = await resume({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      ledgerAdd: led.add,
    });
    expect(result.wasPaused).toBe(true);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
    expect(result.ledger.ok).toBe(true);
    expect(result.ledger.tag).toBe("harness-resumed:2026-05-18T12:00:00.000Z");
    expect(led.calls).toEqual([
      { sessionId: OPERATOR_LEDGER_SESSION, content: "harness-resumed:2026-05-18T12:00:00.000Z" },
    ]);
  });

  it("is idempotent against a missing sentinel (exit 0, no ledger write)", async () => {
    const led = ledgerStub();
    const result = await resume({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      ledgerAdd: led.add,
    });
    expect(result.wasPaused).toBe(false);
    expect(led.calls).toEqual([]);
    expect(result.ledger.ok).toBe(false);
  });

  it("refuses to run in an agent shell", async () => {
    await expect(
      resume({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeSessionIdEnv: "sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell/i);
  });

  it("refuses to run when CLAUDE_CODE_SESSION_ID is set", async () => {
    await expect(
      resume({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        claudeCodeSessionIdEnv: "code-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell.*CLAUDE_CODE_SESSION_ID/is);
  });

  it("refuses to run when CODEX_SESSION_ID is set", async () => {
    await expect(
      resume({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: true,
        codexSessionIdEnv: "codex-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell.*CODEX_SESSION_ID/is);
  });

  it("--i-am-the-operator does NOT bypass the agent-shell check (mirror of the pause invariant)", async () => {
    await expect(
      resume({
        manifest: manifest(),
        generatedDir: tmp,
        stdinIsTTY: false,
        iAmTheOperator: true,
        claudeCodeSessionIdEnv: "code-sess-abc",
        ledgerAdd: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/agent shell.*CLAUDE_CODE_SESSION_ID/is);
  });

  it("resumes an expired pause (deletes the stale sentinel)", async () => {
    await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      forDuration: "1s",
      now: new Date("2026-05-18T12:00:00.000Z"),
      ledgerAdd: async () => ({ ok: true }),
    });
    const result = await resume({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now: new Date("2026-05-18T12:00:30.000Z"),
      ledgerAdd: async () => ({ ok: true }),
    });
    expect(result.wasPaused).toBe(true);
    expect(fs.existsSync(sentinelPath(tmp))).toBe(false);
  });
});

describe("pause + hook integration round-trip", () => {
  it("readSentinel sees an active pause produced by the verb", async () => {
    await pause({
      manifest: manifest(),
      generatedDir: tmp,
      stdinIsTTY: true,
      claudeSessionIdEnv: "",
      now: new Date("2026-05-18T12:00:00.000Z"),
      reason: "hotfix",
      ledgerAdd: async () => ({ ok: true }),
    });
    const result = readSentinel(tmp, new Date("2026-05-18T12:05:00.000Z"));
    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.sentinel.reason).toBe("hotfix");
  });
});
