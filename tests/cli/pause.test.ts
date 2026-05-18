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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pause-cli-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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
