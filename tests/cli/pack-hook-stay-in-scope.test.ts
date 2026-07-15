import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateMatch,
  extractParentPrUrl,
  runPackHookStayInScopeCli,
  STAY_IN_SCOPE_DISABLED_ENV,
  STAY_IN_SCOPE_LOG_ENV,
  TOOL_NAME_TASK_CREATE,
  TOOL_NAME_TASKS_CREATE,
  TOOL_NAME_TASKS_UPDATE,
} from "../../src/cli/pack/hook-stay-in-scope.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stay-in-scope-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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

function eventBody(
  toolName: string,
  toolInput?: Record<string, unknown>,
  toolResponse?: Record<string, unknown>,
): string {
  return JSON.stringify({
    session_id: "sess-1",
    tool_name: toolName,
    ...(toolInput !== undefined && { tool_input: toolInput }),
    ...(toolResponse !== undefined && { tool_response: toolResponse }),
  });
}

function logPath(): string {
  return path.join(tmp, "reminders", "stay-in-scope.log");
}

function readLog(): string {
  return fs.readFileSync(logPath(), "utf8");
}

function readLogRecords(): Array<Record<string, unknown>> {
  return readLog()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("pack hook stay-in-scope — match by review-shaped label", () => {
  it("emits stderr reminder + audit row when labels contain `from-review`", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(
          TOOL_NAME_TASK_CREATE,
          {
            title: "fix cosmetic phase_status thing",
            labels: ["from-review", "cosmetic"],
            description: "Small follow-up from PR review.",
          },
          { task: { id: "task-uuid-abc" } },
        ),
      ),
      stderr: stderr.stream,
    });

    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("label");
    expect(result.logged).toBe(true);
    expect(result.secondOrder).toBe(false);

    const out = stderr.read();
    expect(out).toContain("[stay-in-scope]");
    expect(out).toContain("task=task-uuid-abc");
    expect(out).toContain("feedback_reviewer_findings_stay_in_scope");

    const records = readLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: "task-uuid-abc",
      title: "fix cosmetic phase_status thing",
      labels: ["from-review", "cosmetic"],
      matchedRule: "label",
      secondOrder: false,
    });
  });

  it("matches `followup` and `reviewer-finding` and `review-finding` variants case-insensitively", async () => {
    for (const label of [
      "Followup",
      "followup-from-readme-drift",
      "REVIEWER-FINDING",
      "review-finding-2026",
    ]) {
      const stderr = bufferStream();
      const result = await runPackHookStayInScopeCli({
        generatedDir: path.join(tmp, "harness.generated"),
        logPath: path.join(tmp, `log-${label}.jsonl`),
        env: {},
        stdin: readableFromString(
          eventBody(TOOL_NAME_TASKS_CREATE, {
            title: `t-${label}`,
            labels: [label],
            description: "body",
          }),
        ),
        stderr: stderr.stream,
      });
      expect(result.matched, `label ${label} should match`).toBe(true);
      expect(result.matchedRule).toBe("label");
    }
  });
});

describe("pack hook stay-in-scope — match by description marker", () => {
  it("matches `Vorgaenger-PR:` marker even without a review-shaped label", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(
          TOOL_NAME_TASKS_CREATE,
          {
            title: "deferred work item",
            labels: ["enhancement"],
            description:
              "Cleanup follow-up.\n\nVorgaenger-PR: #91\n\nDetail body here.",
          },
          { task: { id: "task-vorg-1" } },
        ),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("explicit-marker");
    expect(result.logged).toBe(true);

    const records = readLogRecords();
    expect(records[0]).toMatchObject({
      matchedRule: "explicit-marker",
      parentPrUrl: "#91",
    });
  });

  it("matches Unicode `Vorgänger-PR:` form", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(TOOL_NAME_TASKS_CREATE, {
          title: "t",
          description: "Vorgänger-PR: #99",
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("explicit-marker");
  });

  it("matches the `## Hintergrund ... Review` window heuristic", async () => {
    const stderr = bufferStream();
    const description =
      "## Hintergrund\n\nAus dem Review-Subagent-Lauf auf PR #91...\n\nMore body.";
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(TOOL_NAME_TASKS_CREATE, {
          title: "t",
          labels: ["enhancement"],
          description,
        }),
      ),
      stderr: stderr.stream,
    });
    // `Review-Subagent` is an explicit-marker substring, so this exemplar
    // resolves through the explicit-marker rule rather than the window
    // heuristic. The window heuristic only owns the residual case where
    // `## Hintergrund` exists AND `Review` shows up nearby AND none of
    // the explicit markers appear; we exercise that residual case in the
    // next test.
    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("explicit-marker");
  });

  it("falls back to the window heuristic when no explicit marker appears", async () => {
    const description =
      "## Hintergrund\n\nPR landed a Review process workaround that needs follow-up.";
    const evaluation = evaluateMatch([], description);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.matchedRule).toBe("hintergrund-marker");
  });

  it("does NOT match when `## Hintergrund` and `Review` are >200 chars apart", async () => {
    const description =
      "## Hintergrund\n\n" + "x".repeat(250) + "\n\nReview of something else.";
    const evaluation = evaluateMatch([], description);
    expect(evaluation.matched).toBe(false);
  });
});

describe("pack hook stay-in-scope — no-match cases", () => {
  it("ignores tools outside the watch list (`tasks_get`, `task_start`, etc.)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__tasks_get", {
          taskId: "abc",
          labels: ["from-review"],
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(false);
    expect(result.logged).toBe(false);
    expect(fs.existsSync(logPath())).toBe(false);
    expect(stderr.read()).toMatch(/not in watch list/);
  });

  it("ignores task_create with no review-shaped label or description marker", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(TOOL_NAME_TASK_CREATE, {
          title: "fresh feature work",
          labels: ["enhancement", "priority-high"],
          description: "Build a thing. Independent of any prior PR.",
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(false);
    expect(result.matchedRule).toBe("none");
    expect(result.logged).toBe(false);
    expect(fs.existsSync(logPath())).toBe(false);
    expect(stderr.read()).toMatch(/payload carries no review-shaped/);
  });
});

describe("pack hook stay-in-scope — Codex MCP tool-name alias variants (task cf4cdc93 parity)", () => {
  // Same rationale as the track-active-claim alias tests: Codex can
  // emit an MCP tool name in a variant form for the identical tool
  // (server hyphen/underscore swap, the `mcp__server__.tool` dotted
  // form). The generator's `expandCodexHookMatchPattern` already routes
  // these variants to the hook at dispatch time; these tests pin that
  // the hook BODY's watch-list check also recognizes them.
  it("matches a review-shaped task_create carried on an underscore-server tool_name variant", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody("mcp__agent_tasks__task_create", {
          title: "follow-up",
          labels: ["from-review"],
          description: "Split out of the parent PR.",
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("label");
    expect(result.logged).toBe(true);
  });

  it("matches a review-shaped tasks_update carried on the dotted mcp__server__.tool form", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody("mcp__agent-tasks__.tasks_update", {
          taskId: "task-uuid-abc",
          labels: ["reviewer-finding"],
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.logged).toBe(true);
  });

  it("still ignores an alias-variant tool_name outside the watch list", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody("mcp__agent_tasks__tasks_get", {
          taskId: "abc",
          labels: ["from-review"],
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(false);
    expect(stderr.read()).toMatch(/not in watch list/);
  });
});

describe("pack hook stay-in-scope — Codex wire-format synonyms (task cf4cdc93 review fix, MEDIUM)", () => {
  // Reviewer probe (empirically confirmed): a Codex-shaped payload using
  // `raw_input` (instead of `tool_input`) or `tool` (instead of
  // `tool_name`) used to silently no-op here, even though the sibling
  // `codex-post-tool-use` hook already tolerated both synonyms via its
  // own `pickString` / `resolveToolInput`. These pin the fix via the
  // shared `hook-bootstrap.ts` helpers.
  it("matches a review-shaped task_create when the payload arrives under raw_input instead of tool_input", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: TOOL_NAME_TASK_CREATE,
          raw_input: {
            title: "follow-up",
            labels: ["from-review"],
            description: "Split out of the parent PR.",
          },
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("label");
    expect(result.logged).toBe(true);
  });

  it("matches a review-shaped task_create when the tool name arrives under `tool` instead of `tool_name`", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool: TOOL_NAME_TASK_CREATE,
          tool_input: {
            title: "follow-up",
            labels: ["reviewer-finding"],
          },
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.logged).toBe(true);
  });

  it("prefers tool_input over raw_input when both are present (matches the sibling codex-post-tool-use precedence)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: TOOL_NAME_TASK_CREATE,
          tool_input: { title: "from tool_input", labels: ["from-review"] },
          raw_input: { title: "from raw_input", labels: ["from-review"] },
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    const records = readLogRecords();
    expect(records.at(-1)?.["title"]).toBe("from tool_input");
  });

  it("still honors the Claude-only tool_response taskId fallback when the payload also carries raw_input (residual note: Codex envelope may not carry tool_response at all — this only pins that the fallback is not broken by the new resolution)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          tool_name: TOOL_NAME_TASK_CREATE,
          tool_input: { title: "follow-up", labels: ["from-review"] },
          tool_response: { task: { id: "task-uuid-from-response" } },
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    const records = readLogRecords();
    expect(records.at(-1)?.["taskId"]).toBe("task-uuid-from-response");
  });

  it("negative control: missing both tool_name and tool still skips (no false-positive synonym resolution)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        JSON.stringify({
          session_id: "sess-1",
          raw_input: { title: "follow-up", labels: ["from-review"] },
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(false);
    expect(stderr.read()).toMatch(/not in watch list/);
  });
});

describe("pack hook stay-in-scope — operator opt-out", () => {
  it("STAY_IN_SCOPE_DISABLED=1 short-circuits to no-op even on a perfect match", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: { [STAY_IN_SCOPE_DISABLED_ENV]: "1" },
      stdin: readableFromString(
        eventBody(TOOL_NAME_TASKS_CREATE, {
          labels: ["from-review"],
          description: "Vorgaenger-PR: #91",
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(false);
    expect(result.logged).toBe(false);
    expect(fs.existsSync(logPath())).toBe(false);
    expect(stderr.read()).toMatch(/STAY_IN_SCOPE_DISABLED=1, skipping/);
  });
});

describe("pack hook stay-in-scope — log path resolution", () => {
  it("honors STAY_IN_SCOPE_LOG env when no explicit logPath option is set", async () => {
    const envLogPath = path.join(tmp, "from-env", "audit.jsonl");
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      env: { [STAY_IN_SCOPE_LOG_ENV]: envLogPath },
      stdin: readableFromString(
        eventBody(TOOL_NAME_TASKS_CREATE, {
          labels: ["from-review"],
          description: "body",
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.logPath).toBe(envLogPath);
    expect(fs.existsSync(envLogPath)).toBe(true);
  });

  it("explicit logPath option wins over STAY_IN_SCOPE_LOG env", async () => {
    const envLogPath = path.join(tmp, "from-env.jsonl");
    const explicit = path.join(tmp, "explicit.jsonl");
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: explicit,
      env: { [STAY_IN_SCOPE_LOG_ENV]: envLogPath },
      stdin: readableFromString(
        eventBody(TOOL_NAME_TASKS_CREATE, {
          labels: ["from-review"],
          description: "body",
        }),
      ),
      stderr: stderr.stream,
    });
    expect(result.logPath).toBe(explicit);
    expect(fs.existsSync(explicit)).toBe(true);
    expect(fs.existsSync(envLogPath)).toBe(false);
  });
});

describe("pack hook stay-in-scope — second-order heuristic", () => {
  it("upgrades the stderr line to SECOND-ORDER when a review-label task references a parent PR", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(
          TOOL_NAME_TASK_CREATE,
          {
            title: "follow-up of a follow-up",
            labels: ["from-review", "cleanup"],
            description:
              "Aus Review-Subagent auf PR #91.\n\nVorgaenger-PR: #91\n\nDetails ...",
          },
          { task: { id: "task-second-order" } },
        ),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.secondOrder).toBe(true);

    const out = stderr.read();
    expect(out).toContain("[stay-in-scope: SECOND-ORDER]");
    expect(out).toContain("follow-up of a follow-up");

    const records = readLogRecords();
    expect(records[0]).toMatchObject({
      secondOrder: true,
      parentPrUrl: "#91",
    });
  });

  it("does NOT flag second-order when only the parent PR is referenced (no review label)", async () => {
    const evaluation = evaluateMatch(
      ["enhancement"],
      "Vorgaenger-PR: #91 — this is a feature, not a follow-up",
    );
    // Description marker still fires the reminder; secondOrder requires
    // the review-shaped label too.
    expect(evaluation.matched).toBe(true);
    expect(evaluation.secondOrder).toBe(false);
  });
});

describe("pack hook stay-in-scope — tasks_update path", () => {
  it("matches tasks_update when labels get added after creation", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        eventBody(
          TOOL_NAME_TASKS_UPDATE,
          {
            taskId: "task-existing",
            labels: ["from-review"],
          },
          { task: { id: "task-existing" } },
        ),
      ),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(true);
    expect(result.matchedRule).toBe("label");

    const records = readLogRecords();
    expect(records[0]?.["taskId"]).toBe("task-existing");
  });
});

describe("pack hook stay-in-scope — robustness", () => {
  it("treats malformed JSON as no-op (does not throw)", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString("{not valid json"),
      stderr: stderr.stream,
    });
    expect(result.matched).toBe(false);
    expect(stderr.read()).toMatch(/malformed event JSON/);
  });

  it("handles missing tool_input + tool_response gracefully", async () => {
    const stderr = bufferStream();
    const result = await runPackHookStayInScopeCli({
      generatedDir: path.join(tmp, "harness.generated"),
      logPath: logPath(),
      env: {},
      stdin: readableFromString(
        JSON.stringify({ tool_name: TOOL_NAME_TASKS_CREATE }),
      ),
      stderr: stderr.stream,
    });
    // No labels, no description -> no match.
    expect(result.matched).toBe(false);
    expect(result.matchedRule).toBe("none");
  });
});

describe("extractParentPrUrl", () => {
  it("extracts a full GitHub PR URL when present", () => {
    expect(
      extractParentPrUrl(
        "See https://github.com/LanNguyenSi/agent-grounding/pull/91 for context.",
      ),
    ).toBe("https://github.com/LanNguyenSi/agent-grounding/pull/91");
  });

  it("falls back to the `#N` shorthand from `Vorgaenger-PR` lines", () => {
    expect(extractParentPrUrl("Vorgaenger-PR: #91")).toBe("#91");
    expect(extractParentPrUrl("Vorgänger-PR: 91")).toBe("#91");
    expect(extractParentPrUrl("parent PR #42 is the source")).toBe("#42");
  });

  it("returns null when no parent reference is present", () => {
    expect(extractParentPrUrl("no parent here, just text")).toBeNull();
  });
});
