import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildInstructionBlock,
  runPackHookCodexUserPromptSubmitCli,
} from "../../src/cli/pack/hook-codex-user-prompt-submit.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

function manifestWithPack(
  enabled = true,
  config: Record<string, unknown> = {},
): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled,
        config,
      },
    ],
  });
}

function readableFromString(s: string): Readable {
  const r = new Readable();
  r.push(s);
  r.push(null);
  return r;
}

function bufferStream(): { stream: Writable; read: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, read: () => buf };
}

describe("pack hook codex-user-prompt-submit injector", () => {
  it("emits the instruction template on stdout when the pack is enabled", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookCodexUserPromptSubmitCli({
      manifest: manifestWithPack(),
      stdin: readableFromString("{}"),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(result.emitted).toBe(true);
    expect(result.exitCode).toBe(0);
    const text = stdout.read();
    expect(text).toContain("Understanding Gate");
    expect(text).toContain("apply_patch");
    expect(text).toContain("verificationPlan");
    expect(text).toContain("harness approve understanding");
  });

  it("includes the resolved mode in the emitted block", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    await runPackHookCodexUserPromptSubmitCli({
      manifest: manifestWithPack(true, { mode: "strict" }),
      stdin: readableFromString("{}"),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(stdout.read()).toContain("mode: strict");
  });

  it("suppresses injection when the pack is disabled", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookCodexUserPromptSubmitCli({
      manifest: manifestWithPack(false),
      stdin: readableFromString("{}"),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(result.emitted).toBe(false);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toMatch(/not enabled/);
  });

  it("buildInstructionBlock returns deterministic content for a given mode", () => {
    const a = buildInstructionBlock("grill_me");
    const b = buildInstructionBlock("grill_me");
    expect(a).toBe(b);
    expect(a).toContain("mode: grill_me");
  });
});
