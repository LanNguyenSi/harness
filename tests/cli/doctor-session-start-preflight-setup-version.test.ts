import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultVersionProbe } from "../../src/cli/index.js";
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

// Writes a real, executable `preflight` script into a fresh temp dir and
// prepends that dir to the process's real PATH for the duration of the
// test (restored via `cleanups`, same afterEach as makeFixture). Unlike
// the injected-`versionProbe` cases below, this drives a genuine spawn
// through production's `defaultVersionProbe` (src/cli/index.ts, imported
// above) rather than stubbing the return value directly.
function putFakePreflightOnPath(version: string): void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-fakebin-"));
  const fakeBin = path.join(binDir, "preflight");
  fs.writeFileSync(fakeBin, ["#!/bin/sh", `printf 'preflight ${version}\\n'`, ""].join("\n"), {
    mode: 0o755,
  });
  const priorPath = process.env["PATH"];
  process.env["PATH"] = `${binDir}${path.delimiter}${priorPath ?? ""}`;
  cleanups.push(() => {
    if (priorPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = priorPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });
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

describe("doctor: session_start_preflight.setup version floor (task 6993d9b5)", () => {
  it("renders the warning end-to-end through doctor()/format() with a stubbed version probe returning preflight 0.5.0", async () => {
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

  // task 6993d9b5, criterion 1: "tests with a fake preflight on PATH for
  // both cases": this pair drives a real spawn against a genuine
  // executable placed on the process's PATH via production's
  // `defaultVersionProbe` (imported above), not an injected return-value
  // stub.
  it("warns end-to-end through doctor()/format() with a real fake preflight 0.5.0 binary on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    putFakePreflightOnPath("0.5.0");
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: defaultVersionProbe,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
    });
    const text = format(report);
    expect(text).toContain("0.5.0");
    expect(text).toContain("0.6.0");
  });

  it("stays silent through doctor()/format() with a real fake preflight 0.6.0 binary on PATH", async () => {
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    putFakePreflightOnPath("0.6.0");
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: defaultVersionProbe,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
    const text = format(report);
    expect(text).not.toMatch(/session_start_preflight\.setup is enabled but/);
  });

  it("stays silent through doctor()/format() with a stubbed version probe returning preflight 0.6.0", async () => {
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

  it("stays silent through doctor()/format() with a stubbed version probe returning preflight 0.7.1", async () => {
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

  it("stays silent through doctor() when setup is false, even with a stubbed version probe returning preflight 0.5.0", async () => {
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

  it("stays silent through doctor() when session_start_preflight is absent entirely, even with a stubbed version probe returning preflight 0.5.0", async () => {
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

// task 6993d9b5, round 2 F2: `agent-primitives probe` mutated
// `if (report.sessionStartPreflightSetupVersion) warningCount++;` to
// `if (false) warningCount++;` at src/cli/doctor/index.ts and the mutant
// SURVIVED both tests/cli and tests/integration, because the only
// touching assertion was `toBeGreaterThanOrEqual(1)`, which the mutant
// also satisfies whenever some other check independently warns. This
// test instead runs doctor() twice on the SAME fixture, differing only
// in `session_start_preflight.setup`, and asserts the warningCount
// DELTA is exactly 1: a mutant that drops the `warningCount++` collapses
// the delta to 0 and fails this assertion.
describe("doctor: warningCount delta for session_start_preflight.setup (task 6993d9b5, round 2 F2)", () => {
  it("counts exactly one more warning when setup is true than when it is false, same probe", async () => {
    const versionProbe = (cmd: readonly string[]) =>
      cmd[0] === "preflight" ? "preflight 0.5.0\n" : null;
    const homeWithSetup = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    const homeWithoutSetup = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: false"),
    });
    const withSetup = await doctor({
      configPath: path.join(homeWithSetup, "harness.yaml"),
      homeOverride: homeWithSetup,
      versionProbe,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    const withoutSetup = await doctor({
      configPath: path.join(homeWithoutSetup, "harness.yaml"),
      homeOverride: homeWithoutSetup,
      versionProbe,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(withSetup.sessionStartPreflightSetupVersion).toBeDefined();
    expect(withoutSetup.sessionStartPreflightSetupVersion).toBeUndefined();
    expect(withSetup.warningCount - withoutSetup.warningCount).toBe(1);
  });
});

// task 6993d9b5, round 2 F4: on a manifest that both declares a
// `git-preflight`-shaped hook (min_version + version_command, checked by
// the generic `hooks[]` walk) AND has `session_start_preflight.setup:
// true` (checked by this module's own floor), both checks probe the
// IDENTICAL `["preflight", "--version"]` argv. Before doctor() shared one
// memoized probe across both call sites, that argv spawned twice per
// `doctor` run; `memoizeVersionProbe` (src/cli/doctor/index.ts) existed
// already but was only wired into the policy-pack-hook walk.
describe("doctor: shared version-probe memoization across checks (task 6993d9b5, round 2 F4)", () => {
  it("spawns the preflight --version probe once even though two checks need it", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: git-preflight
    event: SessionStart
    command: harness session-start preflight
    blocking: false
    min_version: "0.6.0"
    version_command: ["preflight", "--version"]
session_start_preflight:
  setup: true
policies: []
tools:
  builtin:
    known: []
`,
    });
    const recordedArgv: Array<readonly string[]> = [];
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => {
        recordedArgv.push(cmd);
        return "preflight 0.7.1\n";
      },
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    // Both the git-preflight hook (report.hooks[0].version) and the
    // session_start_preflight.setup check are satisfied (0.7.1 is above
    // both floors), but that is not what this test pins: the pin is the
    // SPAWN COUNT for the shared argv, which the recordedArgv array
    // below asserts directly, independent of either check's result.
    expect(report.hooks.find((h) => h.name === "git-preflight")?.version?.status).toBe("ok");
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
    const preflightVersionCalls = recordedArgv.filter(
      (cmd) => cmd.length === 2 && cmd[0] === "preflight" && cmd[1] === "--version",
    );
    expect(preflightVersionCalls).toHaveLength(1);
  });
});

// task 6993d9b5, round 2 F4: on a manifest shaped like FULL_TEMPLATE (a
// git-preflight hook with min_version 0.6.0 alongside
// session_start_preflight.setup: true) probed against an installed
// preflight 0.5.0, the generic hooks[] min_version walk and this
// module's own floor check both fire, and BOTH count toward
// warningCount. This is by design (documented in docs/CLI.md's VERSION
// CAVEAT and this module's header): the hook floor guards the hook
// itself, the setup check guards the --setup build-step feature
// specifically, and a stale preflight breaks both independently.
describe("doctor: both the hook floor and the setup-version floor fire on a stale preflight (task 6993d9b5, round 2 F4)", () => {
  it("reports both warnings, not a deduplicated one, on a FULL_TEMPLATE-shaped manifest", async () => {
    const home = makeFixture({
      "harness.yaml": `version: 1
hooks:
  - name: git-preflight
    event: SessionStart
    command: harness session-start preflight
    blocking: false
    min_version: "0.6.0"
    version_command: ["preflight", "--version"]
session_start_preflight:
  setup: true
policies: []
tools:
  builtin:
    known: []
`,
    });
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    const hookVersion = report.hooks.find((h) => h.name === "git-preflight")?.version;
    expect(hookVersion?.status).toBe("warn");
    if (hookVersion?.status === "warn") {
      expect(hookVersion.kind).toBe("below_floor");
    }
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
    });
    // Both fire independently: a doctor() that deduplicated the two
    // warnings into one would fail this count.
    const baseline = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => "preflight 0.7.1\n",
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.warningCount - baseline.warningCount).toBe(2);
  });
});
