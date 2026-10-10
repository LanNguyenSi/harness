import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { dryRun } from "../../src/cli/dry-run.js";
import { runInterceptCli } from "../../src/cli/policy/intercept.js";
import type { LedgerClient } from "../../src/runtime/intercept.js";

// `harness dry-run` predicts what `harness policy intercept` will do. A
// policy that still carries a `when:` clause never applies at runtime (the
// clause can no longer be evaluated), so dry-run must not list it as
// matching either: it belongs in the bucket of policies that would not
// apply, with the reason stated (task 3a655f4e).

type RawManifest = {
  hooks: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
} & Record<string, unknown>;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeHome(base: RawManifest, project?: { name: string; contents: unknown }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-dry-run-when-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "harness.yaml"), stringifyYaml(base), "utf8");
  if (project !== undefined) {
    const dir = path.join(home, "projects", project.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "harness.overrides.yaml"), stringifyYaml(project.contents), "utf8");
  }
  return home;
}

/**
 * Inline base manifest for the policy fixtures below: declares the
 * `risk-gate` hook the fixtures' policies reference. Task 6e52c044 removed
 * that hook (and the three gate policies) from FULL_TEMPLATE, so the
 * fixtures no longer derive their shape from the template.
 */
function baseManifest(): RawManifest {
  return {
    version: 1,
    hooks: [
      {
        name: "risk-gate",
        event: "PreToolUse",
        match: "Bash",
        command: "harness policy intercept",
        blocking: "hard",
        budget_ms: 15000,
      },
    ],
    policies: [],
  };
}

/** The inline base manifest with a caller-supplied policy list. */
function withPolicies(policies: Array<Record<string, unknown>>): RawManifest {
  return { ...baseManifest(), policies };
}

const bashPolicy = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  description: `policy ${name}`,
  trigger: { event: "PreToolUse", match: "Bash" },
  requires: { ledger_tag: "ok:${SESSION_ID}" },
  hook: "risk-gate",
  enforcement: "block",
  ...extra,
});

const WHEN = { "environment.name": "production" };

const emptyLedger: LedgerClient = {
  async query() {
    return { kind: "ok", entries: [] };
  },
  async record() {
    /* no-op */
  },
};

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

async function interceptNames(home: string, command: string, project?: string): Promise<string[]> {
  return interceptEventNames(
    home,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      session_id: "sess-parity",
      cwd: os.tmpdir(),
    },
    project,
  );
}

async function interceptEventNames(
  home: string,
  event: Record<string, unknown>,
  project?: string,
): Promise<string[]> {
  const result = await runInterceptCli({
    homeDir: home,
    ...(project !== undefined ? { project } : {}),
    stdin: Readable.from([JSON.stringify(event)]),
    stdout: sink(),
    stderr: sink(),
    ledger: emptyLedger,
  });
  return result.decisions.map((d) => d.policyName).sort();
}

function dryRunReport(home: string, command: string, project?: string) {
  const { report } = dryRun("", {
    homeDir: home,
    ...(project !== undefined ? { project } : {}),
    tool: "Bash",
    toolArgs: JSON.stringify({ command }),
    builtins: { SESSION_ID: "sess-parity", REPO: "r", BRANCH: "feature", CWD: os.tmpdir() },
  });
  return report;
}

const WHEN_REASON = /carries a when: clause, which never applies/;

describe("dry-run: a policy carrying when: never appears under matchingPolicies", () => {
  it("agrees with policy intercept for a when: policy next to a plain sibling", async () => {
    const home = makeHome(
      withPolicies([
        bashPolicy("w-bash", { when: WHEN }),
        bashPolicy("plain", { enforcement: "warn" }),
      ]),
    );
    const report = dryRunReport(home, "ls -la");
    expect(report.matchingPolicies.map((p) => p.name)).toEqual(["plain"]);
    const bucket = report.couldMatchPolicies.find((p) => p.name === "w-bash");
    expect(bucket?.reason).toMatch(WHEN_REASON);
    expect(await interceptNames(home, "ls -la")).toEqual(["plain"]);
  });

  it("keeps the output for policies without when: unchanged (matched and unmatched reasons)", () => {
    const home = makeHome(
      withPolicies([
        bashPolicy("plain"),
        bashPolicy("other-tool", { trigger: { event: "PreToolUse", match: "Edit" } }),
      ]),
    );
    const report = dryRunReport(home, "ls -la");
    expect(report.matchingPolicies.map((p) => p.name)).toEqual(["plain"]);
    const other = report.couldMatchPolicies.find((p) => p.name === "other-tool");
    expect(other?.reason).toContain('does not contain trigger.match "Edit"');
    expect(other?.reason).not.toMatch(WHEN_REASON);
  });

  it("does not list a when: policy as matching when its trigger does not match either", () => {
    const home = makeHome(
      withPolicies([bashPolicy("w-edit", { when: WHEN, trigger: { event: "PreToolUse", match: "Edit" } })]),
    );
    const report = dryRunReport(home, "ls -la");
    expect(report.matchingPolicies).toEqual([]);
    expect(report.couldMatchPolicies.find((p) => p.name === "w-edit")?.reason).toContain(
      'does not contain trigger.match "Edit"',
    );
  });

  it("agrees with policy intercept for a project-override policy carrying when:", async () => {
    const home = makeHome(withPolicies([bashPolicy("plain", { enforcement: "warn" })]), {
      name: "p1",
      contents: { version: 1, policies: [bashPolicy("proj-when", { when: WHEN })] },
    });
    const report = dryRunReport(home, "ls -la", "p1");
    expect(report.matchingPolicies.map((p) => p.name)).toEqual(["plain"]);
    expect(report.couldMatchPolicies.find((p) => p.name === "proj-when")?.reason).toMatch(WHEN_REASON);
    expect(await interceptNames(home, "ls -la", "p1")).toEqual(["plain"]);
  });

  it("applies the same rule to a prompt-event policy carrying when:", async () => {
    const promptPolicy = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      description: `policy ${name}`,
      trigger: { event: "UserPromptSubmit", match: "deploy" },
      requires: { ledger_tag: "ok:${SESSION_ID}" },
      hook: "risk-gate",
      enforcement: "warn",
      ...extra,
    });
    const home = makeHome(withPolicies([promptPolicy("p-plain"), promptPolicy("p-when", { when: WHEN })]));
    const { report } = dryRun("please deploy now", {
      homeDir: home,
      builtins: { SESSION_ID: "sess-parity", REPO: "r", BRANCH: "feature", CWD: os.tmpdir() },
    });
    expect(report.matchingPolicies.map((p) => p.name)).toEqual(["p-plain"]);
    expect(report.couldMatchPolicies.find((p) => p.name === "p-when")?.reason).toMatch(WHEN_REASON);
  });

  for (const command of ["rm -rf /", "ls"]) {
    it(`reports the three former gate policies as not applying to \`${command}\`, as policy intercept does`, async () => {
      // The three policies FULL_TEMPLATE shipped until task 6e52c044
      // removed them (name, trigger, when, requires and enforcement copied
      // verbatim from the removed template entries; the producers: arrays
      // are not needed here).
      const gates = ["gate-dev-unsafe-deletion", "gate-prod-destructive", "gate-prod-destructive-approval"];
      const home = makeHome(
        withPolicies([
          {
            name: "gate-prod-destructive",
            description:
              "Deny critical-severity destructive shell actions against a production target.",
            trigger: { event: "PreToolUse", match: "Bash" },
            when: { "risk.severity_at_least": "critical", "environment.name": "production" },
            requires: { ledger_tag: "risk-override:${SESSION_ID}" },
            hook: "risk-gate",
            enforcement: "block",
          },
          {
            name: "gate-prod-destructive-approval",
            description:
              "Require operator approval for high-severity destructive shell actions against a production target.",
            trigger: { event: "PreToolUse", match: "Bash" },
            when: { "risk.severity_at_least": "high", "environment.name": "production" },
            requires: { ledger_tag: "risk-approved:${SESSION_ID}" },
            hook: "risk-gate",
            enforcement: "require_approval",
          },
          {
            name: "gate-dev-unsafe-deletion",
            description:
              "Require approval for a deletion-verb command whose target cannot be statically proven safe, in every environment.",
            trigger: { event: "PreToolUse", match: "Bash" },
            when: { "action.deletion_target_unresolvable": true },
            requires: { ledger_tag: "risk-approved:deletion:${SESSION_ID}" },
            hook: "risk-gate",
            enforcement: "require_approval",
          },
        ]),
      );
      const report = dryRunReport(home, command);
      const matching = report.matchingPolicies.map((p) => p.name);
      const decided = await interceptNames(home, command);
      for (const gate of gates) {
        expect(matching).not.toContain(gate);
        expect(decided).not.toContain(gate);
        expect(report.couldMatchPolicies.find((p) => p.name === gate)?.reason).toMatch(WHEN_REASON);
      }
    });
  }
});

describe("dry-run and policy intercept agree that a when: policy never applies, whatever its shape", () => {
  // The same policy shapes the runtime never-applies tables cover (the
  // matching code treats each one differently before the when: check), plus
  // a block-tier prompt-event policy. Each case runs its twin without when:
  // as a control: dry-run lists the twin as matching and policy intercept
  // decides it, so the event does reach the policy.
  const promptEvent = (prompt: string) => ({
    hook_event_name: "UserPromptSubmit",
    prompt,
    session_id: "sess-parity",
    cwd: os.tmpdir(),
  });
  const bashToolEvent = (command: string) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    session_id: "sess-parity",
    cwd: os.tmpdir(),
  });

  type Case = {
    label: string;
    policy: Record<string, unknown>;
    // Bash command for a tool case; prompt text for a prompt-event case.
    command?: string;
    prompt?: string;
  };
  const cases: Case[] = [
    { label: "enforcement block", policy: bashPolicy("p", { enforcement: "block" }), command: "terraform destroy" },
    {
      label: "enforcement require_approval",
      policy: bashPolicy("p", { enforcement: "require_approval" }),
      command: "terraform destroy",
    },
    { label: "enforcement warn", policy: bashPolicy("p", { enforcement: "warn" }), command: "terraform destroy" },
    {
      label: "operator_only: true",
      policy: {
        name: "p",
        description: "policy p",
        trigger: { event: "PreToolUse", match: "Bash" },
        hook: "risk-gate",
        enforcement: "block",
        operator_only: true,
      },
      command: "terraform destroy",
    },
    {
      label: "a trigger.bash_match",
      policy: bashPolicy("p", {
        trigger: { event: "PreToolUse", match: "Bash", bash_match: "terraform\\s+destroy" },
      }),
      command: "echo hi && terraform destroy",
    },
    {
      // Per-repo (${REPO}) policy: only the shell model reads the quoted
      // `-C` path with a space, so dry-run reports it as matched by that arm
      // alone (byModelOnly).
      label: "a per-repo policy matched only by the shell-model arm",
      policy: bashPolicy("p", {
        trigger: {
          event: "PreToolUse",
          match: "Bash",
          bash_match: "(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*git( -C \\S+)* push\\b",
        },
        requires: { ledger_tag: "preflight:${REPO}" },
      }),
      command: "git -C '/tmp/repo with space' push origin master",
    },
    {
      label: "a block-tier prompt-event policy",
      policy: {
        name: "p",
        description: "policy p",
        trigger: { event: "UserPromptSubmit" },
        requires: { ledger_tag: "ok:${SESSION_ID}" },
        hook: "risk-gate",
        enforcement: "block",
      },
      prompt: "please deploy now",
    },
  ];

  function reportFor(home: string, c: Case) {
    if (c.prompt !== undefined) {
      return dryRun(c.prompt, {
        homeDir: home,
        builtins: { SESSION_ID: "sess-parity", REPO: "r", BRANCH: "feature", CWD: os.tmpdir() },
      }).report;
    }
    return dryRunReport(home, c.command!);
  }
  const eventFor = (c: Case) => (c.prompt !== undefined ? promptEvent(c.prompt) : bashToolEvent(c.command!));

  for (const c of cases) {
    it(`${c.label}: not matching in dry-run, never-applies reason, no intercept decision`, async () => {
      const home = makeHome(withPolicies([{ ...c.policy, when: WHEN }]));
      const report = reportFor(home, c);
      expect(report.matchingPolicies.map((p) => p.name)).not.toContain("p");
      expect(report.couldMatchPolicies.find((p) => p.name === "p")?.reason).toMatch(WHEN_REASON);
      expect(await interceptEventNames(home, eventFor(c))).toEqual([]);
    });

    it(`${c.label}: the same policy without when: matches in dry-run and is decided by intercept (control)`, async () => {
      const home = makeHome(withPolicies([c.policy]));
      const report = reportFor(home, c);
      expect(report.matchingPolicies.map((p) => p.name)).toEqual(["p"]);
      expect(await interceptEventNames(home, eventFor(c))).toEqual(["p"]);
    });
  }

  it("without --tool, a when: policy gets the never-applies reason, not the need-a-tool reason", () => {
    const home = makeHome(withPolicies([bashPolicy("w-bash", { when: WHEN }), bashPolicy("plain")]));
    const { report } = dryRun("", {
      homeDir: home,
      builtins: { SESSION_ID: "sess-parity", REPO: "r", BRANCH: "feature", CWD: os.tmpdir() },
    });
    expect(report.matchingPolicies).toEqual([]);
    expect(report.couldMatchPolicies.find((p) => p.name === "w-bash")?.reason).toMatch(WHEN_REASON);
    expect(report.couldMatchPolicies.find((p) => p.name === "plain")?.reason).toBe(
      "no --tool supplied; dry-run can only statically match prompt-style events",
    );
  });
});
