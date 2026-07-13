import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
import { parseManifest } from "../../src/schema/index.js";

// Regression guard for task cf1fde6d (pause/resume operator channel is a
// wall for the operator and a speed bump for the agent). The CLI-level
// refuseIfAgentShell / refuseIfNonTTY checks in src/cli/pause/index.ts
// cannot distinguish an operator's `! `-prefixed Claude Code shell from an
// agent Bash call (both inherit the same session env and non-TTY stdin), so
// the actual enforcement point is this PreToolUse deny-policy layer in
// FULL_TEMPLATE. This test pins the three bash_match regexes against the
// exact bypass shapes the task called out, and against the innocent
// neighbours that must NOT be denied.

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
