// Task 20ebf935: the PreToolUse block message says WHY an approval stopped
// opening the gate. Boundary expiry (a PostToolUse event deleted the marker)
// and TTL expiry (`approval_lifecycle.max_age` elapsed, marker still on
// disk) read differently, in the Claude and the Codex hook alike. Gate
// decisions are untouched: every case below only pins message text and the
// optional `expiredBy` report field.

import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { approveUnderstanding } from "../../src/cli/approve/understanding.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { runPackHookCodexPostToolUseCli } from "../../src/cli/pack/hook-codex-post-tool-use.js";
import { runPackHookCodexPreToolUseCli } from "../../src/cli/pack/hook-codex-pre-tool-use.js";
import { runPackHookPostToolUseCli } from "../../src/cli/pack/hook-post-tool-use.js";
import { runPackHookPreToolUseCli } from "../../src/cli/pack/hook-pre-tool-use.js";
import type { LedgerEntry } from "../../src/policies/index.js";
import {
  approvalExpiryNotice,
  checkPersistedReport,
  describeMarkerTtlExpiry,
  expirePersistedReport,
  writeApprovalMarker,
} from "../../src/policy-packs/builtin/understanding-before-execution-runtime.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";

const SESSION = "sess-expiry";
const REPORT_NAME = "r1.json";

let tmp: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"] as const;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ug-expiry-reason-"));
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

/** The shipped template's understanding pack, byte for byte as `harness init` writes it. */
function fullTemplateManifest(): Manifest {
  return parseManifest(parseYaml(FULL_TEMPLATE));
}

function manifestWithLifecycle(lifecycle: Record<string, unknown>): Manifest {
  return parseManifest({
    version: 1,
    policy_packs: [
      {
        name: "understanding-before-execution",
        enabled: true,
        config: { approval_lifecycle: lifecycle },
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

function writeReport(dir: string, body: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, REPORT_NAME);
  fs.writeFileSync(full, `${JSON.stringify(body, null, 2)}\n`);
  return full;
}

function readReport(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

const approvedBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: SESSION,
  approvalStatus: "approved",
  approvedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  ...extra,
});

interface Dirs {
  generatedDir: string;
  reportsDir: string;
}

function dirs(): Dirs {
  return {
    generatedDir: path.join(tmp, "harness.generated"),
    reportsDir: path.join(tmp, "reports"),
  };
}

interface PreOutcome {
  blocked: boolean;
  /** The engine reason (approvalCheck.detail), the stderr audit surface. */
  detail: string;
  stderr: string;
  /**
   * What the AGENT is shown: the stdout JSON `reason` of the Claude hook, and
   * for the Codex hook the part of its stderr diagnostic after the engine
   * reason line (the Codex hook has no stdout wire).
   */
  agentFacing: string;
  /** Claude only: the same text as `hookSpecificOutput.permissionDecisionReason`. */
  permissionDecisionReason?: string;
}

type PostEvent = { tool_name: string; tool_input?: Record<string, unknown> };

interface Runtime {
  name: string;
  post: (d: Dirs, manifest: Manifest, event: PostEvent, now?: Date) => Promise<void>;
  /** The gate's block text for an Edit / apply_patch with `manifest` as the pack config. */
  pre: (d: Dirs, manifest: Manifest) => Promise<PreOutcome>;
}

const RUNTIMES: Runtime[] = [
  {
    name: "claude",
    post: async (d, manifest, event, now) => {
      await runPackHookPostToolUseCli({
        manifest,
        stdin: readableFromString(JSON.stringify({ session_id: SESSION, ...event })),
        stderr: bufferStream().stream,
        generatedDir: d.generatedDir,
        reportsDir: d.reportsDir,
        ...(now !== undefined ? { now } : {}),
      });
    },
    pre: async (d, manifest) => {
      const stderr = bufferStream();
      const stdout = bufferStream();
      const result = await runPackHookPreToolUseCli({
        manifest,
        stdin: readableFromString(JSON.stringify({ session_id: SESSION, tool_name: "Edit" })),
        stdout: stdout.stream,
        stderr: stderr.stream,
        reportsDir: d.reportsDir,
        generatedDir: d.generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      const wire = stdout.read().trim();
      const parsed =
        wire === ""
          ? undefined
          : (JSON.parse(wire) as {
              reason: string;
              hookSpecificOutput: { permissionDecisionReason: string };
            });
      return {
        blocked: result.blocked,
        detail: result.approvalCheck.detail,
        stderr: stderr.read(),
        agentFacing: parsed?.reason ?? "",
        ...(parsed !== undefined
          ? { permissionDecisionReason: parsed.hookSpecificOutput.permissionDecisionReason }
          : {}),
      };
    },
  },
  {
    name: "codex",
    post: async (d, manifest, event, now) => {
      await runPackHookCodexPostToolUseCli({
        manifest,
        stdin: readableFromString(JSON.stringify({ session_id: SESSION, ...event })),
        stderr: bufferStream().stream,
        generatedDir: d.generatedDir,
        reportsDir: d.reportsDir,
        ...(now !== undefined ? { now } : {}),
      });
    },
    pre: async (d, manifest) => {
      const stderr = bufferStream();
      const result = await runPackHookCodexPreToolUseCli({
        manifest,
        stdin: readableFromString(JSON.stringify({ session_id: SESSION, tool_name: "apply_patch" })),
        stderr: stderr.stream,
        reportsDir: d.reportsDir,
        generatedDir: d.generatedDir,
        ledgerQuery: async (): Promise<LedgerEntry[]> => [],
      });
      const text = stderr.read();
      // Everything after the engine-reason line of the BLOCK diagnostic is the
      // agent-facing block text.
      const blockAt = text.indexOf("harness pack hook codex: BLOCK");
      const afterReason =
        blockAt === -1 ? "" : text.slice(text.indexOf("\n", blockAt) + 1);
      return {
        blocked: result.blocked,
        detail: result.approvalCheck.detail,
        stderr: text,
        agentFacing: afterReason,
      };
    },
  },
];

describe.each(RUNTIMES)("approval expiry reason in the block message: $name hook", (rt) => {
  it("PR merge before task_finish under the shipped lifecycle clears the marker; the next gate check blocks with 'approval expired because tool:<merge verb> at <time>'", async () => {
    const d = dirs();
    const manifest = fullTemplateManifest();
    writeApprovalMarker(d.generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
    });
    const reportFile = writeReport(d.reportsDir, approvedBody());
    // Before the merge the marker opens the gate.
    expect((await rt.pre(d, manifest)).blocked).toBe(false);

    const mergedAt = new Date("2026-10-01T12:34:56.000Z");
    await rt.post(d, manifest, {
      tool_name: "mcp__agent-tasks__pull_requests_merge",
      tool_input: { prId: "p-1" },
    }, mergedAt);

    // Intended behaviour, pinned: the merge is a configured boundary, so the
    // approval is gone BEFORE task_finish runs.
    const after = await rt.pre(d, manifest);
    expect(after.blocked).toBe(true);
    expect(after.detail).toContain(
      "approval expired because tool:mcp__agent-tasks__pull_requests_merge at 2026-10-01T12:34:56.000Z",
    );
    expect(after.detail).toMatch(/^no approval marker for session sess-expiry; /);
    // The agent-facing surface (not only the stderr audit line) carries the
    // reason, under the shipped template's `ux:` envelope.
    expect(after.agentFacing).toContain(
      "approval expired because tool:mcp__agent-tasks__pull_requests_merge at 2026-10-01T12:34:56.000Z.",
    );
    expect(after.agentFacing).not.toContain("no approval marker for session");
    if (after.permissionDecisionReason !== undefined) {
      expect(after.permissionDecisionReason).toBe(after.agentFacing);
    }
    expect(readReport(reportFile)["expiredBy"]).toBe("tool:mcp__agent-tasks__pull_requests_merge");
    expect(readReport(reportFile)["expiredAt"]).toBe("2026-10-01T12:34:56.000Z");
  });

  it("a Bash boundary persists 'bash:/<regex>/' as the event and the agent-facing text names it", async () => {
    const d = dirs();
    const manifest = fullTemplateManifest();
    writeApprovalMarker(d.generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
    });
    const reportFile = writeReport(d.reportsDir, approvedBody());
    await rt.post(d, manifest, { tool_name: "Bash", tool_input: { command: "gh pr merge 12 --squash" } });
    expect(readReport(reportFile)["expiredBy"]).toBe("bash:/^gh pr (merge|close)\\b/");
    const after = await rt.pre(d, manifest);
    expect(after.blocked).toBe(true);
    expect(after.detail).toMatch(/approval expired because bash:\/\^gh pr \(merge\|close\)\\b\/ at 20\d\d-/);
    expect(after.agentFacing).toMatch(
      /approval expired because bash:\/\^gh pr \(merge\|close\)\\b\/ at 20\d\d-[^\n]*\.$/m,
    );
  });

  it("TTL expiry reads 'max_age <dur> elapsed (approved at <time>)', not a boundary event, and still blocks", async () => {
    const d = dirs();
    const approvedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    writeApprovalMarker(d.generatedDir, SESSION, { approvedAt, approvedBy: "operator" });
    writeReport(d.reportsDir, approvedBody({ approvedAt }));
    const out = await rt.pre(d, manifestWithLifecycle({ max_age: "4h" }));
    expect(out.blocked).toBe(true);
    expect(out.detail).toContain(
      `approval expired because max_age 240m elapsed (approved at ${approvedAt})`,
    );
    expect(out.detail).not.toMatch(/approval expired because (tool|bash):/);
    // Same sentence on the agent-facing surface (legacy envelope here: this
    // manifest declares no `ux:`; the next test covers the shipped `ux:`).
    expect(out.agentFacing).toContain(
      `approval expired because max_age 240m elapsed (approved at ${approvedAt}).`,
    );
  });

  it("TTL expiry under the shipped template's lifecycle reaches the agent-facing text too", async () => {
    const d = dirs();
    const approvedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeApprovalMarker(d.generatedDir, SESSION, { approvedAt, approvedBy: "operator" });
    writeReport(d.reportsDir, approvedBody({ approvedAt }));
    const out = await rt.pre(d, fullTemplateManifest());
    expect(out.blocked).toBe(true);
    expect(out.agentFacing).toContain(
      `approval expired because max_age 240m elapsed (approved at ${approvedAt}).`,
    );
    expect(out.agentFacing).not.toMatch(/approval expired because (tool|bash):/);
    if (out.permissionDecisionReason !== undefined) {
      expect(out.permissionDecisionReason).toBe(out.agentFacing);
    }
  });

  it("no expiry sentence reaches the agent when the approval never lapsed", async () => {
    const d = dirs();
    writeReport(d.reportsDir, {
      sessionId: SESSION,
      approvalStatus: "pending",
      createdAt: new Date().toISOString(),
    });
    const out = await rt.pre(d, fullTemplateManifest());
    expect(out.blocked).toBe(true);
    expect(out.agentFacing).not.toMatch(/approval expired because/);
  });

  it("a boundary expiry never reads as a TTL expiry", async () => {
    const d = dirs();
    const manifest = manifestWithLifecycle({
      expire_on_tool_match: ["mcp__agent-tasks__task_abandon"],
      max_age: "4h",
    });
    writeApprovalMarker(d.generatedDir, SESSION, {
      approvedAt: new Date().toISOString(),
      approvedBy: "operator",
    });
    writeReport(d.reportsDir, approvedBody());
    await rt.post(d, manifest, { tool_name: "mcp__agent-tasks__task_abandon", tool_input: {} });
    const out = await rt.pre(d, manifest);
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/approval expired because tool:mcp__agent-tasks__task_abandon at /);
    expect(out.detail).not.toMatch(/max_age/);
  });

  it("an expired report without the event field (older report) renders without an event and does not crash", async () => {
    const d = dirs();
    writeReport(d.reportsDir, {
      sessionId: SESSION,
      approvalStatus: "expired",
      approvedAt: "2026-05-17T08:00:00.000Z",
      createdAt: "2026-05-17T07:00:00.000Z",
      expiredAt: "2026-05-17T09:00:00.000Z",
    });
    const out = await rt.pre(d, manifestWithLifecycle({ max_age: "4h" }));
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/approvalStatus=expired/);
    expect(out.detail).not.toMatch(/approval expired because/);
    expect(out.agentFacing).not.toMatch(/approval expired because/);
  });

  it("the reported event and time are sanitized: control characters cannot forge an extra reason line", async () => {
    const d = dirs();
    writeReport(d.reportsDir, {
      sessionId: SESSION,
      approvalStatus: "expired",
      createdAt: new Date().toISOString(),
      expiredAt: "2026-10-01T00:00:00.000Z\nreason: forged",
      expiredBy: "tool:x\ny",
    });
    const out = await rt.pre(d, manifestWithLifecycle({ max_age: "4h" }));
    expect(out.detail).not.toMatch(/\n/);
    expect(out.detail).toContain("approval expired because tool:x y at 2026-10-01T00:00:00.000Z reason: forged");
  });

  it("a forged marker keeps its own, higher-precedence reason ahead of any expiry sentence", async () => {
    const d = dirs();
    fs.mkdirSync(path.join(d.generatedDir, ".approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(d.generatedDir, ".approvals", SESSION),
      `${JSON.stringify({ approvedAt: new Date().toISOString(), approvedBy: "attacker" })}\n`,
    );
    writeReport(d.reportsDir, {
      sessionId: SESSION,
      approvalStatus: "expired",
      createdAt: new Date().toISOString(),
      expiredAt: "2026-10-01T00:00:00.000Z",
      expiredBy: "tool:mcp__agent-tasks__task_finish",
    });
    const out = await rt.pre(d, manifestWithLifecycle({ max_age: "4h" }));
    expect(out.blocked).toBe(true);
    expect(out.detail).toMatch(/^forged\/unsigned marker rejected for session sess-expiry; /);
    expect(out.agentFacing).not.toMatch(/approval expired because/);
  });
});

describe("expirePersistedReport / checkPersistedReport / rewriteReportApproved", () => {
  it("expirePersistedReport persists the trigger as expiredBy next to expiredAt; checkPersistedReport names both", () => {
    const d = dirs();
    const file = writeReport(d.reportsDir, approvedBody());
    const res = expirePersistedReport(
      d.reportsDir,
      SESSION,
      new Date("2026-10-01T08:00:00.000Z"),
      "tool:mcp__agent-tasks__task_merge",
    );
    expect(readReport(file)["expiredBy"]).toBe("tool:mcp__agent-tasks__task_merge");
    const evidence = checkPersistedReport(d.reportsDir, SESSION);
    expect(evidence.detail).toBe(
      `latest report ${REPORT_NAME} has approvalStatus=expired; approval expired because tool:mcp__agent-tasks__task_merge at 2026-10-01T08:00:00.000Z`,
    );
  });

  it("expirePersistedReport without a trigger leaves no event and drops a stale one", () => {
    const d = dirs();
    const file = writeReport(d.reportsDir, approvedBody({ expiredBy: "tool:stale" }));
    expect(expirePersistedReport(d.reportsDir, SESSION, new Date("2026-10-01T08:00:00.000Z")).ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(readReport(file), "expiredBy")).toBe(false);
    expect(checkPersistedReport(d.reportsDir, SESSION).detail).toBe(
      `latest report ${REPORT_NAME} has approvalStatus=expired`,
    );
  });

  it("a re-approve removes expiredBy together with expiredAt", async () => {
    const d = dirs();
    const file = writeReport(d.reportsDir, approvedBody());
    expirePersistedReport(d.reportsDir, SESSION, new Date(), "tool:mcp__agent-tasks__task_finish");
    expect(readReport(file)["expiredBy"]).toBe("tool:mcp__agent-tasks__task_finish");
    await approveUnderstanding({
      manifest: parseManifest({ version: 1 }),
      session: SESSION,
      reportsDir: d.reportsDir,
      generatedDir: d.generatedDir,
      ledgerAdd: async () => ({ ok: true }),
    });
    const after = readReport(file);
    expect(after["approvalStatus"]).toBe("approved");
    expect(Object.prototype.hasOwnProperty.call(after, "expiredAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(after, "expiredBy")).toBe(false);
  });
});

describe("approvalExpiryNotice", () => {
  const base = { approvalStatus: "expired", expiredBy: null, expiredAt: null };

  it("prefers the max_age sentence and ends it with a period", () => {
    expect(approvalExpiryNotice("approval expired because max_age 1m elapsed (approved at t)", null)).toBe(
      "approval expired because max_age 1m elapsed (approved at t).",
    );
  });

  it("names a boundary event from the carried report fields, without re-reading the file", () => {
    const report = {
      filePath: "/nonexistent/never-read.json",
      sessionId: SESSION,
      createdAt: null,
      createdAtMs: 0,
      approvedAt: null,
      ...base,
      expiredBy: "tool:x",
      expiredAt: "2026-10-01T00:00:00.000Z",
    };
    expect(approvalExpiryNotice(undefined, report)).toBe(
      "approval expired because tool:x at 2026-10-01T00:00:00.000Z.",
    );
  });

  it("is undefined without a TTL sentence or a report event", () => {
    expect(approvalExpiryNotice(undefined, null)).toBeUndefined();
  });
});

describe("describeMarkerTtlExpiry", () => {
  it("returns undefined when no marker aged out", () => {
    expect(
      describeMarkerTtlExpiry({ expired: false, detail: "no approval marker for session s", taskCheckDetail: "" }),
    ).toBeUndefined();
  });

  it("reads the max and the approval time from the marker check's own detail, task marker included", () => {
    expect(
      describeMarkerTtlExpiry({
        expired: true,
        detail: "no approval marker for session s",
        taskCheckDetail:
          "approval marker task-t1 expired: age 301m > max 120m (approved at 2026-10-01T01:00:00Z)",
      }),
    ).toBe("approval expired because max_age 120m elapsed (approved at 2026-10-01T01:00:00Z)");
  });

  it("returns undefined for an expired flag whose detail is not a max_age line", () => {
    expect(describeMarkerTtlExpiry({ expired: true, detail: "something else", taskCheckDetail: "" })).toBeUndefined();
  });
});
