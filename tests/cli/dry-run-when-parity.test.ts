import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { dryRun } from "../../src/cli/dry-run.js";
import { FULL_TEMPLATE } from "../../src/cli/init/templates.js";
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

function fullTemplate(): RawManifest {
  return parseYaml(FULL_TEMPLATE) as RawManifest;
}

/** The FULL template's hooks with a caller-supplied policy list. */
function withPolicies(policies: Array<Record<string, unknown>>): RawManifest {
  return { ...fullTemplate(), policies };
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
  const result = await runInterceptCli({
    homeDir: home,
    ...(project !== undefined ? { project } : {}),
    stdin: Readable.from([
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        session_id: "sess-parity",
        cwd: os.tmpdir(),
      }),
    ]),
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

  for (const command of ["rm -rf /", "ls"]) {
    it(`reports the FULL template's three gates as not applying to \`${command}\`, as policy intercept does`, async () => {
      const home = makeHome(fullTemplate());
      const gates = ["gate-dev-unsafe-deletion", "gate-prod-destructive", "gate-prod-destructive-approval"];
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
