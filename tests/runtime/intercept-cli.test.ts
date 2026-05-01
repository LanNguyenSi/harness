import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";
import type { Manifest, Policy } from "../../src/schema/index.js";

function streamFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}

function captureStream(): { stream: NodeJS.WritableStream; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

const captureStdout = captureStream;

const REVIEW_POLICY: Policy = {
  name: "review-before-merge",
  description: "block merges without review evidence",
  trigger: {
    event: "PreToolUse",
    match: "mcp__agent-tasks__pull_requests_merge",
    extract: { PR_NUMBER: "toolArgs.prNumber" },
  },
  requires: { ledger_tag: "review:${PR_NUMBER}" },
  hook: "h",
  enforcement: "block",
} as Policy;

function fakeManifest(policies: Policy[]): Manifest {
  return {
    version: 1,
    grounding: {} as Manifest["grounding"],
    tools: { mcp: [], cli: [], builtin: { known: [] } } as unknown as Manifest["tools"],
    memory: {} as Manifest["memory"],
    hooks: [
      {
        name: "h",
        event: "PreToolUse",
        command: "/bin/true",
        blocking: false,
      } as Manifest["hooks"][number],
    ],
    policies,
  } as Manifest;
}

describe("runInterceptCli", () => {
  it("writes deny JSON when a matching policy denies", async () => {
    const ledger: LedgerClient = {
      async query() {
        return { kind: "ok", entries: [] };
      },
      async record() {
        /* no-op */
      },
    };
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
          session_id: "sess-1",
        }),
      ),
      stdout: stream,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger,
    });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(output().trim());
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toContain("review-before-merge");
  });

  it("stays silent on allow", async () => {
    const ledger: LedgerClient = {
      async query() {
        return {
          kind: "ok",
          entries: [
            {
              id: "1",
              content: "review:42:approved",
              createdAt: "2026-04-30T12:00:00.000Z",
            },
          ],
        };
      },
      async record() {
        /* no-op */
      },
    };
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__agent-tasks__pull_requests_merge",
          tool_input: { prNumber: 42 },
          session_id: "sess-1",
        }),
      ),
      stdout: stream,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger,
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });

  it("does not block when stdin is empty / non-JSON", async () => {
    const { stream, output } = captureStdout();
    const result = await runInterceptCli({
      stdin: streamFrom(""),
      stdout: stream,
      manifest: fakeManifest([REVIEW_POLICY]),
    });
    expect(result.blocked).toBe(false);
    expect(output()).toBe("");
  });
});

describe("runInterceptCli — Phase 5 #3: --verbose stderr diagnostics", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.HARNESS_POLICY_VERBOSE;
    delete process.env.HARNESS_POLICY_VERBOSE;
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.HARNESS_POLICY_VERBOSE;
    } else {
      process.env.HARNESS_POLICY_VERBOSE = savedEnv;
    }
  });

  const denyEvent = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__agent-tasks__pull_requests_merge",
    tool_input: { prNumber: 42 },
    session_id: "sess-1",
  });
  const denyLedger: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      /* no-op */
    },
  };
  const allowLedger: LedgerClient = {
    async query() {
      return {
        kind: "ok",
        entries: [
          { id: "1", content: "review:42:approved", createdAt: "2026-04-30T12:00:00.000Z" },
        ],
      };
    },
    async record() {
      /* no-op */
    },
  };
  const degradedLedger: LedgerClient = {
    async query() {
      return { kind: "degraded", reason: "grounding-mcp timeout after 5000ms" };
    },
    async record() {
      /* no-op */
    },
  };

  it("default (verbose off): stderr is empty even on deny", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
    });
    expect(errOutput()).toBe("");
  });

  it("--verbose on deny: stdout carries deny JSON, stderr carries diagnostic block", async () => {
    const { stream: out, output: outOutput } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
      verbose: true,
    });
    const stdoutLine = outOutput().trim();
    expect(JSON.parse(stdoutLine).decision).toBe("deny");
    const errText = errOutput();
    expect(errText).toContain("harness policy intercept: review-before-merge: deny");
    expect(errText).toContain("ledger_tag: review:42");
    expect(errText).toContain("matched: 0");
    expect(errText).toContain("reason: no matching ledger entry for tag `review:42`");
    expect(errText).toContain("PR_NUMBER=42");
  });

  it("--verbose on allow: stderr stays empty", async () => {
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: allowLedger,
      verbose: true,
    });
    expect(errOutput()).toBe("");
  });

  it("--verbose on warn-degraded: stderr names the ledger reason", async () => {
    const { stream: out, output: outOutput } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: degradedLedger,
      verbose: true,
    });
    expect(outOutput()).toBe("");
    const errText = errOutput();
    expect(errText).toContain("warn-degraded (ledger unreachable)");
    expect(errText).toContain("grounding-mcp timeout after 5000ms");
  });

  it("HARNESS_POLICY_VERBOSE=1 enables verbose without the flag", async () => {
    process.env.HARNESS_POLICY_VERBOSE = "1";
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
    });
    expect(errOutput()).toContain("harness policy intercept: review-before-merge: deny");
  });

  it("HARNESS_POLICY_VERBOSE=0 stays silent (env disable)", async () => {
    process.env.HARNESS_POLICY_VERBOSE = "0";
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
    });
    expect(errOutput()).toBe("");
  });

  it.each(["false", "FALSE", "no", "NO", "off", "Off", "0"])(
    "HARNESS_POLICY_VERBOSE=%s stays silent (env disable variants)",
    async (envValue) => {
      process.env.HARNESS_POLICY_VERBOSE = envValue;
      const { stream: out } = captureStream();
      const { stream: err, output: errOutput } = captureStream();
      await runInterceptCli({
        stdin: streamFrom(denyEvent),
        stdout: out,
        stderr: err,
        manifest: fakeManifest([REVIEW_POLICY]),
        ledger: denyLedger,
      });
      expect(errOutput()).toBe("");
    },
  );

  it("explicit verbose=false beats HARNESS_POLICY_VERBOSE=1", async () => {
    process.env.HARNESS_POLICY_VERBOSE = "1";
    const { stream: out } = captureStream();
    const { stream: err, output: errOutput } = captureStream();
    await runInterceptCli({
      stdin: streamFrom(denyEvent),
      stdout: out,
      stderr: err,
      manifest: fakeManifest([REVIEW_POLICY]),
      ledger: denyLedger,
      verbose: false,
    });
    expect(errOutput()).toBe("");
  });
});
