import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  intercept,
  type LedgerClient,
  type RiskGateContext,
  type ToolEvent,
} from "../../src/runtime/index.js";
import type {
  ExtractBuiltins,
  LedgerEntry,
  LedgerQueryResult,
} from "../../src/policies/index.js";
import type {
  EnvironmentResolver,
  Policy,
  RiskClassifier,
} from "../../src/schema/index.js";
import { makeManifest, makePolicy as policy } from "../_helpers/manifest.js";

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
          verb: "mcp__agent-grounding__ledger_add",
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
    expect(reason).toContain("1. [mcp]  mcp__agent-grounding__ledger_add");
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
          'mcp__agent-grounding__ledger_add { type: "fact", content: "review:${PR_NUMBER} — <verdict + key findings + nits>" }',
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
        '  mcp__agent-grounding__ledger_add { type: "fact", content: "review:42 — <verdict + key findings + nits>" }',
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
          'mcp__agent-grounding__ledger_add { type: "fact", content: "review-subagent:${TASK_ID} — <verdict + key findings + nits>" }',
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
        '  mcp__agent-grounding__ledger_add { type: "fact", content: "review-subagent:abc-123 — <verdict + key findings + nits>" }',
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
          'mcp__agent-grounding__ledger_add { type: "fact", content: "dogfood:${SESSION_ID} — <end-to-end smoke summary>" }',
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
        '  mcp__agent-grounding__ledger_add { type: "fact", content: "dogfood:sess-1 — <end-to-end smoke summary>" }',
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

describe("intercept — degraded ledger", () => {
  it("returns warn-degraded outcome and does NOT block", async () => {
    const ledger = makeLedger({
      kind: "degraded",
      reason: "ledger db missing",
    });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: MERGE_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.decisions[0]?.reason).toBe("ledger db missing");
    expect(result.blockJson).toBeNull();
  });
});

describe("intercept — unresolved template variables", () => {
  it("flags warn-degraded when an extract source is missing", async () => {
    const ledger = makeLedger({ kind: "ok", entries: [] });
    const result = await intercept({
      manifest: manifest([REVIEW_POLICY]),
      event: { ...MERGE_EVENT, tool_input: {} }, // no prNumber
      ledger,
      builtins: BUILTINS,
      now: NOW,
    });
    expect(result.decisions[0]?.outcome).toBe("warn-degraded");
    expect(result.decisions[0]?.reason).toContain("PR_NUMBER");
    expect(result.blockJson).toBeNull();
    expect(ledger.queryCalls).toEqual([]);
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

  it("ux-path carve-out: records whenUnclassifiedFallback=true on the audit decision but does NOT append the clause to the ux agent-facing reason", async () => {
    // A policy with `ux:` uses the operator-curated plain-language surface.
    // The unclassifiedFallback flag must still be on the decision record
    // (audit + explain --trace can replay it), but the block message must
    // not be altered — the operator chose its exact wording.
    // Mutation guard: removing the `if (blockingPolicy?.ux)` guard (so the
    // ux path falls into the neutral-deny branch) would append the clause to
    // the agent-facing text, making the second assertion go red.
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
      manifest: makeManifest({ policies: [uxPolicy] }),
      event: BASH_UNKNOWN_EVENT,
      ledger,
      builtins: BUILTINS,
      now: NOW,
      riskContext: riskCtx("main"),
    });
    // The decision record must carry the flag.
    expect(result.decisions[0]?.whenUnclassifiedFallback).toBe(true);
    // The agent-facing reason must NOT contain the unclassified clause.
    expect(result.blockJson?.reason).not.toContain(
      "matched via the fail-closed unclassified rule",
    );
    // The ux text is verbatim from the policy.
    expect(result.blockJson?.reason).toContain(
      "You cannot run unrecognised commands here.",
    );
  });
});
