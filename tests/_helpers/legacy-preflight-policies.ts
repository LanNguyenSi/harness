import type { Policy } from "../../src/schema/index.js";

// The `preflight-before-investigation` and `preflight-before-push` policies
// (and their `harness session-start preflight` producer command) were
// removed in task f3f15290. A number of `harness policy intercept` engine
// tests used those two policies purely as realistic Bash-trigger fixtures:
// they pin the git-read / git-push `bash_match`, the `${REPO}` / `${BRANCH}`
// ledger tags, the `at_head` / `within` requires clauses, and the `ux` /
// `producers` remediation text. They assert engine behaviour (opaque-target
// attribution, empty-identifier handling, refused shapes, at_head matching),
// not anything specific to preflight.
//
// To keep those engine guards honest without resurrecting the shipped
// policies, this module carries verbatim copies of the two policy objects as
// the schema parsed them out of the pre-f3f15290 reference manifest. Feed
// them to the engine in place of `FULL_TEMPLATE.policies.find(...)`.

const INVESTIGATION = {
  name: "preflight-before-investigation",
  description:
    "Block investigative git reads when agent-preflight has not run recently with ready:true for the current repo (founding-incident policy).",
  trigger: {
    event: "PreToolUse",
    match: "Bash",
    bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* (status|log|diff|branch)\\b",
  },
  requires: { ledger_tag: "preflight:${REPO}", within: "1h" },
  hook: "require-preflight-evidence",
  enforcement: "block",
  producers: [
    {
      kind: "bash",
      command: "harness session-start preflight",
      description:
        "Runs agent-preflight against the current cwd; on ready:true, records preflight:${REPO} to the ledger. Standard producer.",
    },
    {
      kind: "mcp",
      verb: "mcp__grounding-mcp__ledger_add",
      example:
        '{sessionId:"${SESSION_ID}", type:"fact", content:"preflight:${REPO}", source:"manual"}',
      description:
        "Direct ledger write. Use when the Bash hook is locked down (e.g. understanding-gate active) or when the standard producer is unavailable.",
    },
  ],
  ux: {
    cannot: "You cannot investigate this repository yet.",
    required: [
      "verified repository preflight",
      "an approved Understanding Report, if the Understanding Gate is still active (it blocks `harness preflight` itself)",
    ],
    run: ["harness preflight"],
  },
};

const PUSH = {
  name: "preflight-before-push",
  description:
    "Block git push unless a fresh preflight ledger entry exists for the current branch. Catches the stale-checkout class of incident at the last reversible step.",
  trigger: {
    event: "PreToolUse",
    match: "Bash",
    bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
  },
  requires: { ledger_tag: "preflight:${BRANCH}", within: "10m", at_head: true },
  hook: "require-preflight-push-evidence",
  enforcement: "block",
  producers: [
    {
      kind: "bash",
      command: "harness session-start preflight",
      description:
        "Runs agent-preflight against the current cwd; on ready:true, records preflight:${BRANCH} ready:true confidence:<n> head:<sha> to the ledger. Standard producer.",
    },
    {
      kind: "mcp",
      verb: "mcp__grounding-mcp__ledger_add",
      example:
        '{sessionId:"${SESSION_ID}", type:"fact", content:"preflight:${BRANCH} head:<full-sha> — <summary of what is on the branch + smoke results>", source:"manual"}',
      description:
        "Direct ledger write. Include head:<full-sha> if you want the entry to count under at_head; the branch is the WIP review surface and the content should summarise what is staged + the smoke evidence so a reviewer can audit later without re-reading the chat.",
    },
  ],
  ux: {
    cannot: "You cannot push branch ${BRANCH} yet.",
    required: [
      "a preflight for ${BRANCH} at the current HEAD (any age) OR any preflight within the last 10 minutes. Re-run `harness preflight` if you committed since the last preflight AND it has been more than 10 minutes.",
      "if solution-acceptance is enabled, a ready HEAD-pinned verdict at the SAME commit too (run `solution_evaluate`). `git push` trips both gates, so commit first if the tree is dirty, then satisfy both at one HEAD.",
      "an approved Understanding Report, if the Understanding Gate is still active (it blocks `harness preflight` itself)",
    ],
    run: ["harness preflight"],
  },
};

function asPolicy(obj: Record<string, unknown>): Policy {
  // The literals below are the parsed-manifest output (defaults already
  // applied), so a structured clone is a faithful, per-call fresh copy.
  return structuredClone(obj) as unknown as Policy;
}

/** Verbatim copy of the removed `preflight-before-investigation` policy. */
export function legacyPreflightInvestigation(): Policy {
  return asPolicy(INVESTIGATION);
}

/** Verbatim copy of the removed `preflight-before-push` policy. */
export function legacyPreflightPush(): Policy {
  return asPolicy(PUSH);
}
