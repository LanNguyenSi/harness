// Slice 2 AC 3 (docs/decisions/2026-08-27-ug-auto-mode-approval.md): every
// literal in understanding-before-execution's `auto_approve.when` must be
// backed by a checked-in dogfood fixture that shows a harness emitting
// that `permission_mode` value. This is the `harness validate` contract
// test for `checkUnderstandingBeforeExecutionAutoApproveMeasured` in
// `src/cli/validate/checks.ts`. See
// `tests/policy-packs/measured-permission-modes-sync.test.ts` for the
// registry-vs-fixture sync test.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validate } from "../../src/cli/validate/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function writeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-validate-auto-approve-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

const NOOP_PROBES = {
  versionProbe: () => null,
  builtinRuntimeProbe: () => [] as string[],
  gitIgnoreProbe: () => null,
};

function fixtureWithPacks(packs: unknown): string {
  const yaml = `version: 1\npolicy_packs: ${JSON.stringify(packs)}\n`;
  return writeFixture({ "harness.yaml": yaml });
}

function runValidate(home: string) {
  return validate({
    homeDir: home,
    configPath: path.join(home, "harness.yaml"),
    ...NOOP_PROBES,
  });
}

const AUTO_APPROVE_PATH_PREFIX = "policy_packs[0].config.auto_approve.when";

describe("validate — understanding-before-execution auto_approve.when measured literals", () => {
  it("an unmeasured literal is a validate error at the exact index", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: { when: ["bypassPermissions", "dontAsk"], require_report: true },
        },
      },
    ]);
    const result = runValidate(home);
    const diags = result.diagnostics.filter((d) => d.path.startsWith(AUTO_APPROVE_PATH_PREFIX));
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.path).toBe(`${AUTO_APPROVE_PATH_PREFIX}[1]`);
    expect(diags[0]?.message).toMatch(/dontAsk/);
    expect(diags[0]?.message).toMatch(/no checked-in dogfood fixture/);
    expect(diags[0]?.message).toMatch(/measured: acceptEdits, bypassPermissions, default/);
    expect(diags[0]?.message).toMatch(
      /docs\/decisions\/2026-08-27-ug-auto-mode-approval\.md, Slice 2/,
    );
  });

  it.each([["bypassPermissions"], ["default"], ["acceptEdits"]])(
    "a measured literal %s produces no diagnostic",
    (literal) => {
      const home = fixtureWithPacks([
        {
          name: "understanding-before-execution",
          config: { auto_approve: { when: [literal], require_report: true } },
        },
      ]);
      const result = runValidate(home);
      const diags = result.diagnostics.filter((d) => d.path.startsWith(AUTO_APPROVE_PATH_PREFIX));
      expect(diags).toEqual([]);
    },
  );

  it("two unmeasured literals produce two diagnostics at their own indexes", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        config: {
          auto_approve: { when: ["dontAsk", "plan"], require_report: true },
        },
      },
    ]);
    const result = runValidate(home);
    const diags = result.diagnostics.filter((d) => d.path.startsWith(AUTO_APPROVE_PATH_PREFIX));
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.path)).toEqual([
      `${AUTO_APPROVE_PATH_PREFIX}[0]`,
      `${AUTO_APPROVE_PATH_PREFIX}[1]`,
    ]);
  });

  it("a disabled pack with an unmeasured literal produces no diagnostic (skipped on purpose)", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        enabled: false,
        config: { auto_approve: { when: ["dontAsk"], require_report: true } },
      },
    ]);
    const result = runValidate(home);
    const diags = result.diagnostics.filter((d) => /no checked-in dogfood fixture/.test(d.message));
    expect(diags).toEqual([]);
  });

  it("an empty-string literal is left to the schema check (no double report)", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: ["", "dontAsk"], require_report: true } },
      },
    ]);
    const result = runValidate(home);
    const ours = result.diagnostics.filter((d) => /no checked-in dogfood fixture/.test(d.message));
    expect(ours.map((d) => d.path)).toEqual([`${AUTO_APPROVE_PATH_PREFIX}[1]`]);
    const schemaError = result.diagnostics.find(
      (d) => d.path === `${AUTO_APPROVE_PATH_PREFIX}[0]` && !/no checked-in dogfood fixture/.test(d.message),
    );
    expect(schemaError).toBeDefined();
  });

  it("the diagnostic path carries the pack's own index when it is not policy_packs[0]", () => {
    const home = fixtureWithPacks([
      { name: "branch-protection" },
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: ["dontAsk"], require_report: true } },
      },
    ]);
    const result = runValidate(home);
    const ours = result.diagnostics.filter((d) => /no checked-in dogfood fixture/.test(d.message));
    expect(ours.map((d) => d.path)).toEqual(["policy_packs[1].config.auto_approve.when[0]"]);
  });

  it("a manifest without auto_approve produces no diagnostic from this check", () => {
    const home = fixtureWithPacks([{ name: "understanding-before-execution" }]);
    const result = runValidate(home);
    const diags = result.diagnostics.filter((d) => d.path.startsWith(AUTO_APPROVE_PATH_PREFIX));
    expect(diags).toEqual([]);
  });

  it("a malformed auto_approve.when (not an array) produces no diagnostic from this check", () => {
    const home = fixtureWithPacks([
      {
        name: "understanding-before-execution",
        config: { auto_approve: { when: "bypassPermissions", require_report: true } },
      },
    ]);
    const result = runValidate(home);
    // This check only ever reports at an indexed `when[<j>]` path; filter
    // that shape specifically so the schema check's own diagnostic at the
    // un-indexed `when` path (asserted below) is not mistaken for a
    // double-report by this check.
    const diags = result.diagnostics.filter((d) =>
      d.path.startsWith(`${AUTO_APPROVE_PATH_PREFIX}[`),
    );
    expect(diags).toEqual([]);
    // The zod schema check still reports the shape error; this check does
    // not double-report it.
    const schemaError = result.diagnostics.find(
      (d) => d.path === "policy_packs[0].config.auto_approve.when" && d.severity === "error",
    );
    expect(schemaError).toBeDefined();
  });
});
