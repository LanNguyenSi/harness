// Unit tests for the shared hook-bootstrap module.
// These verify the shared pieces in isolation so a regression in the
// common module is caught once, not scattered across the per-hook test files.

import { PassThrough, Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadManifestOrInjected,
  readStdinChecked,
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

// Minimal valid manifest: version 1, all optional sections default.
function minimalManifest(): Manifest {
  return parseManifest({ version: 1 });
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

// ---------------------------------------------------------------------------
// 2. loadManifestOrInjected
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
