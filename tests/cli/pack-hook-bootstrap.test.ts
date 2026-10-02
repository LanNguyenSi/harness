// Unit tests for the shared hook-bootstrap module.
// These verify the three shared pieces in isolation so a regression in the
// common module is caught once, not scattered across eleven per-hook test files.

import { PassThrough, Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHookPause,
  loadManifestOrInjected,
  readStdin,
  readStdinChecked,
  runGateWithStdinRefusal,
  stdoutBlockRefusal,
  resolveSessionAndAgentIds,
  resolveSubagentHookContext,
  stdinTimeoutBlockJson,
  stdinTimeoutBlockReason,
} from "../../src/cli/pack/hook-bootstrap.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

function noopValidateAgentId(): void {
  /* accepts anything: only session-id validation ordering is under test */
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadableOf(content: string): Readable {
  const r = new Readable();
  r.push(content);
  r.push(null);
  return r;
}

function makeStderr(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = [];
  const stream = {
    write(s: string) {
      lines.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, lines };
}

// Minimal valid manifest: version 1, all optional sections default.
function minimalManifest(): Manifest {
  return parseManifest({ version: 1 });
}

// Sentinel body the pause module expects.
function pauseSentinelBody(expiresAt: string | null = null): string {
  return JSON.stringify({
    pausedAt: new Date().toISOString(),
    expiresAt,
    reason: null,
    pausedBy: null,
  });
}

// ---------------------------------------------------------------------------
// 1. readStdin
// ---------------------------------------------------------------------------

describe("readStdin", () => {
  it("reads a utf-8 string from a stream", async () => {
    const result = await readStdin(makeReadableOf('{"tool_name":"Bash"}'));
    expect(result).toBe('{"tool_name":"Bash"}');
  });

  it("resolves empty string for an empty stream", async () => {
    const r = new Readable();
    r.push(null); // EOF immediately
    const result = await readStdin(r);
    expect(result).toBe("");
  });

  it("a closed stdin is read whole with no timeout note", async () => {
    const { stream, lines } = makeStderr();
    const result = await readStdin(makeReadableOf('{"tool_name":"Bash"}'), { stderr: stream });
    expect(result).toBe('{"tool_name":"Bash"}');
    expect(lines).toEqual([]);
  });

  it("an idle stdin with nothing read resolves empty after the bound and notes it", async () => {
    const { stream, lines } = makeStderr();
    const result = await readStdin(new PassThrough(), { idleTimeoutMs: 100, stderr: stream });
    expect(result).toBe("");
    expect(lines).toEqual([
      "harness pack hook: no complete event JSON on stdin within 100 ms (stdin never closed); continuing as an empty event\n",
    ]);
  });

  it("an idle stdin with partial data resolves with the data read and notes the byte count", async () => {
    const { stream, lines } = makeStderr();
    const pt = new PassThrough();
    pt.write('{"tool_name":');
    const result = await readStdin(pt, { idleTimeoutMs: 100, stderr: stream });
    expect(result).toBe('{"tool_name":');
    expect(lines).toEqual([
      "harness pack hook: stdin did not close within 100 ms of the last data; using the 13 bytes read\n",
    ]);
  });

  it("a slow but live pipe is not cut off: each chunk restarts the bound", async () => {
    const { stream, lines } = makeStderr();
    const pt = new PassThrough();
    const read = readStdin(pt, { idleTimeoutMs: 400, stderr: stream });
    pt.write("ab");
    await new Promise((r) => setTimeout(r, 250));
    pt.write("cd");
    await new Promise((r) => setTimeout(r, 250));
    pt.end("ef");
    expect(await read).toBe("abcdef");
    expect(lines).toEqual([]);
  });

  it("rejects when the stream emits an error", async () => {
    const r = new Readable({ read() {} });
    const p = readStdin(r);
    r.emit("error", new Error("EPIPE"));
    await expect(p).rejects.toThrow("EPIPE");
  });
});

describe("readStdinChecked (the PreToolUse gates' reader)", () => {
  it("a closed stdin reports the whole text and no timeout", async () => {
    const read = await readStdinChecked(makeReadableOf('{"tool_name":"Bash"}'), {
      idleTimeoutMs: 100,
    });
    expect(read).toEqual({ text: '{"tool_name":"Bash"}', timedOut: false, idleTimeoutMs: 100 });
  });

  it("an idle empty stdin reports timedOut with no text and the bound that applied", async () => {
    const read = await readStdinChecked(new PassThrough(), { idleTimeoutMs: 100 });
    expect(read).toEqual({ text: "", timedOut: true, idleTimeoutMs: 100 });
  });

  it("an idle stdin with partial data reports timedOut and the text read so far", async () => {
    const pt = new PassThrough();
    pt.write('{"tool_name":');
    const read = await readStdinChecked(pt, { idleTimeoutMs: 100 });
    expect(read).toEqual({ text: '{"tool_name":', timedOut: true, idleTimeoutMs: 100 });
  });

  it("rejects when the stream emits an error", async () => {
    const r = new Readable({ read() {} });
    const p = readStdinChecked(r);
    r.emit("error", new Error("EPIPE"));
    await expect(p).rejects.toThrow("EPIPE");
  });
});

describe("stdin timeout block helpers", () => {
  it("the reason names the stdin timeout and the bound", () => {
    const reason = stdinTimeoutBlockReason(3000);
    expect(reason).toMatch(/^stdin timeout:/);
    expect(reason).toContain("within 3000 ms");
    expect(reason).toContain("fail closed");
  });

  it("stdoutBlockRefusal writes the block envelope to stdout and one BLOCK line to stderr, and returns a blocked result", () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (into: string[]): NodeJS.WritableStream =>
      ({ write: (s: string) => (into.push(s), true) }) as unknown as NodeJS.WritableStream;
    const reason = stdinTimeoutBlockReason(3000);
    const result = stdoutBlockRefusal("some-gate")(reason, sink(out), sink(err));
    expect(result).toEqual({ exitCode: 0, blocked: true, diagnostic: `BLOCK: ${reason}` });
    expect(err).toEqual([`harness pack hook some-gate: BLOCK: ${reason}\n`]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toMatchObject({ decision: "block", reason });
  });

  it("the envelope blocks in both the legacy and the hookSpecificOutput form", () => {
    const parsed = JSON.parse(stdinTimeoutBlockJson("why"));
    expect(parsed).toEqual({
      decision: "block",
      reason: "why",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "why",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. checkHookPause
// ---------------------------------------------------------------------------

describe("checkHookPause", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-pause-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns { paused: false } when no sentinel exists", () => {
    const { stream } = makeStderr();
    const result = checkHookPause("test-hook", stream, undefined, tmp);
    expect(result.paused).toBe(false);
  });

  it("returns { paused: true } and writes a notice when an indefinite sentinel exists", () => {
    fs.writeFileSync(
      path.join(tmp, ".harness-paused"),
      pauseSentinelBody(null),
    );
    const { stream, lines } = makeStderr();
    const result = checkHookPause("test-hook", stream, undefined, tmp);
    expect(result.paused).toBe(true);
    // The pause announcement should mention the hook label.
    expect(lines.join("")).toContain("test-hook");
  });

  it("returns { paused: false } when an expired sentinel exists", () => {
    // expiresAt is in the past relative to `now`.
    const now = new Date("2026-06-01T12:00:00.000Z");
    const past = new Date(now.getTime() - 60_000).toISOString();
    fs.writeFileSync(
      path.join(tmp, ".harness-paused"),
      pauseSentinelBody(past),
    );
    const { stream } = makeStderr();
    // Pass `now` so the sentinel is evaluated as expired.
    const result = checkHookPause("test-hook", stream, undefined, tmp, now);
    expect(result.paused).toBe(false);
  });

  it("resolves the sentinel from loaderOpts.homeDir when no generatedDir is passed", () => {
    // Locks the loaderOpts passthrough: the manifest-loading hooks rely on
    // checkHookPause forwarding loaderOpts so the sentinel is read from the
    // loader-derived <homeDir>/harness.generated/ dir, not an explicit one.
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, ".harness-paused"),
      pauseSentinelBody(null),
    );
    const { stream, lines } = makeStderr();
    const result = checkHookPause("test-hook", stream, { homeDir: tmp }, undefined);
    expect(result.paused).toBe(true);
    expect(lines.join("")).toContain("test-hook");
  });
});

// ---------------------------------------------------------------------------
// 3. loadManifestOrInjected
// ---------------------------------------------------------------------------

describe("loadManifestOrInjected", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-loader-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the injected manifest directly without reading disk", () => {
    const injected = minimalManifest();
    const result = loadManifestOrInjected({ homeDir: tmp }, injected);
    expect(result.manifest).toBe(injected); // same reference
    expect(result.manifestPath).toBeUndefined();
  });

  it("loads from disk when injected is undefined and harness.yaml exists", () => {
    const yaml = "version: 1\npolicy_packs: []\n";
    fs.writeFileSync(path.join(tmp, "harness.yaml"), yaml);
    const result = loadManifestOrInjected({ homeDir: tmp }, undefined);
    expect(result.manifest).toBeDefined();
    expect(result.manifestPath).toBe(path.join(tmp, "harness.yaml"));
  });

  it("throws when injected is undefined and no harness.yaml exists", () => {
    expect(() =>
      loadManifestOrInjected({ homeDir: tmp }, undefined),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. resolveSessionAndAgentIds — validation order
// ---------------------------------------------------------------------------

describe("resolveSessionAndAgentIds", () => {
  it("rejects a malformed session_id before ever reporting a missing agent_id, and never echoes the raw id (task 496660c5)", () => {
    // sessionId is malformed (path traversal) AND agent_id is missing.
    // rejectMalformedSessionId must run before the agent_id emptiness
    // check, so the failure is "malformed session_id", not "missing
    // agent_id" with the raw traversal string echoed back in `sessionId`.
    const result = resolveSessionAndAgentIds(
      "harness pack hook: subagent-start",
      { session_id: "../escape", agent_id: undefined },
      noopValidateAgentId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostic).toMatch(/malformed session_id/);
    expect(result.diagnostic).not.toMatch(/missing agent_id/);
    expect(result.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. resolveSubagentHookContext
// ---------------------------------------------------------------------------

describe("resolveSubagentHookContext", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-subagent-ctx-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function manifestWithPack(): Manifest {
    return parseManifest({
      version: 1,
      policy_packs: [{ name: "understanding-before-execution", enabled: true, config: {} }],
    });
  }

  it("honours the pause sentinel before resolving ids or pack context", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDir, ".harness-paused"),
      pauseSentinelBody(null),
    );
    const stderr = makeStderr();

    const result = resolveSubagentHookContext(
      "harness pack hook: subagent-start",
      "subagent-start",
      "understanding-before-execution",
      { session_id: "sess-1", agent_id: "agent-1" },
      noopValidateAgentId,
      { manifest: manifestWithPack(), generatedDir, stderr: stderr.stream },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostic).toMatch(/paused/);
    expect(result.sessionId).toBeNull();
    expect(result.agentId).toBeNull();
  });

  it("resolves sessionId, agentId, declared pack, and generatedDir when unpaused and ids/context are valid", () => {
    const generatedDir = path.join(tmp, "harness.generated");
    const stderr = makeStderr();

    const result = resolveSubagentHookContext(
      "harness pack hook: subagent-start",
      "subagent-start",
      "understanding-before-execution",
      { session_id: "sess-1", agent_id: "agent-1" },
      noopValidateAgentId,
      { manifest: manifestWithPack(), generatedDir, stderr: stderr.stream },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.context.sessionId).toBe("sess-1");
    expect(result.context.agentId).toBe("agent-1");
    expect(result.context.generatedDir).toBe(generatedDir);
    expect(result.context.declared.name).toBe("understanding-before-execution");
  });
});

// ---------------------------------------------------------------------------
// Pin: every Codex hook honours the pause sentinel (task 1432e053)
// ---------------------------------------------------------------------------
//
// Source-grep rather than behavioral, deliberately: the per-hook behavioral
// pause tests already live alongside each hook's own test file (e.g.
// pack-hook-codex-stop.test.ts, pack-hook-codex-user-prompt-submit.test.ts,
// pack-hook-codex-pre-tool-use.test.ts). This test's job is narrower and
// purely textual: it pins that each file imports `checkHookPause` from
// hook-bootstrap.js and contains a `checkHookPause(` call site somewhere in
// its source. It does not pin that the call is reachable, correctly wired
// into the hook's control flow, or actually honoured at runtime, that
// coverage is what the behavioral tests in the per-hook files are for; a
// call site could in principle sit in dead code and still satisfy this
// pin.
describe("codex hooks import checkHookPause (parity pin, task 1432e053)", () => {
  const CODEX_HOOK_FILES = [
    "hook-codex-pre-tool-use.ts",
    "hook-codex-post-tool-use.ts",
    "hook-codex-stop.ts",
    "hook-codex-user-prompt-submit.ts",
  ];

  it.each(CODEX_HOOK_FILES)("%s imports checkHookPause from hook-bootstrap.js", (filename) => {
    const src = fs.readFileSync(
      new URL(`../../src/cli/pack/${filename}`, import.meta.url),
      "utf8",
    );
    // Matches every `import { ..., checkHookPause, ... } from
    // "./hook-bootstrap.js"` statement in the file, not just the first,
    // a second, separate import statement from the same specifier would
    // otherwise hide behind the first match and still pass. Union the
    // named imports across all matches.
    const importBlocks = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/hook-bootstrap\.js["']/g)];
    expect(importBlocks.length, `${filename}: no import from ./hook-bootstrap.js found`).toBeGreaterThan(0);
    const names = importBlocks.flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()));
    expect(names).toContain("checkHookPause");
    // The import alone is not enough: pin that the hook actually calls
    // checkHookPause somewhere in its body, not merely imports it.
    expect(src, `${filename}: imports checkHookPause but never calls it`).toMatch(/checkHookPause\(/);
  });
});

describe("runGateWithStdinRefusal", () => {
  const sink = (): NodeJS.WritableStream =>
    ({ write: () => true }) as unknown as NodeJS.WritableStream;

  it("a closed stdin is replayed whole to the gate, which runs unrefused", async () => {
    let seen = "";
    const result = await runGateWithStdinRefusal(
      { stdin: makeReadableOf('{"tool_name":"Bash"}'), stdout: sink(), stderr: sink() },
      () => false,
      () => "refused",
      async (opts) => {
        seen = await readStdin(opts.stdin as NodeJS.ReadableStream);
        return "ran";
      },
    );
    expect(result).toBe("ran");
    expect(seen).toBe('{"tool_name":"Bash"}');
  });

  it("a timed-out read refuses with the stdin-timeout reason and never runs the gate", async () => {
    let ran = false;
    const pt = new PassThrough();
    pt.write('{"tool_name":');
    const reasons: string[] = [];
    const result = await runGateWithStdinRefusal(
      { stdin: pt, stdout: sink(), stderr: sink() },
      () => false,
      (reason) => (reasons.push(reason), "refused"),
      async () => {
        ran = true;
        return "ran";
      },
    );
    expect(result).toBe("refused");
    expect(ran).toBe(false);
    expect(reasons).toEqual([stdinTimeoutBlockReason(3000)]);
  }, 15_000);

  it("the operator pause wins: a timed-out read under a pause runs the gate with the text read", async () => {
    let seen = "";
    const pt = new PassThrough();
    pt.write('{"tool_name":');
    const result = await runGateWithStdinRefusal(
      { stdin: pt, stdout: sink(), stderr: sink() },
      () => true,
      () => "refused",
      async (opts) => {
        seen = await readStdin(opts.stdin as NodeJS.ReadableStream);
        return "ran";
      },
    );
    expect(result).toBe("ran");
    expect(seen).toBe('{"tool_name":');
  }, 15_000);
});
