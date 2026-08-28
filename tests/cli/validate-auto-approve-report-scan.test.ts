// Slice 3 AC 1 (docs/decisions/2026-08-27-ug-auto-mode-approval.md,
// agent-tasks 37ad0b05): `auto_approve.report_scan.max_wait`, the bound
// of the child's transcript poll under `claude -p`.
//
// The key has TWO parsers and they must not drift: the zod `configSchema`
// block that `harness validate` runs at lint time, and
// `parseAutoApprove`, the defensive runtime parser the PreToolUse hook
// uses on whatever config it finds on disk. Both call the same
// `parseReportScanMaxWait`, and both describes below hold them to the
// same accept/reject set for that reason. Sibling of
// validate-auto-approve-measured.test.ts, which pins the `when` literals.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validate } from "../../src/cli/validate/index.js";
import {
  DEFAULT_REPORT_SCAN_MAX_WAIT_MS,
  parseAutoApprove,
} from "../../src/policy-packs/builtin/understanding-before-execution/auto-approve.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
  gitIgnoreProbe: () => null,
};

function fixtureWithAutoApprove(autoApprove: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-validate-report-scan-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const yaml = `version: 1\npolicy_packs: ${JSON.stringify([
    {
      name: "understanding-before-execution",
      config: { auto_approve: autoApprove },
    },
  ])}\n`;
  fs.writeFileSync(path.join(home, "harness.yaml"), yaml, "utf8");
  return home;
}

function autoApproveDiagnostics(home: string): Array<{ path: string; severity: string; message: string }> {
  const result = validate({
    homeDir: home,
    configPath: path.join(home, "harness.yaml"),
    ...NOOP_PROBES,
  });
  return result.diagnostics.filter((d) =>
    d.path.startsWith("policy_packs[0].config.auto_approve.report_scan"),
  );
}

function baseBlock(reportScan?: unknown): Record<string, unknown> {
  return {
    when: ["bypassPermissions"],
    require_report: true,
    ...(reportScan === undefined ? {} : { report_scan: reportScan }),
  };
}

describe("validate: auto_approve.report_scan.max_wait", () => {
  it.each([["500ms"], ["1500ms"], ["2s"]])(
    "accepts the measured-scale duration %s",
    (maxWait) => {
      expect(autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock({ max_wait: maxWait })))).toEqual(
        [],
      );
    },
  );

  it("accepts an absent report_scan block (the measured default applies)", () => {
    expect(autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock()))).toEqual([]);
  });

  it("rejects 30s: far past the hard ceiling, so no config can park a hook on a session", () => {
    const diags = autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock({ max_wait: "30s" })));
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.path).toBe("policy_packs[0].config.auto_approve.report_scan.max_wait");
    expect(diags[0]?.message).toMatch(/hard ceiling/);
  });

  it("rejects 6s: one step past the ceiling, so the bound is a real edge and not a round-number check", () => {
    const diags = autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock({ max_wait: "6s" })));
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.message).toMatch(/hard ceiling/);
  });

  it.each([["0s"], ["0ms"]])("rejects the zero bound %s", (maxWait) => {
    const diags = autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock({ max_wait: maxWait })));
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.message).toMatch(/greater than zero/);
  });

  it("rejects a negative bound", () => {
    const diags = autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock({ max_wait: "-1s" })));
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.message).toMatch(/invalid duration/);
  });

  it("rejects an unknown key under report_scan (the block is .strict())", () => {
    const diags = autoApproveDiagnostics(
      fixtureWithAutoApprove(baseBlock({ max_wait: "2s", poll_interval: "10ms" })),
    );
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags.some((d) => d.severity === "error")).toBe(true);
    expect(diags.some((d) => /poll_interval|Unrecognized|unrecognized/.test(d.message))).toBe(true);
  });

  it("rejects a report_scan block with no max_wait at all", () => {
    const diags = autoApproveDiagnostics(fixtureWithAutoApprove(baseBlock({})));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("parseAutoApprove: report_scan on the runtime path", () => {
  function parse(reportScan?: unknown): ReturnType<typeof parseAutoApprove> {
    return parseAutoApprove(baseBlock(reportScan), null);
  }

  it("resolves the measured default when the block is absent", () => {
    expect(parse()?.reportScan).toEqual({ maxWaitMs: DEFAULT_REPORT_SCAN_MAX_WAIT_MS });
  });

  it.each([
    ["500ms", 500],
    ["1500ms", 1_500],
    ["2s", 2_000],
  ])("parses %s to %ims", (maxWait, expected) => {
    expect(parse({ max_wait: maxWait })?.reportScan).toEqual({ maxWaitMs: expected });
  });

  it.each([
    ["past the ceiling", { max_wait: "30s" }],
    ["one step past the ceiling", { max_wait: "6s" }],
    ["zero", { max_wait: "0s" }],
    ["negative", { max_wait: "-1s" }],
    ["not a duration", { max_wait: "soon" }],
    ["not a string", { max_wait: 500 }],
    ["max_wait absent", {}],
    ["an unknown sibling key", { max_wait: "2s", poll_interval: "10ms" }],
    ["not an object", "2s"],
  ])(
    "fails the WHOLE auto_approve block closed when report_scan is %s",
    (_label, reportScan) => {
      // Fail-closed, not "ignore the bad key and keep the opt-in": an
      // operator who typo'd the bound must not silently keep the auto
      // path running on the default.
      expect(parse(reportScan)).toBeNull();
    },
  );

  it("writes exactly one stderr line naming the offending key", () => {
    const lines: string[] = [];
    const stderr = { write: (s: string): void => void lines.push(s) };
    expect(parseAutoApprove(baseBlock({ max_wait: "30s" }), stderr)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/config\.auto_approve\.report_scan\.max_wait ignored/);
  });
});
