// Tests for the Codex config-drift check (follow-up of slice 2 of ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md, agent-tasks
// f59ea0eb): a live `approval_policy = "never"` or full-access
// `default_permissions` selection in `$CODEX_HOME/config.toml` or
// `<repo>/.codex/config.toml`, gated on the understanding-gate pack's
// `auto_approve.harnesses` listing `codex`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import {
  buildCodexConfigDrift,
  isCodexOptedIntoAutoApprove,
} from "../../src/cli/doctor/codex-config-drift.js";
import { buildLastApply, writeLastApply } from "../../src/io/last-apply.js";
import type { Manifest } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

const NO_SNAPSHOT_SUFFIX = " (harness keeps no apply-time snapshot of this file; presence only)";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fixture {
  projectDir: string;
  home: string;
  generatedDir: string;
  lockPath: string;
}

function makeFixture(): Fixture {
  const projectDir = tempDir("harness-doctor-codex-config-drift-project-");
  const home = tempDir("harness-doctor-codex-config-drift-home-");
  return {
    projectDir,
    home,
    generatedDir: path.join(projectDir, "harness.generated"),
    lockPath: path.join(projectDir, "harness.lock"),
  };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

const codexHomeConfigPath = (f: Fixture) => path.join(f.home, ".codex", "config.toml");
const repoCodexConfigPath = (f: Fixture) => path.join(f.projectDir, ".codex", "config.toml");

function basePolicyPack(config: Record<string, unknown>): Manifest["policy_packs"][number] {
  return {
    name: "understanding-before-execution",
    source: "builtin",
    enabled: true,
    config,
  } as Manifest["policy_packs"][number];
}

describe("isCodexOptedIntoAutoApprove: pure function", () => {
  it("true when auto_approve.harnesses lists codex", () => {
    const manifest = {
      policy_packs: [
        basePolicyPack({
          auto_approve: { when: ["bypassPermissions"], harnesses: ["codex"], require_report: true },
        }),
      ],
    } as unknown as Manifest;
    expect(isCodexOptedIntoAutoApprove(manifest)).toBe(true);
  });

  it("false when auto_approve.harnesses lists only claude-code", () => {
    const manifest = {
      policy_packs: [
        basePolicyPack({
          auto_approve: {
            when: ["bypassPermissions"],
            harnesses: ["claude-code"],
            require_report: true,
          },
        }),
      ],
    } as unknown as Manifest;
    expect(isCodexOptedIntoAutoApprove(manifest)).toBe(false);
  });

  it("false when auto_approve.harnesses is omitted (default [claude-code] does not cover codex)", () => {
    const manifest = {
      policy_packs: [
        basePolicyPack({
          auto_approve: { when: ["bypassPermissions"], require_report: true },
        }),
      ],
    } as unknown as Manifest;
    expect(isCodexOptedIntoAutoApprove(manifest)).toBe(false);
  });

  it("false when auto_approve is absent", () => {
    const manifest = {
      policy_packs: [basePolicyPack({ mode: "grill_me" })],
    } as unknown as Manifest;
    expect(isCodexOptedIntoAutoApprove(manifest)).toBe(false);
  });

  it("false when the pack is not declared at all", () => {
    const manifest = { policy_packs: [] } as unknown as Manifest;
    expect(isCodexOptedIntoAutoApprove(manifest)).toBe(false);
  });
});

describe("buildCodexConfigDrift: pure function", () => {
  it('warns on approval_policy = "never" in $CODEX_HOME/config.toml', () => {
    const f = makeFixture();
    writeFile(codexHomeConfigPath(f), 'approval_policy = "never"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in ~/.codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it('warns on approval_policy = "never" in <repo>/.codex/config.toml', () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it("resolves $CODEX_HOME from env when set, not the default ~/.codex", () => {
    const f = makeFixture();
    const codexHomeOverride = tempDir("harness-doctor-codex-config-drift-codexhome-");
    writeFile(path.join(codexHomeOverride, "config.toml"), 'approval_policy = "never"\n');
    // The default ~/.codex/config.toml also exists but must NOT be the one
    // reported on, since CODEX_HOME is set.
    writeFile(codexHomeConfigPath(f), "sandbox_mode = \"workspace-write\"\n");

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: { CODEX_HOME: codexHomeOverride },
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in $CODEX_HOME/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it("warns on a full-access default_permissions selection", () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), 'default_permissions = ":danger-full-access"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `default_permissions = ":danger-full-access" (full access) set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it("no warning for a non-full-access default_permissions selection", () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), 'default_permissions = ":read-only"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
  });

  it("no false positive: a value that merely contains danger-full-access as a substring, not an exact match (L1)", () => {
    const f = makeFixture();
    writeFile(
      repoCodexConfigPath(f),
      'default_permissions = ":not-danger-full-access-really"\n',
    );

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
  });

  it("config without the risky keys: no warnings", () => {
    const f = makeFixture();
    writeFile(
      repoCodexConfigPath(f),
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
    );

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
  });

  it("a key inside a [table] (a profile-scoped setting) is not treated as root-level (documented M2 limitation)", () => {
    const f = makeFixture();
    writeFile(
      repoCodexConfigPath(f),
      '[profiles.myprofile]\napproval_policy = "never"\n',
    );

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
  });

  it('a quoted root-level key ("approval_policy" = "never") is still detected (L1/M2)', () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), '"approval_policy" = "never"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it("approval_policy = 'never' (literal single-quoted value) is detected", () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), "approval_policy = 'never'\n");

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it('approval_policy="never" (no surrounding spaces around =) is detected', () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), 'approval_policy="never"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it("a body line inside a multi-line string is not mistaken for a root-level assignment (L2)", () => {
    const f = makeFixture();
    writeFile(
      repoCodexConfigPath(f),
      [
        'description = """',
        'approval_policy = "never"',
        '"""',
        'approval_policy = "on-request"',
      ].join("\n") + "\n",
    );

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    // The `approval_policy = "never"` line lives inside the `"""..."""`
    // body, so it must never be scanned as a real assignment; the real
    // root-level `approval_policy = "on-request"` after the closing
    // delimiter is not risky, so there is nothing to warn about.
    expect(result.warnings).toEqual([]);
  });

  it("malformed TOML (unterminated string) produces exactly one diagnostic and does not crash", () => {
    const f = makeFixture();
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      ".codex/config.toml: unreadable/invalid Codex config TOML",
    ]);
  });

  it("a malformed line does not hide a risky key that DID parse from a different line of the same file (M1)", () => {
    const f = makeFixture();
    writeFile(
      repoCodexConfigPath(f),
      ['sandbox_mode = "workspace-write', 'approval_policy = "never"'].join("\n") + "\n",
    );

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      ".codex/config.toml: unreadable/invalid Codex config TOML",
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });

  it("a missing config file produces no warning at all", () => {
    const f = makeFixture();
    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
  });

  it("both file locations are checked in the same run", () => {
    const f = makeFixture();
    writeFile(codexHomeConfigPath(f), 'approval_policy = "never"\n');
    writeFile(repoCodexConfigPath(f), 'default_permissions = ":danger-full-access"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain(
      `approval_policy = "never" set in ~/.codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    );
    expect(result.warnings).toContain(
      `default_permissions = ":danger-full-access" (full access) set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    );
  });

  it("a harness.generated/.last-apply snapshot is never consulted for Codex config: still reports presence-only (M4, renamed from the old annotation test)", () => {
    // Unlike settings-drift.ts, this check keeps no apply-time baseline
    // for Codex config at all (see the module header: `apply.ts` never
    // records a `kind: "target"` lock entry for the installed Codex
    // config path, and the only thing `.last-apply` ever captures for
    // Codex is harness's OWN generated hook block, not the operator's
    // live file). Writing a `.last-apply` entry that happens to carry
    // the exact same live value must not change the emitted suffix.
    const f = makeFixture();
    writeLastApply(
      f.generatedDir,
      buildLastApply({ "codex/config.toml": 'approval_policy = "never"\n' }),
    );
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const result = buildCodexConfigDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    ]);
  });
});

const HARNESS_YAML_HEADER = `version: 1
hooks: []
policies: []
doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
tools:
  builtin:
    known: [Read]
`;

function optedInHarnessYaml(): string {
  return `${HARNESS_YAML_HEADER}policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        harnesses: [codex]
        require_report: true
`;
}

describe("doctor: codex config drift (Environment section)", () => {
  it("warns and rolls into warningCount when codex is opted in and the key is present", async () => {
    const f = makeFixture();
    fs.writeFileSync(path.join(f.projectDir, "harness.yaml"), optedInHarnessYaml());
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.codexConfigDrift?.warnings).toContain(
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    );
    expect(report.warningCount).toBeGreaterThanOrEqual(1);

    const text = format(report);
    expect(text).toContain(
      `⚠ approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    );
  });

  it("the warning is what actually put warningCount +1 over the baseline (M3 delta assertion, not just >= 1)", async () => {
    const f = makeFixture();
    fs.writeFileSync(path.join(f.projectDir, "harness.yaml"), optedInHarnessYaml());

    const withoutConfig = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const withConfig = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(withoutConfig.codexConfigDrift?.warnings ?? []).toEqual([]);
    expect(withConfig.codexConfigDrift?.warnings).toHaveLength(1);
    expect(withConfig.warningCount).toBe(withoutConfig.warningCount + 1);
  });

  it("harness doctor --target codex emits the same warning as the default target", async () => {
    const f = makeFixture();
    fs.writeFileSync(path.join(f.projectDir, "harness.yaml"), optedInHarnessYaml());
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
      target: "codex",
    });

    expect(report.codexConfigDrift?.warnings).toContain(
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    );
  });

  it("--json output (JSON.stringify of the report) carries codexConfigDrift", async () => {
    const f = makeFixture();
    fs.writeFileSync(path.join(f.projectDir, "harness.yaml"), optedInHarnessYaml());
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    const parsed = JSON.parse(JSON.stringify(report)) as { codexConfigDrift?: { warnings: string[] } };
    expect(parsed.codexConfigDrift?.warnings).toContain(
      `approval_policy = "never" set in .codex/config.toml${NO_SNAPSHOT_SUFFIX}`,
    );
  });

  it("no warning when auto_approve is opted in but codex is not in harnesses (mutation-probe target)", async () => {
    const f = makeFixture();
    fs.writeFileSync(
      path.join(f.projectDir, "harness.yaml"),
      `${HARNESS_YAML_HEADER}policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        harnesses: [claude-code]
        require_report: true
`,
    );
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.codexConfigDrift).toBeUndefined();
    const text = format(report);
    expect(text).not.toContain("approval_policy");
  });

  it("no warning when auto_approve.harnesses is omitted (default [claude-code] does not cover codex, L3)", async () => {
    const f = makeFixture();
    fs.writeFileSync(
      path.join(f.projectDir, "harness.yaml"),
      `${HARNESS_YAML_HEADER}policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        require_report: true
`,
    );
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.codexConfigDrift).toBeUndefined();
  });

  it("no warning when the pack has no auto_approve block at all", async () => {
    const f = makeFixture();
    fs.writeFileSync(
      path.join(f.projectDir, "harness.yaml"),
      `${HARNESS_YAML_HEADER}policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
`,
    );
    writeFile(repoCodexConfigPath(f), 'approval_policy = "never"\n');

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.codexConfigDrift).toBeUndefined();
  });
});
