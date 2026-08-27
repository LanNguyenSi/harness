// Tests for the settings-drift compensating control (ADR
// docs/decisions/2026-08-27-ug-auto-mode-approval.md slice 1,
// agent-tasks 74b4b17d, threat model (c) / "Audit and doctor"): a
// `permissions.defaultMode` or hook entry present in a live Claude Code
// settings file but absent from harness's own `.last-apply` snapshot.
//
// Two directories per fixture, deliberately kept distinct: `projectDir`
// (holds harness.yaml, harness.generated/, harness.lock, and
// .claude/settings*.json — the project-scoped candidates, resolved
// against `cwd`) and `home` (the user-scope `~/.claude/settings.json`
// candidate). Collapsing them into one directory would make the
// project and user candidate paths coincide and defeat the "which file
// actually got a snapshot" distinction the checks under test exist to
// make.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/doctor/index.js";
import { format } from "../../src/cli/doctor/format.js";
import { buildSettingsDrift } from "../../src/cli/doctor/settings-drift.js";
import { buildLastApply, writeLastApply } from "../../src/io/last-apply.js";
import { writeLock, type TargetEntry } from "../../src/io/harness-lock.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN } from "../_helpers/npm-bin-exec.js";

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
  const projectDir = tempDir("harness-doctor-settings-drift-project-");
  const home = tempDir("harness-doctor-settings-drift-home-");
  return {
    projectDir,
    home,
    generatedDir: path.join(projectDir, "harness.generated"),
    lockPath: path.join(projectDir, "harness.lock"),
  };
}

function writeSnapshot(generatedDir: string, settings: Record<string, unknown>): void {
  writeLastApply(generatedDir, buildLastApply({ "settings.json": JSON.stringify(settings) }));
}

function writeTargetLock(lockPath: string, absolutePaths: string[]): void {
  const entries: TargetEntry[] = absolutePaths.map((p) => ({
    kind: "target",
    path: p,
    sha256: "0".repeat(64),
  }));
  writeLock(lockPath, entries);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

const projectSettingsPath = (f: Fixture) => path.join(f.projectDir, ".claude", "settings.json");
const projectLocalSettingsPath = (f: Fixture) =>
  path.join(f.projectDir, ".claude", "settings.local.json");
const userSettingsPath = (f: Fixture) => path.join(f.home, ".claude", "settings.json");

const hookGroup = (matcher: string, command: string) => [
  { matcher, hooks: [{ type: "command", command }] },
];

describe("buildSettingsDrift — pure function", () => {
  it("no .last-apply at all: one ℹ note, zero warnings", () => {
    const f = makeFixture();
    fs.mkdirSync(f.generatedDir, { recursive: true });
    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result).toEqual({
      notes: ["no apply snapshot; settings drift not checked"],
      warnings: [],
    });
  });

  it("warns on a live permissions.defaultMode absent from the snapshot", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectSettingsPath(f), { permissions: { defaultMode: "bypassPermissions" } });

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.notes).toEqual([]);
    expect(result.warnings).toContain(
      "permissions.defaultMode set in .claude/settings.json but absent at last apply: bypassPermissions",
    );
  });

  it("warns on a planted UserPromptSubmit hook entry absent from the snapshot", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectSettingsPath(f), {
      hooks: { UserPromptSubmit: hookGroup("*", "planted-command") },
    });

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toContain(
      "hook entries in .claude/settings.json absent at last apply: UserPromptSubmit/*",
    );
  });

  it("warns on a planted SessionStart hook entry absent from the snapshot", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectSettingsPath(f), {
      hooks: { SessionStart: hookGroup("*", "planted-command") },
    });

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toContain(
      "hook entries in .claude/settings.json absent at last apply: SessionStart/*",
    );
  });

  it("a planted hook UNDER THE SAME EVENT as an existing baseline entry, but with a different command, is still flagged (P2 target)", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, {
      hooks: { UserPromptSubmit: hookGroup("*", "harness-owned-command") },
    });
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectSettingsPath(f), {
      hooks: {
        UserPromptSubmit: [
          { matcher: "*", hooks: [{ type: "command", command: "harness-owned-command" }] },
          { matcher: "*", hooks: [{ type: "command", command: "planted-command" }] },
        ],
      },
    });

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    // Exactly one warning: the harness-owned entry matches the baseline
    // and is silent; only the planted, differently-commanded entry
    // under the SAME event is flagged. An event-only comparison would
    // consider the event already present and miss this entirely.
    expect(result.warnings).toEqual([
      "hook entries in .claude/settings.json absent at last apply: UserPromptSubmit/*",
    ]);
  });

  it("identical live and snapshot content: no warnings", () => {
    const f = makeFixture();
    const settings = {
      permissions: { defaultMode: "acceptEdits" },
      hooks: { PreToolUse: hookGroup("Edit|Write|Bash", "harness-owned-command") },
    };
    // permissions.defaultMode is never part of harness's own generated
    // projection, so even a snapshot that happens to carry a
    // permissions block (hand-constructed here) exercises the
    // "unchanged" branch for defaultMode too, not just hooks.
    writeSnapshot(f.generatedDir, settings);
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectSettingsPath(f), settings);

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
  });

  it("settings.local.json with a hook and no snapshot (never a --target) warns with the 'no apply snapshot' phrasing", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    // Only settings.json was ever a --target; settings.local.json's
    // absolute path has no entry in harness.lock at all.
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectLocalSettingsPath(f), {
      hooks: { UserPromptSubmit: hookGroup("*", "hand-added-command") },
    });

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toContain(
      "hook entries in .claude/settings.local.json absent at last apply: UserPromptSubmit/* (no apply snapshot for this file)",
    );
  });

  it("unreadable live JSON produces exactly one warning and does not crash", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    fs.mkdirSync(path.dirname(projectSettingsPath(f)), { recursive: true });
    fs.writeFileSync(projectSettingsPath(f), "not json{{{", "utf8");

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([".claude/settings.json: unreadable settings JSON"]);
  });

  it("a missing settings file produces no warning at all (nothing to report)", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("the user-scope file is checked too, tildeized in its warning", () => {
    const f = makeFixture();
    writeSnapshot(f.generatedDir, { hooks: {} });
    writeTargetLock(f.lockPath, [userSettingsPath(f)]);
    writeJson(userSettingsPath(f), { permissions: { defaultMode: "bypassPermissions" } });

    const result = buildSettingsDrift({
      generatedDir: f.generatedDir,
      lockPath: f.lockPath,
      cwd: f.projectDir,
      home: f.home,
      env: {},
    });
    expect(result.warnings).toContain(
      "permissions.defaultMode set in ~/.claude/settings.json but absent at last apply: bypassPermissions",
    );
  });
});

describe("doctor — settings drift (Environment section)", () => {
  it("renders warnings and rolls each into warningCount", async () => {
    const f = makeFixture();
    fs.writeFileSync(
      path.join(f.projectDir, "harness.yaml"),
      `version: 1
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
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
`,
    );
    writeSnapshot(f.generatedDir, { hooks: {} });
    writeTargetLock(f.lockPath, [projectSettingsPath(f)]);
    writeJson(projectSettingsPath(f), { permissions: { defaultMode: "bypassPermissions" } });

    const baseline = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(baseline.settingsDrift?.warnings).toContain(
      "permissions.defaultMode set in .claude/settings.json but absent at last apply: bypassPermissions",
    );
    expect(baseline.warningCount).toBeGreaterThanOrEqual(1);

    const text = format(baseline);
    expect(text).toContain(
      "⚠ permissions.defaultMode set in .claude/settings.json but absent at last apply: bypassPermissions",
    );
  });

  it("is absent from the report when harness.generated/ has never been created (no apply has ever run)", async () => {
    const f = makeFixture();
    fs.writeFileSync(
      path.join(f.projectDir, "harness.yaml"),
      `version: 1
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
policy_packs:
  - name: understanding-before-execution
    config:
      mode: grill_me
`,
    );
    // No harness.generated/ directory created at all.

    const report = await doctor({
      configPath: path.join(f.projectDir, "harness.yaml"),
      homeOverride: f.home,
      cwd: f.projectDir,
      versionProbe: () => null,
      pathEnv: "",
      npmBinExec: STUB_NPM_BIN_EXEC_UNKNOWN,
      envOverride: {},
    });

    expect(report.settingsDrift).toBeUndefined();
    const text = format(report);
    expect(text).not.toMatch(/\nEnvironment\n/);
  });
});
