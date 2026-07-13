import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest, type Policy } from "../../src/schema/index.js";
import {
  intercept,
  type LedgerClient,
  type ToolEvent,
} from "../../src/runtime/index.js";
import type { ExtractBuiltins, LedgerEntry, LedgerQueryResult } from "../../src/policies/index.js";
import { makeManifest } from "../_helpers/manifest.js";

// Regression guard for task cf1fde6d (pause/resume operator channel is a
// wall for the operator and a speed bump for the agent). The CLI-level
// refuseIfAgentShell / refuseIfNonTTY checks in src/cli/pause/index.ts
// cannot distinguish an operator's `! `-prefixed Claude Code shell from an
// agent Bash call (both inherit the same session env and non-TTY stdin), so
// the actual enforcement point is this PreToolUse deny-policy layer in
// FULL_TEMPLATE. This test pins the three bash_match regexes against the
// exact bypass shapes the task called out, and against the innocent
// neighbours that must NOT be denied.
//
// Review round 2 (same task): a skeptical reviewer found live bypasses of
// the round-1 regexes (npx/absolute-path/./node_modules/.bin/ prefixes,
// quoted verbs, empty env-var assignment, `-u` with no space, `--unset=`)
// and proved the requires.ledger_tag itself is self-satisfiable by the
// gated agent (see the "declares no producers" describe block below and
// tests/runtime/intercept.test.ts-style coverage in the
// "actually blocks via intercept()" describe block further down). The regex
// fixes here close the cheap wins; the self-satisfy hole is NOT closable
// from bash_match at all (it lives one layer up, in the policy engine's
// requires: evaluator) and is deliberately recorded, not hidden: see
// docs/okf/pause-vs-gate-kill-switch.md and the HONESTY NOTE comment above
// deny-kill-switch-bypass in src/cli/init/templates.ts.

function policyBashMatch(name: string): RegExp {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === name);
  if (!policy) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
  const pattern = policy.trigger.bash_match;
  if (!pattern) throw new Error(`policy ${name} declares no trigger.bash_match`);
  return new RegExp(pattern);
}

// Commands that must NEVER match any of the three new deny rules:
// asserted once, against every regex, so a future edit that accidentally
// widens one of them fails loud immediately regardless of which rule
// over-matched.
const INNOCENT_NEIGHBOURS = [
  "harness pause-check",
  "harness doctor",
  "harness status",
  "harness validate",
  "env FOO=bar cmd",
  "harness gate --help",
  "cat .harness-paused",
  "stat harness.generated/.harness-paused",
];

describe("FULL_TEMPLATE: deny-kill-switch-bypass bash_match", () => {
  const re = () => policyBashMatch("deny-kill-switch-bypass");

  it.each([
    "harness pause",
    "harness pause --for 1h",
    "harness resume",
    "harness gate disable --matcher foo",
    "harness gate enable",
    "foo; harness pause --for 1h",
    "echo x && harness resume",
    // Round-2 bypasses the reviewer confirmed live; now covered.
    "npx harness pause",
    "/usr/local/bin/harness pause",
    "./node_modules/.bin/harness pause",
    'harness "pause"',
    "harness 'resume'",
    'harness gate "disable"',
    "CLAUDE_CODE_SESSION_ID= harness pause",
  ])("matches %s", (cmd) => {
    expect(re().test(cmd)).toBe(true);
  });

  it.each(INNOCENT_NEIGHBOURS)("does not match innocent neighbour %s", (cmd) => {
    expect(re().test(cmd)).toBe(false);
  });

  it("hook wiring: trigger.hook resolves to a hooks[] entry with matching bash_match", () => {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = parsed.policies.find((p) => p.name === "deny-kill-switch-bypass");
    const hook = parsed.hooks.find((h) => h.name === policy?.hook);
    expect(hook, "deny-kill-switch-bypass.hook must resolve to a real hooks[] entry").toBeDefined();
    expect(hook?.bash_match).toBe(policy?.trigger.bash_match);
    expect(policy?.enforcement).toBe("block");
  });
});

describe("FULL_TEMPLATE: deny-session-env-strip bash_match", () => {
  const re = () => policyBashMatch("deny-session-env-strip");

  it.each([
    "env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CODEX_SESSION_ID harness pause --for 1h --i-am-the-operator",
    "env -u CLAUDE_CODE_SESSION_ID harness pause --for 6h",
    "env -u CLAUDE_SESSION_ID harness resume",
    "unset CLAUDE_CODE_SESSION_ID",
    "unset CLAUDE_SESSION_ID CODEX_SESSION_ID",
    // Round-2 bypasses the reviewer confirmed live; now covered.
    "env -uCLAUDE_CODE_SESSION_ID harness pause",
    "env --unset=CLAUDE_CODE_SESSION_ID harness pause",
    "env --unset CLAUDE_CODE_SESSION_ID harness pause",
    "CLAUDE_CODE_SESSION_ID= harness pause",
    "CLAUDE_SESSION_ID= harness pause",
  ])("matches %s", (cmd) => {
    expect(re().test(cmd)).toBe(true);
  });

  it.each([...INNOCENT_NEIGHBOURS, "unset FOO", "env -i FOO=bar cmd"])(
    "does not match innocent neighbour %s",
    (cmd) => {
      expect(re().test(cmd)).toBe(false);
    },
  );

  it("hook wiring: trigger.hook resolves to a hooks[] entry with matching bash_match", () => {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = parsed.policies.find((p) => p.name === "deny-session-env-strip");
    const hook = parsed.hooks.find((h) => h.name === policy?.hook);
    expect(hook, "deny-session-env-strip.hook must resolve to a real hooks[] entry").toBeDefined();
    expect(hook?.bash_match).toBe(policy?.trigger.bash_match);
    expect(policy?.enforcement).toBe("block");
  });
});

describe("FULL_TEMPLATE: deny-pause-sentinel-forgery bash_match", () => {
  const re = () => policyBashMatch("deny-pause-sentinel-forgery");

  it.each([
    "> .harness-paused",
    "echo hi > .harness-paused",
    "echo hi >> .harness-paused",
    "echo hi > harness.generated/.harness-paused",
    "tee .harness-paused",
    "echo x | tee .harness-paused",
    "tee -a .harness-paused",
    "cp fake.json .harness-paused",
    "cp fake.json harness.generated/.harness-paused",
  ])("matches %s", (cmd) => {
    expect(re().test(cmd)).toBe(true);
  });

  it.each(INNOCENT_NEIGHBOURS)("does not match innocent neighbour %s", (cmd) => {
    expect(re().test(cmd)).toBe(false);
  });

  it("hook wiring: trigger.hook resolves to a hooks[] entry with matching bash_match", () => {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = parsed.policies.find((p) => p.name === "deny-pause-sentinel-forgery");
    const hook = parsed.hooks.find((h) => h.name === policy?.hook);
    expect(hook, "deny-pause-sentinel-forgery.hook must resolve to a real hooks[] entry").toBeDefined();
    expect(hook?.bash_match).toBe(policy?.trigger.bash_match);
    expect(policy?.enforcement).toBe("block");
  });
});

describe("FULL_TEMPLATE: kill-switch deny policies declare no producers (deliberate)", () => {
  // These three policies intentionally have no legitimate in-session
  // evidence flow: see the comment above deny-kill-switch-bypass in
  // src/cli/init/templates.ts. Pin the deliberate absence of producers so
  // a future edit does not "fix" the harness-validate self-attestation
  // warning by adding a producer that would just teach the agent a
  // ledger_tag it can self-satisfy.
  it.each([
    "deny-kill-switch-bypass",
    "deny-session-env-strip",
    "deny-pause-sentinel-forgery",
  ])("%s declares no producers", (name) => {
    const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
    const policy = parsed.policies.find((p) => p.name === name);
    expect(policy?.producers).toBeUndefined();
  });
});

// Real enforcement, not just regex shape: drives the actual runtime
// intercept() evaluator (src/runtime/intercept.ts) against the REAL policy
// objects parsed out of FULL_TEMPLATE, mirroring the pattern in
// tests/runtime/intercept.test.ts. Two things are proven here, and both are
// load-bearing for the review's PRIORITY 1 finding:
//   1. On an empty ledger, each policy actually returns a deny blockJson,
//      not merely "the regex matches" (which the describe blocks above only
//      pin at the string level).
//   2. On a ledger the AGENT itself populated with the exact tag content
//      (via mcp__agent-grounding__ledger_add, which intercept() cannot
//      distinguish from an operator write), the SAME policy flips to allow.
//      This is the self-satisfy hole the reviewer proved via intercept();
//      it is asserted here so it is recorded as known behaviour, not
//      hidden. Closing it needs a schema-level operator-only unconditional-
//      deny expression (an enforcement mode with no requires: at all);
//      out of scope for this task, filed as a follow-up.
function policyByName(name: string): Policy {
  const parsed = parseManifest(parseYaml(FULL_TEMPLATE));
  const policy = parsed.policies.find((p) => p.name === name);
  if (!policy) throw new Error(`policy ${name} missing from FULL_TEMPLATE`);
  return policy;
}

const SESSION_ID = "sess-1";

const BUILTINS: ExtractBuiltins = {
  SESSION_ID,
  REPO: "harness",
  BRANCH: "feat/example",
  TOOL_NAME: "Bash",
  CWD: "/home/lan/git/pandora/harness",
};

function bashEvent(command: string): ToolEvent {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    session_id: SESSION_ID,
  };
}

function makeLedger(entries: LedgerEntry[]): LedgerClient {
  const result: LedgerQueryResult = { kind: "ok", entries };
  return {
    async query() {
      return result;
    },
    async record() {
      /* not exercised by these tests */
    },
  };
}

describe("FULL_TEMPLATE: kill-switch deny policies actually block via intercept()", () => {
  it.each([
    ["deny-kill-switch-bypass", "harness pause --for 1h"],
    ["deny-session-env-strip", "env -u CLAUDE_CODE_SESSION_ID harness pause --for 1h"],
    ["deny-pause-sentinel-forgery", "echo hi > .harness-paused"],
  ])("%s: blocks %s on an empty ledger", async (policyName, command) => {
    const policy = policyByName(policyName);
    const result = await intercept({
      manifest: makeManifest({ policies: [policy] }),
      event: bashEvent(command),
      ledger: makeLedger([]),
      builtins: BUILTINS,
    });
    expect(result.blockJson).not.toBeNull();
    expect(result.blockJson?.decision).toBe("block");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.outcome).toBe("deny");
  });

  it.each([
    ["deny-kill-switch-bypass", "harness pause --for 1h"],
    ["deny-session-env-strip", "env -u CLAUDE_CODE_SESSION_ID harness pause --for 1h"],
    ["deny-pause-sentinel-forgery", "echo hi > .harness-paused"],
  ])(
    "%s: SELF-SATISFY HOLE, allows %s once the SAME session's ledger carries the requires.ledger_tag (KNOWN, not fixed here)",
    async (policyName, command) => {
      const policy = policyByName(policyName);
      const forgedTag = `operator-ran-this-outside-the-session:${SESSION_ID}`;
      // The agent can write exactly this row itself via
      // mcp__agent-grounding__ledger_add before running the denied Bash
      // command; intercept() has no way to tell an operator-written row
      // from an agent-written one (src/runtime/intercept.ts, the
      // satisfied-requires branch always allows). Recorded, not hidden.
      const forgedEntry: LedgerEntry = {
        id: "forged-1",
        content: `${forgedTag}: self-written by the gated agent`,
        createdAt: new Date().toISOString(),
      };
      const result = await intercept({
        manifest: makeManifest({ policies: [policy] }),
        event: bashEvent(command),
        ledger: makeLedger([forgedEntry]),
        builtins: BUILTINS,
      });
      expect(result.blockJson).toBeNull();
      expect(result.decisions[0]?.outcome).toBe("allow");
    },
  );
});
