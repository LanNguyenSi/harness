import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  attributeTriggerSegments,
  buildActionEnvelope,
  classifyRisk,
  intercept,
  policyMatchesEvent,
  type EnvelopeContext,
  type LedgerClient,
  type RiskGateContext,
  type ToolEvent,
} from "../../src/runtime/index.js";
import type { CommandSegment } from "../../src/runtime/command-normalize.js";
import type {
  ExtractBuiltins,
  LedgerEntry,
  LedgerQueryResult,
} from "../../src/policies/index.js";
import { parseManifest } from "../../src/schema/index.js";
import type {
  EnvironmentResolver,
  Policy,
  RiskClassifier,
} from "../../src/schema/index.js";
import { makeManifest, makePolicy as policy } from "../_helpers/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

const NOW = new Date("2026-04-30T12:00:00.000Z");

const BUILTINS: ExtractBuiltins = {
  SESSION_ID: "sess-1",
  REPO: "harness",
  BRANCH: "master",
  TOOL_NAME: "mcp__agent-tasks__pull_requests_merge",
  CWD: "/home/lan/git/pandora/harness",
};

const manifest = (policies: Policy[]) => makeManifest({ policies });

function makeLedger(
  result: LedgerQueryResult,
  recordSink?: { calls: Array<{ tag: string; sessionId: string }> },
): LedgerClient & {
  queryCalls: Array<{ tag: string; sessionId: string }>;
  recordCalls: Array<{ decisionName: string; sessionId: string }>;
} {
  const queryCalls: Array<{ tag: string; sessionId: string }> = [];
  const recordCalls: Array<{ decisionName: string; sessionId: string }> = [];
  return {
    queryCalls,
    recordCalls,
    async query(tag, sessionId) {
      queryCalls.push({ tag, sessionId });
      if (recordSink) recordSink.calls.push({ tag, sessionId });
      return result;
    },
    async record(decision, sessionId) {
      recordCalls.push({ decisionName: decision.policyName, sessionId });
    },
  };
}

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

const MERGE_EVENT: ToolEvent = {
  hook_event_name: "PreToolUse",
  tool_name: "mcp__agent-tasks__pull_requests_merge",
  tool_input: { prNumber: 42 },
  session_id: "sess-1",
};

const matchingEntry: LedgerEntry = {
  id: "1",
  content: "review:42:approved",
  createdAt: NOW.toISOString(),
};

describe("intercept — match + allow", () => {
  it("returns no block when ledger has a matching entry", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).toBeNull();
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.decisions[0]?.ledgerTag).toBe("review:42");
    expect(result.decisions[0]?.extractValues.PR_NUMBER).toBe("42");
    expect(ledger.queryCalls).toEqual([
      { tag: "review:42", sessionId: "sess-1" },
    ]);
  });

  it("matches Codex MCP underscore and dot tool names against hyphenated policy triggers", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: {
        ...MERGE_EVENT,
        tool_name: "mcp__agent_tasks__.pull_requests_merge",
        tool_input: undefined,
        raw_input: { prNumber: 42 },
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.decisions[0]?.ledgerTag).toBe("review:42");
  });
});

describe("intercept — match + deny", () => {
  it("emits Claude Code deny JSON when the ledger is empty", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    const expectedReason =
      "review-before-merge: no matching ledger entry for tag `review:42`. " +
      "To satisfy: record an evidence-ledger entry containing `review:42`, " +
      "under this runtime session's id `sess-1` (not the agent-tasks task UUID).";
    expect(result.blockJson).toEqual({
      decision: "block",
      reason: expectedReason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expectedReason,
      },
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.decisions[0]?.recordHint).toBe(
      "record an evidence-ledger entry containing `review:42`",
    );
  });

  it("names the sessionId namespace (runtime session, not the task UUID)", async () => {
    // A ledger gate keys off the runtime session id; an entry written
    // under the agent-tasks task UUID never satisfies it (2026-05-17
    // incident). The deny hint must name BOTH the required tag and the
    // namespace to write it under, so the agent does not guess the wrong
    // identity. Mutation guard: drop the namespace clause from intercept's
    // hintSuffix and this test goes red.
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("`review:42`");
    expect(reason).toContain("under this runtime session's id `sess-1`");
    expect(reason).toContain("not the agent-tasks task UUID");
  });
});

describe("intercept — deny with producer hints", () => {
  it("appends rendered producers (with substituted vars) to the deny reason", async () => {
    // The producers field is opt-in per policy. When present, the
    // engine renders bash/mcp/ask hints with ${VAR} substituted
    // against the same extract.values the ledger_tag resolved with
    // (agent-tasks/3804b785).
    const policyWithProducers: Policy = {
      ...REVIEW_POLICY,
      producers: [
        {
          kind: "mcp",
          verb: "mcp__grounding-mcp__ledger_add",
          example: '{type:"fact", content:"review:${PR_NUMBER}"}',
          description: "Persist the review verdict tagged with the PR number.",
        },
      ],
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([policyWithProducers]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("no matching ledger entry for tag `review:42`");
    expect(reason).toContain("To satisfy: record an evidence-ledger entry");
    expect(reason).toContain("To produce this tag:");
    expect(reason).toContain("1. [mcp]  mcp__grounding-mcp__ledger_add");
    expect(reason).toContain('example={type:"fact", content:"review:42"}');
    expect(reason).toContain(
      "Persist the review verdict tagged with the PR number.",
    );
    // Lock the assembled order: <policyName>: <reason>. <hintSuffix>
    // <producersBlock>. Structured consumers (or human readers
    // skimming) rely on the hint coming before the producer list.
    expect(reason.indexOf("To satisfy:")).toBeLessThan(
      reason.indexOf("To produce this tag:"),
    );
  });

  it("legacy neutral envelope is preserved when policy has no producers", async () => {
    // Backwards-compat: a policy without `producers:` keeps the
    // existing deny shape (recordHint only, no producer block).
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson?.reason).not.toContain("To produce this tag:");
  });
});

describe("intercept — agent-facing ux replaces engine vocabulary", () => {
  // The preflight-before-investigation reference scenario, end-to-end:
  // a Bash git-status with no preflight ledger entry triggers the
  // deny path. With `ux:` declared, the agent sees the plain-language
  // shape verbatim, with no "ledger entry for tag X" vocabulary leaking
  // through. The internal decision (reason, recordHint) is unchanged
  // and still recorded to the audit ledger (covered by the audit-log
  // describe block).
  const preflightPolicy: Policy = {
    name: "preflight-before-investigation",
    description: "block investigative git reads without a preflight",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "git (status|log|diff|branch)",
    },
    requires: { ledger_tag: "preflight:${REPO}", within: "1h" },
    hook: "h",
    enforcement: "block",
    ux: {
      cannot: "You cannot investigate this repository yet.",
      required: ["verified repository preflight"],
      run: ["harness preflight"],
    },
  } as Policy;

  const investigateEvent: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    session_id: "sess-1",
  };

  it("emits the verbatim agent-facing block on missing preflight", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([preflightPolicy]),
      event: investigateEvent,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    const expectedReason = [
      "You cannot investigate this repository yet.",
      "",
      "Required:",
      "- verified repository preflight",
      "",
      "Run:",
      "  harness preflight",
    ].join("\n");
    expect(result.blockJson?.reason).toBe(expectedReason);
    expect(result.blockJson?.hookSpecificOutput?.permissionDecisionReason).toBe(
      expectedReason,
    );
  });

  it("matches Codex exec_command shell events and reads cmd for bash_match", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([preflightPolicy]),
      event: {
        ...investigateEvent,
        tool_name: "exec_command",
        tool_input: { cmd: "git status" },
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.blockJson?.reason).toContain(
      "You cannot investigate this repository yet.",
    );
  });

  it("does not leak engine vocabulary (ledger / tag / matching) to the agent surface", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([preflightPolicy]),
      event: investigateEvent,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    const reason = result.blockJson?.reason ?? "";
    expect(reason).not.toMatch(/ledger/i);
    expect(reason).not.toMatch(/\btag\b/i);
    expect(reason).not.toMatch(/no matching/i);
    expect(reason).not.toMatch(/to satisfy:/i);
    expect(reason).not.toContain("preflight:harness");
    expect(reason).not.toContain("To produce this tag:");
  });

  it("keeps the engine-internal reason on the PolicyDecision (audit surface unchanged)", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([preflightPolicy]),
      event: investigateEvent,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    // Internal model is the audit truth: the decision still names the
    // tag, the reason, and the satisfaction hint. The ledger record()
    // call gets this same shape (covered by the audit-log describe).
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.decisions[0]?.ledgerTag).toBe("preflight:harness");
    expect(result.decisions[0]?.reason).toBe(
      "no matching ledger entry for tag `preflight:harness`",
    );
    expect(result.decisions[0]?.recordHint).toBe(
      "record an evidence-ledger entry containing `preflight:harness` within 1h",
    );
  });

  it("ux substitutes ${VAR} against extract values + builtins (BRANCH from builtins)", async () => {
    const pushPolicy: Policy = {
      ...preflightPolicy,
      name: "preflight-before-push",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: "git push" },
      requires: { ledger_tag: "preflight:${BRANCH}", within: "10m" },
      ux: {
        cannot: "You cannot push branch ${BRANCH} yet.",
        required: [
          "a fresh preflight for ${BRANCH} (within the last 10 minutes)",
        ],
        run: ["harness preflight"],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([pushPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson?.reason).toContain(
      "You cannot push branch master yet.",
    );
    expect(result.blockJson?.reason).toContain(
      "- a fresh preflight for master (within the last 10 minutes)",
    );
  });
});

describe("intercept — agent-facing ux for non-preflight policies (MCP-recipe run field)", () => {
  // Review / dogfood policies cannot point `run:` at a shell verb,
  // their satisfying action is an MCP ledger_add. The ux contract is
  // the same shape; the `run:` lines name the MCP verb instead. These
  // snapshots pin the verbatim form so future composer / template
  // edits cannot silently drift the agent-facing surface.

  it("review-before-merge: names the ledger_add recipe in run:", async () => {
    const reviewPolicy: Policy = {
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
      ux: {
        cannot: "You cannot merge PR #${PR_NUMBER} yet.",
        required: ["a recorded review of PR #${PR_NUMBER}"],
        run: [
          'mcp__grounding-mcp__ledger_add { type: "fact", content: "review:${PR_NUMBER} — <verdict + key findings + nits>" }',
        ],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([reviewPolicy]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson?.reason).toBe(
      [
        "You cannot merge PR #42 yet.",
        "",
        "Required:",
        "- a recorded review of PR #42",
        "",
        "Run:",
        '  mcp__grounding-mcp__ledger_add { type: "fact", content: "review:42 — <verdict + key findings + nits>" }',
      ].join("\n"),
    );
  });

  it("review-subagent-before-pr-create: substitutes TASK_ID into the ledger_add recipe", async () => {
    const reviewSubagentPolicy: Policy = {
      name: "review-subagent-before-pr-create",
      description: "block PR create without review-subagent evidence",
      trigger: {
        event: "PreToolUse",
        match: "mcp__agent-tasks__pull_requests_create",
        extract: { TASK_ID: "toolArgs.taskId" },
      },
      requires: { ledger_tag: "review-subagent:${TASK_ID}" },
      hook: "h",
      enforcement: "block",
      ux: {
        cannot: "You cannot open a pull request for task ${TASK_ID} yet.",
        required: ["a completed review-subagent pass on this task"],
        run: [
          'mcp__grounding-mcp__ledger_add { type: "fact", content: "review-subagent:${TASK_ID} — <verdict + key findings + nits>" }',
        ],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([reviewSubagentPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agent-tasks__pull_requests_create",
        tool_input: { taskId: "abc-123" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson?.reason).toBe(
      [
        "You cannot open a pull request for task abc-123 yet.",
        "",
        "Required:",
        "- a completed review-subagent pass on this task",
        "",
        "Run:",
        '  mcp__grounding-mcp__ledger_add { type: "fact", content: "review-subagent:abc-123 — <verdict + key findings + nits>" }',
      ].join("\n"),
    );
  });

  it("dogfood-before-release: substitutes SESSION_ID from builtins into the ledger_add recipe", async () => {
    const dogfoodPolicy: Policy = {
      name: "dogfood-before-release",
      description: "block release without dogfood evidence",
      trigger: {
        event: "PreToolUse",
        match: "Bash",
        bash_match: "npm publish",
      },
      requires: { ledger_tag: "dogfood:${SESSION_ID}", within: "24h" },
      hook: "h",
      enforcement: "block",
      ux: {
        cannot: "You cannot publish a release yet.",
        required: ["an end-to-end dogfood run in this session"],
        run: [
          'mcp__grounding-mcp__ledger_add { type: "fact", content: "dogfood:${SESSION_ID} — <end-to-end smoke summary>" }',
        ],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([dogfoodPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm publish" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson?.reason).toBe(
      [
        "You cannot publish a release yet.",
        "",
        "Required:",
        "- an end-to-end dogfood run in this session",
        "",
        "Run:",
        '  mcp__grounding-mcp__ledger_add { type: "fact", content: "dogfood:sess-1 — <end-to-end smoke summary>" }',
      ].join("\n"),
    );
  });
});

describe("intercept — non-PreToolUse deny shape", () => {
  it("omits hookSpecificOutput for non-PreToolUse events while still blocking", async () => {
    const promptPolicy: Policy = {
      ...REVIEW_POLICY,
      name: "block-bare-prompt",
      trigger: {
        event: "UserPromptSubmit",
        extract: { PR_NUMBER: "toolArgs.prNumber" },
      },
      requires: { ledger_tag: "review:${PR_NUMBER}" },
    };
    const promptEvent: ToolEvent = {
      hook_event_name: "UserPromptSubmit",
      tool_input: { prNumber: 7 },
      session_id: "sess-1",
    };
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([promptPolicy]),
      event: promptEvent,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).toEqual({
      decision: "block",
      reason:
        "block-bare-prompt: no matching ledger entry for tag `review:7`. " +
        "To satisfy: record an evidence-ledger entry containing `review:7`, " +
        "under this runtime session's id `sess-1` (not the agent-tasks task UUID).",
    });
    expect(result.blockJson?.hookSpecificOutput).toBeUndefined();
  });
});

describe("intercept — multiple policies, deny if any", () => {
  it("denies when one of two matching policies fails", async () => {
    const second: Policy = {
      ...REVIEW_POLICY,
      name: "two-reviewers-required",
      requires: { ledger_tag: "review:${PR_NUMBER}", count: { min: 2 } },
    };
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY, second]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.decisions[1]?.outcome).toBe("deny");
    expect(result.blockJson?.reason).toContain("two-reviewers-required");
    expect(result.blockJson?.reason).toContain("1 of required 2");
  });

  it("warn enforcement yields a `warn` outcome and does not block", async () => {
    // Phase 7 #5 four-way decision: a `warn`-enforcement policy whose
    // requires fails resolves to outcome `warn` (was `deny` in the
    // Phase 4 binary model). It still never blocks.
    const warnPolicy: Policy = { ...REVIEW_POLICY, enforcement: "warn" };
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([warnPolicy]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn");
    expect(result.blockJson).toBeNull();
  });
});

describe("intercept — non-matching trigger", () => {
  it("skips policies whose trigger.match does not match the tool name", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, tool_name: "Bash" },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blockJson).toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });

  it("skips policies whose trigger.event does not match", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, hook_event_name: "PostToolUse" },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
  });
});

describe("intercept — bash_match", () => {
  const dogfoodPolicy: Policy = policy({
    name: "dogfood-before-release",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "^npm publish",
    },
    requires: { ledger_tag: "dogfood:${SESSION_ID}", within: "24h" },
    hook: "h",
  });

  it("matches a bash command that fits the regex and denies on missing evidence", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([dogfoodPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm publish" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blockJson).not.toBeNull();
  });

  it("skips when bash command does not match", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([dogfoodPolicy]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
  });

  // Regression for task ec2336c1: the reference policy regexes were once
  // start-anchored (`^git push`), so `cd <repo> && git push`, `git -C <repo>
  // push`, and env-prefixed forms slipped past the gate entirely. These lock
  // the un-anchored, command-position match against both the bypass class
  // and the string-argument false-positive class (`git commit -m "...push"`).
  describe("command-position bash_match (ec2336c1 regression)", () => {
    const cases: Array<{
      policyName: string;
      bashMatch: string;
      shouldMatch: string[];
      shouldSkip: string[];
    }> = [
      {
        policyName: "preflight-before-push",
        bashMatch:
          "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
        shouldMatch: [
          "git push",
          "cd /home/lan/repo && git push",
          "git -C /home/lan/repo push",
          "GIT_TRACE=1 git push origin master",
        ],
        shouldSkip: [
          'git commit -m "remember to git push"',
          "echo git push",
          "legit pushups",
        ],
      },
      {
        policyName: "preflight-before-investigation",
        bashMatch:
          "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b",
        shouldMatch: [
          "git status",
          "cd /repo && git status --short",
          "git -C /repo log --oneline",
        ],
        shouldSkip: ['echo "git status"', "git stash", "git statusfoo"],
      },
      {
        policyName: "dogfood-before-release",
        bashMatch:
          "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*(npm publish\\b|git( -C \\S+)* tag v)",
        shouldMatch: [
          "npm publish",
          "cd /repo && git tag v0.10.0",
          "git tag v1.2.3",
        ],
        shouldSkip: ['echo "npm publish"', "npm publishx", "git tag -l"],
      },
    ];

    for (const c of cases) {
      const pol: Policy = policy({
        name: c.policyName,
        trigger: {
          event: "PreToolUse",
          match: "Bash",
          bash_match: c.bashMatch,
        },
        requires: { ledger_tag: "gate:${SESSION_ID}", within: "24h" },
        hook: "h",
      });
      for (const command of c.shouldMatch) {
        it(`${c.policyName}: matches ${JSON.stringify(command)}`, async () => {
          const result = await intercept({
            manifest: manifest([pol]),
            event: {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command },
              session_id: "sess-1",
            },
            ledger: makeLedger({ kind: "ok", entries: [] }),
            builtins: BUILTINS,
            now: NOW,
          });
          expect(result.decisions).toHaveLength(1);
          expect(result.decisions[0]?.outcome).toBe("deny");
        });
      }
      for (const command of c.shouldSkip) {
        it(`${c.policyName}: skips ${JSON.stringify(command)}`, async () => {
          const result = await intercept({
            manifest: manifest([pol]),
            event: {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command },
              session_id: "sess-1",
            },
            ledger: makeLedger({ kind: "ok", entries: [] }),
            builtins: BUILTINS,
            now: NOW,
          });
          expect(result.decisions).toHaveLength(0);
        });
      }
    }
  });
});

// Task f1aea826: the degraded family ("could not evaluate requires") is
// tier-aware. block/require_approval fail CLOSED (`deny-degraded`, blocks);
// warn keeps the availability-first `warn-degraded` (never blocks);
// `risk.degraded_fail_posture: fail_open` restores the old mapping for
// every tier. The pre-0.45 pins asserting warn-degraded-never-blocks for a
// block-enforcement policy were rewritten here deliberately, together with
// docs/risk-gate.md and docs/okf/gate-fail-posture-matrix.md.
describe("intercept — degraded ledger (fail posture per enforcement tier)", () => {
  it("block enforcement + degraded ledger fails CLOSED as deny-degraded", async () => {
    const ledger = makeLedger({
      kind: "degraded",
      reason: "grounding-mcp timeout after 1ms",
    });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny-degraded");
    expect(result.decisions[0]?.reason).toBe("grounding-mcp timeout after 1ms");
    expect(result.blockJson).not.toBeNull();
    // Degraded-specific envelope: names the unreadable evidence source
    // and the operator recovery path, and must NOT read like the
    // missing-evidence deny (no "To satisfy:" producer hint — producing
    // the tag cannot unblock an unreadable ledger). The fail_open
    // opt-out must be ABSENT from this agent-facing text (review
    // 2026-08-08, high finding: a deny that includes its own disable
    // recipe is not a gate); it lives on the stderr diagnostic only,
    // pinned in tests/runtime/intercept-cli.test.ts.
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("could not be read");
    expect(reason).toContain("grounding-mcp timeout after 1ms");
    expect(reason).toContain("Ask your operator");
    expect(reason).not.toContain("degraded_fail_posture");
    expect(reason).not.toContain("fail_open");
    expect(reason).not.toContain("To satisfy:");
    // The degraded decision is still submitted to the audit trail.
    expect(ledger.recordCalls).toEqual([
      { decisionName: "review-before-merge", sessionId: "sess-1" },
    ]);
  });

  it("require_approval enforcement + degraded ledger also fails CLOSED", async () => {
    const ledger = makeLedger({
      kind: "degraded",
      reason: "grounding-mcp timeout after 1ms",
    });
    const result = await intercept({
      manifest: manifest([{ ...REVIEW_POLICY, enforcement: "require_approval" } as Policy]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny-degraded");
    expect(result.blockJson).not.toBeNull();
  });

  it("warn enforcement + degraded ledger keeps the non-blocking warn-degraded", async () => {
    const ledger = makeLedger({
      kind: "degraded",
      reason: "grounding-mcp timeout after 1ms",
    });
    const result = await intercept({
      manifest: manifest([{ ...REVIEW_POLICY, enforcement: "warn" } as Policy]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.blockJson).toBeNull();
  });

  it("risk.degraded_fail_posture: fail_open restores the availability-first mapping for block tier", async () => {
    const ledger = makeLedger({
      kind: "degraded",
      reason: "grounding-mcp timeout after 1ms",
    });
    const result = await intercept({
      manifest: makeManifest({
        policies: [REVIEW_POLICY],
        degradedFailPosture: "fail_open",
      }),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.blockJson).toBeNull();
  });

  it("healthy ledger with satisfying evidence still allows (no fail-closed regression)", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.blockJson).toBeNull();
  });

  it("deny-degraded envelope takes precedence over the policy's ux: surface", async () => {
    // The operator-curated ux text describes the MISSING-evidence case
    // ("run the producer, then retry"), which is misleading when the
    // evidence could not be READ. Swapping the branch order in
    // intercept()'s envelope construction must turn this red (the
    // review 2026-08-08 found the precedence entirely unpinned).
    const uxPolicy: Policy = {
      ...REVIEW_POLICY,
      ux: {
        cannot: "You cannot merge this PR yet.",
        required: ["a review entry for this PR"],
        run: ["harness record review --pr ${PR_NUMBER}"],
      },
    } as Policy;
    const ledger = makeLedger({
      kind: "degraded",
      reason: "grounding-mcp timeout after 1ms",
    });
    const result = await intercept({
      manifest: manifest([uxPolicy]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny-degraded");
    const reason = result.blockJson?.reason ?? "";
    expect(reason).toContain("could not be read");
    expect(reason).not.toContain("You cannot merge this PR yet.");
    expect(reason).not.toContain("harness record review");
  });

  it("bounds and strips the transport reason in the envelope (untrusted subprocess output)", async () => {
    // exitDiagnostic appends the grounding-mcp child's last stderr line
    // to the degraded reason; that string is untrusted and now reaches
    // model-visible text for the first time. The envelope interpolation
    // is bounded to 200 chars and control characters collapse to a
    // space; the decision's own reason keeps the raw string for the
    // audit row and stderr diagnostic. (Control chars are built via
    // fromCharCode so this test file itself stays free of raw bytes.)
    // Boundary chars of the sanitiser's class: NUL (0x00) and US (0x1F)
    // bound the C0 range, DEL (0x7F) is the lone high member; an
    // off-by-one in the fromCharCode-built range would ship green
    // without them (review 2026-08-08, round 2).
    const bell = String.fromCharCode(7);
    const newline = String.fromCharCode(10);
    const nul = String.fromCharCode(0);
    const us = String.fromCharCode(31);
    const del = String.fromCharCode(127);
    const noisy = `spawn failed: bell${bell}${newline}line2${nul}${us}${del}x ${"x".repeat(400)}`;
    const ledger = makeLedger({ kind: "degraded", reason: noisy });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.reason).toBe(noisy);
    const reason = result.blockJson?.reason ?? "";
    expect(reason).not.toContain(bell);
    expect(reason).not.toContain(newline);
    expect(reason).not.toContain(nul);
    expect(reason).not.toContain(us);
    expect(reason).not.toContain(del);
    // The three adjacent boundary controls collapse to ONE space.
    expect(reason).toContain("spawn failed: bell line2 x");
    expect(reason).not.toContain("x".repeat(201));
  });
});

describe("intercept — unresolved template variables", () => {
  it("fails CLOSED as deny-degraded for block enforcement when an extract source is missing", async () => {
    // Same tier-aware family as the degraded-ledger case: an event that
    // matches the trigger but defeats extraction must not slip past a
    // block-tier gate (task f1aea826).
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, tool_input: {} }, // no prNumber
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny-degraded");
    expect(result.decisions[0]?.reason).toContain("PR_NUMBER");
    expect(result.blockJson).not.toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });

  it("stays non-blocking warn-degraded for warn enforcement", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([{ ...REVIEW_POLICY, enforcement: "warn" } as Policy]),
      event: { ...MERGE_EVENT, tool_input: {} },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.blockJson).toBeNull();
  });
});

// Bash-surface parallels of the MCP review policies (task 7eed0bb2 / V3).
// A PolicyTrigger can only AND-match one surface (MCP tool-name OR Bash
// command), so the full template ships two parallel policies per PR
// surface; the tag shape switches from PR_NUMBER/TASK_ID (extractable from
// MCP toolArgs) to BRANCH (a builtin) on the Bash side. These tests pin
// the matcher behaviour for both new policies + a negative case so an
// unrelated Bash command does not vacuously trip the gate.
describe("intercept — review-before-merge-bash (gh pr merge surface)", () => {
  const POLICY: Policy = {
    name: "review-before-merge-bash",
    description: "block `gh pr merge` without review evidence",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b",
    },
    requires: { ledger_tag: "review:${BRANCH}" },
    hook: "h",
    enforcement: "block",
  } as Policy;
  const EVENT: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr merge 42 --squash" },
    session_id: "sess-1",
  };

  it("blocks when the ledger has no review:<branch> entry", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([POLICY]),
      event: EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.decisions[0]?.ledgerTag).toBe("review:master");
    expect(ledger.queryCalls).toEqual([
      { tag: "review:master", sessionId: "sess-1" },
    ]);
  });

  it("allows when the ledger carries a matching review:<branch> entry", async () => {
    const branchEntry: LedgerEntry = {
      id: "br-1",
      content: "review:master — approved (no findings)",
      createdAt: NOW.toISOString(),
    };
    const ledger = makeLedger({ kind: "ok", entries: [branchEntry] });
    const result = await intercept({
      manifest: manifest([POLICY]),
      event: EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).toBeNull();
    expect(result.decisions[0]?.outcome).toBe("allow");
  });

  it("does not trip on unrelated Bash commands (e.g. `git status`)", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([POLICY]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blockJson).toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });
});

describe("intercept — review-subagent-before-pr-create-bash (gh pr create surface)", () => {
  const POLICY: Policy = {
    name: "review-subagent-before-pr-create-bash",
    description: "block `gh pr create` without review-subagent evidence",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "(^|\\n|;|\\||&&|\\()\\s*(\\w+=\\S+\\s+)*gh pr create\\b",
    },
    requires: { ledger_tag: "review-subagent:${BRANCH}" },
    hook: "h",
    enforcement: "block",
  } as Policy;
  const EVENT: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr create --fill" },
    session_id: "sess-1",
  };

  it("blocks when the ledger has no review-subagent:<branch> entry", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([POLICY]),
      event: EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.decisions[0]?.ledgerTag).toBe("review-subagent:master");
    expect(ledger.queryCalls).toEqual([
      { tag: "review-subagent:master", sessionId: "sess-1" },
    ]);
  });

  it("allows when the ledger carries a matching review-subagent:<branch> entry", async () => {
    const branchEntry: LedgerEntry = {
      id: "br-2",
      content: "review-subagent:master — approved",
      createdAt: NOW.toISOString(),
    };
    const ledger = makeLedger({ kind: "ok", entries: [branchEntry] });
    const result = await intercept({
      manifest: manifest([POLICY]),
      event: EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).toBeNull();
    expect(result.decisions[0]?.outcome).toBe("allow");
  });

  it("does not trip on unrelated Bash commands (e.g. `gh repo view`)", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([POLICY]),
      event: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh repo view" },
        session_id: "sess-1",
      },
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blockJson).toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });
});

describe("intercept — audit log", () => {
  it("records one ledger entry per matching policy", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [matchingEntry] });
    const second: Policy = { ...REVIEW_POLICY, name: "second" };
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY, second]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(2);
    expect(ledger.recordCalls).toHaveLength(2);
    expect(ledger.recordCalls[0]?.decisionName).toBe("review-before-merge");
    expect(ledger.recordCalls[1]?.decisionName).toBe("second");
  });

  it("emits a stderr diagnostic and does not crash if audit-write throws", async () => {
    const chunks: string[] = [];
    const err = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString("utf8"));
        cb();
      },
    });
    const ledger: LedgerClient = {
      async query() {
        return { kind: "ok", entries: [] };
      },
      async record() {
        throw new Error("ledger_add failed");
      },
    };
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      stderr: err,
    });
    // Fail-open: the decision is still applied even though the write failed.
    expect(result).toBeDefined();
    // The failure must now be loud: a diagnostic goes to stderr.
    const text = chunks.join("");
    expect(text).toContain(
      "harness runtime intercept: audit-write failed for review-before-merge",
    );
    expect(text).toContain("ledger_add failed");
  });
});

// ---------------------------------------------------------------------------
// Phase 7 #5 — `policy.when:` evaluation + the four-way decision space.
// ---------------------------------------------------------------------------

const BASH_DESTROY_EVENT: ToolEvent = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "terraform destroy" },
  session_id: "sess-1",
  cwd: "/tmp/proj",
};

const DESTROY_CLASSIFIER: RiskClassifier = {
  name: "dangerous-shell",
  tool: "Bash",
  patterns: [
    {
      pattern: "terraform\\s+destroy",
      categories: ["destructive", "infrastructure_change"],
      severity: "critical",
    },
  ],
};

const PROD_RESOLVER: EnvironmentResolver = {
  name: "production-signals",
  environment: "production",
  signals: { branch_patterns: ["main"] },
};

// gate-prod-destructive — the canonical risk policy shape from
// docs/risk-gate.md. `enforcement: require_approval` so a failed
// `requires` resolves to the new `require_approval` outcome.
const RISK_POLICY: Policy = {
  name: "gate-prod-destructive",
  description: "require approval for destructive production actions",
  trigger: { event: "PreToolUse", match: "Bash" },
  when: {
    "risk.severity_at_least": "high",
    "environment.name": "production",
  },
  requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
  hook: "h",
  enforcement: "require_approval",
} as Policy;

const riskCtx = (branch: string): RiskGateContext => ({
  git: { repo: "proj", branch, sha: "" },
  cwd: "/tmp/proj",
  user: "tester",
  host: "testhost",
  env: {},
  kubeContext: "",
  kubeNamespace: "",
});

describe("intercept — Phase 7 #5 when: evaluation", () => {
  it("fires a when: policy only when trigger AND when both hold", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [RISK_POLICY],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.policyName).toBe("gate-prod-destructive");
    // Risk Gate verdicts ride along on the decision for the audit trail.
    expect(result.decisions[0]?.risk?.severity).toBe("critical");
    expect(result.decisions[0]?.environment?.name).toBe("production");
  });

  it("does NOT fire when the when: environment clause fails", async () => {
    // Branch `feature/x` matches no resolver → environment `unknown` →
    // the `environment.name: production` clause fails → policy is not in
    // the matching set at all, so it records no decision.
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [RISK_POLICY],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("feature/x"),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blockJson).toBeNull();
  });

  it("fires fail-closed when the manifest declares no classifiers (unknown is not safe)", async () => {
    // No classifier → action is unclassified → `severity_at_least`
    // matches by the unknown-is-not-safe rule; the environment clause
    // still holds (branch `main`), so the policy fires.
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [RISK_POLICY],
        resolvers: [PROD_RESOLVER],
      }),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.risk?.classified).toBe(false);
  });

  it("a no-when: policy is unaffected and carries no risk/environment", async () => {
    // The manifest has no `when:`-bearing policy → the Risk Gate is
    // inactive → decisions are byte-identical to Phase 4 (no `risk` /
    // `environment` fields).
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.risk).toBeUndefined();
    expect(result.decisions[0]?.environment).toBeUndefined();
  });
});

describe("intercept — Phase 7 #5 four-way decision", () => {
  const fullManifest = () =>
    makeManifest({
      policies: [RISK_POLICY],
      classifiers: [DESTROY_CLASSIFIER],
      resolvers: [PROD_RESOLVER],
    });

  it("require_approval enforcement yields a require_approval outcome AND blocks (Phase 7 #6)", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: fullManifest(),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions[0]?.outcome).toBe("require_approval");
    // Phase 7 #6 makes the Risk Gate authoritative: require_approval
    // aborts the tool call until the approval tag exists.
    expect(result.blockJson?.decision).toBe("block");
  });

  it("require_approval resolves to allow once the approval tag is on record", async () => {
    const approval: LedgerEntry = {
      id: "a1",
      content: "risk-approved:sess-1",
      createdAt: NOW.toISOString(),
    };
    const ledger = makeLedger({ kind: "ok", entries: [approval] });
    const result = await intercept({
      manifest: fullManifest(),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions[0]?.outcome).toBe("allow");
    expect(result.blockJson).toBeNull();
  });

  it("block enforcement still denies and blocks when a when: policy's requires fails", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [{ ...RISK_POLICY, enforcement: "block" } as Policy],
        classifiers: [DESTROY_CLASSIFIER],
        resolvers: [PROD_RESOLVER],
      }),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blockJson?.decision).toBe("block");
  });
});

describe("intercept — operator_only unconditional deny (task 2cc73f55)", () => {
  // Schema contract: operator_only: true carries NO requires: (schema's
  // superRefine forbids the combination), so `makePolicy` is called
  // without a `requires` override — this exercises the exact shape
  // `parseManifest` accepts.
  const OPERATOR_ONLY_POLICY: Policy = policy({
    name: "operator-only-deny",
    description: "unconditional operator-only deny",
    trigger: { event: "PreToolUse", match: "Bash" },
    hook: "h",
    enforcement: "block",
    operator_only: true,
  });

  const OPERATOR_ONLY_EVENT: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
    session_id: "sess-1",
  };

  it("denies on an empty ledger and never queries it", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([OPERATOR_ONLY_POLICY]),
      event: OPERATOR_ONLY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.blockJson).not.toBeNull();
    expect(result.blockJson?.decision).toBe("block");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.decisions[0]?.enforcement).toBe("block");
    // The load-bearing property: intercept() never even asks the ledger
    // a question for this policy, so no ledger content — forged or real
    // — can ever be the reason it allowed.
    expect(ledger.queryCalls).toEqual([]);
  });

  it("FORGE-ALL-SIGNALS: no in-session ledger evidence flips the outcome to allow", async () => {
    // Every shape of "evidence" an agent might try to plant, in one
    // ledger, on ONE fire: an exact-content match against a plausible
    // tag, an operator-source spoof, a head-matching token, a replayed
    // policy_decision row claiming a prior allow, and inert noise.
    const forged: LedgerEntry[] = [
      {
        id: "f1",
        content: "operator-only-deny satisfied: sess-1",
        createdAt: NOW.toISOString(),
      },
      {
        id: "f2",
        content: "operator-ran-this-outside-the-session:sess-1",
        source: "operator",
        createdAt: NOW.toISOString(),
      },
      {
        id: "f3",
        content: "operator-ran-this-outside-the-session:sess-1 head:deadbeef",
        createdAt: NOW.toISOString(),
      },
      {
        id: "f4",
        type: "policy_decision",
        content:
          'policy_decision:operator-only-deny:allow {"name":"operator-only-deny","outcome":"allow"}',
        createdAt: NOW.toISOString(),
      },
    ];
    const ledger = makeLedger({ kind: "ok", entries: forged });
    const result = await intercept({
      manifest: manifest([OPERATOR_ONLY_POLICY]),
      event: OPERATOR_ONLY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      currentHeadSha: "deadbeef",
    });
    expect(result.blockJson).not.toBeNull();
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(ledger.queryCalls).toEqual([]);
  });

  it("does not record a ledgerTag that could later be confused with a real evidence tag", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([OPERATOR_ONLY_POLICY]),
      event: OPERATOR_ONLY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.ledgerTag).toMatch(/operator-only/i);
  });

  it("existing requires-carrying block policies are unaffected (byte-identical outcome)", async () => {
    // Mutation guard: proves the operator_only branch is additive — a
    // normal policy without operator_only still goes through the full
    // requires pipeline (ledger IS queried) exactly as before.
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(ledger.queryCalls).toEqual([{ tag: "review:42", sessionId: "sess-1" }]);
  });

  it("schema-invariant-violated defensive branch: block tier degrades to deny-degraded, not a crash and not an allow", async () => {
    // Unreachable through `parseManifest` (the schema's superRefine
    // requires one or the other), but a hand-built Policy object (a test
    // double, a manifest loaded via a bypassed/legacy code path) could
    // still reach `intercept()` in this shape. Must degrade loudly, not
    // throw — and since task f1aea826 a block-tier policy in this state
    // fails CLOSED (`deny-degraded`), observably distinct from a
    // deliberate `operator_only` deny in every audit row and envelope.
    const noContractPolicy: Policy = policy({
      name: "no-contract",
      description: "neither requires nor operator_only",
      trigger: { event: "PreToolUse", match: "Bash" },
      hook: "h",
      enforcement: "block",
    });
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([noContractPolicy]),
      event: OPERATOR_ONLY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("deny-degraded");
    expect(result.decisions[0]?.reason).toMatch(/schema invariant violated/);
    expect(result.blockJson).not.toBeNull();
    expect(ledger.queryCalls).toEqual([]);
  });
});

describe("intercept — audit-write failure is surfaced, not swallowed", () => {
  // A ledger whose record() throws simulates a persistently-failing
  // grounding-mcp writer. The decision must still be applied (fail-open
  // invariant) and the error must appear on the injected stderr stream
  // so operators can diagnose a silently-broken audit trail.

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

  const throwingLedger: LedgerClient = {
    async query() {
      return { kind: "ok", entries: [] };
    },
    async record() {
      throw new Error("grounding-mcp: connection refused");
    },
  };

  it("emits a stderr diagnostic when ledger.record() throws", async () => {
    const { stream: err, output: errOutput } = captureStream();
    await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger: throwingLedger,
      builtins: BUILTINS,
      now: NOW,
      stderr: err,
    });
    const text = errOutput();
    expect(text).toContain(
      "harness runtime intercept: audit-write failed for review-before-merge",
    );
    expect(text).toContain("grounding-mcp: connection refused");
  });

  it("still applies the decision (fail-open) when ledger.record() throws", async () => {
    const { stream: err } = captureStream();
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger: throwingLedger,
      builtins: BUILTINS,
      now: NOW,
      stderr: err,
    });
    // The deny decision must still be present: the gate decision is
    // unaffected by the audit-write failure.
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny");
    expect(result.blockJson).not.toBeNull();
  });
});

// M7: whenUnclassifiedFallback — audit record + block-message distinction.
// ---------------------------------------------------------------------------
//
// Verifies that:
//   1. An unclassified action against a risk-gating policy yields
//      `whenUnclassifiedFallback === true` on the decision and the
//      unclassified clause in the deny message.
//   2. A classified action that genuinely matches has the field absent
//      and the clause absent from the deny message.
//   3. A no-when: policy (Phase 4 shape) is unaffected regardless.
//
// Mutation guards are noted per test.

describe("intercept — M7 whenUnclassifiedFallback flag", () => {
  // A minimal policy with a risk.severity_at_least clause but no
  // environment.name scope. For these tests we use `block` enforcement
  // so the deny message is the neutral (non-ux) path we want to inspect.
  const RISK_BLOCK_POLICY: Policy = {
    name: "gate-risk-unscoped",
    description: "test policy for unclassified fallback coverage",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: {
      "risk.severity_at_least": "high",
    },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "h",
    enforcement: "block",
  } as Policy;

  const BASH_UNKNOWN_EVENT: ToolEvent = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "some-unknown-command --flag" },
    session_id: "sess-1",
    cwd: "/tmp/proj",
  };

  it("sets whenUnclassifiedFallback=true and inserts the clause (before hintSuffix) when the action is unclassified", async () => {
    // No classifiers → action is unclassified → fail-close rule fires.
    // Mutation guard: remove the `whenFallbackMap.set` call in intercept.ts
    // or the `whenUnclassifiedFallback: true` spread and this test goes red
    // (the field will be absent and the message will not contain the clause).
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({ policies: [RISK_BLOCK_POLICY] }),
      event: BASH_UNKNOWN_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBe(true);
    // The deny message must contain the unclassified clause.
    expect(result.blockJson?.reason).toContain(
      "(matched via the fail-closed unclassified rule, not a real risk classification)",
    );
  });

  it("does NOT set whenUnclassifiedFallback and does NOT append the clause for a real classification hit", async () => {
    // The DESTROY_CLASSIFIER matches `terraform destroy` with critical
    // severity, so the risk clause matches on a genuine classification,
    // not the fail-closed rule.
    // Mutation guard: removing the `...base` spread from the decision
    // build (so the field is always absent) would pass this test, but the
    // previous test would fail because the decision would then lack the
    // field for the unclassified case too.
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [RISK_BLOCK_POLICY],
        classifiers: [DESTROY_CLASSIFIER],
      }),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions).toHaveLength(1);
    // A real classification hit: field must be absent (not false, absent).
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBeUndefined();
    // The deny message must NOT contain the unclassified clause.
    expect(result.blockJson?.reason).not.toContain(
      "matched via the fail-closed unclassified rule",
    );
  });

  it("does not set whenUnclassifiedFallback on a no-when: policy (Phase 4 shape stays byte-identical)", async () => {
    // Mutation guard: adding an unconditional `whenUnclassifiedFallback: false`
    // to every decision would break this test (field would be present).
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBeUndefined();
  });

  it("ux-path (task 2929c5b7): records whenUnclassifiedFallback=true on the audit decision AND prepends a fallback-specific sentence to the ux agent-facing reason, without altering the operator's own cannot: text", async () => {
    // A policy with `ux:` uses the operator-curated plain-language surface.
    // Pre-2929c5b7 this surface was left untouched even for a fail-closed
    // unclassified match — the exact bug this task exists to fix
    // (gate-prod-destructive's "critical destructive action" wording shown
    // verbatim for an unrecognized READ the moment environment resolved to
    // production). Now: the unclassifiedFallback flag still rides the
    // decision record (audit + explain --trace can replay it), AND the
    // block message is prefixed with a sentence naming the real cause,
    // while the operator's own `cannot:` text is still present, unaltered.
    // Mutation guard: removing the fallback-specific prefix logic in
    // intercept.ts's ux branch makes the "unclassified action in a
    // production context" assertion below go red.
    const uxPolicy: Policy = {
      ...RISK_BLOCK_POLICY,
      name: "gate-risk-unscoped-ux",
      ux: {
        cannot: "You cannot run unrecognised commands here.",
        required: ["explicit operator approval"],
        run: ["harness approve risk"],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      // The production resolver is what makes AC2's exact phrase
      // ("in a production context") the right assertion here: the prefix
      // interpolates the RESOLVED environment, so a manifest with no
      // resolver would legitimately say "unknown" instead (pinned by the
      // round-3 sibling test below).
      manifest: makeManifest({ policies: [uxPolicy], resolvers: [PROD_RESOLVER] }),
      event: BASH_UNKNOWN_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    // The decision record must carry the flag.
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBe(true);
    expect(result.decisions[0]?.environment?.name).toBe("production");
    // The agent-facing reason must NOT contain the non-ux engine-vocabulary
    // clause (that wording is reserved for the non-ux path).
    expect(result.blockJson?.reason).not.toContain(
      "matched via the fail-closed unclassified rule",
    );
    // AC2: the fallback-specific reason names the real cause.
    expect(result.blockJson?.reason).toContain(
      "unclassified action in a production context",
    );
    // The operator's own cannot: text is still present, unaltered.
    expect(result.blockJson?.reason).toContain(
      "You cannot run unrecognised commands here.",
    );
  });

  it("ux-path: a genuine classification hit renders the operator's cannot: text with NO fallback prefix", async () => {
    // Negative control for the test above: when the risk clause matches a
    // REAL classification (not the fallback), the ux text is rendered
    // exactly as the operator wrote it, with no "unclassified action in a
    // production context" prefix — that phrase is reserved for a genuine
    // fallback deny (AC2: "Explicitly classified critical actions keep the
    // existing wording").
    const uxPolicy: Policy = {
      ...RISK_BLOCK_POLICY,
      name: "gate-risk-unscoped-ux-classified",
      ux: {
        cannot: "You cannot run this critical destructive action against production.",
        required: ["explicit operator approval"],
        run: ["harness approve risk"],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [uxPolicy],
        classifiers: [DESTROY_CLASSIFIER],
      }),
      event: BASH_DESTROY_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBeUndefined();
    expect(result.blockJson?.reason).not.toContain(
      "unclassified action in a production context",
    );
    // No prefix: the operator's cannot: text is the FIRST thing rendered.
    expect(result.blockJson?.reason?.startsWith(
      "You cannot run this critical destructive action against production.",
    )).toBe(true);
  });

  it("ux-path (round 3): the fallback prefix names the RESOLVED environment and the policy's OWN threshold, not a hard-coded production/critical", async () => {
    // Round-2 shipped this prefix with "production" and "critical"
    // hard-coded, so an unscoped `severity_at_least: high` policy on a
    // feature branch (environment resolves to `unknown`, threshold is
    // `high`) emitted two false halves at once. Both are interpolated now.
    //
    // Mutation guard: restore either literal in
    // `unclassifiedFallbackPrefix` (src/runtime/intercept.ts) and the
    // corresponding assertion below goes red.
    const uxPolicy: Policy = {
      ...RISK_BLOCK_POLICY,
      name: "gate-risk-unscoped-ux-high",
      ux: {
        cannot: "You cannot run this action yet.",
        required: ["operator approval"],
        run: ["harness approve risk"],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      // No resolvers at all, and a feature branch: the environment
      // resolves to the matchable `unknown`, never `production`.
      manifest: makeManifest({ policies: [uxPolicy] }),
      event: BASH_UNKNOWN_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("feature/x"),
    });
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBe(true);
    expect(result.decisions[0]?.environment?.name).toBe("unknown");
    const reason = result.blockJson?.reason ?? "";
    // The resolved environment, with the correct article.
    expect(reason).toContain("unclassified action in an unknown context");
    expect(reason).not.toContain("in a production context");
    // The policy's OWN declared threshold, and the fallback rung.
    expect(reason).toContain("(treated as high) satisfied this policy's severity_at_least: high");
    expect(reason).not.toContain("critical-severity match");
    // The operator's own text is still appended, unaltered.
    expect(reason).toContain("You cannot run this action yet.");
  });
});

// Task 2929c5b7 — end-to-end AC1/AC2 coverage against the REAL shipped
// gate-prod-destructive policy shape and the REAL shipped
// risk.classifiers[] (docs/examples/full-manifest.yaml), not a hand-
// trimmed local fixture. Loading the real classifier list means a
// reviewer's mutation probe (delete the `dd` pattern, delete the `cat`
// floor) exercises the actual shipped config, not a copy that could
// silently drift from it.
describe("intercept — task 2929c5b7: gate-prod-destructive unclassified-fallback fix", () => {
  const REAL_MANIFEST_PATH = path.join(REPO_ROOT, "docs", "examples", "full-manifest.yaml");

  function realClassifiers(): RiskClassifier[] {
    const raw = fs.readFileSync(REAL_MANIFEST_PATH, "utf8");
    return parseManifest(parseYaml(raw)).risk.classifiers;
  }

  // Mirrors the shipped gate-prod-destructive policy's `when:` /
  // `enforcement:` exactly (docs/examples/full-manifest.yaml,
  // src/cli/init/templates.ts): severity_at_least critical + production,
  // hard block.
  const GATE_PROD_DESTRUCTIVE_CRITICAL: Policy = {
    name: "gate-prod-destructive",
    description: "deny critical-severity destructive shell actions against a production target",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: {
      "risk.severity_at_least": "critical",
      "environment.name": "production",
    },
    requires: { ledger_tag: "risk-override:${SESSION_ID}" },
    hook: "risk-gate",
    enforcement: "block",
  } as Policy;

  const bashEvent = (command: string): ToolEvent => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    session_id: "sess-1",
    cwd: "/tmp/proj",
  });

  async function runInProdCwd(command: string) {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    return intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE_CRITICAL],
        classifiers: realClassifiers(),
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent(command),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
  }

  const ENVELOPE_CTX: EnvelopeContext = {
    cwd: "/tmp/proj",
    git: { repo: "proj", branch: "main", sha: "" },
    user: "agent",
    host: "host",
    now: NOW,
  };

  // AC1: these six commands must NOT be denied by gate-prod-destructive
  // in a production cwd — the exact false-positive shape from the
  // 2026-09-01 incident (four consecutive read-only investigation
  // commands denied until the cwd was moved out of the repo).
  //
  // Each case asserts TWO things, deliberately: (1) `intercept()`
  // end-to-end does not deny it, AND (2) the Risk Classifier explicitly
  // recognizes it as `low` severity. (2) is the discriminating half —
  // without it, deleting the `cat` floor from read-only-bash.ts would
  // NOT fail (1): a `cat` that falls all the way to fully unclassified
  // is ALSO not denied by the critical-threshold gate now, since prong
  // (b) alone (unclassified no longer satisfies severity_at_least:
  // critical) already covers that case. Asserting the real `low`
  // classification is what actually exercises prong (a) — the explicit
  // read-only floor — and fails when it's removed.
  it.each([
    ["cat", "cat notes/memory.md"],
    ["sed -n", "sed -n '1,20p' notes/memory.md"],
    ["grep", "grep TODO notes/memory.md"],
    ["curl (no -X/-d)", "curl https://api.example.com/status"],
  ])("does NOT deny %s in a production cwd, and it is explicitly classified `low`, not merely unclassified", async (_label, command) => {
    const result = await runInProdCwd(command);
    expect(result.blockJson).toBeNull();

    const envelope = buildActionEnvelope(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as ToolEvent,
      ENVELOPE_CTX,
    );
    const risk = classifyRisk(envelope, realClassifiers());
    expect(risk.classified).toBe(true);
    expect(risk.severity).toBe("low");
  });

  // D-011 (fix round 2): `ssh <host> <cmd>` and `node -e`/`--eval` do NOT
  // get an explicit `low` floor. The local head cannot see the remote
  // command or the eval'd code, so a `low` floor there would remove Risk
  // Gate coverage entirely for those shapes (neither `severity_at_least:
  // critical` nor `severity_at_least: high` fires on a `low` action).
  // Instead they stay genuinely unclassified and ride prong (b)'s fallback:
  // not hard-denied by the critical gate, but still approval-gated by the
  // high-severity gate. Mutation probe A (re-add a `low` floor for ssh):
  // this test's `classified: false` assertion goes red. Mutation probe B
  // (restore old when-eval.ts fallback semantics, unclassified satisfies
  // every severity_at_least): the "not denied by gate-prod-destructive"
  // assertion below goes red.
  it.each([
    ["ssh <host> <cmd>", 'ssh prod-host "cat /etc/hosts"'],
    ["node -e", "node -e \"console.log(1+1)\""],
  ])("%s stays unclassified: NOT denied by gate-prod-destructive (critical), but IS approval-gated by gate-prod-destructive-approval (high) via the fallback", async (_label, command) => {
    const envelope = buildActionEnvelope(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as ToolEvent,
      ENVELOPE_CTX,
    );
    const risk = classifyRisk(envelope, realClassifiers());
    expect(risk.classified).toBe(false);
    expect(risk.severity).toBeNull();

    const critical = await runInProdCwd(command);
    expect(critical.blockJson).toBeNull();

    const ledger = makeLedger({ kind: "ok", entries: [] });
    const approval = await intercept({
      manifest: makeManifest({
        policies: [
          {
            name: "gate-prod-destructive-approval",
            description:
              "require operator approval for high-severity destructive shell actions against a production target",
            trigger: { event: "PreToolUse", match: "Bash" },
            when: {
              "risk.severity_at_least": "high",
              "environment.name": "production",
            },
            requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
            hook: "risk-gate",
            enforcement: "require_approval",
          } as Policy,
        ],
        classifiers: realClassifiers(),
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent(command),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(approval.blockJson).not.toBeNull();
    // Denied via the fallback, not a real pattern match.
    expect(approval.decisions[0]?.whenUnclassifiedFallback).toBe(true);
  });

  // Prong (b) itself, directly: a command NO classifier pattern
  // reasons about at all (genuinely unclassified, not floored low by
  // any built-in floor either) must NOT be denied by the
  // critical-threshold gate-prod-destructive — this is the core
  // when-eval.ts change (unclassified no longer satisfies
  // severity_at_least: critical on its own). Mutation probe target:
  // restore the old fallback semantics in when-eval.ts (unclassified
  // matches EVERY severity_at_least threshold) and this test goes red.
  it("does NOT deny a genuinely unclassified command via gate-prod-destructive (critical) — prong (b)", async () => {
    const command = "some-unrecognized-admin-tool --flag";
    const envelope = buildActionEnvelope(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as ToolEvent,
      ENVELOPE_CTX,
    );
    // Confirm the premise: genuinely unclassified, not floored.
    expect(classifyRisk(envelope, realClassifiers()).classified).toBe(false);

    const result = await runInProdCwd(command);
    expect(result.blockJson).toBeNull();
  });

  // AC1's negative control: a genuinely destructive command must still
  // be denied — the floor/fallback change must not weaken this gate.
  it("STILL denies `rm -rf /x` in a production cwd", async () => {
    const result = await runInProdCwd("rm -rf /x");
    expect(result.blockJson).not.toBeNull();
    expect(result.decisions[0]?.policyName).toBe("gate-prod-destructive");
    expect(result.decisions[0]?.risk?.severity).toBe("critical");
  });

  // Anti-bypass coverage, critical tier: these mutating heads must stay
  // classified `critical` (not just risk-bearing) so the loosened
  // fallback cannot slip them past gate-prod-destructive's hard block.
  // Mutation probe target: delete one of these patterns from
  // docs/examples/full-manifest.yaml's dangerous-shell classifier and
  // the matching case below goes green->red (denied becomes
  // not-denied — an unclassified action no longer satisfies
  // severity_at_least: critical on its own).
  it.each([
    ["dd", "dd if=/dev/zero of=/dev/sda"],
    ["truncate", "truncate -s 0 /var/log/app.log"],
    ["shred", "shred -u secret.txt"],
    ["mkfs", "mkfs.ext4 /dev/sdb1"],
    ["find -delete", "find /var/www -name '*.php' -delete"],
    ["find -exec rm", "find /var/www -exec rm {} \\;"],
  ])("STILL denies %s in a production cwd via gate-prod-destructive (critical, explicit classification)", async (_label, command) => {
    const result = await runInProdCwd(command);
    expect(result.blockJson).not.toBeNull();
    expect(result.decisions[0]?.risk?.classified).toBe(true);
    expect(result.decisions[0]?.risk?.severity).toBe("critical");
  });

  // Anti-bypass coverage, high tier: these mutating heads are classified
  // `high`, one rung below the tier above — gate-prod-destructive
  // (critical) correctly does NOT fire on them (matches AC1's own scope:
  // it only pins the six read-only heads against the critical
  // threshold), but they must still be a REAL classification (not
  // merely risk-bearing via the fallback) so an operator can see and
  // tighten a specific pattern's severity if a given deployment wants
  // these hard-blocked too. Verified against the real
  // gate-prod-destructive-approval shape (severity_at_least: high,
  // require_approval) — still blocks execution until approved.
  const GATE_PROD_DESTRUCTIVE_APPROVAL_FOR_TEST: Policy = {
    name: "gate-prod-destructive-approval",
    description: "require operator approval for high-severity destructive shell actions against a production target",
    trigger: { event: "PreToolUse", match: "Bash" },
    when: {
      "risk.severity_at_least": "high",
      "environment.name": "production",
    },
    requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
    hook: "risk-gate",
    enforcement: "require_approval",
  } as Policy;
  it.each([
    ["git reset --hard", "git reset --hard HEAD~3"],
    ["git push --force", "git push --force origin main"],
    ["git clean -f", "git clean -fd"],
    ["git checkout -- .", "git checkout -- ."],
    ["git restore .", "git restore ."],
    ["chmod -R", "chmod -R 777 /var/www"],
    ["chown -R", "chown -R www-data:www-data /var/www"],
    ["curl -X POST", "curl -X POST https://api.example.com/deploy"],
    ["curl -d", "curl -d @payload.json https://api.example.com/deploy"],
    ["sed -i", "sed -i 's/a/b/' /etc/config"],
  ])("does NOT hard-deny %s via gate-prod-destructive (correctly high, not critical), but IS a real classification requiring approval", async (_label, command) => {
    const critical = await runInProdCwd(command);
    expect(critical.blockJson).toBeNull();

    const ledger = makeLedger({ kind: "ok", entries: [] });
    const approval = await intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE_APPROVAL_FOR_TEST],
        classifiers: realClassifiers(),
        resolvers: [PROD_RESOLVER],
      }),
      event: bashEvent(command),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(approval.blockJson).not.toBeNull();
    expect(approval.decisions[0]?.risk?.classified).toBe(true);
    expect(approval.decisions[0]?.risk?.severity).toBe("high");
    // Not the fallback — a real pattern match.
    expect(approval.decisions[0]?.whenUnclassifiedFallback).toBeUndefined();
  });

  // AC2: the envelope for an unclassified deny names the fallback,
  // rather than reusing gate-prod-destructive's own "critical
  // destructive action" wording, which is reserved for a genuine
  // critical-severity classification (see the "intercept — M7
  // whenUnclassifiedFallback flag" describe block above for the
  // ux-rendering-layer unit coverage; this is the end-to-end version
  // against the real shipped severity_at_least: high approval gate,
  // where an unclassified action can still legitimately deny/require
  // approval — see when-eval.ts's module header).
  it("AC2: an unclassified deny via the real gate-prod-destructive-approval policy names the fallback in its envelope", async () => {
    const GATE_PROD_DESTRUCTIVE_APPROVAL: Policy = {
      name: "gate-prod-destructive-approval",
      description: "require operator approval for high-severity destructive shell actions against a production target",
      trigger: { event: "PreToolUse", match: "Bash" },
      when: {
        "risk.severity_at_least": "high",
        "environment.name": "production",
      },
      requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
      hook: "risk-gate",
      enforcement: "require_approval",
      ux: {
        cannot: "You cannot run this destructive production action yet.",
        required: ["operator approval of this Risk Gate decision"],
        run: ["harness approve risk"],
      },
    } as Policy;
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: makeManifest({
        policies: [GATE_PROD_DESTRUCTIVE_APPROVAL],
        classifiers: realClassifiers(),
        resolvers: [PROD_RESOLVER],
      }),
      // A head no classifier pattern reasons about at all (not `cat`,
      // not `dd`) — genuinely unclassified, so the fallback (not a real
      // classification) is what makes this deny.
      event: bashEvent("some-unrecognized-admin-tool --flag"),
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBe(true);
    expect(result.blockJson?.reason).toContain(
      "unclassified action in a production context",
    );
    // The operator's own cannot: text is still present.
    expect(result.blockJson?.reason).toContain(
      "You cannot run this destructive production action yet.",
    );
  });
});

// Task 98ad072f, T-003: unit-level coverage of the attribution sibling of
// `policyMatchesEvent` — segment-level re-testing of a policy's own
// `bash_match`, independent of any filesystem/git-context resolution
// (that end-to-end behaviour is covered in `intercept-cli.test.ts`,
// where real git fixtures are available).
describe("attributeTriggerSegments — segment-level re-test of a policy's own bash_match", () => {
  const PUSH_POLICY: Policy = policy({
    name: "preflight-before-push",
    trigger: {
      event: "PreToolUse",
      match: "Bash",
      bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
    },
    requires: { ledger_tag: "preflight:${BRANCH}", at_head: true },
    hook: "h",
  });

  const seg = (
    text: string,
    ownTarget: string | null = null,
    effectiveTarget: string | null = null,
  ): CommandSegment => ({ text, ownTarget, effectiveTarget });

  it("returns only the segment(s) whose OWN text satisfies the regex", () => {
    const segments = [seg("cd /tmp/decoy", "/tmp/decoy", "/tmp/decoy"), seg("git log"), seg("git push")];
    const satisfying = attributeTriggerSegments(PUSH_POLICY, segments);
    expect(satisfying).toHaveLength(1);
    expect(satisfying[0]?.text).toBe("git push");
  });

  it("returns every segment that individually matches (D-004 shape: several satisfying segments)", () => {
    const readPolicy: Policy = policy({
      name: "preflight-before-investigation",
      trigger: {
        event: "PreToolUse",
        match: "Bash",
        bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b",
      },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "h",
    });
    const segments = [
      seg("git -C /tmp/B status", "/tmp/B", "/tmp/B"),
      seg("git status"),
    ];
    const satisfying = attributeTriggerSegments(readPolicy, segments);
    expect(satisfying).toHaveLength(2);
  });

  it("returns [] when no single segment matches (whole-string-only match)", () => {
    const wholeStringOnly: Policy = policy({
      name: "whole-string-only-probe",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: "status.*log" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "h",
    });
    const segments = [seg("git status"), seg("git log")];
    expect(attributeTriggerSegments(wholeStringOnly, segments)).toEqual([]);
  });

  it("returns [] when the policy has no bash_match trigger (MCP-tool-name policy)", () => {
    const mcpPolicy: Policy = policy({
      name: "mcp-triggered",
      trigger: { event: "PreToolUse", match: "mcp__x__y" },
      requires: { ledger_tag: "review:${SESSION_ID}" },
      hook: "h",
    });
    expect(attributeTriggerSegments(mcpPolicy, [seg("git push")])).toEqual([]);
  });

  it("returns [] defensively when the policy's bash_match is a malformed regex", () => {
    const malformed: Policy = policy({
      name: "malformed-regex",
      trigger: { event: "PreToolUse", match: "Bash", bash_match: "(unterminated" },
      requires: { ledger_tag: "preflight:${REPO}" },
      hook: "h",
    });
    expect(attributeTriggerSegments(malformed, [seg("git push")])).toEqual([]);
  });

  it("never changes whether a policy matches — policyMatchesEvent stays a pure boolean, unrelated to this function", () => {
    // Sanity pin that this task did not alter `policyMatchesEvent`'s own
    // contract: it still returns a plain boolean and accepts no segment
    // view at all.
    const event: ToolEvent = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
      session_id: "sess-1",
    };
    expect(policyMatchesEvent(PUSH_POLICY, event)).toBe(true);
  });
});
