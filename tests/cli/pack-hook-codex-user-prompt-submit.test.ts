import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildInstructionBlock,
  runPackHookCodexUserPromptSubmitCli,
} from "../../src/cli/pack/hook-codex-user-prompt-submit.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";
import { writeSentinel, type PauseSentinel } from "../../src/runtime/pause-sentinel.js";

/** A real operator turn: the envelope carries non-empty `prompt` text. */
const REAL_PROMPT_PAYLOAD = JSON.stringify({
  session_id: "sess-1",
  prompt: "please fix the flaky test",
});

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
      stdin: readableFromString(REAL_PROMPT_PAYLOAD),
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
      stdin: readableFromString(REAL_PROMPT_PAYLOAD),
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
      stdin: readableFromString(REAL_PROMPT_PAYLOAD),
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

  describe("no real user input (fail-open to inject, task 63fefe3a fix)", () => {
    it("REGRESSION: an envelope with only the documented config.toml fields (no prompt field at all) still injects", async () => {
      // This is the exact regression an advisor review caught: the
      // generated config.toml header documents the wire shape as
      // { session_id?, tool_name?, raw_input?, event? }, no `prompt`
      // field. A hook that suppressed on "no prompt field" would go
      // permanently silent against the real envelope while every test
      // using a synthetic `{"prompt": ...}` fixture stayed green.
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify({
            session_id: "sess-1",
            tool_name: "Bash",
            raw_input: { command: "echo hi" },
            event: "PreToolUse",
          }),
        ),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
      expect(stdout.read()).toContain("Understanding Gate");
    });

    it("injects on malformed (non-JSON) stdin", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString("not json at all"),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
    });

    it("injects on empty stdin", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(""),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
    });

    it("injects on an envelope with no recognizable fields at all", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(JSON.stringify({ foo: "bar" })),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
    });

    it("suppresses injection when prompt is POSITIVELY present and empty/whitespace-only (a real signal of a notification turn)", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(JSON.stringify({ session_id: "sess-1", prompt: "   " })),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(false);
      expect(stdout.read()).toBe("");
    });

    it("still injects on a real operator prompt (positive control)", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(REAL_PROMPT_PAYLOAD),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
      expect(stdout.read()).toContain("Understanding Gate");
    });

    it.each(["text", "input", "message", "user_prompt", "user_input"])(
      "still injects on a real operator prompt carried under the alias field `%s`",
      async (alias) => {
        const stdout = bufferStream();
        const result = await runPackHookCodexUserPromptSubmitCli({
          manifest: manifestWithPack(),
          stdin: readableFromString(
            JSON.stringify({ session_id: "sess-1", [alias]: "please fix the flaky test" }),
          ),
          stdout: stdout.stream,
          stderr: bufferStream().stream,
        });
        expect(result.emitted).toBe(true);
        expect(stdout.read()).toContain("Understanding Gate");
      },
    );

    // Discriminating probe for alias support: a fail-open default means
    // "still injects on alias `%s`" (above) passes even if that alias were
    // dropped from the recognized list entirely, because an unrecognized
    // field falls through to "inject anyway". Only the SUPPRESS path
    // (an alias present and positively empty) actually proves the alias is
    // recognized, since dropping the alias would flip that case from
    // "suppress" to "inject" (fail-open), an observable difference.
    it.each(["prompt", "text", "input", "message", "user_prompt", "user_input"])(
      "suppresses injection when the alias field `%s` is positively present and empty (proves the alias is recognized)",
      async (alias) => {
        const stdout = bufferStream();
        const result = await runPackHookCodexUserPromptSubmitCli({
          manifest: manifestWithPack(),
          stdin: readableFromString(JSON.stringify({ session_id: "sess-1", [alias]: "" })),
          stdout: stdout.stream,
          stderr: bufferStream().stream,
        });
        expect(result.emitted).toBe(false);
        expect(stdout.read()).toBe("");
      },
    );

    // Fix round (task 1432e053 review): the decision must consider every
    // alias present on the envelope, not just the first alias in list
    // order. `prompt` sorts before `text` in REAL_PROMPT_FIELD_ALIASES; a
    // first-match short-circuit would return on the empty `prompt` and
    // never look at the real text carried under `text`.
    it("injects when an earlier-listed alias is empty but a later-listed alias carries real text", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify({ session_id: "sess-1", prompt: "", text: "real operator text" }),
        ),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
      expect(stdout.read()).toContain("Understanding Gate");
    });

    it("suppresses when every string-valued alias present on the envelope is empty", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(JSON.stringify({ session_id: "sess-1", prompt: "", text: "" })),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(false);
      expect(stdout.read()).toBe("");
    });

    it("ignores a non-string alias value and still injects on a real string alias", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(
          JSON.stringify({ session_id: "sess-1", prompt: 123, text: "real" }),
        ),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });
      expect(result.emitted).toBe(true);
      expect(stdout.read()).toContain("Understanding Gate");
    });
  });

  describe("pause sentinel", () => {
    let tmp: string;
    let generatedDir: string;

    const ACTIVE_SENTINEL: PauseSentinel = {
      pausedAt: new Date().toISOString(),
      expiresAt: null, // indefinite, never auto-expires during test
      reason: "operator recovery",
      pausedBy: "test",
    };

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-ups-cli-"));
      generatedDir = path.join(tmp, "harness.generated");
      fs.mkdirSync(generatedDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("suppresses injection and emits a PAUSED notice when the sentinel is active", async () => {
      writeSentinel(generatedDir, ACTIVE_SENTINEL);

      const stdout = bufferStream();
      const stderr = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(REAL_PROMPT_PAYLOAD),
        stdout: stdout.stream,
        stderr: stderr.stream,
        generatedDir,
      });

      expect(result.emitted).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(stdout.read()).toBe("");
      const stderrText = stderr.read();
      expect(stderrText).toContain("PAUSED");
      expect(stderrText).toContain("operator recovery");
      expect(stderrText).toContain(
        "harness pack hook codex-user-prompt-submit: harness paused, skipping injection.",
      );
    });

    it("still injects on a real prompt when no sentinel is present (unchanged behavior)", async () => {
      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(REAL_PROMPT_PAYLOAD),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
        generatedDir,
      });

      expect(result.emitted).toBe(true);
      expect(stdout.read()).toContain("Understanding Gate");
    });

    it("resumes injecting after the pause sentinel expires (negative control)", async () => {
      const now = new Date("2026-01-01T01:00:00.000Z");
      writeSentinel(generatedDir, {
        pausedAt: "2025-12-31T23:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z", // one hour before `now`
        reason: "operator recovery",
        pausedBy: "test",
      });

      const stdout = bufferStream();
      const result = await runPackHookCodexUserPromptSubmitCli({
        manifest: manifestWithPack(),
        stdin: readableFromString(REAL_PROMPT_PAYLOAD),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
        generatedDir,
        now,
      });

      expect(result.emitted).toBe(true);
      expect(stdout.read()).toContain("Understanding Gate");
    });
  });
});
