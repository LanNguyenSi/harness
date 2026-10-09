// `harness doctor` expands policy packs against the runtime a plain
// `harness apply` would select (recorded in .last-apply, inferred from its
// files, else the default), not always claude-code, and names it
// (agent-tasks 04b8abcf).
//
// The runtime-following cases use `branch-protection` as the generic pack
// fixture: it declares no version probe, so nothing in the
// packExpansionRuntime surface depends on the understanding-gate pack.
// The assertions that DO need the understanding-gate hook-level version
// floor live in the UG-specific describe at the bottom and are removed
// with that pack.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../src/cli/apply/index.js";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { readLastApply, writeLastApply } from "../../src/io/last-apply.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeHome(policyPacks: unknown[] = [{ name: "branch-protection" }]): {
  home: string;
  configPath: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-runtime-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, "harness.yaml");
  fs.writeFileSync(
    configPath,
    yamlStringify({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [],
      policies: [],
      policy_packs: policyPacks,
    }),
  );
  return { home, configPath };
}

function makeUgHome(): { home: string; configPath: string } {
  return makeHome([{ name: "understanding-before-execution" }]);
}

// understanding-gate below the 0.5.0 floor the claude-code hooks declare.
const BELOW_FLOOR = () => "understanding-gate 0.4.11";

async function runDoctor(configPath: string) {
  return doctor({
    configPath,
    shallow: true,
    pathEnv: "",
    npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    versionProbe: BELOW_FLOOR,
  });
}

describe("doctor: pack expansion runtime follows the runtime apply selects", () => {
  it("codex-recorded machine: names codex (recorded by the last apply)", async () => {
    const { home, configPath } = makeHome();
    await apply({ homeDir: home, configPath, runtime: "codex" });
    expect(readLastApply(path.join(home, "harness.generated"))?.runtime).toBe("codex");

    const report = await runDoctor(configPath);
    expect(report.packExpansionRuntime).toEqual({
      runtime: "codex",
      source: "last-apply",
      previousRuntime: "codex",
    });
    const text = format(report);
    expect(text).toContain("Pack expansion runtime: codex (recorded by the last apply)");
  });

  it("claude-code-recorded machine names claude-code (recorded by the last apply)", async () => {
    const { home, configPath } = makeHome();
    await apply({ homeDir: home, configPath, runtime: "claude-code" });

    const report = await runDoctor(configPath);
    expect(report.packExpansionRuntime.runtime).toBe("claude-code");
    expect(report.packExpansionRuntime.source).toBe("last-apply");
    expect(format(report)).toContain("Pack expansion runtime: claude-code (recorded by the last apply)");
  });

  it("never applied: names the default runtime and says no apply was recorded", async () => {
    const { configPath } = makeHome();
    const report = await runDoctor(configPath);
    expect(report.packExpansionRuntime).toEqual({ runtime: "claude-code", source: "default" });
    expect(format(report)).toContain("Pack expansion runtime: claude-code (no apply recorded yet; default)");
  });

  it("record without a runtime field: infers the runtime from its files, like apply", async () => {
    const { home, configPath } = makeHome();
    await apply({ homeDir: home, configPath, runtime: "codex" });
    const generatedDir = path.join(home, "harness.generated");
    const record = readLastApply(generatedDir)!;
    const { runtime: _dropped, ...withoutRuntime } = record;
    writeLastApply(generatedDir, withoutRuntime as typeof record);

    const report = await runDoctor(configPath);
    expect(report.packExpansionRuntime.runtime).toBe("codex");
    expect(report.packExpansionRuntime.source).toBe("inferred");
    expect(format(report)).toContain(
      "Pack expansion runtime: codex (inferred from the last apply's generated files)",
    );
  });

  it("malformed .last-apply: does not crash, falls back to the default and warns naming the file", async () => {
    // No pack declared: doctor's own read of the record is what is
    // under test.
    const { home, configPath } = makeHome([]);
    await apply({ homeDir: home, configPath, runtime: "codex" });
    const target = path.join(home, "harness.generated", ".last-apply");
    fs.writeFileSync(target, "{ not json");

    const report = await runDoctor(configPath);
    expect(report.packExpansionRuntime.runtime).toBe("claude-code");
    expect(report.packExpansionRuntime.source).toBe("default");
    expect(report.packExpansionRuntime.warning).toContain(target);
    const text = format(report);
    expect(text).toContain(`warning: ${target} is unreadable`);
    // The malformed record counts as a warning in the summary.
    const clean = makeHome([]);
    const cleanReport = await runDoctor(clean.configPath);
    expect(report.warningCount).toBe(cleanReport.warningCount + 1);
  });
});

// UG-specific: these assertions need the understanding-gate hook-level
// version floor (the claude-code hooks of the
// `understanding-before-execution` pack declare a 0.5.0 floor, the codex
// ones declare none) to be falsifiable at all; with any probe-less pack
// `policyPackHookVersions` is trivially empty. They are deleted together
// with the pack.
describe("doctor - policyPackHookVersions follows the expansion runtime (UG-specific)", () => {
  it("UG floor gap: a codex-expansion machine reports no hook floor gap at all", async () => {
    const { home, configPath } = makeUgHome();
    await apply({ homeDir: home, configPath, runtime: "codex" });

    const report = await runDoctor(configPath);
    // The codex hooks declare no understanding-gate floor, so the gap the
    // claude-code expansion reports is not a finding on this machine.
    expect(report.policyPackHookVersions).toHaveLength(0);
    expect(format(report)).not.toContain("Policy-pack hooks");
  });

  it("UG floor gap: a claude-code-recorded machine keeps reporting it", async () => {
    const { home, configPath } = makeUgHome();
    await apply({ homeDir: home, configPath, runtime: "claude-code" });

    const report = await runDoctor(configPath);
    expect(report.policyPackHookVersions.length).toBeGreaterThanOrEqual(1);
  });

  it("UG floor gap: never applied, the default claude-code expansion reports it", async () => {
    const { configPath } = makeUgHome();
    const report = await runDoctor(configPath);
    expect(report.policyPackHookVersions.length).toBeGreaterThanOrEqual(1);
  });

  it("UG floor gap: an inferred codex expansion (record without a runtime field) reports none", async () => {
    const { home, configPath } = makeUgHome();
    await apply({ homeDir: home, configPath, runtime: "codex" });
    const generatedDir = path.join(home, "harness.generated");
    const record = readLastApply(generatedDir)!;
    const { runtime: _dropped, ...withoutRuntime } = record;
    writeLastApply(generatedDir, withoutRuntime as typeof record);

    const report = await runDoctor(configPath);
    expect(report.policyPackHookVersions).toHaveLength(0);
  });
});
