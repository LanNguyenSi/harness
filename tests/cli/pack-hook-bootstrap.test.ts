// Unit tests for the shared hook-bootstrap module.
// These verify the three shared pieces in isolation so a regression in the
// common module is caught once, not scattered across eleven per-hook test files.

import { Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHookPause,
  loadManifestOrInjected,
  readStdin,
} from "../../src/cli/pack/hook-bootstrap.js";
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

  it("rejects when the stream emits an error", async () => {
    const r = new Readable({ read() {} });
    const p = readStdin(r);
    r.emit("error", new Error("EPIPE"));
    await expect(p).rejects.toThrow("EPIPE");
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
// Pin: every Codex hook honours the pause sentinel (task 1432e053)
// ---------------------------------------------------------------------------
//
// Source-grep rather than behavioral, deliberately: the per-hook behavioral
// pause tests already live alongside each hook's own test file (e.g.
// pack-hook-codex-stop.test.ts, pack-hook-codex-user-prompt-submit.test.ts).
// This test's job is narrower — pin that the module header's "no pause
// check" exception list can never silently grow back to include one of the
// four hook-codex-*.ts files without a test failing here first.
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
