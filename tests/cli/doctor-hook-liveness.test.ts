// Hook liveness: the hooks `harness apply` generates must be present in the
// live runtime config. Every test points the live paths at a temp dir (the
// `envOverride` / `homeOverride` / `codexLiveConfigPath` seams) so nothing
// reads the developer's real ~/.claude or ~/.codex.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, format } from "../../src/cli/doctor/index.js";
import {
  checkClaudeLiveHooks,
  checkCodexLiveHooks,
  livenessRuntimes,
} from "../../src/cli/doctor/hook-liveness.js";
import { generateSettings } from "../../src/cli/apply/generate-settings.js";
import { generateCodexConfig } from "../../src/cli/apply/generate-codex-config.js";
import {
  planCodexConfigInstall,
  writeCodexConfigInstall,
} from "../../src/cli/apply/install-codex-config.js";
import { gateDisable } from "../../src/cli/gate/disable.js";
import { gateEnable } from "../../src/cli/gate/enable.js";
import { codexGateDisable } from "../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../src/cli/gate/codex-enable.js";
import { expandPolicyPacks } from "../../src/policy-packs/index.js";
import { loadManifest } from "../../src/cli/loader.js";
import { downgradeToVersion1 } from "../_helpers/claude-gate-legacy.js";
import type { Manifest } from "../../src/schema/index.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const MANIFEST_YAML = `version: 1
hooks:
  - name: branch-guard
    event: PreToolUse
    match: "Write|Edit"
    command: guard-bin check
    blocking: hard
    budget_ms: 5000
  - name: session-start
    event: SessionStart
    command: session-bin start
    blocking: false
    budget_ms: 5000
policies: []
`;

interface Fixture {
  dir: string;
  manifest: Manifest;
  configPath: string;
  settingsPath: string;
  codexPath: string;
}

function fixture(yaml: string = MANIFEST_YAML): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-liveness-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "harness.yaml");
  fs.writeFileSync(configPath, yaml);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
  const manifest = loadManifest({ configPath }).manifest;
  return {
    dir,
    manifest,
    configPath,
    settingsPath: path.join(dir, ".claude", "settings.json"),
    codexPath: path.join(dir, ".codex", "config.toml"),
  };
}

/** The manifest as `harness apply` sees it: declared hooks plus the policy packs' hooks. */
function withPacks(f: Fixture, runtime: "claude-code" | "codex"): Manifest {
  return { ...f.manifest, hooks: [...f.manifest.hooks, ...expandPolicyPacks(f.manifest, runtime).hooks] };
}

function installClaude(f: Fixture): Record<string, unknown> {
  const settings = generateSettings(withPacks(f, "claude-code")) as unknown as Record<string, unknown>;
  fs.writeFileSync(f.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

function installCodex(f: Fixture, configPath: string = f.codexPath): void {
  const plan = planCodexConfigInstall({
    configPath,
    generatedPath: path.join(f.dir, "codex.generated.toml"),
    generatedContent: generateCodexConfig(withPacks(f, "codex")).content,
  });
  writeCodexConfigInstall(plan);
}

function codexSnapshotPath(f: Fixture): string {
  return fs
    .readdirSync(path.join(f.dir, ".codex"))
    .filter((n) => n.startsWith("harness.gate-disable-codex."))
    .map((n) => path.join(f.dir, ".codex", n))[0]!;
}

function claudeSnapshotPath(f: Fixture): string {
  return fs
    .readdirSync(path.join(f.dir, ".claude"))
    .filter((n) => n.startsWith("harness.gate-disable.") && !n.endsWith(".restored.json"))
    .map((n) => path.join(f.dir, ".claude", n))[0]!;
}

function claudeSnapshotBackupPath(f: Fixture): string {
  return (JSON.parse(fs.readFileSync(claudeSnapshotPath(f), "utf8")) as { settingsBackupPath: string })
    .settingsBackupPath;
}

/** The `settingsBackupPath` one snapshot file records. */
function snapshotBackupOf(snapPath: string): string {
  return (JSON.parse(fs.readFileSync(snapPath, "utf8")) as { settingsBackupPath: string }).settingsBackupPath;
}

/** The live Claude snapshots beside the fixture's settings file, by name (the ISO stamps order them oldest first). */
function liveClaudeSnapshotNames(f: Fixture): string[] {
  return fs
    .readdirSync(path.join(f.dir, ".claude"))
    .filter((n) => n.startsWith("harness.gate-disable.") && !n.endsWith(".restored.json"))
    .sort();
}

/** Disables the guard matcher at a fixed time and returns the snapshot the call wrote. */
function disableAt(f: Fixture, createdAt: string): string {
  const r = gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit", now: new Date(createdAt) });
  if (r.mode !== "remove") throw new Error("expected remove");
  return r.snapshotPath;
}

/**
 * The state the releases that wrote one snapshot per disable left behind when the
 * same group was disabled twice on the way: the installed file is disabled once
 * (older snapshot), an apply plus an operator key puts the group back, and a
 * second disable takes it out again (newer snapshot). Both live snapshots name
 * the same group; the newer one is the state the file is in now, the older one
 * an edited state of the past. Returns the snapshot paths, oldest first.
 */
function twoLiveSnapshotsSameGroup(f: Fixture): [string, string] {
  installClaude(f);
  const older = disableAt(f, "2026-09-01T10:00:00.000Z");
  fs.renameSync(older, `${older}.parked`);
  fs.writeFileSync(f.settingsPath, `${JSON.stringify({ ...installClaude(f), operatorAddedKey: 1 }, null, 2)}\n`);
  const newer = disableAt(f, "2026-09-01T11:00:00.000Z");
  fs.renameSync(`${older}.parked`, older);
  downgradeToVersion1(older);
  downgradeToVersion1(newer);
  return [older, newer];
}

function editCodexSnapshot(f: Fixture, edit: (n: { id: string; eventIndex: number }) => void): void {
  const p = codexSnapshotPath(f);
  const snap = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const n of snap.neutralised) edit(n);
  fs.writeFileSync(p, JSON.stringify(snap));
}

function kinds(r: { entries: Array<{ kind: string; status: string }> }): string[] {
  return r.entries.map((e) => `${e.kind}:${e.status}`).sort();
}

describe("hook liveness: Claude settings.json", () => {
  it("all generated hooks present: every entry ok", () => {
    const f = fixture();
    installClaude(f);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["present:ok", "present:ok"]);
  });

  it("one hook missing: error naming event, matcher and command", () => {
    const f = fixture();
    const s = installClaude(f) as { hooks: Record<string, unknown> };
    delete s.hooks["PreToolUse"];
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["missing:error", "present:ok"]);
    const miss = r.entries.find((e) => e.kind === "missing")!;
    expect(miss.event).toBe("PreToolUse");
    expect(miss.matcher).toBe("Write|Edit");
    expect(miss.command).toBe("guard-bin check");
    expect(miss.message).toContain("PreToolUse");
    expect(miss.message).toContain("Write|Edit");
    expect(miss.message).toContain("guard-bin check");
  });

  it("one hook with a differing command: error, not reported again as extra", () => {
    const f = fixture();
    const s = installClaude(f) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    s.hooks["PreToolUse"]![0]!.hooks[0]!.command = "other-bin check";
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["differing:error", "present:ok"]);
    expect(r.entries.find((e) => e.kind === "differing")!.message).toContain("other-bin check");
  });

  it("disabled via `harness gate disable`: warn, from the recorded snapshot", () => {
    const f = fixture();
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["disabled:warn", "present:ok"]);
  });

  it("the disabled warning names `harness gate enable`, with --settings only for a file other than the gate's default", () => {
    const f = fixture();
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const atDefault = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    const plain = atDefault.entries.find((e) => e.kind === "disabled")!.message;
    expect(plain).toContain("run `harness gate enable` to put it back");
    expect(plain).not.toContain("--settings");
    const elsewhere = path.join(f.dir, "home", ".claude", "settings.json");
    const named = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: elsewhere });
    expect(named.entries.find((e) => e.kind === "disabled")!.message).toContain(
      `run \`harness gate enable --settings ${f.settingsPath}\` to put it back`,
    );
    // Without a known default the flag is always named: it reaches the compared file either way.
    const unknown = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(unknown.entries.find((e) => e.kind === "disabled")!.message).toContain(`--settings ${f.settingsPath}`);
  });

  it("the --settings the disabled warning names is shell-quoted", () => {
    const f = fixture();
    const spaced = path.join(f.dir, "my dir");
    fs.mkdirSync(spaced);
    const target = path.join(spaced, "settings.json");
    fs.writeFileSync(target, `${JSON.stringify(generateSettings(withPacks(f, "claude-code")), null, 2)}\n`);
    gateDisable({ settingsPath: target, matcher: "Write|Edit" });
    const r = checkClaudeLiveHooks(f.manifest, target, { gateDefaultPath: f.settingsPath });
    expect(r.entries.find((e) => e.kind === "disabled")!.message).toContain(
      `run \`harness gate enable --settings '${target}'\` to put it back`,
    );
  });

  it("a group with the event and matcher of the removed one but other content: the warning names --force, which is what `gate enable` needs", () => {
    const f = fixture();
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const backup = claudeSnapshotBackupPath(f);
    const s = JSON.parse(fs.readFileSync(f.settingsPath, "utf8")) as { hooks: Record<string, unknown[]> };
    // The gate's own group was the only one on the event; the file now holds a changed stand-in.
    s.hooks["PreToolUse"] = [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "other-guard check" }] }];
    fs.writeFileSync(f.settingsPath, `${JSON.stringify(s, null, 2)}\n`);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    expect(kinds(r)).toEqual(["disabled:warn", "extra:info", "present:ok"]);
    const msg = r.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain("run `harness gate enable --force` to put it back");
    expect(msg).toContain("holds a group with the event and matcher of the removed one but other content");
    expect(msg).toContain(backup);
    expect(msg).not.toContain("--settings");
    // The gate agrees: without --force it refuses on such a group, with it the snapshot is spent and retired.
    expect(() => gateEnable({ settingsPath: f.settingsPath })).toThrow(/does not count as back/);
    expect(gateEnable({ settingsPath: f.settingsPath, force: true }).mode).toBe("already-restored");
  });

  it("settings.json edited since the disable: the warning names --force, which is what `gate enable` needs", () => {
    const f = fixture();
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const backup = claudeSnapshotBackupPath(f);
    const edited = JSON.parse(fs.readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>;
    edited["operatorAddedKey"] = "preserve me";
    fs.writeFileSync(f.settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    expect(kinds(r)).toEqual(["disabled:warn", "present:ok"]);
    const msg = r.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain("run `harness gate enable --force` to put it back");
    expect(msg).toContain("was edited since the disable");
    expect(msg).toContain(backup);
    // The gate agrees: without --force it refuses, with it the hook comes back and the edit stays.
    expect(() => gateEnable({ settingsPath: f.settingsPath })).toThrow(/edited since the snapshot/);
    expect(gateEnable({ settingsPath: f.settingsPath, force: true }).mode).toBe("restored");
    expect(kinds(checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath }))).toEqual([
      "present:ok",
      "present:ok",
    ]);
    expect(fs.readFileSync(f.settingsPath, "utf8")).toContain("preserve me");
  });

  it("a changed group and an edit since the disable at once: the warning names --force with the changed-group reason, as the gate's own refusal words it", () => {
    const f = fixture(`version: 1
hooks:
  - {name: a, event: PreToolUse, match: "Write", command: a-bin check, blocking: hard, budget_ms: 5000}
  - {name: b, event: PreToolUse, match: "Edit", command: b-bin check, blocking: hard, budget_ms: 5000}
policies: []
`);
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write" });
    gateDisable({ settingsPath: f.settingsPath, matcher: "Edit" });
    // One removed group came back in a changed form, the other is still missing, and the file was edited.
    const handEdited = {
      operatorAddedKey: 1,
      hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "a-bin --other" }] }] },
    };
    fs.writeFileSync(f.settingsPath, `${JSON.stringify(handEdited, null, 2)}\n`);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    expect(kinds(r)).toEqual(["disabled:warn", "disabled:warn", "extra:info"]);
    const msgs = r.entries.filter((e) => e.kind === "disabled").map((e) => e.message);
    expect(msgs).toHaveLength(2);
    for (const msg of msgs) {
      expect(msg).toContain("run `harness gate enable --force` to put it back");
      expect(msg).toContain("holds a group with the event and matcher of the removed one but other content");
      expect(msg).not.toContain("was edited since the disable");
    }
    // The gate agrees: it refuses with the changed-group message, naming the missing group too, and --force wins.
    let gateMessage = "";
    try {
      gateEnable({ settingsPath: f.settingsPath });
    } catch (err) {
      gateMessage = (err as Error).message;
    }
    expect(gateMessage).toContain("does not count as back");
    expect(gateMessage).toContain("1 more hook group(s) it removed are missing");
    expect(gateEnable({ settingsPath: f.settingsPath, force: true }).mode).toBe("restored");
  });

  it("an unedited file: the warning names no --force, and that plain command puts the hook back", () => {
    const f = fixture();
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    const msg = r.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain("run `harness gate enable` to put it back");
    expect(msg).not.toContain("--force");
    expect(gateEnable({ settingsPath: f.settingsPath }).mode).toBe("restored");
    expect(kinds(checkClaudeLiveHooks(f.manifest, f.settingsPath))).toEqual(["present:ok", "present:ok"]);
  });

  it("settings.json already restored to the pre-disable bytes: no disabled warning, and `gate enable` only retires the live snapshot", () => {
    const f = fixture();
    installClaude(f);
    const original = fs.readFileSync(f.settingsPath, "utf8");
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    fs.writeFileSync(f.settingsPath, original);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    expect(kinds(r)).toEqual(["present:ok", "present:ok"]);
    expect(gateEnable({ settingsPath: f.settingsPath }).mode).toBe("already-restored");
  });

  it("two live snapshots name one group and the newest restores cleanly: no --force, and that plain command puts the hook back", () => {
    const f = fixture();
    const [older, newer] = twoLiveSnapshotsSameGroup(f);
    expect(liveClaudeSnapshotNames(f)).toEqual([path.basename(older), path.basename(newer)]);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    expect(kinds(r)).toEqual(["disabled:warn", "present:ok"]);
    const msg = r.entries.find((e) => e.kind === "disabled")!.message;
    // The OLDER snapshot would refuse against this file, but the plain `gate enable` that
    // is next applies the NEWEST one and restores: the warning may not name --force.
    expect(msg).toContain("run `harness gate enable` to put it back");
    expect(msg).not.toContain("--force");
    expect(msg).not.toContain(snapshotBackupOf(older));
    // The gate agrees with the warning: the plain call restores from the newest snapshot
    // and reports the older one as still live; the call after it retires that one.
    const first = gateEnable({ settingsPath: f.settingsPath });
    expect(first.mode).toBe("restored");
    if (first.mode !== "restored") return;
    expect(first.remaining).toEqual([older]);
    expect(liveClaudeSnapshotNames(f)).toEqual([path.basename(older)]);
    expect(kinds(checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath }))).toEqual([
      "present:ok",
      "present:ok",
    ]);
    expect(gateEnable({ settingsPath: f.settingsPath }).mode).toBe("already-restored");
  });

  it("two live snapshots name one group and the newest refuses: --force, named with the newest snapshot's backup, and the plain enable refuses", () => {
    const f = fixture();
    const [older, newer] = twoLiveSnapshotsSameGroup(f);
    // One more edit: now even the snapshot the next plain enable applies refuses.
    const edited = JSON.parse(fs.readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>;
    edited["secondEditKey"] = 1;
    fs.writeFileSync(f.settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    const msg = r.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain("run `harness gate enable --force` to put it back");
    expect(msg).toContain("was edited since the disable");
    expect(msg).toContain(snapshotBackupOf(newer));
    expect(msg).not.toContain(snapshotBackupOf(older));
    expect(() => gateEnable({ settingsPath: f.settingsPath })).toThrow(/edited since the snapshot/);
    expect(gateEnable({ settingsPath: f.settingsPath, force: true }).mode).toBe("restored");
  });

  it("two live snapshots name different groups and the newest refuses: every disabled hook names --force with the newest snapshot's backup, as the plain enable refuses for all of them", () => {
    const f = fixture(`version: 1
hooks:
  - {name: a, event: PreToolUse, match: "Write", command: a-bin check, blocking: hard, budget_ms: 5000}
  - {name: b, event: PreToolUse, match: "Edit", command: b-bin check, blocking: hard, budget_ms: 5000}
policies: []
`);
    installClaude(f);
    const olderRun = gateDisable({ settingsPath: f.settingsPath, matcher: "Write", now: new Date("2026-09-01T10:00:00.000Z") });
    if (olderRun.mode !== "remove") throw new Error("expected remove");
    const older = olderRun.snapshotPath;
    // Park the older snapshot so the second disable writes its own instead of merging (the
    // one-snapshot-per-disable state older releases left behind).
    fs.renameSync(older, `${older}.parked`);
    const newerRun = gateDisable({ settingsPath: f.settingsPath, matcher: "Edit", now: new Date("2026-09-01T11:00:00.000Z") });
    if (newerRun.mode !== "remove") throw new Error("expected remove");
    const newer = newerRun.snapshotPath;
    fs.renameSync(`${older}.parked`, older);
    downgradeToVersion1(older);
    downgradeToVersion1(newer);
    // An edit after the last disable: the snapshot the next plain enable applies (the newest) refuses.
    const edited = JSON.parse(fs.readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>;
    edited["operatorAddedKey"] = 1;
    fs.writeFileSync(f.settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
    const msgs = r.entries.filter((e) => e.kind === "disabled").map((e) => e.message);
    expect(msgs).toHaveLength(2);
    for (const msg of msgs) {
      expect(msg).toContain("run `harness gate enable --force` to put it back");
      expect(msg).toContain("was edited since the disable");
      expect(msg).toContain(snapshotBackupOf(newer));
    }
    // The gate agrees: the plain call refuses on the newest snapshot, whichever group the hook belongs to.
    expect(() => gateEnable({ settingsPath: f.settingsPath })).toThrow(/edited since the snapshot/);
    expect(gateEnable({ settingsPath: f.settingsPath, force: true }).mode).toBe("restored");
  });

  it("a hooks shape the gate refuses to read: the disabled warning names no --force", () => {
    for (const malformed of [[], { PreToolUse: {} }]) {
      const f = fixture();
      installClaude(f);
      gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
      const s = JSON.parse(fs.readFileSync(f.settingsPath, "utf8")) as Record<string, unknown>;
      s["hooks"] = malformed;
      fs.writeFileSync(f.settingsPath, `${JSON.stringify(s, null, 2)}\n`);
      const r = checkClaudeLiveHooks(f.manifest, f.settingsPath, { gateDefaultPath: f.settingsPath });
      const disabled = r.entries.filter((e) => e.kind === "disabled");
      expect(disabled.length).toBeGreaterThan(0);
      // `gate enable` refuses such a file outright: that is neither of the two refusals
      // this warning could name a --force for, whatever the snapshot would have said.
      for (const e of disabled) expect(e.message).not.toContain("--force");
    }
  });

  it("removed by hand without a snapshot: still a missing error, not a disabled warn", () => {
    const f = fixture();
    const s = installClaude(f) as { hooks: Record<string, unknown> };
    delete s.hooks["PreToolUse"];
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(r.entries.some((e) => e.kind === "disabled")).toBe(false);
    expect(kinds(r)).toEqual(["missing:error", "present:ok"]);
  });

  it("a missing hook beside a gate-disabled one (no extras): the hint warns that --merge brings the disabled hook back", () => {
    const f = fixture();
    const s = installClaude(f) as { hooks: Record<string, unknown> };
    delete s.hooks["SessionStart"];
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["disabled:warn", "missing:error"]);
    expect(r.entries.find((e) => e.kind === "missing")!.message).toContain("replaces the hooks key");
  });

  it("a corrupt gate snapshot beside settings.json: one error naming it; missing entries point at it, not at apply --merge", () => {
    const f = fixture();
    const s = installClaude(f) as { hooks: Record<string, unknown> };
    delete s.hooks["PreToolUse"];
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    const snap = path.join(f.dir, ".claude", "harness.gate-disable.2026-01-01T00-00-00-000Z.json");
    fs.writeFileSync(snap, "{ corrupt");
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["file:error", "missing:error", "present:ok"]);
    const file = r.entries.find((e) => e.kind === "file")!;
    expect(file.message).toContain(snap);
    const miss = r.entries.find((e) => e.kind === "missing")!;
    expect(miss.message).toContain("gate snapshot finding");
    expect(miss.message).not.toContain("--merge");
  });

  it("the apply --merge hint shell-quotes the path and warns that --merge replaces the hooks key when extras exist", () => {
    const f = fixture();
    const spaced = path.join(f.dir, "my dir");
    fs.mkdirSync(spaced);
    const target = path.join(spaced, "settings.json");
    fs.writeFileSync(
      target,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-stop" }] }] } }),
    );
    const r = checkClaudeLiveHooks(f.manifest, target);
    const miss = r.entries.find((e) => e.kind === "missing")!;
    expect(miss.message).toContain(`--target '${target}' --merge`);
    expect(miss.message).toContain("replaces the hooks key");
    // Without extras or disabled entries the warning is absent.
    fs.writeFileSync(target, JSON.stringify({ hooks: {} }));
    const plain = checkClaudeLiveHooks(f.manifest, target).entries.find((e) => e.kind === "missing")!;
    expect(plain.message).not.toContain("replaces the hooks key");
  });

  it("policy pack hook: present after install, missing after removal", () => {
    const f = fixture("version: 1\nhooks: []\npolicies: []\npolicy_packs:\n  - name: branch-protection\n");
    const s = installClaude(f) as { hooks: Record<string, unknown> };
    const before = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(before.entries.length).toBeGreaterThan(0);
    expect(before.entries.every((e) => e.kind === "present")).toBe(true);
    for (const k of Object.keys(s.hooks)) delete s.hooks[k];
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    const after = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(after.entries.every((e) => e.kind === "missing" && e.status === "error")).toBe(true);
    expect(after.entries.length).toBe(before.entries.length);
  });

  it("extra live hook: info only, no error or warning counted", () => {
    const f = fixture();
    const s = installClaude(f) as { hooks: Record<string, unknown[]> };
    s.hooks["Stop"] = [{ hooks: [{ type: "command", command: "my-own-stop" }] }];
    fs.writeFileSync(f.settingsPath, JSON.stringify(s));
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["extra:info", "present:ok", "present:ok"]);
  });

  it("missing settings file: one clear error finding, no crash", () => {
    const f = fixture();
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["file:error"]);
    expect(r.entries[0]!.message).toContain("not found");
  });

  it("unreadable settings file (a directory): one error finding, no crash", () => {
    const f = fixture();
    fs.mkdirSync(f.settingsPath);
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["file:error"]);
    expect(r.entries[0]!.message).toContain("cannot read");
  });

  it("settings file that is JSON but not an object: one error finding", () => {
    const f = fixture();
    fs.writeFileSync(f.settingsPath, "[]");
    const r = checkClaudeLiveHooks(f.manifest, f.settingsPath);
    expect(kinds(r)).toEqual(["file:error"]);
    expect(r.entries[0]!.message).toContain("not a JSON object");
  });

  it("a manifest that generates no hooks has nothing to compare, even with no live file", () => {
    const f = fixture();
    fs.writeFileSync(f.configPath, "version: 1\nhooks: []\npolicies: []\n");
    const empty = loadManifest({ configPath: f.configPath }).manifest;
    expect(checkClaudeLiveHooks(empty, f.settingsPath).entries).toEqual([]);
    expect(checkCodexLiveHooks(empty, f.codexPath).entries).toEqual([]);
  });

  it("settings file that is not JSON: one error finding", () => {
    const f = fixture();
    fs.writeFileSync(f.settingsPath, "{ not json");
    expect(kinds(checkClaudeLiveHooks(f.manifest, f.settingsPath))).toEqual(["file:error"]);
  });
});

describe("hook liveness: Codex config.toml", () => {
  it("all generated hooks present: every entry ok", () => {
    const f = fixture();
    installCodex(f);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["present:ok", "present:ok"]);
  });

  it("one hook missing: error", () => {
    const f = fixture();
    installCodex(f);
    const text = fs.readFileSync(f.codexPath, "utf8");
    // Drop the SessionStart unit entirely.
    const cut = text.replace(/# harness hook: session-start[\s\S]*?\n\[\[hooks\.SessionStart\]\]\nhooks = \[[^\n]*\]\n/, "");
    expect(cut).not.toBe(text);
    fs.writeFileSync(f.codexPath, cut);
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["missing:error", "present:ok"]);
    expect(r.entries.find((e) => e.kind === "missing")!.event).toBe("SessionStart");
  });

  it("one hook with a differing command: error", () => {
    const f = fixture();
    installCodex(f);
    const text = fs.readFileSync(f.codexPath, "utf8");
    const changed = text.replace("guard-bin check", "other-bin check");
    expect(changed).not.toBe(text);
    fs.writeFileSync(f.codexPath, changed);
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["differing:error", "present:ok"]);
  });

  it("disabled via `harness gate disable --runtime codex`: warn, from the neutralised unit", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["disabled:warn", "present:ok"]);
  });

  it("the disabled warning names `harness gate enable --runtime codex`, with --config only for a config other than the default", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const atDefault = checkCodexLiveHooks(f.manifest, f.codexPath, { gateDefaultPath: f.codexPath });
    const plain = atDefault.entries.find((e) => e.kind === "disabled")!.message;
    expect(plain).toContain("disabled via `harness gate disable --runtime codex`");
    expect(plain).toContain("run `harness gate enable --runtime codex` to put it back");
    expect(plain).not.toContain("--config");
    expect(plain).not.toContain("--force");
    const elsewhere = path.join(f.dir, "home", ".codex", "config.toml");
    const named = checkCodexLiveHooks(f.manifest, f.codexPath, { gateDefaultPath: elsewhere });
    expect(named.entries.find((e) => e.kind === "disabled")!.message).toContain(
      `run \`harness gate enable --runtime codex --config ${f.codexPath}\` to put it back`,
    );
    // Without a known default the flag is always named.
    const unknown = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(unknown.entries.find((e) => e.kind === "disabled")!.message).toContain(`--config ${f.codexPath}`);
    // The command as named puts it back: an unedited config needs no --force.
    expect(codexGateEnable({ configPath: f.codexPath }).mode).toBe("restored");
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["present:ok", "present:ok"]);
  });

  it("the --config the disabled warning names is shell-quoted", () => {
    const f = fixture();
    const spaced = path.join(f.dir, "my dir");
    fs.mkdirSync(spaced);
    const target = path.join(spaced, "config.toml");
    installCodex(f, target);
    codexGateDisable({ configPath: target, matcher: "Write|Edit" });
    const r = checkCodexLiveHooks(f.manifest, target, { gateDefaultPath: f.codexPath });
    expect(r.entries.find((e) => e.kind === "disabled")!.message).toContain(
      `run \`harness gate enable --runtime codex --config '${target}'\` to put it back`,
    );
  });

  it("a config edited since the disable: still a warning, and it names --force, which is what `gate enable` needs", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const backup = JSON.parse(fs.readFileSync(codexSnapshotPath(f), "utf8")).configBackupPath as string;
    fs.appendFileSync(f.codexPath, "\n# user note\n");
    const r = checkCodexLiveHooks(f.manifest, f.codexPath, { gateDefaultPath: f.codexPath });
    expect(kinds(r)).toEqual(["disabled:warn", "present:ok"]);
    const msg = r.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain("run `harness gate enable --runtime codex --force` to put it back");
    expect(msg).toContain("edited since the disable");
    expect(msg).toContain(backup);
    // The gate agrees: without --force it refuses, with it the unit comes back and the edit stays.
    expect(() => codexGateEnable({ configPath: f.codexPath })).toThrow(/edited since the snapshot/);
    expect(codexGateEnable({ configPath: f.codexPath, force: true }).mode).toBe("restored");
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["present:ok", "present:ok"]);
    expect(fs.readFileSync(f.codexPath, "utf8")).toContain("# user note");
  });

  it("a comment between two units of the managed block (the block scanner refuses it): no throw, the emptied unit is a missing error", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const text = fs.readFileSync(f.codexPath, "utf8");
    const noted = text.replace("# harness hook: session-start", "# user note\n# harness hook: session-start");
    expect(noted).not.toBe(text);
    fs.writeFileSync(f.codexPath, noted);
    // `gate enable` cannot read the block either, so it could not put the unit back.
    expect(() => codexGateEnable({ configPath: f.codexPath })).toThrow(/comment between hook units/);
    let r: ReturnType<typeof checkCodexLiveHooks> | undefined;
    expect(() => {
      r = checkCodexLiveHooks(f.manifest, f.codexPath);
    }).not.toThrow();
    expect(kinds(r!)).toEqual(["missing:error", "present:ok"]);
  });

  it("a hand-emptied unit with no gate snapshot: missing error, not a disabled warn", () => {
    const f = fixture();
    installCodex(f);
    const text = fs.readFileSync(f.codexPath, "utf8");
    const emptied = text.replace(/(\[\[hooks\.PreToolUse\]\]\n(?:matcher[^\n]*\n)?)hooks = \[[^\n]*\]/, "$1hooks = []");
    expect(emptied).not.toBe(text);
    fs.writeFileSync(f.codexPath, emptied);
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["missing:error", "present:ok"]);
  });

  it("a snapshot for one unit does not make another hand-emptied unit disabled", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const text = fs.readFileSync(f.codexPath, "utf8");
    const emptied = text.replace(/(\[\[hooks\.SessionStart\]\]\n(?:matcher[^\n]*\n)?)hooks = \[[^\n]*\]/, "$1hooks = []");
    expect(emptied).not.toBe(text);
    fs.writeFileSync(f.codexPath, emptied);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["disabled:warn", "missing:error"]);
  });

  it("the id alone names the unit even when the recorded position moved", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    editCodexSnapshot(f, (n) => (n.eventIndex = 7));
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["disabled:warn", "present:ok"]);
  });

  it("a snapshot that names the unit by position only does not make it disabled: `gate enable` restores by id", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    editCodexSnapshot(f, (n) => (n.id = "renamed-unit"));
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["missing:error", "present:ok"]);
  });

  it("two units on one event: only the one the snapshot names by id is disabled, whatever its position", () => {
    const f = fixture(`version: 1
hooks:
  - {name: a, event: PreToolUse, match: "Write", command: a-bin check, blocking: hard, budget_ms: 5000}
  - {name: b, event: PreToolUse, match: "Edit", command: b-bin check, blocking: hard, budget_ms: 5000}
policies: []
`);
    installCodex(f);
    // The second unit of the event (event index 1) is the one the gate takes out.
    codexGateDisable({ configPath: f.codexPath, matcher: "Edit" });
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["disabled:warn", "present:ok"]);
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(r.entries.find((e) => e.kind === "disabled")!.command).toBe("b-bin check");
  });

  it("a live snapshot that an install superseded does not make a hand-emptied unit disabled", () => {
    const f = fixture();
    installCodex(f);
    // The disable is dated before the install that follows it, so the install backup is newer.
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit", now: new Date("2026-01-01T00:00:00.000Z") });
    const snapPath = codexSnapshotPath(f);
    const snapText = fs.readFileSync(snapPath, "utf8");
    installCodex(f);
    // The install retires the snapshot it supersedes; put the live file back, as a copied-over or stale one would be.
    for (const n of fs.readdirSync(path.dirname(snapPath))) {
      if (n.startsWith("harness.gate-disable-codex.")) fs.rmSync(path.join(path.dirname(snapPath), n));
    }
    fs.writeFileSync(snapPath, snapText);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["present:ok", "present:ok"]);
    const text = fs.readFileSync(f.codexPath, "utf8");
    const emptied = text.replace(/(\[\[hooks\.PreToolUse\]\]\n(?:matcher[^\n]*\n)?)hooks = \[[^\n]*\]/, "$1hooks = []");
    expect(emptied).not.toBe(text);
    fs.writeFileSync(f.codexPath, emptied);
    // The snapshot is still live (doctor retires nothing) but `gate enable` would only retire it.
    expect(fs.existsSync(snapPath)).toBe(true);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["missing:error", "present:ok"]);
  });

  it("a snapshot naming a unit that was deleted from the block: `gate enable` refuses, so the other unit is not disabled either", () => {
    const f = fixture(`version: 1
hooks:
  - {name: a, event: PreToolUse, match: "Write", command: a-bin check, blocking: hard, budget_ms: 5000}
  - {name: b, event: PreToolUse, match: "Edit", command: b-bin check, blocking: hard, budget_ms: 5000}
policies: []
`);
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write" });
    codexGateDisable({ configPath: f.codexPath, matcher: "Edit" });
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["disabled:warn", "disabled:warn"]);
    const text = fs.readFileSync(f.codexPath, "utf8");
    const cut = text.replace(/# harness hook: b[^\n]*\n\[\[hooks\.PreToolUse\]\]\nmatcher = "Edit"\nhooks = \[\]\n/, "");
    expect(cut).not.toBe(text);
    fs.writeFileSync(f.codexPath, cut);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["missing:error", "missing:error"]);
  });

  it("a unit listed in the snapshot but live with another command is a differing error, not disabled", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const text = fs.readFileSync(f.codexPath, "utf8");
    const edited = text.replace(/(\[\[hooks\.PreToolUse\]\]\n(?:matcher[^\n]*\n)?)hooks = \[\]/, '$1hooks = [{ type = "command", command = "other-bin check", timeout = 5 }]');
    expect(edited).not.toBe(text);
    fs.writeFileSync(f.codexPath, edited);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["differing:error", "present:ok"]);
  });

  it("two units with the same command: a snapshot for one does not disable the other", () => {
    const f = fixture(`version: 1
hooks:
  - {name: a, event: PreToolUse, match: "Write", command: same-bin check, blocking: hard, budget_ms: 5000}
  - {name: b, event: PreToolUse, match: "Edit", command: same-bin check, blocking: hard, budget_ms: 5000}
policies: []
`);
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write" });
    const text = fs.readFileSync(f.codexPath, "utf8");
    const emptied = text.replace(/(matcher = "Edit"\n)hooks = \[[^\n]*\]/, "$1hooks = []");
    expect(emptied).not.toBe(text);
    fs.writeFileSync(f.codexPath, emptied);
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["disabled:warn", "missing:error"]);
  });

  it("a snapshot that does not carry the expected command does not make the unit disabled", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const snapPath = fs
      .readdirSync(path.join(f.dir, ".codex"))
      .filter((n) => n.startsWith("harness.gate-disable-codex."))
      .map((n) => path.join(f.dir, ".codex", n))[0]!;
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    for (const n of snap.neutralised) n.hooksText = n.hooksText.replace("guard-bin check", "other-bin check");
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    // An edit elsewhere in the config keeps the restore from being refused outright; the command check decides.
    fs.appendFileSync(f.codexPath, "\n# note\n");
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["missing:error", "present:ok"]);
  });

  it("a snapshot of an unedited config that does not rebuild its pre-disable bytes: `gate enable` refuses, so the unit is not disabled", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    // Same command, another timeout: the command check passes, only the rebuild check can tell.
    const p = codexSnapshotPath(f);
    const snap = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const n of snap.neutralised) n.hooksText = n.hooksText.replace(/timeout = \d+/, "timeout = 99");
    expect(JSON.stringify(snap)).not.toBe(fs.readFileSync(p, "utf8"));
    fs.writeFileSync(p, JSON.stringify(snap));
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["missing:error", "present:ok"]);
  });

  it("a corrupt Codex gate snapshot: one error naming it; the missing entry points at it", () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const snapPath = fs
      .readdirSync(path.join(f.dir, ".codex"))
      .filter((n) => n.startsWith("harness.gate-disable-codex."))
      .map((n) => path.join(f.dir, ".codex", n))[0]!;
    fs.writeFileSync(snapPath, "{ corrupt");
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["file:error", "missing:error", "present:ok"]);
    expect(r.entries.find((e) => e.kind === "file")!.message).toContain(snapPath);
    expect(r.entries.find((e) => e.kind === "missing")!.message).toContain("gate snapshot finding");
  });

  it("policy pack hook: present after install, missing after removal", () => {
    const f = fixture("version: 1\nhooks: []\npolicies: []\npolicy_packs:\n  - name: branch-protection\n");
    installCodex(f);
    const before = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(before.entries.length).toBeGreaterThan(0);
    expect(before.entries.every((e) => e.kind === "present")).toBe(true);
    fs.writeFileSync(f.codexPath, "");
    const after = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(after.entries.length).toBe(before.entries.length);
    expect(after.entries.every((e) => e.kind === "missing" && e.status === "error")).toBe(true);
  });

  it("extra live hook outside the managed block: info only", () => {
    const f = fixture();
    installCodex(f);
    fs.appendFileSync(
      f.codexPath,
      `\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "my-own-stop", timeout = 5 }]\n`,
    );
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["extra:info", "present:ok", "present:ok"]);
  });

  it("missing config: one error finding", () => {
    const f = fixture();
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["file:error"]);
  });

  it("unreadable config (a directory): one error finding", () => {
    const f = fixture();
    fs.mkdirSync(f.codexPath);
    const r = checkCodexLiveHooks(f.manifest, f.codexPath);
    expect(kinds(r)).toEqual(["file:error"]);
    expect(r.entries[0]!.message).toContain("cannot read");
  });

  it("config that is not TOML: one error finding", () => {
    const f = fixture();
    fs.writeFileSync(f.codexPath, "[[[ nope");
    expect(kinds(checkCodexLiveHooks(f.manifest, f.codexPath))).toEqual(["file:error"]);
  });
});

describe("hook liveness: wired into doctor()", () => {
  it("a missing hook raises errorCount; the rendered report names it", async () => {
    const f = fixture();
    fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks: {} }));
    const report = await doctor({
      configPath: f.configPath,
      homeOverride: f.dir,
      envOverride: {},
      shallow: true,
    });
    expect(report.hookLiveness?.runtimes.map((r) => r.runtime)).toEqual(["claude-code"]);
    expect(report.errorCount).toBeGreaterThanOrEqual(2);
    expect(format(report)).toContain("missing from settings.json");
  });

  it("all present: no liveness errors or warnings; a gate-disabled hook is a warning, not an error", async () => {
    const f = fixture();
    installClaude(f);
    const opts = {
      configPath: f.configPath,
      homeOverride: f.dir,
      envOverride: {} as NodeJS.ProcessEnv,
      shallow: true,
    };
    const clean = await doctor(opts);
    const cleanLiveness = clean.hookLiveness!.runtimes[0]!.entries;
    expect(cleanLiveness.every((e) => e.status === "ok")).toBe(true);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const disabled = await doctor(opts);
    expect(disabled.errorCount).toBe(clean.errorCount);
    expect(disabled.warningCount).toBe(clean.warningCount + 1);
  });

  it("`--target codex` also compares the Codex config", async () => {
    const f = fixture();
    installClaude(f);
    const report = await doctor({
      configPath: f.configPath,
      homeOverride: f.dir,
      envOverride: {},
      shallow: true,
      target: "codex",
      codexLiveConfigPath: f.codexPath,
    });
    expect(report.hookLiveness?.runtimes.map((r) => r.runtime)).toEqual(["claude-code", "codex"]);
    const codex = report.hookLiveness!.runtimes[1]!;
    expect(kinds(codex)).toEqual(["file:error"]);
  });

  it("CLAUDE_CONFIG_DIR decides which settings.json is compared", async () => {
    const f = fixture();
    const other = path.join(f.dir, "alt");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "settings.json"), JSON.stringify({ hooks: {} }));
    installClaude(f);
    const report = await doctor({
      configPath: f.configPath,
      homeOverride: f.dir,
      envOverride: { CLAUDE_CONFIG_DIR: other },
      shallow: true,
    });
    expect(report.hookLiveness!.runtimes[0]!.livePath).toBe(path.join(other, "settings.json"));
    expect(report.hookLiveness!.runtimes[0]!.entries.some((e) => e.kind === "missing")).toBe(true);
  });

  it("a gate-disabled hook in the default settings.json: the warning names plain `harness gate enable`", async () => {
    const f = fixture();
    installClaude(f);
    gateDisable({ settingsPath: f.settingsPath, matcher: "Write|Edit" });
    const report = await doctor({ configPath: f.configPath, homeOverride: f.dir, envOverride: {}, shallow: true });
    const msg = report.hookLiveness!.runtimes[0]!.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain("run `harness gate enable` to put it back");
    expect(msg).not.toContain("--settings");
  });

  it("a gate-disabled hook in the settings.json CLAUDE_CONFIG_DIR names: the warning names it with --settings, which the gate needs", async () => {
    const f = fixture();
    const other = path.join(f.dir, "alt");
    fs.mkdirSync(other);
    const settings = path.join(other, "settings.json");
    fs.writeFileSync(settings, `${JSON.stringify(generateSettings(withPacks(f, "claude-code")), null, 2)}\n`);
    gateDisable({ settingsPath: settings, matcher: "Write|Edit" });
    const report = await doctor({
      configPath: f.configPath,
      homeOverride: f.dir,
      envOverride: { CLAUDE_CONFIG_DIR: other },
      shallow: true,
    });
    const msg = report.hookLiveness!.runtimes[0]!.entries.find((e) => e.kind === "disabled")!.message;
    expect(msg).toContain(`run \`harness gate enable --settings ${settings}\` to put it back`);
    // The gate's default (`<home>/.claude/settings.json`) holds no snapshot; the named file does.
    expect(gateEnable({ homeDir: f.dir }).mode).toBe("no-snapshots");
    expect(gateEnable({ settingsPath: settings }).mode).toBe("restored");
  });

  it("a gate-disabled unit under `--target codex`: --config only when the compared config is not `<home>/.codex/config.toml`", async () => {
    const f = fixture();
    installCodex(f);
    codexGateDisable({ configPath: f.codexPath, matcher: "Write|Edit" });
    const base = { configPath: f.configPath, homeOverride: f.dir, envOverride: {}, shallow: true, target: "codex" as const };
    const atDefault = await doctor({ ...base, codexLiveConfigPath: f.codexPath });
    const plain = atDefault.hookLiveness!.runtimes[1]!.entries.find((e) => e.kind === "disabled")!.message;
    expect(plain).toContain("run `harness gate enable --runtime codex` to put it back");
    const moved = path.join(f.dir, "codex-elsewhere", "config.toml");
    fs.mkdirSync(path.dirname(moved));
    installCodex(f, moved);
    codexGateDisable({ configPath: moved, matcher: "Write|Edit" });
    const named = await doctor({ ...base, codexLiveConfigPath: moved });
    expect(named.hookLiveness!.runtimes[1]!.entries.find((e) => e.kind === "disabled")!.message).toContain(
      `run \`harness gate enable --runtime codex --config ${moved}\` to put it back`,
    );
  });

  it("livenessRuntimes: the selected runtime, plus codex under --target codex", () => {
    expect(livenessRuntimes("claude-code", undefined)).toEqual(["claude-code"]);
    expect(livenessRuntimes("codex", undefined)).toEqual(["codex"]);
    expect(livenessRuntimes("claude-code", "codex")).toEqual(["claude-code", "codex"]);
    expect(livenessRuntimes("opencode", undefined)).toEqual([]);
  });
});
