// Tests for the "bypassPermissions observed, auto_approve missing"
// doctor finding (task 8f637efd, docs/decisions/2026-08-27-ug-auto-mode-
// approval.md, "Amendment: install default").
//
// Mutation probe M2: invert the finding's `covered` condition in
// bypass-without-auto-approve.ts (report when auto_approve IS present
// instead of when it is absent/mismatched) and BOTH the fixture test
// ("fires ...") and the negative control ("does not fire ...") below go
// red: the fixture test because the finding now vanishes when it
// should fire, the negative control because it now fires when it
// should stay silent.
//
// Review round 2 F2: the `harnessAllowed(autoApprove, CLAUDE_CODE_HARNESS)`
// leg of `covered` was inert (no test exercised the case where `when`
// covers `bypassPermissions` but `harnesses` does not cover
// `claude-code`); "auto_approve present but claude-code not in
// harnesses (codex only): still fires" below covers it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { checkBypassWithoutAutoApprove } from "../../src/cli/doctor/bypass-without-auto-approve.js";
import { parseManifest, type Manifest } from "../../src/schema/index.js";
import { parse as parseYaml } from "yaml";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempGeneratedDir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-bypass-auto-approve-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return path.join(home, "harness.generated");
}

function writeObservation(
  generatedDir: string,
  sessionId: string,
  permissionMode: string,
  observedAt: string,
): void {
  const dir = path.join(generatedDir, ".permission-mode-observations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, sessionId),
    JSON.stringify({ sessionId, permissionMode, observedAt }),
    "utf8",
  );
}

const SILENCE_DRIFT = `doctor:
  ignore_template_drift:
    - deny-kill-switch-bypass
    - deny-session-env-strip
    - deny-pause-sentinel-forgery
`;

const MANIFEST_NO_AUTO_APPROVE = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
`;

const MANIFEST_WITH_AUTO_APPROVE = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        harnesses: [claude-code]
        require_report: true
`;

const MANIFEST_WITHOUT_PACK = `version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
`;

function manifestFor(yamlText: string): Manifest {
  return parseManifest(parseYaml(yamlText));
}

describe("checkBypassWithoutAutoApprove: pure function", () => {
  it("no observations directory at all: undefined", () => {
    const generatedDir = tempGeneratedDir();
    const result = checkBypassWithoutAutoApprove(manifestFor(MANIFEST_NO_AUTO_APPROVE), generatedDir, {
      recentSessions: 20,
    });
    expect(result).toBeUndefined();
  });

  it("bypassPermissions observed, auto_approve absent: fires, naming the newest qualifying session", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-old", "bypassPermissions", "2026-08-29T09:00:00.000Z");
    writeObservation(generatedDir, "sess-new", "bypassPermissions", "2026-08-29T10:00:00.000Z");
    writeObservation(generatedDir, "sess-default", "default", "2026-08-29T11:00:00.000Z");

    const result = checkBypassWithoutAutoApprove(manifestFor(MANIFEST_NO_AUTO_APPROVE), generatedDir, {
      recentSessions: 20,
    });
    expect(result).toBeDefined();
    expect(result?.sessionId).toBe("sess-new");
    expect(result?.observedAt).toBe("2026-08-29T10:00:00.000Z");
    expect(result?.message).toContain("bypassPermissions");
    expect(result?.detail.join("\n")).toContain("harness pack upgrade understanding-before-execution");
    expect(result?.detail.join("\n")).toContain("auto_approve:");
    expect(result?.detail.join("\n")).toContain("when: [bypassPermissions]");
  });

  it("negative control: bypassPermissions observed, auto_approve already covers it: does not fire", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-new", "bypassPermissions", "2026-08-29T10:00:00.000Z");

    const result = checkBypassWithoutAutoApprove(
      manifestFor(MANIFEST_WITH_AUTO_APPROVE),
      generatedDir,
      { recentSessions: 20 },
    );
    expect(result).toBeUndefined();
  });

  it("only a non-bypass mode observed: does not fire even without auto_approve", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-a", "default", "2026-08-29T10:00:00.000Z");
    writeObservation(generatedDir, "sess-b", "acceptEdits", "2026-08-29T11:00:00.000Z");

    const result = checkBypassWithoutAutoApprove(manifestFor(MANIFEST_NO_AUTO_APPROVE), generatedDir, {
      recentSessions: 20,
    });
    expect(result).toBeUndefined();
  });

  it("auto_approve present but bypassPermissions not in when: still fires", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-new", "bypassPermissions", "2026-08-29T10:00:00.000Z");
    const manifest = manifestFor(`version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [acceptEdits]
        harnesses: [claude-code]
        require_report: true
`);
    const result = checkBypassWithoutAutoApprove(manifest, generatedDir, { recentSessions: 20 });
    expect(result).toBeDefined();
    expect(result?.sessionId).toBe("sess-new");
  });

  it("auto_approve present but claude-code not in harnesses (codex only): still fires", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-new", "bypassPermissions", "2026-08-29T10:00:00.000Z");
    const manifest = manifestFor(`version: 1
hooks: []
policies: []
${SILENCE_DRIFT}tools:
  builtin:
    known: [Read]
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
      auto_approve:
        when: [bypassPermissions]
        harnesses: [codex]
        require_report: true
`);
    const result = checkBypassWithoutAutoApprove(manifest, generatedDir, { recentSessions: 20 });
    expect(result).toBeDefined();
    expect(result?.sessionId).toBe("sess-new");
  });

  it("pack not declared: does not fire, even with a qualifying observation on disk", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-new", "bypassPermissions", "2026-08-29T10:00:00.000Z");
    const result = checkBypassWithoutAutoApprove(manifestFor(MANIFEST_WITHOUT_PACK), generatedDir, {
      recentSessions: 20,
    });
    expect(result).toBeUndefined();
  });

  it("N=1 window: the newest non-bypass observation excludes an older bypass one from firing", () => {
    const generatedDir = tempGeneratedDir();
    writeObservation(generatedDir, "sess-bypass", "bypassPermissions", "2026-08-29T09:00:00.000Z");
    writeObservation(generatedDir, "sess-default", "default", "2026-08-29T10:00:00.000Z");

    const result = checkBypassWithoutAutoApprove(manifestFor(MANIFEST_NO_AUTO_APPROVE), generatedDir, {
      recentSessions: 1,
    });
    expect(result).toBeUndefined();

    // Sanity: the same fixture at N=2 does fire, so the above undefined
    // is genuinely the window's doing.
    const wide = checkBypassWithoutAutoApprove(manifestFor(MANIFEST_NO_AUTO_APPROVE), generatedDir, {
      recentSessions: 2,
    });
    expect(wide).toBeDefined();
  });
});

let doctorCleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of doctorCleanups) c();
  doctorCleanups = [];
});

function makeFixture(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-bypass-auto-approve-fixture-"));
  doctorCleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return home;
}

describe("doctor: bypassPermissions without auto_approve (Environment section)", () => {
  it("fires and renders the snippet + upgrade command when bypassPermissions was observed and auto_approve is absent", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_NO_AUTO_APPROVE });
    writeObservation(
      path.join(home, "harness.generated"),
      "sess-bypass",
      "bypassPermissions",
      "2026-08-29T10:00:00.000Z",
    );

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugBypassWithoutAutoApprove).toBeDefined();
    expect(report.warningCount).toBeGreaterThanOrEqual(1);

    const text = format(report);
    expect(text).toContain("bypassPermissions observed for session sess-bypass");
    expect(text).toContain("harness pack upgrade understanding-before-execution");
    expect(text).toContain("auto_approve:");
  });

  it("negative control: does not fire when auto_approve already covers the observed bypassPermissions session", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_WITH_AUTO_APPROVE });
    writeObservation(
      path.join(home, "harness.generated"),
      "sess-bypass",
      "bypassPermissions",
      "2026-08-29T10:00:00.000Z",
    );

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugBypassWithoutAutoApprove).toBeUndefined();
    const text = format(report);
    expect(text).not.toContain("bypassPermissions observed for session");
  });

  it("negative control: does not fire when no observation exists at all", async () => {
    const home = makeFixture({ "harness.yaml": MANIFEST_NO_AUTO_APPROVE });

    const report = await doctor({
      configPath: path.join(home, "harness.yaml"),
      homeOverride: home,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.ugBypassWithoutAutoApprove).toBeUndefined();
  });
});
