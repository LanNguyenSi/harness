import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  assertCodexHookEditInvariant,
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  CodexInstallRefusalError,
  planCodexConfigInstall,
  readCodexManagedHookUnits,
  writeCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import {
  CODEX_SNAPSHOT_BASENAME_PREFIX,
  CODEX_SNAPSHOT_TARGET,
  CODEX_SNAPSHOT_VERSION,
  readCodexSnapshot,
} from "../../../src/cli/gate/codex-snapshot.js";
import { gateDisable, GateDisableError } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";
import { listSnapshots } from "../../../src/cli/gate/snapshot.js";
import { parseManifest } from "../../../src/schema/index.js";

// The Codex gate edits the config `harness apply --runtime codex --install`
// writes, so every fixture here is built by the installer itself.

let tmp: string;
let configPath: string;

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

const OPERATOR_BEFORE = [
  'model = "gpt-5.5"',
  "",
  "[mcp_servers.docs]",
  'command = "docs-server"',
  'env = { TOKEN = "sk-live-FAKE-0123456789" }',
  "",
].join("\n");

const OPERATOR_AFTER = [
  "",
  '[projects."/work/x"]',
  'trust_level = "trusted"',
  "",
  "[[hooks.Stop]]",
  'hooks = [{ type = "command", command = "operator-stop-hook", timeout = 3 }]',
  "",
].join("\n");

function manifest() {
  return parseManifest({
    version: 1,
    hooks: [
      {
        name: "policy-pack:branch-protection:pre-tool-use",
        event: "PreToolUse",
        match: "apply_patch",
        command: "harness pack hook branch-protection --runtime codex",
        blocking: "hard",
        budget_ms: 5000,
      },
      {
        name: "hand-shell-guard",
        event: "PreToolUse",
        match: "Bash",
        command: "harness pack hook shell-guard --runtime codex",
        blocking: "hard",
        budget_ms: 5000,
      },
      {
        name: "hand-user-prompt-submit",
        event: "UserPromptSubmit",
        command: "/usr/bin/true",
        blocking: false,
        budget_ms: 5000,
      },
    ],
  });
}

/** Installs the generated block into `target` with the installer, between operator content. */
function installConfig(
  target: string,
  opts: { before?: string; after?: string; mode?: number } = {},
): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, opts.before ?? OPERATOR_BEFORE);
  if (opts.mode !== undefined) fs.chmodSync(target, opts.mode);
  const generated = generateCodexConfig(manifest());
  const plan = planCodexConfigInstall({
    configPath: target,
    generatedPath: "/gen/codex/config.toml",
    generatedContent: generated.content,
  });
  writeCodexConfigInstall(plan, { now: new Date("2026-10-01T00:00:00.000Z") });
  const installed = fs.readFileSync(plan.configPath, "utf8");
  const full = `${installed}${opts.after ?? OPERATOR_AFTER}`;
  fs.writeFileSync(plan.configPath, full);
  return full;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-codex-gate-"));
  configPath = path.join(tmp, ".codex", "config.toml");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T0 = new Date("2026-10-02T10:00:00.000Z");
const T1 = new Date("2026-10-02T11:00:00.000Z");

describe("readCodexManagedHookUnits", () => {
  it("returns the generated units with exact slab offsets, and null for a file with no block", () => {
    const text = installConfig(configPath);
    const block = readCodexManagedHookUnits(text, configPath);
    expect(block?.units.map((u) => [u.event, u.matcher, u.id])).toEqual([
      ["PreToolUse", "apply_patch", "policy-pack:branch-protection:pre-tool-use"],
      ["PreToolUse", expect.stringContaining("Bash"), "hand-shell-guard"],
      ["UserPromptSubmit", null, "hand-user-prompt-submit"],
    ]);
    const [first, second, third] = block!.units;
    expect(first!.commands).toEqual(["harness pack hook branch-protection --runtime codex"]);
    // Slabs tile the units region: each unit starts at its comment line and
    // ends where the next one (or the END marker line) begins.
    expect(text.slice(first!.start, first!.start + 14)).toBe("# harness hook");
    expect(first!.end).toBe(second!.start);
    expect(second!.end).toBe(third!.start);
    expect(third!.end).toBe(block!.endMarkerStart);
    expect(text.slice(block!.endMarkerStart).startsWith(CODEX_MANAGED_END)).toBe(true);
    expect(readCodexManagedHookUnits(OPERATOR_BEFORE, configPath)).toBeNull();
  });

  it("refuses a block without a BEGIN fence (an older install) instead of guessing", () => {
    const legacy = [
      "# Harness Codex hook wiring. Generated source: /gen/config.toml",
      "# Generated by harness apply --runtime codex.",
      "# harness hook: legacy (budget_ms=5000)",
      "[[hooks.PreToolUse]]",
      'matcher = "apply_patch"',
      'hooks = [{ type = "command", command = "harness pack hook branch-protection --runtime codex", timeout = 5 }]',
      "",
    ].join("\n");
    expect(() => readCodexManagedHookUnits(legacy, configPath)).toThrow(/no '# BEGIN harness-managed codex hooks' fence/);
  });

  it("refuses content inside the block that is not a generated unit", () => {
    const text = installConfig(configPath);
    const extra = text.replace(
      "# harness hook: hand-shell-guard",
      'stray_key = "x"\n# harness hook: hand-shell-guard',
    );
    expect(() => readCodexManagedHookUnits(extra, configPath)).toThrow(CodexInstallRefusalError);
    const reshaped = text.replace(/(\[\[hooks\.UserPromptSubmit\]\]\n)/, "$1extra = 1\n");
    expect(() => readCodexManagedHookUnits(reshaped, configPath)).toThrow(/not the generated shape/);
  });
});

describe("assertCodexHookEditInvariant", () => {
  it("passes when the event arrays differ by exactly the declared delta", () => {
    const text = installConfig(configPath);
    const block = readCodexManagedHookUnits(text, configPath)!;
    const first = block.units[0]!;
    const after = text.slice(0, first.start) + text.slice(first.end);
    expect(() => assertCodexHookEditInvariant(text, after, configPath, { PreToolUse: -1 })).not.toThrow();
  });

  it("refuses an edit that drops an entry the delta does not account for", () => {
    const text = installConfig(configPath);
    const block = readCodexManagedHookUnits(text, configPath)!;
    const first = block.units[0]!;
    const after = text.slice(0, first.start) + text.slice(first.end);
    expect(() => assertCodexHookEditInvariant(text, after, configPath, {})).toThrow(
      /number of 'PreToolUse' hook entries by -1, expected 0/,
    );
    expect(() => assertCodexHookEditInvariant(text, after, configPath, { PreToolUse: -2 })).toThrow(
      /expected -2/,
    );
  });

  it("refuses an edit that changes anything outside the hook event arrays", () => {
    const text = installConfig(configPath);
    const after = text.replace('model = "gpt-5.5"', 'model = "other"');
    expect(() => assertCodexHookEditInvariant(text, after, configPath, {})).toThrow(/model/);
  });
});

describe("codexGateDisable — listing", () => {
  it("lists every unit and writes nothing", () => {
    installConfig(configPath);
    const before = fs.readdirSync(path.dirname(configPath)).sort();
    const r = codexGateDisable({ configPath });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(r.candidates.map((c) => [c.event, c.index, c.matcher === null ? null : c.matcher.length > 0])).toEqual([
      ["PreToolUse", 0, true],
      ["PreToolUse", 1, true],
      ["UserPromptSubmit", 0, null],
    ]);
    expect(r.candidates[0]!.description).toBe("harness pack hook branch-protection --runtime codex");
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(before);
  });

  it("uses ~/.codex/config.toml under the injected home by default", () => {
    const home = path.join(tmp, "home");
    installConfig(path.join(home, ".codex", "config.toml"));
    const r = codexGateDisable({ homeDir: home });
    expect(r.mode).toBe("list");
    expect(r.configPath).toBe(path.join(home, ".codex", "config.toml"));
  });
});

describe("codexGateDisable / codexGateEnable — round trip", () => {
  it("removes only the matching unit and restores the config byte-identically", () => {
    const original = installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    expect(d.mode).toBe("remove");
    if (d.mode !== "remove") return;
    expect(d.removed.map((u) => u.id)).toEqual(["policy-pack:branch-protection:pre-tool-use"]);

    const disabled = fs.readFileSync(configPath, "utf8");
    expect(disabled).not.toContain("branch-protection");
    // The other two units, the fences and the source-prefix line stay.
    expect(disabled).toContain("# harness hook: hand-shell-guard");
    expect(disabled).toContain("# harness hook: hand-user-prompt-submit");
    expect(disabled).toContain(CODEX_MANAGED_BEGIN);
    expect(disabled).toContain(CODEX_MANAGED_END);
    expect(disabled).toContain("# Harness Codex hook wiring.");
    // The backup is the pre-disable file, the snapshot records both shas.
    expect(fs.readFileSync(d.backupPath, "utf8")).toBe(original);
    const snap = readCodexSnapshot(d.snapshotPath);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.version).toBe(CODEX_SNAPSHOT_VERSION);
    expect(snap.snapshot.target).toBe(CODEX_SNAPSHOT_TARGET);
    expect(snap.snapshot.configBeforeSha256).toBe(sha(original));
    expect(snap.snapshot.configAfterSha256).toBe(sha(disabled));

    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("restored");
    if (e.mode !== "restored") return;
    expect(e.restoredCount).toBe(1);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readFileSync(e.backupPath, "utf8")).toBe(disabled);
  });

  it("restores a config with several removed units, including the last, byte-identically", () => {
    const original = installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "a", now: T0 });
    // "a" substring-matches both PreToolUse matchers ("apply_patch", and the Bash alias set).
    expect(d.mode === "remove" && d.removed.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("removes every unit with a matching matcher and nothing else when two units match", () => {
    const original = installConfig(configPath);
    const block = readCodexManagedHookUnits(original, configPath)!;
    const bashMatcher = block.units[1]!.matcher!;
    const d = codexGateDisable({ configPath, matcher: bashMatcher.slice(0, 4), now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.removed.map((u) => u.id)).toEqual(["hand-shell-guard"]);
    expect(fs.readFileSync(configPath, "utf8")).toContain("branch-protection");
  });

  it("keeps the matcher filter literal: a unit with no matcher is never matched", () => {
    installConfig(configPath);
    expect(() => codexGateDisable({ configPath, matcher: "UserPromptSubmit", now: T0 })).toThrow(
      /no hook units matched/,
    );
  });

  it("leaves every operator table before and after the fences untouched", () => {
    const original = installConfig(configPath);
    const beginAt = original.indexOf("# Harness Codex hook wiring.");
    const endAt = original.indexOf(CODEX_MANAGED_END) + CODEX_MANAGED_END.length;
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const disabled = fs.readFileSync(configPath, "utf8");
    expect(disabled.slice(0, beginAt)).toBe(original.slice(0, beginAt));
    expect(disabled.slice(disabled.length - (original.length - endAt))).toBe(original.slice(endAt));
    expect(disabled).toContain("operator-stop-hook");
    expect(disabled).toContain("sk-live-FAKE-0123456789");
  });

  it("disables everything when every unit is matched, and the next enable brings the block back", () => {
    const original = installConfig(configPath);
    const block = readCodexManagedHookUnits(original, configPath)!;
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    const second = codexGateDisable({ configPath, now: T0 });
    expect(second.mode).toBe("list");
    codexGateEnable({ configPath, now: T1 });
    expect(readCodexManagedHookUnits(fs.readFileSync(configPath, "utf8"), configPath)!.units).toHaveLength(
      block.units.length,
    );
  });

  it("is idempotent: enable on an already restored config writes nothing", () => {
    const original = installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    codexGateEnable({ configPath, now: T1 });
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    const again = codexGateEnable({ configPath, now: new Date("2026-10-02T12:00:00.000Z") });
    expect(again.mode).toBe("already-restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
  });

  it("reports no snapshots when none exist", () => {
    installConfig(configPath);
    expect(codexGateEnable({ configPath }).mode).toBe("no-snapshots");
  });
});

describe("codex gate — symlinked config", () => {
  it("edits the resolved target, keeps the link, and writes backup and snapshot beside the link", () => {
    const real = path.join(tmp, "dotfiles", "config.toml");
    const original = installConfig(real);
    const linkDir = path.join(tmp, "codex-home");
    fs.mkdirSync(linkDir);
    const link = path.join(linkDir, "config.toml");
    fs.symlinkSync(real, link);

    const d = codexGateDisable({ configPath: link, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).not.toContain("branch-protection");
    expect(path.dirname(d.backupPath)).toBe(linkDir);
    expect(path.dirname(d.snapshotPath)).toBe(linkDir);
    // Nothing of the gate lands in the dotfiles directory the link points into.
    expect(fs.readdirSync(path.dirname(real)).filter((n) => !n.startsWith("config.toml.harness-backup-"))).toEqual([
      "config.toml",
    ]);

    const e = codexGateEnable({ configPath: link, now: T1 });
    expect(e.mode).toBe("restored");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe(original);
  });

  it("refuses a dangling symlink", () => {
    const link = path.join(tmp, "config.toml");
    fs.symlinkSync(path.join(tmp, "missing.toml"), link);
    expect(() => codexGateDisable({ configPath: link, matcher: "x" })).toThrow(GateDisableError);
    expect(() => codexGateEnable({ configPath: link })).toThrow(/dangling symlink/);
  });
});

describe("codex gate — file mode", () => {
  it("keeps mode 0600 on the rewritten config, the backup and the snapshot, on disable and on enable", () => {
    installConfig(configPath, { mode: 0o600 });
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    for (const file of [configPath, d.backupPath, d.snapshotPath]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const e = codexGateEnable({ configPath, now: T1 });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(e.backupPath).mode & 0o777).toBe(0o600);
  });
});

describe("codexGateEnable — integrity", () => {
  it("refuses when the config was edited since the disable, leaving it untouched", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.appendFileSync(configPath, '\n[tui]\nnotifications = true\n');
    const edited = fs.readFileSync(configPath, "utf8");
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    expect(() => codexGateEnable({ configPath, now: T1 })).toThrow(/edited since the snapshot was taken/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
  });

  it("--force restores the unit at its place and keeps the edit", () => {
    const original = installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.appendFileSync(configPath, '\n[tui]\nnotifications = true\n');
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode).toBe("restored");
    const restored = fs.readFileSync(configPath, "utf8");
    expect(restored).toBe(`${original}\n[tui]\nnotifications = true\n`);
  });

  it("--force puts several removed units back at their positions among the remaining ones", () => {
    const original = installConfig(configPath);
    // "a" matches both PreToolUse units; the UserPromptSubmit unit stays.
    const d = codexGateDisable({ configPath, matcher: "a", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.removed.map((u) => u.ordinal)).toEqual([0, 1]);
    fs.appendFileSync(configPath, '\n[tui]\nnotifications = true\n');
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode === "restored" && e.restoredCount).toBe(2);
    const restored = fs.readFileSync(configPath, "utf8");
    expect(restored).toBe(`${original}\n[tui]\nnotifications = true\n`);
  });

  it("--force restores into a block whose remaining units were reordered by the edit, by ordinal", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    // The operator removed the shell guard unit by hand, so the block now has one unit left.
    const text = fs.readFileSync(configPath, "utf8");
    const block = readCodexManagedHookUnits(text, configPath)!;
    const shell = block.units[0]!;
    fs.writeFileSync(configPath, text.slice(0, shell.start) + text.slice(shell.end));
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode).toBe("restored");
    const units = readCodexManagedHookUnits(fs.readFileSync(configPath, "utf8"), configPath)!.units;
    expect(units.map((u) => u.id)).toEqual(["policy-pack:branch-protection:pre-tool-use", "hand-user-prompt-submit"]);
  });

  it("--force into a block with no unit left puts the units in front of the END marker", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const text = fs.readFileSync(configPath, "utf8");
    const block = readCodexManagedHookUnits(text, configPath)!;
    fs.writeFileSync(
      configPath,
      text.slice(0, block.units[0]!.start) + text.slice(block.endMarkerStart),
    );
    expect(readCodexManagedHookUnits(fs.readFileSync(configPath, "utf8"), configPath)!.units).toEqual([]);
    codexGateEnable({ configPath, force: true, now: T1 });
    const units = readCodexManagedHookUnits(fs.readFileSync(configPath, "utf8"), configPath)!.units;
    expect(units.map((u) => u.id)).toEqual(["policy-pack:branch-protection:pre-tool-use"]);
  });

  it("--force refuses to restore a unit whose id is already in the block (a second forced enable)", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.appendFileSync(configPath, '\n[tui]\nnotifications = true\n');
    codexGateEnable({ configPath, force: true, now: T1 });
    const restored = fs.readFileSync(configPath, "utf8");
    expect(() => codexGateEnable({ configPath, force: true, now: new Date("2026-10-02T12:00:00.000Z") })).toThrow(
      /already in the block/,
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(restored);
  });

  it("--force refuses a restore whose result would not parse (the post-edit guard on enable)", () => {
    installConfig(configPath);
    // "a" removes both PreToolUse units. The operator then defines hooks.PreToolUse as a plain
    // table, which a restored [[hooks.PreToolUse]] unit earlier in the file would contradict.
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    fs.appendFileSync(configPath, '\n[hooks.PreToolUse]\nnote = "x"\n');
    const edited = fs.readFileSync(configPath, "utf8");
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(/would not parse as TOML/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited);
  });

  it("--force refuses when the harness block is gone from the config", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.writeFileSync(configPath, OPERATOR_BEFORE);
    expect(() => codexGateEnable({ configPath, force: true })).toThrow(/no harness-managed Codex hook block/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(OPERATOR_BEFORE);
  });

  it("refuses a snapshot whose text does not rebuild the recorded config", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const disabled = fs.readFileSync(configPath, "utf8");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    snap.removed[0].text = snap.removed[0].text.replace("apply_patch", "apply_patcX");
    fs.writeFileSync(d.snapshotPath, JSON.stringify(snap));
    expect(() => codexGateEnable({ configPath, now: T1 })).toThrow(/does not rebuild the config/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
  });

  it("refuses a snapshot taken for another config", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    snap.configPath = path.join(tmp, "elsewhere.toml");
    fs.writeFileSync(d.snapshotPath, JSON.stringify(snap));
    expect(() => codexGateEnable({ configPath })).toThrow(/was taken for/);
  });

  it("refuses a malformed or foreign-version snapshot", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    for (const broken of [
      { ...snap, version: 1 },
      { ...snap, target: "claude" },
      { ...snap, target: undefined },
      { ...snap, configAfterSha256: undefined },
      { ...snap, filter: null },
      { ...snap, removed: [] },
      { ...snap, removed: [{ ...snap.removed[0], end: snap.removed[0].end + 1 }] },
    ]) {
      fs.writeFileSync(d.snapshotPath, JSON.stringify(broken));
      expect(() => codexGateEnable({ configPath })).toThrow(GateEnableError);
    }
  });

  it("refuses when the config is gone", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.rmSync(configPath);
    expect(() => codexGateEnable({ configPath })).toThrow(/Codex config not found/);
  });
});

describe("codexGateDisable — refusals leave the file byte-identical", () => {
  function expectRefusal(content: string | null, matcher: string | undefined, message: RegExp): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.rmSync(configPath, { force: true });
    if (content !== null) fs.writeFileSync(configPath, content);
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    expect(() => codexGateDisable({ configPath, ...(matcher ? { matcher } : {}), now: T0 })).toThrow(message);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
    if (content !== null) expect(fs.readFileSync(configPath, "utf8")).toBe(content);
  }

  it("a missing config file", () => {
    expectRefusal(null, "apply_patch", /Codex config not found/);
  });

  it("a config with no harness block", () => {
    expectRefusal(OPERATOR_BEFORE, "apply_patch", /no harness-managed Codex hook block/);
  });

  it("nothing matched", () => {
    const text = installConfig(configPath);
    expectRefusal(text, "no-such-matcher", /no hook units matched/);
  });

  it("a duplicate BEGIN marker", () => {
    const text = installConfig(configPath);
    expectRefusal(`${text}\n${CODEX_MANAGED_BEGIN}\n`, "apply_patch", /more than one/);
  });

  it("a missing END marker", () => {
    const text = installConfig(configPath, { after: "" }).replace(CODEX_MANAGED_END, "# not the end");
    expectRefusal(text, "apply_patch", /not closed by a '# END harness-managed codex hooks' marker/);
  });

  it("a drifted END marker (a foreign table between the last unit and the END line)", () => {
    const text = installConfig(configPath, { after: "" });
    const drifted = text.replace(
      CODEX_MANAGED_END,
      `[wedge]\nkey = "v"\n${CODEX_MANAGED_END}`,
    );
    expectRefusal(drifted, "apply_patch", /not closed by a '# END harness-managed codex hooks' marker/);
  });

  it("a foreign table wedged between the fences", () => {
    const text = installConfig(configPath);
    const wedged = text.replace(
      "# harness hook: hand-shell-guard",
      '[wedge]\nkey = "v"\n\n# harness hook: hand-shell-guard',
    );
    expectRefusal(wedged, "apply_patch", /foreign table/);
  });

  it("a removal that would turn a hook event array into a plain table (the post-edit guard)", () => {
    // `[hooks.PreToolUse.extra]` extends the LAST PreToolUse entry. Removing both
    // PreToolUse units would leave it defining `hooks.PreToolUse` as a table,
    // a change outside the hook event arrays that the semantic net refuses.
    const text = installConfig(configPath, { after: '\n[hooks.PreToolUse.extra]\nnote = "x"\n' });
    expectRefusal(text, "a", /installing would change 'hooks\.PreToolUse/);
  });

  it("a hook comment outside the block that harness cannot tell from a stray unit", () => {
    const text = installConfig(configPath, {
      after: '\n# harness hook: stray (budget_ms=5000)\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "x", timeout = 1 }]\n',
    });
    expectRefusal(text, "apply_patch", /no harness block marker/);
  });
});

describe("codex gate — snapshot isolation from the Claude gate", () => {
  let settingsPath: string;

  beforeEach(() => {
    // Both configs sit in one directory, so the snapshots share it.
    settingsPath = path.join(path.dirname(configPath), "settings.json");
  });

  function writeSettings(): string {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const body = `${JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "claude-gate" }] }] } },
      null,
      2,
    )}\n`;
    fs.writeFileSync(settingsPath, body);
    return body;
  }

  function touch(file: string, when: Date): void {
    fs.utimesSync(file, when, when);
  }

  it("Codex enable ignores a newer Claude snapshot and Claude enable ignores a newer Codex snapshot", () => {
    const originalConfig = installConfig(configPath);
    const originalSettings = writeSettings();

    const claude = gateDisable({ settingsPath, matcher: "Edit", now: T0 });
    const codex = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (claude.mode !== "remove" || codex.mode !== "remove") throw new Error("expected remove");
    expect(path.basename(codex.snapshotPath).startsWith(CODEX_SNAPSHOT_BASENAME_PREFIX)).toBe(true);
    expect(path.basename(claude.snapshotPath).startsWith(CODEX_SNAPSHOT_BASENAME_PREFIX)).toBe(false);

    // Claude snapshot newer than the Codex one.
    touch(codex.snapshotPath, new Date("2026-10-02T10:00:00.000Z"));
    touch(claude.snapshotPath, new Date("2026-10-02T11:00:00.000Z"));
    expect(codexGateEnable({ configPath, now: T1 }).mode).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(fs.readFileSync(settingsPath, "utf8")).not.toBe(originalSettings);

    // Codex snapshot newer than the Claude one.
    codexGateDisable({ configPath, matcher: "apply_patch", now: new Date("2026-10-02T12:00:00.000Z") });
    const newest = listSnapshots(path.dirname(configPath), CODEX_SNAPSHOT_BASENAME_PREFIX)[0]!;
    touch(newest, new Date("2026-10-02T13:00:00.000Z"));
    touch(claude.snapshotPath, new Date("2026-10-02T09:00:00.000Z"));
    const e = gateEnable({ settingsPath });
    expect(e.mode).toBe("restored");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(originalSettings);
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(originalConfig);
  });

  it("each target sees no snapshots when only the other target's exist", () => {
    installConfig(configPath);
    writeSettings();
    const codex = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (codex.mode !== "remove") throw new Error("expected remove");
    expect(gateEnable({ settingsPath }).mode).toBe("no-snapshots");
    fs.rmSync(codex.snapshotPath);
    gateDisable({ settingsPath, matcher: "Edit", now: T1 });
    expect(codexGateEnable({ configPath }).mode).toBe("no-snapshots");
  });

  it("a Codex snapshot renamed to the Claude prefix is rejected by the Claude reader, not restored", () => {
    installConfig(configPath);
    writeSettings();
    const codex = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (codex.mode !== "remove") throw new Error("expected remove");
    const renamed = path.join(path.dirname(configPath), "harness.gate-disable.2026-10-02T09-00-00.000Z.json");
    fs.renameSync(codex.snapshotPath, renamed);
    expect(() => gateEnable({ settingsPath })).toThrow(/unsupported version/);
  });

  it("a Claude snapshot renamed to the Codex prefix is rejected by the Codex reader, not restored", () => {
    const original = installConfig(configPath);
    writeSettings();
    const claude = gateDisable({ settingsPath, matcher: "Edit", now: T0 });
    if (claude.mode !== "remove") throw new Error("expected remove");
    const renamed = path.join(path.dirname(configPath), `${CODEX_SNAPSHOT_BASENAME_PREFIX}2026-10-02T09-00-00.000Z.json`);
    fs.renameSync(claude.snapshotPath, renamed);
    expect(() => codexGateEnable({ configPath })).toThrow(/is not a Codex gate snapshot/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("an existing Claude version-1 snapshot (no target) still restores under the Claude gate", () => {
    writeSettings();
    const d = gateDisable({ settingsPath, matcher: "Edit", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    expect(snap.version).toBe(1);
    expect(snap.target).toBeUndefined();
    expect(gateEnable({ settingsPath }).mode).toBe("restored");
  });
});
