// Hook-side observation of `permission_mode` (task 8f637efd,
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, "Amendment: install
// default"): the PreToolUse hook writes a small per-session record under
// `<generatedDir>/.permission-mode-observations/<sessionId>` at the same
// point `attemptAutoApproval` runs, feeding `harness doctor`'s
// missing-`auto_approve` finding (bypass-without-auto-approve.ts).

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  listPermissionModeObservations,
  permissionModeObservationPathFor,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

let tmp: string;
let generatedDir: string;
let savedClaude: string | undefined;
let savedClaudeCode: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-permission-mode-obs-"));
  generatedDir = path.join(tmp, "harness.generated");
  savedClaude = process.env.CLAUDE_SESSION_ID;
  savedClaudeCode = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = savedClaude;
  if (savedClaudeCode === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedClaudeCode;
});

function manifestWithPack(): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", enabled: true }],
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

describe("pack hook pre-tool-use: permission-mode observation", () => {
  it("writes an observation for a blocked call that carries permission_mode: bypassPermissions", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-obs-1",
          tool_name: "Edit",
          permission_mode: "bypassPermissions",
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(true);

    expect(fs.existsSync(permissionModeObservationPathFor(generatedDir, "sess-obs-1"))).toBe(true);
    const observed = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(observed.dirPresent).toBe(true);
    expect(observed.entries).toHaveLength(1);
    expect(observed.entries[0]?.sessionId).toBe("sess-obs-1");
    expect(observed.entries[0]?.permissionMode).toBe("bypassPermissions");
  });

  it("writes an observation even when permission_mode is a non-bypass value (default)", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-obs-2",
          tool_name: "Edit",
          permission_mode: "default",
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    const observed = listPermissionModeObservations(generatedDir, { windowSize: 20 });
    expect(observed.entries[0]?.permissionMode).toBe("default");
  });

  it("writes no observation when permission_mode is absent from the payload", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({ session_id: "sess-obs-3", tool_name: "Edit" }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(fs.existsSync(permissionModeObservationPathFor(generatedDir, "sess-obs-3"))).toBe(false);
  });

  it("a path-traversal session_id writes nothing outside the observations dir (review round 3 F1, mutation probe M1)", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const outsideTarget = path.join(tmp, "escape-target", "victim");
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "../../escape-target/victim",
          tool_name: "Edit",
          permission_mode: "bypassPermissions",
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    // The overall gate decision is unaffected by this fix (a malformed
    // session id was already handled elsewhere in the hook's own
    // decision order); this test's only concern is the observation
    // write, which used to happen unconditionally and unvalidated.
    expect(typeof result.blocked).toBe("boolean");

    // Mutation probe M1: if `permissionModeObservationPathFor` stops
    // calling `rejectMalformedSessionId`, this traversal id would be
    // joined verbatim and the write would land at `outsideTarget`
    // instead of failing closed (this test goes red).
    expect(fs.existsSync(outsideTarget)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "escape-target"))).toBe(false);
    // Nothing was written under the observations dir under that literal
    // (path-separator-carrying) name either.
    const obsDir = path.join(generatedDir, ".permission-mode-observations");
    if (fs.existsSync(obsDir)) {
      expect(fs.readdirSync(obsDir, { recursive: true })).toEqual([]);
    }
  });

  it("a read-only Bash call (never reaches the block/auto-approve step) writes no observation", async () => {
    const stdout = bufferStream();
    const stderr = bufferStream();
    const result = await runPackHookPreToolUseCli({
      manifest: manifestWithPack(),
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-obs-4",
          tool_name: "Bash",
          tool_input: { command: "git status" },
          permission_mode: "bypassPermissions",
        }),
      ),
      stdout: stdout.stream,
      stderr: stderr.stream,
      reportsDir: path.join(tmp, "no-reports"),
      generatedDir,
      ledgerQuery: async (): Promise<LedgerEntry[]> => [],
    });
    expect(result.blocked).toBe(false);
    expect(fs.existsSync(permissionModeObservationPathFor(generatedDir, "sess-obs-4"))).toBe(false);
  });
});
