import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import {
  checkSessionStartPreflightSetupVersion,
  PREFLIGHT_SETUP_VERSION_COMMAND,
} from "../../src/cli/doctor/session-start-preflight-setup-version.js";
import { SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION } from "../../src/schema/session-start-preflight.js";
import { parseManifest } from "../../src/schema/index.js";
import { parse as parseYaml } from "yaml";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

function loadManifestFromYaml(raw: string) {
  return parseManifest(parseYaml(raw));
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

function buildManifest(setupLine: string): string {
  return `version: 1
${setupLine}
policies: []
tools:
  builtin:
    known: []
`;
}

// task 6993d9b5, criterion 1: the shared floor constant this whole check
// (and the init template's git-preflight min_version, in the sibling
// bump commit) hangs off. Pinned here so a drift between the two
// literals shows up as a failing assertion, not a silent divergence.
describe("checkSessionStartPreflightSetupVersion (task 6993d9b5)", () => {
  it("pins the required floor to the shared constant", () => {
    expect(SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION).toBe("0.6.0");
  });

  it("is silent when session_start_preflight.setup is absent, even with an ancient preflight", () => {
    const manifest = loadManifestFromYaml(buildManifest(""));
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "preflight 0.1.0\n");
    expect(finding).toBeUndefined();
  });

  it("is silent when session_start_preflight.setup is false, even with an ancient preflight", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: false"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "preflight 0.5.0\n");
    expect(finding).toBeUndefined();
  });

  it("warns naming both versions when setup is true and preflight is below the floor", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    let received: readonly string[] | null = null;
    const finding = checkSessionStartPreflightSetupVersion(manifest, (cmd) => {
      received = cmd;
      return "preflight 0.5.0\n";
    });
    expect(received).toEqual(PREFLIGHT_SETUP_VERSION_COMMAND);
    expect(finding).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message:
        "session_start_preflight.setup is enabled but installed preflight v0.5.0 < 0.6.0: " +
        "--setup on v0.5.0 is dependency-install only (no build step); upgrade preflight " +
        "(npm i -g @lannguyensi/agent-preflight) or set session_start_preflight.setup: false",
    });
    expect(finding?.message).toContain("0.5.0");
    expect(finding?.message).toContain("0.6.0");
  });

  it("is silent when setup is true and preflight is exactly at the floor", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "preflight 0.6.0\n");
    expect(finding).toBeUndefined();
  });

  it("is silent when setup is true and preflight is above the floor", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "preflight 0.7.1\n");
    expect(finding).toBeUndefined();
  });

  it("warns fail-loud (not silent) when setup is true and the probe returns nothing", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => null);
    expect(finding?.kind).toBe("probe_failed");
    expect(finding?.actualVersion).toBeNull();
    expect(finding?.message).toContain("could not be determined");
  });

  it("warns fail-loud (not silent) when setup is true and the probe returns unparseable garbage", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "no version in here\n");
    expect(finding?.kind).toBe("parse_failed");
    expect(finding?.actualVersion).toBeNull();
    expect(finding?.message).toContain("could not be parsed");
  });
});

describe("doctor — session_start_preflight.setup version floor (task 6993d9b5)", () => {
  it("renders the warning end-to-end through doctor()/format() with a fake preflight 0.5.0 on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
    });
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain("0.5.0");
    expect(text).toContain("0.6.0");
    expect(text).toMatch(/⚠.*session_start_preflight\.setup/);
  });

  it("stays silent through doctor()/format() with a fake preflight 0.6.0 on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.6.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
    const text = format(report);
    expect(text).not.toMatch(/session_start_preflight\.setup is enabled but/);
  });

  it("stays silent through doctor()/format() with a fake preflight 0.7.1 on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.7.1\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
  });

  it("stays silent through doctor() when setup is false, even with a fake preflight 0.5.0 on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: false"),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
  });

  it("stays silent through doctor() when session_start_preflight is absent entirely, even with a fake preflight 0.5.0 on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest(""),
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
  });
});
