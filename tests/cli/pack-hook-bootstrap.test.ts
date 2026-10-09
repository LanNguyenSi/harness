// Unit tests for the shared hook-bootstrap module.
// These verify the shared pieces in isolation so a regression in the
// common module is caught once, not scattered across the per-hook test files.

import { PassThrough, Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHookPause,
  loadManifestOrInjected,
  readStdinChecked,
} from "../../src/cli/pack/hook-bootstrap.js";
import { stdinTimeoutBlockJson, stdinTimeoutBlockReason } from "../../src/cli/bounded-stdin.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

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
// 1. readStdinChecked
// ---------------------------------------------------------------------------

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
