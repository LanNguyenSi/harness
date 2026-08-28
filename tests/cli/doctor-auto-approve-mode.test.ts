// Tests for the `auto_approve`-outside-`grill_me` doctor advisory
// (agent-tasks abfad738, follow-up of ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1): `harness
// doctor` warns (never errors) when the understanding-gate pack's
// `config.auto_approve` opts a session into the hook-written signed
// auto-marker path but `config.mode` is not `grill_me`, the auto
// path's report precondition only validates the report's contents in
// that mode, so pairing `auto_approve` with a weaker mode silently
// degrades the gate.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { checkAutoApproveMode } from "../../src/cli/doctor/auto-approve-mode.js";
import { parseManifest } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

function packWith(config: Record<string, unknown>, enabled = true) {
  return parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", config, enabled }],
  });
}

const AUTO_APPROVE = {
  when: ["bypassPermissions"],
  require_report: true,
};

describe("checkAutoApproveMode: pure function", () => {
  it("no warning when auto_approve is absent", () => {
    const manifest = packWith({ mode: "fast_confirm" });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("no warning when mode is grill_me", () => {
    const manifest = packWith({ mode: "grill_me", auto_approve: AUTO_APPROVE });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("no warning when the pack is not declared at all", () => {
    const manifest = parseManifest({ version: 1 });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("no warning when the pack is declared but disabled", () => {
    const manifest = packWith({ mode: "fast_confirm", auto_approve: AUTO_APPROVE }, false);
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("warns with the configured mode when auto_approve is set and mode is not grill_me", () => {
    const manifest = packWith({ mode: "fast_confirm", auto_approve: AUTO_APPROVE });
    const result = checkAutoApproveMode(manifest);
    expect(result).toBeDefined();
    expect(result?.mode).toBe("fast_confirm");
    expect(result?.message).toBe(
      "auto_approve is configured with mode fast_confirm (policy_packs[understanding-before-execution].config.mode); report validation is structural only outside grill_me",
    );
    expect(result?.detail).toEqual([
      "set config.mode: grill_me, or accept the weaker report gate; see docs/policy-packs/understanding-before-execution.md",
    ]);
  });

  it("no warning when mode is absent (resolves to the grill_me default)", () => {
    // `resolveModeFromConfig` falls back to DEFAULT_MODE (`grill_me`)
    // when `config.mode` is absent, and that resolved value is what the
    // generated Stop-hook command actually passes as
    // `UNDERSTANDING_GATE_MODE`, a report written under an unset
    // `mode` genuinely carries `grill_me`, so there is nothing to warn
    // about here.
    const manifest = packWith({ auto_approve: AUTO_APPROVE });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("no warning for a malformed config.auto_approve (require_report: false)", () => {
    // Pins parseAutoApprove's fail-closed reading (auto-approve.ts):
    // `require_report: false` makes the whole block "not opted in"
    // (null), never a partial default, so checkAutoApproveMode has
    // nothing to flag even though `mode` is not grill_me.
    const manifest = packWith({
      mode: "fast_confirm",
      auto_approve: { ...AUTO_APPROVE, require_report: false },
    });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("no warning for a malformed config.auto_approve (unknown key)", () => {
    const manifest = packWith({
      mode: "fast_confirm",
      auto_approve: { ...AUTO_APPROVE, unknown_key: "x" },
    });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });

  it("warns with mode strict when auto_approve is set and mode is strict", () => {
    const manifest = packWith({ mode: "strict", auto_approve: AUTO_APPROVE });
    const result = checkAutoApproveMode(manifest);
    expect(result).toBeDefined();
    expect(result?.mode).toBe("strict");
    expect(result?.message).toBe(
      "auto_approve is configured with mode strict (policy_packs[understanding-before-execution].config.mode); report validation is structural only outside grill_me",
    );
  });

  it("no warning for an enum-invalid config.mode literal (resolves to grill_me)", () => {
    // An unrecognised `config.mode` literal resolves to the `grill_me`
    // default the same way an absent one does (`resolveModeFromConfig`'s
    // own fallback), with its own warning already surfaced elsewhere;
    // this check must not duplicate that.
    const manifest = packWith({ mode: "fastConfirm", auto_approve: AUTO_APPROVE });
    expect(checkAutoApproveMode(manifest)).toBeUndefined();
  });
});

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-auto-approve-mode-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

const SILENCE_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

function manifestWith(configYaml: string): string {
  return `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
${configYaml}
`;
}

const AUTO_APPROVE_YAML = `      auto_approve:
        when: [bypassPermissions]
        require_report: true
`;

describe("doctor: auto_approve outside grill_me (Environment section)", () => {
  it("adds exactly one warning and renders the Environment section when mode is not grill_me", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWith(`      mode: fast_confirm\n${AUTO_APPROVE_YAML}`),
    });
    const runDoctor = () =>
      doctor({
        configPath: path.join(home, "harness.yaml"),
        homeOverride: home,
        versionProbe: () => null,
        pathEnv: "",
        npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
        envOverride: {},
      });

    const withAuto = await runDoctor();

    const homeNoAuto = makeFixture({
      "harness.yaml": manifestWith(`      mode: fast_confirm\n`),
    });
    const withoutAuto = await doctor({
      configPath: path.join(homeNoAuto, "harness.yaml"),
      homeOverride: homeNoAuto,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(withoutAuto.ugAutoApproveMode).toBeUndefined();
    expect(withAuto.ugAutoApproveMode).toBeDefined();
    expect(withAuto.ugAutoApproveMode?.mode).toBe("fast_confirm");

    expect(withAuto.warningCount).toBe(withoutAuto.warningCount + 1);
    expect(withAuto.errorCount).toBe(withoutAuto.errorCount);

    const text = format(withAuto);
    expect(text).toMatch(/\nEnvironment\n/);
    expect(text).toContain(
      "auto_approve is configured with mode fast_confirm (policy_packs[understanding-before-execution].config.mode); report validation is structural only outside grill_me",
    );
    expect(text).toContain(
      "set config.mode: grill_me, or accept the weaker report gate; see docs/policy-packs/understanding-before-execution.md",
    );

    const textWithout = format(withoutAuto);
    expect(textWithout).not.toMatch(/\nEnvironment\n/);
  });

  it("adds no warning when mode is grill_me", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWith(`      mode: grill_me\n${AUTO_APPROVE_YAML}`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });
    expect(report.ugAutoApproveMode).toBeUndefined();
  });

  it("emits a JSON field for the warning", async () => {
    const home = makeFixture({
      "harness.yaml": manifestWith(`      mode: fast_confirm\n${AUTO_APPROVE_YAML}`),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });
    const json = JSON.parse(JSON.stringify(report));
    expect(json.ugAutoApproveMode).toEqual({
      mode: "fast_confirm",
      message:
        "auto_approve is configured with mode fast_confirm (policy_packs[understanding-before-execution].config.mode); report validation is structural only outside grill_me",
      detail: [
        "set config.mode: grill_me, or accept the weaker report gate; see docs/policy-packs/understanding-before-execution.md",
      ],
    });
  });

  it("renders the Environment section when the auto_approve-mode warning is the ONLY reason to render it", async () => {
    // Fixture deliberately silences every other Environment-section
    // contributor (no npm-bin warning via STUB_NPM_BIN_EXEC_UNKNOWN, no
    // UNDERSTANDING_GATE_MODE env override, no `.approvals/` dir, no
    // settings drift via SILENCE_DRIFT, no codex config drift since
    // `auto_approve.harnesses` never lists `codex`), so this pins that
    // `formatEnvironmentSection` treats `autoApproveMode` as sufficient
    // on its own, both to show the section and to hide it.
    const home = makeFixture({
      "harness.yaml": manifestWith(`      mode: fast_confirm\n${AUTO_APPROVE_YAML}`),
    });
    const withOnlyAutoApproveMode = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });
    expect(withOnlyAutoApproveMode.ugAutoApproveMode).toBeDefined();
    expect(withOnlyAutoApproveMode.npmGlobalBin?.status).not.toBe("warn");
    expect(withOnlyAutoApproveMode.understandingModeEnv).toBeUndefined();
    expect(withOnlyAutoApproveMode.ugAutoApprovals?.approvalsDirPresent).not.toBe(true);
    expect(withOnlyAutoApproveMode.codexConfigDrift).toBeUndefined();
    expect(format(withOnlyAutoApproveMode)).toMatch(/\nEnvironment\n/);

    const homeNone = makeFixture({
      "harness.yaml": manifestWith(`      mode: grill_me\n`),
    });
    const withNone = await doctor({
      configPath: path.join(homeNone, "harness.yaml"),
      homeOverride: homeNone,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });
    expect(withNone.ugAutoApproveMode).toBeUndefined();
    expect(format(withNone)).not.toMatch(/\nEnvironment\n/);
  });
});
