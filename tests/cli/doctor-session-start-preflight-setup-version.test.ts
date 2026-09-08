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

// task 6993d9b5, criterion 1, split by task 65952a0c: the SETUP floor
// constant this check hangs off. Pinned here so a change to its value
// shows up as a failing assertion, not a silent drift.
describe("checkSessionStartPreflightSetupVersion (task 6993d9b5)", () => {
  it("pins the setup floor's value", () => {
    expect(SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION).toBe("0.6.0");
  });

  // Task 65952a0c (docs/decisions/2026-09-08-preflight-floors.md) split
  // the constant this check used to share with FULL_TEMPLATE's
  // git-preflight hook into two independent constants: this check must
  // keep reading SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION (the
  // SETUP floor), never GIT_PREFLIGHT_HOOK_MIN_VERSION (the HOOK floor,
  // src/cli/init/templates.ts). Both are "0.6.0" today, so a
  // value-only assertion (as in the test above, and the `required:
  // "0.6.0"` checks throughout this file) cannot tell the two apart;
  // this reads the source text and asserts which identifier the
  // `const required =` line actually binds.
  it("reads the SETUP floor identifier, not the hook floor, for `required`", () => {
    const src = fs.readFileSync(
      new URL("../../src/cli/doctor/session-start-preflight-setup-version.ts", import.meta.url),
      "utf8",
    );
    const requiredLine = src.split("\n").find((line) => line.trim().startsWith("const required ="));
    expect(
      requiredLine,
      "no const required = ... line interpolating a *_MIN_VERSION identifier found in session-start-preflight-setup-version.ts; if you aliased or wrapped the constant, update this pin per the ADR (docs/decisions/2026-09-08-preflight-floors.md), not the source",
    ).toBeDefined();
    expect(requiredLine).toContain("SESSION_START_PREFLIGHT_SETUP_BUILD_MIN_VERSION");
    expect(requiredLine).not.toContain("GIT_PREFLIGHT_HOOK_MIN_VERSION");
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

  // Prerelease decision (task 65952a0c, docs/decisions/2026-09-08-
  // preflight-floors.md): a release candidate of the floor version does
  // NOT satisfy it. "0.6.0-rc.1" does not carry the build step this
  // check exists to guarantee (a real 0.6.0 does), matching semver
  // precedence (0.6.0-rc.1 < 0.6.0). Before this task, the version-probe
  // regex only ever captured the leading numeric run, so this exact
  // input parsed to "0.6.0" and was silently treated as meeting the
  // floor; this pins the fix.
  it("is below_floor when setup is true and preflight reports a prerelease of the floor version", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "preflight 0.6.0-rc.1\n");
    expect(finding?.kind).toBe("below_floor");
    expect(finding?.actualVersion).toBe("0.6.0");
    expect(finding?.requiredVersion).toBe("0.6.0");
    expect(finding?.message).toContain("0.6.0-rc.1");
  });

  // Reviewer round 1 (T-006 R1, low): the prerelease suffix regex
  // (`src/io/version-compare.ts`'s `parseProbedVersion`) was pinned
  // only with a DOTTED suffix ("-rc.1") above; a mutant tightening the
  // suffix group to require an inner dot survived every existing test.
  // A dotless suffix ("-beta") must still be detected as a prerelease.
  it("is below_floor when setup is true and preflight reports a dotless prerelease of the floor version", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(manifest, () => "preflight 0.6.0-beta\n");
    expect(finding?.kind).toBe("below_floor");
    expect(finding?.actualVersion).toBe("0.6.0");
    expect(finding?.requiredVersion).toBe("0.6.0");
    expect(finding?.message).toContain("0.6.0-beta");
  });

  // Reviewer round 1 (T-006 R1, medium): `parseProbedVersion`'s `raw`
  // field truncates a multi-hyphen suffix at the first character
  // outside `[0-9A-Za-z.]` (a git-describe suffix like
  // "0.6.0-4-gabc123" would truncate to "0.6.0-4" at the second `-`).
  // The below_floor message must quote the FULL probed token
  // (`parseProbedVersion`'s `token` field), not the truncated `raw`.
  it("quotes the full multi-hyphen probed token in the below_floor message, not a truncated one", () => {
    const manifest = loadManifestFromYaml(
      buildManifest("session_start_preflight:\n  setup: true"),
    );
    const finding = checkSessionStartPreflightSetupVersion(
      manifest,
      () => "preflight 0.6.0-4-gabc123\n",
    );
    expect(finding?.kind).toBe("below_floor");
    expect(finding?.actualVersion).toBe("0.6.0");
    expect(finding?.message).toContain("v0.6.0-4-gabc123 <");
    expect(finding?.message).not.toContain("v0.6.0-4 <");
    // Reviewer round 2 (T-006 R2, low): the pin above only covers the
    // first of the message's two `${token}` interpolations. The
    // second, in the "--setup on v${token} is dependency-install only"
    // clause, is unpinned by the first assertion alone.
    expect(finding?.message).toContain("--setup on v0.6.0-4-gabc123 is dependency-install only");
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
      // Not inside a git work tree, so the scoped load's derived
      // project name is deterministically null (task c88461c1, review
      // round 3 residual, decision D-006's projectName field);
      // without pinning `cwd`, this would fall back to the real
      // process.cwd() and assert an environment-dependent value.
      cwd: home,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
      projectName: null,
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
      // See the projectName comment on the sibling test above.
      cwd: home,
      versionProbe: defaultVersionProbe,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
      projectName: null,
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

  // task 6993d9b5, round 3 F1: the test above only covers checkHooks and
  // this module's own floor check (both wired to `dedupedVersionProbe`
  // directly in `doctor()`), because its fixture has `policies: []`.
  // `buildPolicyPacks` (which calls `checkPolicyPackVersions`) and
  // `checkPolicyPackHookVersions` are wired to the SAME
  // `dedupedVersionProbe`, but nothing here drove a policy pack that
  // spawns a version probe, so a revert of either of those two wirings
  // back to a fresh `memoizeVersionProbe(...)` call (or to the raw,
  // un-memoized `opts.versionProbe`) would pass every test in this file
  // silently. This fixture adds an enabled `understanding-before-execution`
  // pack with a pack-level `min_version`, alongside the git-preflight hook
  // and `session_start_preflight.setup: true` from the test above, so all
  // four `dedupedVersionProbe` callers in `doctor()` fire on ONE report:
  //   - checkHooks                    -> ["preflight", "--version"]
  //   - checkSessionStartPreflightSetupVersion -> ["preflight", "--version"]
  //   - buildPolicyPacks (checkPolicyPackVersions)   -> ["understanding-gate", "--version"]
  //   - checkPolicyPackHookVersions (pack's own hooks) -> ["understanding-gate", "--version"]
  // Two distinct argvs, each expected to spawn exactly once despite four
  // call sites splitting across the two argvs 2-and-2.
  it("shares one spawn per distinct argv across all four version-probe callers", async () => {
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
policy_packs:
  - name: understanding-before-execution
    source: builtin
    enabled: true
    min_version: "0.5.0"
tools:
  builtin:
    known: []
`,
    });
    const recordedArgv: Array<readonly string[]> = [];
    const versionProbe = (cmd: readonly string[]): string | null => {
      recordedArgv.push(cmd);
      if (cmd[0] === "preflight") return "preflight 0.7.1\n";
      if (cmd[0] === "understanding-gate") return "understanding-gate 0.9.0\n";
      return null;
    };
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    // Both floors are satisfied (0.7.1 ≥ 0.6.0, 0.9.0 ≥ 0.5.0); the pin
    // below is the per-argv spawn COUNT, not either check's verdict.
    expect(report.hooks.find((h) => h.name === "git-preflight")?.version?.status).toBe("ok");
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
    expect(report.policyPacks.versionGaps).toEqual([]);
    const argvKey = (cmd: readonly string[]) => JSON.stringify(cmd);
    const counts = new Map<string, number>();
    for (const cmd of recordedArgv) {
      const key = argvKey(cmd);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.get(JSON.stringify(["preflight", "--version"]))).toBe(1);
    expect(counts.get(JSON.stringify(["understanding-gate", "--version"]))).toBe(1);
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
      // See the projectName comment in the version-floor describe
      // block above.
      cwd: home,
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
      projectName: null,
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

// Review round 2, decision D-021b: round 1's `checkSessionStartPreflightSetupVersion`
// judged only the manifest `doctor()` loaded from `opts` DIRECTLY (base
// plus machine-override layers), never a per-repo project layer, because
// `doctor()`'s own `loadManifest(opts)` call never derived a project name
// from `opts.cwd`. The round-1 reviewer reproduced this: a stub preflight
// below the floor warned/stayed-silent against the BASE value while the
// producer (`harness session-start preflight`) actually read a DIFFERENT,
// project-layer-scoped effective value for the same repo. These two tests
// drive `doctor()` with a `cwd` pointing at a fixture repo that has a
// matching `<home>/projects/<name>/harness.overrides.yaml`, in both merge
// directions, and assert the check now judges the EFFECTIVE per-repo
// value, not the base/machine one.
describe("doctor: session_start_preflight per-repo effective value (task c88461c1, review round 2, decision D-021b)", () => {
  function makeRepoFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-repo-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  function writeProjectLayer(home: string, projectName: string, setup: boolean): void {
    const projectDir = path.join(home, "projects", projectName);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      ["session_start_preflight:", `  setup: ${setup}`, ""].join("\n"),
    );
  }

  it("warns against a stale preflight when the base is false but the cwd-derived project layer turns setup on", async () => {
    const repoName = "doctor-scope-on-repo";
    const repo = makeRepoFixture(repoName);
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: false"),
    });
    writeProjectLayer(home, repoName, true);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
      // task c88461c1, review round 3 residual, decision D-006: the
      // cwd-derived project name this check's own verdict came from,
      // carried on the finding.
      projectName: repoName,
    });
    // Task 1c4eb3ea, round 2, D-027 item 2: format.ts renders the
    // carried projectName as a `(project: X)` suffix on the warning
    // line. Round 1 shipped this rendering with no test asserting it
    // (a probe forcing the suffix condition to `false` survived).
    const text = format(report);
    expect(text).toContain(`(project: ${repoName})`);
  });

  it("does NOT render the (project: X) suffix when no project layer decided the value (negative control)", async () => {
    // Task 1c4eb3ea, round 2, D-027 items 1 and 2: a cwd inside a git
    // work tree still ATTEMPTS a project-name derivation even when no
    // matching `<home>/projects/<name>/harness.overrides.yaml` exists
    // on disk; the finding's `projectName` (and therefore format.ts's
    // suffix) must stay absent in that case, not name the attempted
    // derivation, so the suffix is genuinely distinguishable from a
    // base/machine-decided warning.
    const repoName = "doctor-scope-no-layer-repo";
    const repo = makeRepoFixture(repoName);
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    // No `<home>/projects/<repoName>/...` layer written at all.
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toEqual({
      kind: "below_floor",
      actualVersion: "0.5.0",
      requiredVersion: "0.6.0",
      message: expect.stringContaining("v0.5.0 < 0.6.0"),
      projectName: null,
    });
    const text = format(report);
    expect(text).not.toContain("(project:");
  });

  it("stays silent when the base is true but the cwd-derived project layer turns setup off (the inverse), even with an ancient preflight", async () => {
    const repoName = "doctor-scope-off-repo";
    const repo = makeRepoFixture(repoName);
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    writeProjectLayer(home, repoName, false);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
  });

  it("does not pick up a project layer named after an unrelated repo", async () => {
    const repoName = "doctor-scope-unrelated-repo";
    const repo = makeRepoFixture(repoName);
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: false"),
    });
    writeProjectLayer(home, "some-other-repo", true);
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.5.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.sessionStartPreflightSetupVersion).toBeUndefined();
  });
});

// Review round 3, decision D-028: the derived project layer this task
// wires through `doctor`'s SECOND load must be scoped to
// `session_start_preflight.setup` ONLY. A project layer that changes
// any OTHER key must never reach every OTHER check in this report
// (MCP/CLI/hook probes, policies, and the rest): that manifest is
// loaded PLAIN (base/machine/explicit `--project` only), exactly the
// manifest `harness policy intercept` and `harness dry-run` enforce a
// real tool call against.
describe("doctor: the derived project layer never reaches any OTHER check (task c88461c1, review round 3, decision D-028)", () => {
  function makeRepoFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-boundary-repo-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  it("keeps a required-but-missing CLI tool's error/exit signal when a cwd-derived project layer deletes it from tools.cli", async () => {
    const repoName = "doctor-boundary-repo";
    const repo = makeRepoFixture(repoName);
    const home = makeFixture({
      "harness.yaml": `version: 1
session_start_preflight:
  setup: false
policies: []
tools:
  builtin:
    known: []
  cli:
    - name: boundary-required-cli
      binary: definitely-not-a-real-binary-c88461c1
      required: true
`,
    });
    const projectDir = path.join(home, "projects", repoName);
    fs.mkdirSync(projectDir, { recursive: true });
    // If this reached the manifest EVERY OTHER check reads, it would
    // delete the required-but-missing CLI entry above and the report
    // would go error-free for a repo that is not actually healthy.
    fs.writeFileSync(
      path.join(projectDir, "harness.overrides.yaml"),
      "tools:\n  cli: []\n",
    );
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      shallow: true,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    expect(report.tools.cli).toEqual([
      expect.objectContaining({
        name: "boundary-required-cli",
        status: "error",
        message: expect.stringContaining("definitely-not-a-real-binary-c88461c1"),
      }),
    ]);
    expect(report.errorCount).toBeGreaterThanOrEqual(1);
  });
});

// Residual of task c88461c1's review round 3 (T-004 of the follow-up
// batch, decision D-006): a scoped-load failure used to keep the PLAIN
// `manifest`'s own `setup` value (a comment claimed this was NOT a
// mismatch with the producer, but the producer's own `setupEnabled`
// catch degrades to `setup: false`, see src/cli/session-start/
// index.ts). This drives the scoped load into a genuine failure (a
// malformed project layer file) against a base manifest that says
// `setup: true`.
//
// Task 1c4eb3ea, round 2, D-027 item 3: round 1 fixed the degrade
// itself (this check no longer warns against the PLAIN load's
// setup:true) but left the failure fully silent, indistinguishable
// from a genuinely off `setup`, which the task's own goal named as
// the residual gap ("no diagnostic anywhere"). This check now reports
// its own `layer_unresolvable` warning naming the layer path and the
// first line of the parse error instead of going silent.
describe("doctor: session_start_preflight.setup reports a layer_unresolvable warning on a scoped-load failure (task c88461c1 round 3 residual; task 1c4eb3ea round 2, D-027 item 3)", () => {
  function makeRepoFixture(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-ssp-unresolvable-repo-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    return repo;
  }

  it("warns layer_unresolvable (not silent, not below_floor against the plain value) when the cwd-derived project layer fails to parse, even with an ancient preflight and setup:true at the base", async () => {
    const repoName = "doctor-unresolvable-repo";
    const repo = makeRepoFixture(repoName);
    const home = makeFixture({
      "harness.yaml": buildManifest("session_start_preflight:\n  setup: true"),
    });
    const projectDir = path.join(home, "projects", repoName);
    fs.mkdirSync(projectDir, { recursive: true });
    const layerPath = path.join(projectDir, "harness.overrides.yaml");
    // Malformed YAML (an unterminated flow mapping): the scoped
    // `loadManifest` call throws while parsing this layer. The message
    // this produces is genuinely multi-line; the finding's own message
    // must collapse it to its first line (D-027 item 5).
    fs.writeFileSync(layerPath, "session_start_preflight: {setup: true\n");
    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeDir: home,
      homeOverride: home,
      cwd: repo,
      versionProbe: (cmd) => (cmd[0] === "preflight" ? "preflight 0.1.0\n" : null),
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
    });
    // If the pre-fix "keep the plain manifest's value" degrade were
    // still in place, this would warn `below_floor` against the base
    // manifest's setup:true instead; if round 2's own "goes silent"
    // fix were still in place unchanged, this would be `undefined`.
    expect(report.sessionStartPreflightSetupVersion?.kind).toBe("layer_unresolvable");
    expect(report.sessionStartPreflightSetupVersion?.actualVersion).toBeNull();
    expect(report.sessionStartPreflightSetupVersion?.projectName).toBe(repoName);
    expect(report.sessionStartPreflightSetupVersion?.message).toContain(layerPath);
    // The message carries only the FIRST line of the underlying parse
    // error, not the full multi-line YAML diagnostic (measured: the
    // raw `yaml` error message alone is 6 lines).
    expect(report.sessionStartPreflightSetupVersion?.message.split("\n")).toHaveLength(1);
    expect(report.sessionStartPreflightSetupVersion?.message).not.toContain("^");
    // Counted in warningCount (D-027 item 3); other environment-derived
    // warnings from this doctor() run (e.g. npm bin path) are not this
    // test's concern, so this only pins that the count is non-zero.
    expect(report.warningCount).toBeGreaterThanOrEqual(1);
    const text = format(report);
    expect(text).toContain(layerPath);
    expect(text).toContain(`(project: ${repoName})`);
  });
});
