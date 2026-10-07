// Agent-facing deny text when the understanding-gate reports directory is too
// large for the PreToolUse gate to read (task 6e001bfc). Past the bound the gate
// reads nothing and denies fail closed; `harness approve understanding` cannot
// fix that, so the deny text must name the cleanup instead of re-approval, in
// both hooks, with and without a configured `ux:` block, and with or without a
// signed marker present. A directory under the bound keeps the re-approval
// text (the control cases).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import type { LedgerWriteArgs } from "../../src/runtime/ledger-writer.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

// The bound written out, not read from the constant.
const BOUND = 8192;
const PLANT_TIMEOUT_MS = 60_000;
const SESSION = "01998f2a-too-large-deny-1";
const REPORT_NAME = "2026-10-04T10-00-00-000Z-report-aaaa1111.json";

let tmp: string;
let generatedDir: string;
let reportsDir: string;
let transcriptPath: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"] as const;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ug-too-large-deny-")));
  generatedDir = path.join(tmp, "harness.generated");
  reportsDir = path.join(tmp, "reports");
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  transcriptPath = path.join(tmp, `rollout-2026-10-04T00-00-00-${SESSION}.jsonl`);
  fs.writeFileSync(transcriptPath, "");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

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

function manifestWith(ux: boolean): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        ...(ux
          ? {
              config: {
                mode: "grill_me",
                ux: {
                  cannot: "You cannot use write-capable tools yet.",
                  required: ["an approved Understanding Report for this session"],
                  run: ["Run `harness approve understanding` and approve the prompt"],
                },
              },
            }
          : {}),
      },
    ],
  });
}

function pendingReportBody(): Record<string, unknown> {
  return {
    sessionId: SESSION,
    approvalStatus: "pending",
    createdAt: "2026-10-04T10:00:00.000Z",
    mode: "grill_me",
    currentUnderstanding: "the too-large reports directory deny text under test",
    priorArt: ["searched the repo for the existing entry bound"],
  };
}

function writePendingReport(): void {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, REPORT_NAME), `${JSON.stringify(pendingReportBody(), null, 2)}\n`);
}

async function approveSessionReport(): Promise<void> {
  writePendingReport();
  const approve = await approveUnderstanding({
    manifest: parseManifest({ version: 1 }),
    session: SESSION,
    reportsDir,
    generatedDir,
    ledgerAdd: async () => ({ ok: true }),
  });
  expect(approve.marker.ok).toBe(true);
}

/** Plant `count` tiny `*.json` entries that sort newer than the timestamped report. */
function plantJsonEntries(count: number): void {
  fs.mkdirSync(reportsDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(reportsDir, `z-entry-${String(i).padStart(6, "0")}.json`), "{}");
  }
}

/**
 * Plant 40 report-sized entries of about 900 KiB each (36 MiB in all, far
 * under the entry bound, each under the 1 MiB per-file cap): the byte budget
 * is crossed, the entry bound is not. `prefix` decides whether they sort older
 * or newer than the timestamped session report.
 */
function plantLargeReports(prefix: string): void {
  fs.mkdirSync(reportsDir, { recursive: true });
  const pad = "x".repeat(900 * 1024);
  for (let i = 0; i < 40; i++) {
    const name = `${prefix}T10-00-${String(i).padStart(2, "0")}-000Z-report-big${i}.json`;
    fs.writeFileSync(
      path.join(reportsDir, name),
      JSON.stringify({
        sessionId: "other",
        approvalStatus: "expired",
        createdAt: "2026-09-10T10:00:00.000Z",
        mode: "grill_me",
        currentUnderstanding: pad,
        priorArt: ["x"],
      }),
    );
  }
}

interface Denied {
  blocked: boolean;
  /** What the agent reads: the Claude hook's stdout deny reason, the Codex hook's stderr. */
  agentText: string;
}

interface Runtime {
  name: string;
  run: (manifest: Manifest) => Promise<Denied>;
}

const RUNTIMES: Runtime[] = [
  {
    name: "claude pre-tool-use",
    run: async (manifest) => {
      process.env["CLAUDE_CODE_SESSION_ID"] = SESSION;
      const stdout = bufferStream();
      const result = await runPackHookPreToolUseCli({
        manifest,
        stdin: readableFromString(
          JSON.stringify({ session_id: SESSION, tool_name: "Edit", transcript_path: transcriptPath }),
        ),
        stdout: stdout.stream,
        stderr: bufferStream().stream,
        reportsDir,
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
        writeLedger: async (_args: LedgerWriteArgs): Promise<{ ok: true }> => ({ ok: true }),
      });
      const out = stdout.read().trim();
      const reason = out.length > 0 ? (JSON.parse(out) as { reason: string }).reason : "";
      return { blocked: result.blocked, agentText: reason };
    },
  },
  {
    name: "codex codex-pre-tool-use",
    run: async (manifest) => {
      const stderr = bufferStream();
      const result = await runPackHookCodexPreToolUseCli({
        manifest,
        stdin: readableFromString(
          JSON.stringify({ session_id: SESSION, tool_name: "apply_patch", transcript_path: transcriptPath }),
        ),
        stderr: stderr.stream,
        reportsDir,
        generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
        writeLedger: async (_args: LedgerWriteArgs): Promise<{ ok: true }> => ({ ok: true }),
      });
      return { blocked: result.blocked, agentText: stderr.read() };
    },
  },
];

function expectCleanupNotRetry(text: string): void {
  expect(text).toContain(`The reports directory ${reportsDir} holds more than the gate reads`);
  expect(text).toContain("approving again will not help");
  expect(text).toContain("`harness gc --apply`");
  expect(text).toContain("by hand");
  // Neither the legacy call-to-action nor the report schema hint nor a ux "run" line.
  expect(text).not.toContain("harness approve understanding");
  expect(text).not.toContain("Run `harness approve");
}

describe.each(RUNTIMES)("too-large reports directory deny text: $name", (rt) => {
  it(
    "no marker, directory past the bound: the deny names the cleanup, not re-approval",
    async () => {
      writePendingReport();
      plantJsonEntries(BOUND);
      const out = await rt.run(manifestWith(false));
      expect(out.blocked).toBe(true);
      expectCleanupNotRetry(out.agentText);
    },
    PLANT_TIMEOUT_MS,
  );

  it(
    "a configured ux: block does not bring the re-approval recipe back",
    async () => {
      writePendingReport();
      plantJsonEntries(BOUND);
      const out = await rt.run(manifestWith(true));
      expect(out.blocked).toBe(true);
      expectCleanupNotRetry(out.agentText);
      expect(out.agentText).not.toContain("You cannot use write-capable tools yet.");
    },
    PLANT_TIMEOUT_MS,
  );

  it(
    "a signed marker is present but the directory is past the bound: the same cleanup text, never re-approval",
    async () => {
      await approveSessionReport();
      expect((await rt.run(manifestWith(false))).blocked).toBe(false);
      plantJsonEntries(BOUND);
      const out = await rt.run(manifestWith(false));
      expect(out.blocked).toBe(true);
      expectCleanupNotRetry(out.agentText);
    },
    PLANT_TIMEOUT_MS,
  );

  it(
    "directory exactly at the bound is still read: the ordinary re-approval text, no cleanup notice",
    async () => {
      writePendingReport();
      plantJsonEntries(BOUND - 1);
      const out = await rt.run(manifestWith(false));
      expect(out.blocked).toBe(true);
      expect(out.agentText).toContain("Run `harness approve understanding`");
      expect(out.agentText).not.toContain("approving again will not help");
      expect(out.agentText).not.toContain("harness gc --apply");
    },
    PLANT_TIMEOUT_MS,
  );

  it("a missing reports directory keeps the ordinary re-approval text", async () => {
    const out = await rt.run(manifestWith(false));
    expect(out.blocked).toBe(true);
    expect(out.agentText).toContain("Run `harness approve understanding`");
    expect(out.agentText).not.toContain("approving again will not help");
  });
});

function expectApproveNewestThenCleanup(text: string): void {
  expect(text).toContain(`The reports directory ${reportsDir} holds more than 32 MiB of report data`);
  expect(text).toContain("Run `harness approve understanding` to approve the newest report");
  expect(text).toContain("If this deny persists after approving");
  expect(text).toContain("`harness gc --apply`");
  expect(text).toContain("by hand");
  // The entry-count notice's claim is false here and must not appear.
  expect(text).not.toContain("approving again will not help");
  expect(text).not.toContain("Clean the directory up instead");
}

describe.each(RUNTIMES)("byte-budget truncation deny text: $name", (rt) => {
  it(
    "no marker, over the byte budget but under the entry bound: approve the newest report first, cleanup if the deny persists",
    async () => {
      writePendingReport();
      plantLargeReports("2026-09-10");
      const out = await rt.run(manifestWith(false));
      expect(out.blocked).toBe(true);
      expectApproveNewestThenCleanup(out.agentText);
    },
    PLANT_TIMEOUT_MS,
  );

  it(
    "a configured ux: block does not replace the byte-budget notice",
    async () => {
      writePendingReport();
      plantLargeReports("2026-09-10");
      const out = await rt.run(manifestWith(true));
      expect(out.blocked).toBe(true);
      expectApproveNewestThenCleanup(out.agentText);
      expect(out.agentText).not.toContain("You cannot use write-capable tools yet.");
    },
    PLANT_TIMEOUT_MS,
  );

  it(
    "the instruction is true: approving the newest report opens the gate",
    async () => {
      writePendingReport();
      plantLargeReports("2026-09-10");
      expect((await rt.run(manifestWith(false))).blocked).toBe(true);
      const approve = await approveUnderstanding({
        manifest: parseManifest({ version: 1 }),
        session: SESSION,
        reportsDir,
        generatedDir,
        ledgerAdd: async () => ({ ok: true }),
      });
      expect(approve.marker.ok).toBe(true);
      expect((await rt.run(manifestWith(false))).blocked).toBe(false);
    },
    PLANT_TIMEOUT_MS,
  );

  it(
    "a signed marker whose report sits behind newer large reports: the text never says approving will not help",
    async () => {
      await approveSessionReport();
      plantLargeReports("2026-10-05");
      const out = await rt.run(manifestWith(false));
      expect(out.blocked).toBe(true);
      expect(out.agentText).toContain("harness approve understanding");
      expect(out.agentText).not.toContain("approving again will not help");
      expect(out.agentText).not.toContain("Clean the directory up instead");
    },
    PLANT_TIMEOUT_MS,
  );
});
