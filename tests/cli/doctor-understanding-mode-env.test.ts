// Tests for the understanding-gate mode env/config divergence advisory
// (task 24abdecb, reviewer finding on the 5d73d78d verification round):
// `harness doctor` warns (never errors) when `UNDERSTANDING_GATE_MODE` is
// set in the operator environment and diverges from
// `policy_packs[understanding-before-execution].config.mode`. Every case
// below injects `envOverride` (never touches real `process.env`) and the
// doctor()-level cases use an isolated tmp `homeOverride` plus stubbed
// npm/MCP probes, so nothing here reads or writes the operator's real
// `~/.harness` or `~/.claude`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { checkUnderstandingModeEnvDivergence } from "../../src/cli/doctor/understanding-mode-env.js";
import { parseManifest } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

function packWith(config: Record<string, unknown>, enabled = true) {
  const m = parseManifest({
    version: 1,
    policy_packs: [{ name: "understanding-before-execution", config, enabled }],
  });
  return m;
}

describe("checkUnderstandingModeEnvDivergence — pure function", () => {
  it("no advisory when the env var is unset", () => {
    const manifest = packWith({ mode: "grill_me" });
    expect(checkUnderstandingModeEnvDivergence(manifest, {})).toBeUndefined();
  });

  it("no advisory when the env var is set to the empty string", () => {
    const manifest = packWith({ mode: "grill_me" });
    expect(
      checkUnderstandingModeEnvDivergence(manifest, { UNDERSTANDING_GATE_MODE: "" }),
    ).toBeUndefined();
  });

  it("no advisory when env and config.mode agree", () => {
    const manifest = packWith({ mode: "grill_me" });
    expect(
      checkUnderstandingModeEnvDivergence(manifest, {
        UNDERSTANDING_GATE_MODE: "grill_me",
      }),
    ).toBeUndefined();
  });

  it("no advisory when env and config.mode agree after normalisation (trim + lowercase)", () => {
    const manifest = packWith({ mode: "grill_me" });
    expect(
      checkUnderstandingModeEnvDivergence(manifest, {
        UNDERSTANDING_GATE_MODE: " Grill_Me ",
      }),
    ).toBeUndefined();
  });

  it("no advisory when the env value is not a recognised mode (the live resolver would ignore it too)", () => {
    const manifest = packWith({ mode: "grill_me" });
    expect(
      checkUnderstandingModeEnvDivergence(manifest, {
        UNDERSTANDING_GATE_MODE: "bogus",
      }),
    ).toBeUndefined();
  });

  it("no advisory when the pack is not declared at all", () => {
    const manifest = parseManifest({ version: 1 });
    expect(
      checkUnderstandingModeEnvDivergence(manifest, {
        UNDERSTANDING_GATE_MODE: "fast_confirm",
      }),
    ).toBeUndefined();
  });

  it("no advisory when the pack is declared but disabled", () => {
    const manifest = packWith({ mode: "grill_me" }, false);
    expect(
      checkUnderstandingModeEnvDivergence(manifest, {
        UNDERSTANDING_GATE_MODE: "fast_confirm",
      }),
    ).toBeUndefined();
  });

  it("advisory fires when env and config.mode diverge, naming both values", () => {
    const manifest = packWith({ mode: "grill_me" });
    const result = checkUnderstandingModeEnvDivergence(manifest, {
      UNDERSTANDING_GATE_MODE: "fast_confirm",
    });
    expect(result).toBeDefined();
    expect(result?.envMode).toBe("fast_confirm");
    expect(result?.configMode).toBe("grill_me");
    expect(result?.message).toContain("UNDERSTANDING_GATE_MODE=fast_confirm");
    expect(result?.message).toContain(
      "policy_packs[understanding-before-execution].config.mode=grill_me",
    );
  });

  it("advisory fires against the default config.mode (grill_me) when no config.mode key is set", () => {
    const manifest = packWith({});
    const result = checkUnderstandingModeEnvDivergence(manifest, {
      UNDERSTANDING_GATE_MODE: "fast_confirm",
    });
    expect(result).toEqual(
      expect.objectContaining({ envMode: "fast_confirm", configMode: "grill_me" }),
    );
  });
});

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-understanding-mode-env-"));
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

function manifestWithUnderstandingPack(mode: string): string {
  return `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: ${mode}
`;
}

describe("doctor — understanding-gate mode env/config divergence (Environment section)", () => {
  it("adds a warning and renders the Environment section when env diverges from config.mode", async () => {
    const home = makeFixture({ "harness.yaml": manifestWithUnderstandingPack("grill_me") });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: { UNDERSTANDING_GATE_MODE: "fast_confirm" },
    });
    expect(report.understandingModeEnv).toBeDefined();
    expect(report.understandingModeEnv?.envMode).toBe("fast_confirm");
    expect(report.understandingModeEnv?.configMode).toBe("grill_me");
    expect(report.warningCount).toBeGreaterThanOrEqual(1);

    const text = format(report);
    expect(text).toMatch(/\nEnvironment\n/);
    expect(text).toContain("UNDERSTANDING_GATE_MODE=fast_confirm");
    expect(text).toContain("config.mode=grill_me");
  });

  it("adds no warning and omits the section when the env var is unset", async () => {
    const home = makeFixture({ "harness.yaml": manifestWithUnderstandingPack("grill_me") });
    const reportUnset = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });
    expect(reportUnset.understandingModeEnv).toBeUndefined();
    expect(format(reportUnset)).not.toMatch(/\nEnvironment\n/);

    const reportSame = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: { UNDERSTANDING_GATE_MODE: "grill_me" },
    });
    expect(reportSame.understandingModeEnv).toBeUndefined();
    expect(format(reportSame)).not.toMatch(/\nEnvironment\n/);
  });
});
