import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseTomlForTest } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  assertCodexHookEditInvariant,
  assertConfigSemanticInvariant,
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  CodexInstallRefusalError,
  latestCodexInstallBackupMs,
  planCodexConfigInstall,
  readCodexManagedHookUnits,
  writeCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import {
  CODEX_NEUTRALISED_HOOKS,
  CODEX_SNAPSHOT_BASENAME_PREFIX,
  CODEX_SNAPSHOT_TARGET,
  CODEX_SNAPSHOT_VERSION,
  type CodexSnapshotRetirement,
  gateWording,
  listCodexSnapshots,
  readCodexSnapshot,
  codexSnapshotPath,
  retiredCodexSnapshotPath,
} from "../../../src/cli/gate/codex-snapshot.js";
import { gateDisable, GateDisableError } from "../../../src/cli/gate/disable.js";
import { gateEnable, GateEnableError } from "../../../src/cli/gate/enable.js";
import { listSnapshots } from "../../../src/cli/gate/snapshot.js";
import { parseManifest } from "../../../src/schema/index.js";
import { downgradeToVersion1 } from "../../_helpers/claude-gate-legacy.js";
import { foldsCase } from "./fold-case.js";
import { asLegacyInstall } from "./legacy-install.js";

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

function manifest(shellGuardCommand = "harness pack hook shell-guard --runtime codex", withEditGuard = false) {
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
        command: shellGuardCommand,
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
      ...(withEditGuard
        ? [
            {
              name: "hand-edit-guard",
              event: "PreToolUse",
              match: "Edit",
              command: "harness pack hook edit-guard --runtime codex",
              blocking: "hard",
              budget_ms: 5000,
            },
          ]
        : []),
    ],
  });
}

/** Installs the generated block into `target` with the installer, between operator content. */
function installConfig(
  target: string,
  opts: { before?: string; after?: string; mode?: number; withEditGuard?: boolean } = {},
): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, opts.before ?? OPERATOR_BEFORE);
  if (opts.mode !== undefined) fs.chmodSync(target, opts.mode);
  const generated = generateCodexConfig(manifest(undefined, opts.withEditGuard));
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

/** Re-runs the installer over the config at `now`, as `harness apply --runtime codex --install`
 * does after a manifest change: it re-renders the whole block and leaves its
 * `<config>.harness-backup-<now>` file beside the config. */
function reinstall(target: string, now: Date, shellGuardCommand?: string): string {
  const generated = generateCodexConfig(manifest(shellGuardCommand));
  // As an installer that predates the install-time supersede would leave the snapshots: the
  // gate's own dating by the installer's backup files is what these callers exercise.
  asLegacyInstall(path.dirname(target), () =>
    writeCodexConfigInstall(
      planCodexConfigInstall({ configPath: target, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
      { now },
    ),
  );
  return fs.readFileSync(target, "utf8");
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

/** The hook event arrays of a config, parsed. */
function hookArrays(text: string): Record<string, Array<Record<string, unknown>>> {
  const doc = parseTomlForTest(text) as { hooks?: Record<string, unknown> };
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [event, value] of Object.entries(doc.hooks ?? {})) {
    if (Array.isArray(value)) out[event] = value as Array<Record<string, unknown>>;
  }
  return out;
}

function hookHasKey(text: string, event: string, index: number, key: string): boolean {
  return key in (hookArrays(text)[event]?.[index] ?? {});
}

/** The config with the named units neutralised by hand (the shape the gate writes). */
function neutraliseByHand(text: string, ...ids: string[]): string {
  const block = readCodexManagedHookUnits(text, configPath)!;
  let out = text;
  for (const unit of [...block.units].reverse()) {
    if (!ids.includes(unit.id)) continue;
    out = `${out.slice(0, unit.hooksStart)}${CODEX_NEUTRALISED_HOOKS}${out.slice(unit.hooksEnd)}`;
  }
  return out;
}

/** The current config with the unit's `hooks` line put back by hand: the snapshot's original line, or `line`. */
function putBack(id: string, line?: string): string {
  const live = listCodexSnapshots(path.dirname(configPath))[0]!;
  const snap = readCodexSnapshot(live);
  if (!snap.ok) throw new Error("snapshot unreadable");
  const text = fs.readFileSync(configPath, "utf8");
  const unit = readCodexManagedHookUnits(text, configPath)!.units.find((u) => u.id === id)!;
  const original = snap.snapshot.neutralised.find((u) => u.id === id)!.hooksText;
  return `${text.slice(0, unit.hooksStart)}${line ?? original}${text.slice(unit.hooksEnd)}`;
}

function touch(file: string, when: Date): void {
  fs.utimesSync(file, when, when);
}

/** `file` as an installer from before the block generation marker wrote it: the marker line
 * removed (rewritten in place), so only the installer's backup files date an install. */
function preMarker(file: string): string {
  const text = fs.readFileSync(file, "utf8").replace(/^# harness block generation: [0-9a-f]{64}\n/m, "");
  fs.writeFileSync(file, text);
  return text;
}

/** The name the enable walk gives a snapshot it retires. */
function retired(snapPath: string, why: CodexSnapshotRetirement = "restored"): string {
  return retiredCodexSnapshotPath(snapPath, why);
}

const BP = "policy-pack:branch-protection:pre-tool-use";

/** The message a call throws; fails when it does not throw. */
function thrownMessage(call: () => unknown): string {
  try {
    call();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the call to throw");
}

describe("readCodexManagedHookUnits", () => {
  it("returns the generated units with the exact span of their hooks line, and null for a file with no block", () => {
    const text = installConfig(configPath);
    const block = readCodexManagedHookUnits(text, configPath);
    expect(block?.units.map((u) => [u.event, u.matcher, u.id, u.disabled])).toEqual([
      ["PreToolUse", "apply_patch", BP, false],
      ["PreToolUse", expect.stringContaining("Bash"), "hand-shell-guard", false],
      ["UserPromptSubmit", null, "hand-user-prompt-submit", false],
    ]);
    const [first] = block!.units;
    expect(first!.commands).toEqual(["harness pack hook branch-protection --runtime codex"]);
    expect(text.slice(first!.start, first!.start + 14)).toBe("# harness hook");
    for (const unit of block!.units) {
      const line = text.slice(unit.hooksStart, unit.hooksEnd);
      expect(line.startsWith("hooks = [{")).toBe(true);
      expect(line.endsWith("}]")).toBe(true);
    }
    expect(readCodexManagedHookUnits(OPERATOR_BEFORE, configPath)).toBeNull();
  });

  it("reads a neutralised unit as disabled and keeps the others enabled", () => {
    const text = neutraliseByHand(installConfig(configPath), BP);
    const block = readCodexManagedHookUnits(text, configPath)!;
    expect(block.units.map((u) => [u.id, u.disabled])).toEqual([
      [BP, true],
      ["hand-shell-guard", false],
      ["hand-user-prompt-submit", false],
    ]);
    expect(block.units[0]!.commands).toEqual([]);
    expect(text.slice(block.units[0]!.hooksStart, block.units[0]!.hooksEnd)).toBe(CODEX_NEUTRALISED_HOOKS);
  });

  it("spans the hooks line without its CRLF terminator", () => {
    const text = installConfig(configPath).replace(/\n/g, "\r\n");
    const block = readCodexManagedHookUnits(text, configPath)!;
    for (const unit of block.units) {
      const line = text.slice(unit.hooksStart, unit.hooksEnd);
      expect(line).not.toMatch(/[\r\n]/);
      expect(line.startsWith("hooks = [")).toBe(true);
    }
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

  it("refuses a unit whose matcher is not a string", () => {
    const text = installConfig(configPath).replace('matcher = "apply_patch"', "matcher = 7");
    expect(() => readCodexManagedHookUnits(text, configPath)).toThrow(/matcher that is not a string/);
  });

  it("refuses a comment between two hook units", () => {
    const text = installConfig(configPath);
    const noted = text.replace(
      "# harness hook: hand-shell-guard",
      "# operator note about the next hook\n# harness hook: hand-shell-guard",
    );
    expect(() => readCodexManagedHookUnits(noted, configPath)).toThrow(/comment between hook units/);
  });
});

describe("assertCodexHookEditInvariant", () => {
  it("passes a neutralise of exactly the declared count, and the restore back", () => {
    const text = installConfig(configPath);
    const off = neutraliseByHand(text, BP);
    expect(() =>
      assertCodexHookEditInvariant(text, off, configPath, { direction: "neutralise", counts: { PreToolUse: 1 } }),
    ).not.toThrow();
    expect(() =>
      assertCodexHookEditInvariant(off, text, configPath, { direction: "restore", counts: { PreToolUse: 1 } }),
    ).not.toThrow();
  });

  it("refuses a neutralise in the wrong direction or for the wrong count", () => {
    const text = installConfig(configPath);
    const off = neutraliseByHand(text, BP);
    expect(() =>
      assertCodexHookEditInvariant(text, off, configPath, { direction: "restore", counts: { PreToolUse: 1 } }),
    ).toThrow(/by more than its hooks array/);
    expect(() => assertCodexHookEditInvariant(text, off, configPath, { direction: "neutralise", counts: {} })).toThrow(
      /change 1 entries, expected 0/,
    );
    expect(() =>
      assertCodexHookEditInvariant(text, off, configPath, { direction: "neutralise", counts: { PreToolUse: 2 } }),
    ).toThrow(/change 1 entries, expected 2/);
  });

  it("refuses an edit that drops an entry", () => {
    const text = installConfig(configPath);
    const block = readCodexManagedHookUnits(text, configPath)!;
    // Cut the first unit (comment line to the next unit's comment line) out.
    const nextStart = text.indexOf("# harness hook: hand-shell-guard");
    const dropped = text.slice(0, block.units[0]!.start) + text.slice(nextStart);
    expect(() =>
      assertCodexHookEditInvariant(text, dropped, configPath, { direction: "neutralise", counts: { PreToolUse: 1 } }),
    ).toThrow(/change the number of entries from 2 to 1/);
  });

  it("compares entry by entry, not only counts: an unrelated entry that changed refuses", () => {
    const text = installConfig(configPath);
    // Same entry counts, the declared unit is neutralised, and a second entry also changed.
    const tampered = neutraliseByHand(text, BP).replace("shell-guard --runtime codex", "other-guard --runtime codex");
    expect(() =>
      assertCodexHookEditInvariant(text, tampered, configPath, { direction: "neutralise", counts: { PreToolUse: 1 } }),
    ).toThrow(/change entry 1 by more than its hooks array/);
  });

  it("refuses a key that moves from one entry into another (a bare key after the END marker)", () => {
    // A bare key after the END marker belongs, in TOML, to the last harness table.
    const trailing = installConfig(configPath, { after: '\napproval_policy = "never"\n' });
    expect(hookArrays(trailing)["UserPromptSubmit"]![0]!["approval_policy"]).toBe("never");
    const moved = neutraliseByHand(trailing, BP)
      .replace('\napproval_policy = "never"\n', "\n")
      .replace('matcher = "apply_patch"\nhooks = []', 'matcher = "apply_patch"\napproval_policy = "never"\nhooks = []');
    expect(hookHasKey(moved, "PreToolUse", 0, "approval_policy")).toBe(true);
    expect(() =>
      assertCodexHookEditInvariant(trailing, moved, configPath, { direction: "neutralise", counts: { PreToolUse: 1 } }),
    ).toThrow(/change entry 0 by more than its hooks array/);
  });

  it("refuses an edit that changes anything outside the hook event arrays", () => {
    const text = installConfig(configPath);
    const after = text.replace('model = "gpt-5.5"', 'model = "other"');
    expect(() => assertCodexHookEditInvariant(text, after, configPath, { direction: "neutralise", counts: {} })).toThrow(
      /model/,
    );
  });
});

describe("gate wording of installer refusals", () => {
  it("maps each installer phrase to the gate's own wording", () => {
    let semantic = "";
    try {
      assertConfigSemanticInvariant('model = "a"\n', 'model = "b"\n', "/c/config.toml");
    } catch (err) {
      semantic = (err as Error).message;
    }
    expect(semantic).toContain("installing would change");
    const mapped = gateWording(semantic);
    expect(mapped).toContain("the gate edit would change 'model'");
    expect(mapped).toContain("refusing to edit rather than risk");
    expect(mapped).not.toMatch(/refusing to install|installing would/);

    let unparsable = "";
    try {
      assertConfigSemanticInvariant("a = = 1\n", "a = 1\n", "/c/config.toml");
    } catch (err) {
      unparsable = (err as Error).message;
    }
    expect(gateWording(unparsable)).toContain("refusing to edit, because without parsing it");
    expect(gateWording(unparsable)).not.toContain("refusing to install");
  });
});

describe("codexGateDisable: listing", () => {
  it("lists every unit and writes nothing", () => {
    installConfig(configPath);
    const before = fs.readdirSync(path.dirname(configPath)).sort();
    const r = codexGateDisable({ configPath });
    expect(r.mode).toBe("list");
    if (r.mode !== "list") return;
    expect(
      r.candidates.map((c) => [c.event, c.index, c.disabled, c.matcher === null ? null : c.matcher.length > 0]),
    ).toEqual([
      ["PreToolUse", 0, false, true],
      ["PreToolUse", 1, false, true],
      ["UserPromptSubmit", 0, false, null],
    ]);
    expect(r.candidates[0]!.description).toBe("harness pack hook branch-protection --runtime codex");
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(before);
  });

  it("shows a neutralised unit as disabled, named by its id", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const r = codexGateDisable({ configPath });
    if (r.mode !== "list") throw new Error("expected list");
    expect(r.candidates.map((c) => [c.index, c.disabled])).toEqual([
      [0, true],
      [1, false],
      [0, false],
    ]);
    expect(r.candidates[0]!.description).toBe(BP);
  });

  it("uses ~/.codex/config.toml under the injected home by default", () => {
    const home = path.join(tmp, "home");
    installConfig(path.join(home, ".codex", "config.toml"));
    const r = codexGateDisable({ homeDir: home });
    expect(r.mode).toBe("list");
    expect(r.configPath).toBe(path.join(home, ".codex", "config.toml"));
  });
});

describe("codexGateDisable / codexGateEnable: round trip", () => {
  it("neutralises only the matching unit in place and restores the config byte-identically", () => {
    const original = installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    expect(d.mode).toBe("remove");
    if (d.mode !== "remove") return;
    expect(d.neutralised.map((u) => u.id)).toEqual([BP]);

    const disabled = fs.readFileSync(configPath, "utf8");
    // The unit keeps its comment line, header and matcher; only its hooks value is emptied.
    expect(disabled).toContain(`# harness hook: ${BP} (budget_ms=5000)`);
    expect(disabled).toContain('matcher = "apply_patch"\nhooks = []\n');
    expect(disabled).not.toContain("harness pack hook branch-protection");
    // The other two units, the fences and the source-prefix line stay.
    expect(disabled).toContain("# harness hook: hand-shell-guard");
    expect(disabled).toContain("# harness hook: hand-user-prompt-submit");
    expect(disabled).toContain(CODEX_MANAGED_BEGIN);
    expect(disabled).toContain(CODEX_MANAGED_END);
    expect(disabled).toContain("# Harness Codex hook wiring.");
    expect(disabled.split("\n")).toHaveLength(original.split("\n").length);
    // The backup is the pre-disable file, the snapshot records both shas.
    expect(fs.readFileSync(d.backupPath, "utf8")).toBe(original);
    const snap = readCodexSnapshot(d.snapshotPath);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.version).toBe(CODEX_SNAPSHOT_VERSION);
    expect(snap.snapshot.target).toBe(CODEX_SNAPSHOT_TARGET);
    expect(snap.snapshot.configBeforeSha256).toBe(sha(original));
    expect(snap.snapshot.configAfterSha256).toBe(sha(disabled));
    expect(snap.snapshot.neutralised[0]!.hooksText).toBe(
      'hooks = [{ type = "command", command = "harness pack hook branch-protection --runtime codex", timeout = 5 }]',
    );

    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("restored");
    if (e.mode !== "restored") return;
    expect(e.restoredCount).toBe(1);
    expect(e.stillDisabled).toEqual([]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readFileSync(e.backupPath, "utf8")).toBe(disabled);
  });

  it("keeps the position and content of every other hook entry, in every event, on disable and on enable", () => {
    // An operator PreToolUse table after the END marker follows the harness ones in the array.
    const operatorHook =
      '\n[[hooks.PreToolUse]]\nmatcher = "operator-tool"\nhooks = [{ type = "command", command = "operator-pre", timeout = 2 }]\n';
    const original = installConfig(configPath, { after: `${operatorHook}${OPERATOR_AFTER}` });
    const was = hookArrays(original);
    expect(was["PreToolUse"]!.map((e) => e["matcher"])).toEqual([
      "apply_patch",
      expect.stringContaining("Bash"),
      "operator-tool",
    ]);

    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const now = hookArrays(fs.readFileSync(configPath, "utf8"));
    expect(Object.keys(now).sort()).toEqual(Object.keys(was).sort());
    for (const event of Object.keys(was)) {
      expect(now[event]).toHaveLength(was[event]!.length);
      was[event]!.forEach((entry, i) => {
        if (event === "PreToolUse" && i === 0) {
          expect(now[event]![i]).toEqual({ ...entry, hooks: [] });
        } else {
          expect(now[event]![i]).toEqual(entry);
        }
      });
    }

    codexGateEnable({ configPath, now: T1 });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(hookArrays(fs.readFileSync(configPath, "utf8"))).toEqual(was);
  });

  it("round-trips a CRLF config byte-identically, without --force", () => {
    const original = installConfig(configPath).replace(/\n/g, "\r\n");
    fs.writeFileSync(configPath, original);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const disabled = fs.readFileSync(configPath, "utf8");
    expect(disabled).toContain("hooks = []\r\n");
    expect(disabled.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("round-trips a config with extra blank lines and a missing final newline byte-identically", () => {
    const base = installConfig(configPath, { after: "" });
    const original = base
      .replace("\n\n# harness hook: hand-shell-guard", "\n\n\n\n# harness hook: hand-shell-guard")
      .replace(/\n$/, "");
    fs.writeFileSync(configPath, `${original}\n\n[tui]\nnotifications = true`);
    const full = fs.readFileSync(configPath, "utf8");
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(full);
    expect(codexGateEnable({ configPath, now: T1 }).mode).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(full);
  });

  it("restores a config with several neutralised units byte-identically", () => {
    const original = installConfig(configPath);
    // "a" substring-matches both PreToolUse matchers ("apply_patch", and the Bash alias set).
    const d = codexGateDisable({ configPath, matcher: "a", now: T0 });
    expect(d.mode === "remove" && d.neutralised.map((u) => u.id)).toEqual([BP, "hand-shell-guard"]);
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("restored");
    expect(e.mode === "restored" && e.restoredCount).toBe(2);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("neutralises the other matching unit and leaves the first one alone", () => {
    const original = installConfig(configPath);
    const block = readCodexManagedHookUnits(original, configPath)!;
    const bashMatcher = block.units[1]!.matcher!;
    const d = codexGateDisable({ configPath, matcher: bashMatcher.slice(0, 4), now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.neutralised.map((u) => u.id)).toEqual(["hand-shell-guard"]);
    expect(fs.readFileSync(configPath, "utf8")).toContain("harness pack hook branch-protection");
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

  it("is idempotent: enable on an already restored config writes nothing", () => {
    const original = installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    codexGateEnable({ configPath, now: T1 });
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    // The first enable retired the snapshot it applied, so nothing is left to walk.
    const again = codexGateEnable({ configPath, now: new Date("2026-10-02T12:00:00.000Z") });
    expect(again.mode).toBe("no-snapshots");
    expect(again.stillDisabled).toEqual([]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
  });

  it("reports no snapshots when none exist", () => {
    installConfig(configPath);
    const r = codexGateEnable({ configPath });
    expect(r.mode).toBe("no-snapshots");
    expect(r.stillDisabled).toEqual([]);
  });
});

describe("codexGateDisable: a unit that is already disabled", () => {
  it("is neither neutralised again nor lost: the second disable refuses and the first snapshot still restores", () => {
    const original = installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const disabled = fs.readFileSync(configPath, "utf8");
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    expect(() => codexGateDisable({ configPath, matcher: "apply_patch", now: T1 })).toThrow(
      /already disabled \(policy-pack:branch-protection:pre-tool-use\)/,
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
    codexGateEnable({ configPath, now: T1 });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("neutralises only the units that are still enabled when a wider matcher follows, and joins the live snapshot", () => {
    const original = installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", T0);
    const d = codexGateDisable({ configPath, matcher: "a", now: T1 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.neutralised.map((u) => u.id)).toEqual(["hand-shell-guard"]);
    // One live snapshot: the new unit joined it, the call reports only what it neutralised itself.
    expect(d.snapshotPath).toBe(first);
    const snap = readCodexSnapshot(d.snapshotPath);
    expect(snap.ok && snap.snapshot.neutralised.map((u) => u.id)).toEqual([BP, "hand-shell-guard"]);
    expect(codexGateEnable({ configPath, now: at(12) }).mode).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });
});

describe("codexGateDisable: one live snapshot per config", () => {
  function twoDisables(): { original: string; afterFirst: string; snapshotPath: string; second: ReturnType<typeof codexGateDisable> } {
    const original = installConfig(configPath);
    const a = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (a.mode !== "remove") throw new Error("expected remove");
    const afterFirst = fs.readFileSync(configPath, "utf8");
    const second = codexGateDisable({ configPath, matcher: "Bash", now: T1 });
    return { original, afterFirst, snapshotPath: a.snapshotPath, second };
  }

  it("a second disable merges its units into the live snapshot: one file, both units, the original pre-disable sha, the new post-disable sha", () => {
    const { original, afterFirst, snapshotPath, second } = twoDisables();
    if (second.mode !== "remove") throw new Error("expected remove");
    expect(second.snapshotPath).toBe(snapshotPath);
    expect(second.neutralised.map((u) => u.id)).toEqual(["hand-shell-guard"]);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([snapshotPath]);
    const snap = readCodexSnapshot(snapshotPath);
    if (!snap.ok) throw new Error("snapshot unreadable");
    expect(snap.snapshot.neutralised.map((u) => u.id)).toEqual([BP, "hand-shell-guard"]);
    expect(snap.snapshot.configBeforeSha256).toBe(sha(original));
    expect(snap.snapshot.configAfterSha256).toBe(sha(fs.readFileSync(configPath, "utf8")));
    expect(snap.snapshot.configAfterSha256).not.toBe(sha(afterFirst));
    // The merge is recorded for audit: when, with which matcher, and the backup it wrote.
    expect(snap.snapshot.merges).toEqual([
      { createdAt: T1.toISOString(), matcher: "Bash", configBackupPath: second.backupPath },
    ]);
    expect(snap.snapshot.createdAt).toBe(T0.toISOString());
    expect(snap.snapshot.filter).toEqual({ matcher: "apply_patch" });
    // The second disable still backs up the file as it stood.
    expect(fs.readFileSync(second.backupPath, "utf8")).toBe(afterFirst);
  });

  it("lists every merge in order, three disables into one snapshot, and one enable restores all three byte-identically", () => {
    const original = installConfig(configPath, { withEditGuard: true });
    const first = disableAt(configPath, "apply_patch", at(1));
    expect(disableAt(configPath, "Bash", at(2))).toBe(first);
    expect(disableAt(configPath, "Edit", at(3))).toBe(first);
    const snap = readCodexSnapshot(first);
    if (!snap.ok) throw new Error("snapshot unreadable");
    expect(snap.snapshot.merges?.map((m) => [m.createdAt, m.matcher])).toEqual([
      [at(2).toISOString(), "Bash"],
      [at(3).toISOString(), "Edit"],
    ]);
    expect(snap.snapshot.neutralised).toHaveLength(3);
    const e = codexGateEnable({ configPath, now: at(4) });
    expect(e.mode === "restored" && e.restoredCount).toBe(3);
    expect(read()).toBe(original);
  });

  it("keeps the merged units in block order whichever disable came first", () => {
    const original = installConfig(configPath);
    const first = disableAt(configPath, "Bash", T0);
    expect(disableAt(configPath, "apply_patch", T1)).toBe(first);
    const snap = readCodexSnapshot(first);
    expect(snap.ok && snap.snapshot.neutralised.map((u) => [u.id, u.ordinal])).toEqual([
      [BP, 0],
      ["hand-shell-guard", 1],
    ]);
    codexGateEnable({ configPath, now: at(12) });
    expect(read()).toBe(original);
  });

  it("one enable restores both disables byte-identically and retires the snapshot; a second enable is a clean no-op", () => {
    const { original, snapshotPath } = twoDisables();
    const e = codexGateEnable({ configPath, now: at(12) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.snapshotPath).toBe(retired(snapshotPath));
    expect(e.restoredCount).toBe(2);
    expect(e.stillDisabled).toEqual([]);
    expect(e.remaining).toEqual([]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
    const again = codexGateEnable({ configPath, now: at(13) });
    expect(again.mode).toBe("no-snapshots");
    expect(again.stillDisabled).toEqual([]);
  });

  it("refuses a second disable once the config was edited since the live snapshot, and writes nothing", () => {
    installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", T0);
    fs.appendFileSync(configPath, "\n[tui]\nnotifications = true\n");
    const edited = read();
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    const body = fs.readFileSync(first, "utf8");
    expect(() => codexGateDisable({ configPath, matcher: "Bash", now: T1 })).toThrow(
      /no longer matches .*cannot join it\. Run `harness gate enable --runtime codex --config \S+ --force`/,
    );
    expect(read()).toBe(edited);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
    expect(fs.readFileSync(first, "utf8")).toBe(body);
  });

  it("a second disable after an install re-rendered the block retires the superseded snapshot and starts a fresh one, with no enable in between", () => {
    installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", at(1));
    const v2 = reinstall(configPath, at(2), V2);
    const d = codexGateDisable({ configPath, matcher: "Bash", now: at(3) });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.retired).toEqual({
      from: first,
      to: retired(first, "superseded"),
      why: "superseded",
      installBackup: `${configPath}.harness-backup-2026-10-02T02-00-00-000Z`,
    });
    expect(fs.existsSync(retired(first, "superseded"))).toBe(true);
    // The fresh snapshot covers only what this disable neutralised, rebuilt from the re-rendered config.
    expect(d.snapshotPath).not.toBe(first);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([d.snapshotPath]);
    const snap = readCodexSnapshot(d.snapshotPath);
    if (!snap.ok) throw new Error("snapshot unreadable");
    expect(snap.snapshot.neutralised.map((u) => u.id)).toEqual([SG]);
    expect(snap.snapshot.configBeforeSha256).toBe(sha(v2));
    expect(snap.snapshot.merges).toBeUndefined();
    // One enable brings back exactly the re-rendered block.
    expect(codexGateEnable({ configPath, now: at(4) }).mode).toBe("restored");
    expect(read()).toBe(v2);
  });

  it("a second disable retires a snapshot whose config was put back at the pre-disable state (restored from the backup), and starts a fresh one", () => {
    const original = installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", at(1));
    fs.writeFileSync(configPath, original);
    const d = codexGateDisable({ configPath, matcher: "Bash", now: at(2) });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.retired).toEqual({ from: first, to: retired(first, "restored"), why: "restored" });
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([d.snapshotPath]);
    expect(codexGateEnable({ configPath, now: at(3) }).mode).toBe("restored");
    expect(read()).toBe(original);
  });

  it("a second disable retires a snapshot whose units were all put back by hand, even with another edit in the file", () => {
    const original = installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", at(1));
    const edited = `${original}\n[tui]\nnotifications = true\n`;
    fs.writeFileSync(configPath, edited);
    const d = codexGateDisable({ configPath, matcher: "Bash", now: at(2) });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.retired).toEqual({ from: first, to: retired(first, "superseded"), why: "superseded" });
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([d.snapshotPath]);
    expect(codexGateEnable({ configPath, now: at(3) }).mode).toBe("restored");
    expect(read()).toBe(edited);
  });

  it("a second disable keeps a live snapshot that names a unit deleted from the block: nothing is retired, it refuses and names the ways out, not --force", () => {
    installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", at(1));
    const units = readCodexManagedHookUnits(read(), configPath)!.units;
    const gone = `${read().slice(0, units[0]!.start)}${read().slice(units[1]!.start)}`;
    fs.writeFileSync(configPath, gone);
    const message = thrownMessage(() => codexGateDisable({ configPath, matcher: "Bash", now: at(2) }));
    expect(message).toMatch(/cannot join it\. the hook unit .* is not in the block/);
    expect(message).toContain("harness apply --runtime codex --install");
    expect(message).not.toContain("--force");
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([first]);
    expect(read()).toBe(gone);
  });

  it("a disable that finds the live snapshot spent but cannot retire it (the retired name is taken) writes nothing and names the file and the move-aside step", () => {
    const original = installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", at(1));
    fs.writeFileSync(configPath, original);
    fs.mkdirSync(retired(first));
    fs.writeFileSync(path.join(retired(first), "keep"), "");
    const dir = path.dirname(configPath);
    const entries = fs.readdirSync(dir).sort();
    // The gate's own error type, so the CLI exits with its refusal code and message rather than a crash.
    expect(() => codexGateDisable({ configPath, matcher: "Bash", now: at(2) })).toThrow(GateDisableError);
    const message = thrownMessage(() => codexGateDisable({ configPath, matcher: "Bash", now: at(2) }));
    expect(message).toContain(
      `nothing was written: the live gate snapshot is spent (enable would only retire it), but cannot retire the snapshot ${first}`,
    );
    expect(message).toContain("move it out of this directory by hand so it is never applied again, then run the command again");
    expect(read()).toBe(original);
    expect(fs.readdirSync(dir).sort()).toEqual(entries);
    // The way out it names: move the snapshot aside, run the disable again.
    fs.renameSync(first, path.join(tmp, "aside.json"));
    expect(disableAt(configPath, "Bash", at(3))).not.toBe(first);
  });

  it("refuses a disable while a live snapshot of this config is unreadable, and writes nothing", () => {
    installConfig(configPath);
    const first = disableAt(configPath, "apply_patch", T0);
    fs.writeFileSync(first, "{ not json");
    const before = read();
    const message = thrownMessage(() => codexGateDisable({ configPath, matcher: "Bash", now: T1 }));
    expect(message).toContain(`cannot read snapshot ${first}`);
    expect(message).toContain(`move ${first} aside`);
    expect(read()).toBe(before);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([first]);
  });

  it("a snapshot taken for another config is neither joined nor disturbed", () => {
    const dir = path.dirname(configPath);
    const other = path.join(dir, "b.toml");
    installConfig(configPath);
    installConfig(other);
    const b1 = disableAt(other, "apply_patch", at(1));
    const bBody = fs.readFileSync(b1, "utf8");
    const a1 = disableAt(configPath, "apply_patch", at(2));
    expect(a1).not.toBe(b1);
    expect(fs.readFileSync(b1, "utf8")).toBe(bBody);
    expect(listCodexSnapshots(dir).sort()).toEqual([a1, b1].sort());
  });

  it("names the unit that stays disabled when a hand edit neutralised it beyond the snapshot, and never reports an all-clear", () => {
    const text = installConfig(configPath);
    fs.writeFileSync(configPath, neutraliseByHand(text, "hand-shell-guard"));
    const snapshotPath = disableAt(configPath, "apply_patch", T0);
    const e = codexGateEnable({ configPath, now: at(12) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.snapshotPath).toBe(retired(snapshotPath));
    expect(e.stillDisabled).toEqual(["hand-shell-guard"]);
    // The call after it finds no live snapshot (the applied one is retired), yet the unit is still off.
    const again = codexGateEnable({ configPath, now: at(13) });
    expect(again.mode).toBe("no-snapshots");
    expect(again.stillDisabled).toEqual(["hand-shell-guard"]);
  });

  it("reports a hand-neutralised unit that no snapshot covers instead of 'no snapshots'", () => {
    const text = installConfig(configPath);
    fs.writeFileSync(configPath, neutraliseByHand(text, "hand-shell-guard"));
    const r = codexGateEnable({ configPath });
    expect(r.mode).toBe("no-snapshots");
    expect(r.stillDisabled).toEqual(["hand-shell-guard"]);
  });
});

const SG = "hand-shell-guard";
const OLD_SG_LINE = 'command = "harness pack hook shell-guard --runtime codex"';
const V2 = "harness pack hook shell-guard --runtime codex --v2";
const at = (hour: number): Date => new Date(`2026-10-02T${String(hour).padStart(2, "0")}:00:00.000Z`);
const read = (): string => fs.readFileSync(configPath, "utf8");

function disableAt(target: string, matcher: string, now: Date): string {
  const d = codexGateDisable({ configPath: target, matcher, now });
  if (d.mode !== "remove") throw new Error("expected remove");
  return d.snapshotPath;
}

describe("the commands a refusal prints repeat the call's --config only when it had one", () => {
  const home = (): string => path.join(tmp, "home");
  const homeConfig = (): string => path.join(home(), ".codex", "config.toml");

  it("names the install and the list command for a config without a block or a matcher that matches", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, OPERATOR_BEFORE);
    expect(thrownMessage(() => codexGateDisable({ configPath, matcher: "x", now: T0 }))).toContain(
      `\`harness apply --runtime codex --install --codex-config ${configPath}\` writes that block.`,
    );
    installConfig(configPath);
    expect(thrownMessage(() => codexGateDisable({ configPath, matcher: "no-such", now: T0 }))).toContain(
      `Run \`harness gate disable --runtime codex --config ${configPath}\` (no --matcher)`,
    );
    // Without --config the commands are the bare ones.
    installConfig(homeConfig());
    const bare = thrownMessage(() => codexGateDisable({ homeDir: home(), matcher: "no-such", now: T0 }));
    expect(bare).toContain("Run `harness gate disable --runtime codex` (no --matcher)");
    expect(bare).not.toContain("--config");
  });

  it("names the enable command for a unit that is off already, and the install for two units with one id", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    expect(thrownMessage(() => codexGateDisable({ configPath, matcher: "apply_patch", now: T1 }))).toContain(
      `\`harness gate enable --runtime codex --config ${configPath}\` restores them.`,
    );
    installConfig(homeConfig());
    codexGateDisable({ homeDir: home(), matcher: "apply_patch", now: T0 });
    const bare = thrownMessage(() => codexGateDisable({ homeDir: home(), matcher: "apply_patch", now: T1 }));
    expect(bare).toContain("`harness gate enable --runtime codex` restores them.");
    expect(bare).not.toContain("--config");

    const other = path.join(tmp, "twins", "config.toml");
    const text = installConfig(other);
    fs.writeFileSync(other, text.replace("# harness hook: hand-shell-guard", `# harness hook: ${BP}`));
    expect(thrownMessage(() => codexGateDisable({ configPath: other, matcher: "apply_patch", now: T0 }))).toContain(
      `Re-run \`harness apply --runtime codex --install --codex-config ${other}\` to rewrite the block.`,
    );
  });

  it("names the ways out with the call's --config when a snapshot cannot be restored, and bare ones without", () => {
    installConfig(homeConfig());
    codexGateDisable({ homeDir: home(), matcher: "Bash", now: T0 });
    fs.rmSync(homeConfig());
    const bare = thrownMessage(() => codexGateEnable({ homeDir: home() }));
    expect(bare).toContain("Ways out: run `harness apply --runtime codex --install`,");
    expect(bare).toContain("the next `harness gate enable --runtime codex` (or disable) retires the snapshot");
    expect(bare).not.toContain("--config");
    expect(bare).not.toContain("--codex-config");
  });
});

describe("codexGateEnable: retired snapshots are never applied again", () => {
  it("renames each snapshot it applies to *.restored.json, keeps it on disk and never lists it again", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", T0);
    const body = fs.readFileSync(s0, "utf8");
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("restored");
    expect(e.mode === "restored" && e.snapshotPath).toBe(retired(s0));
    expect(fs.existsSync(s0)).toBe(false);
    expect(fs.readFileSync(retired(s0), "utf8")).toBe(body);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
    // The same unit neutralised again by hand: no snapshot offers its line back.
    fs.writeFileSync(configPath, neutraliseByHand(read(), SG));
    const again = codexGateEnable({ configPath, now: at(12) });
    expect(again.mode).toBe("no-snapshots");
    expect(again.stillDisabled).toEqual([SG]);
  });

  it("retires a snapshot the config already matches (restored by hand, or a crash after the write) as restored", () => {
    const original = installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", T0);
    fs.writeFileSync(configPath, original);
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("already-restored");
    expect(e.mode === "already-restored" && e.snapshotPath).toBe(retired(s0));
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
    expect(read()).toBe(original);
    fs.writeFileSync(configPath, neutraliseByHand(original, SG));
    expect(codexGateEnable({ configPath, now: at(12) }).mode).toBe("no-snapshots");
  });

  it("disable, enable, re-install with a changed command, neutralise by hand, disable another unit, enable: the old line never comes back", () => {
    installConfig(configPath);
    disableAt(configPath, "Bash", at(1));
    codexGateEnable({ configPath, now: at(2) });
    const v2 = reinstall(configPath, at(3), V2);
    expect(v2).toContain(V2);
    fs.writeFileSync(configPath, neutraliseByHand(v2, SG));
    disableAt(configPath, "apply_patch", at(4));
    const e = codexGateEnable({ configPath, now: at(5) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.restoredCount).toBe(1);
    expect(e.stillDisabled).toEqual([SG]);
    expect(read()).not.toContain(OLD_SG_LINE);
    expect(read()).toBe(neutraliseByHand(v2, SG));
  });

  it("the same unit disabled again through the gate after a re-install, with the old snapshot copied back live: the current line comes back, the old snapshot is superseded next", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    codexGateEnable({ configPath, now: at(2) });
    const v2 = reinstall(configPath, at(3), V2);
    const s1 = disableAt(configPath, "Bash", at(4));
    // A copy of the directory taken before the enable brings S0 back live, with the newest mtime.
    fs.copyFileSync(retired(s0), s0);
    touch(s1, at(10));
    touch(s0, at(20));
    const e = codexGateEnable({ configPath, now: at(5) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.snapshotPath).toBe(retired(s1));
    expect(e.stillDisabled).toEqual([]);
    expect(e.remaining).toEqual([s0]);
    expect(read()).toBe(v2);
    expect(read()).not.toContain(OLD_SG_LINE);
    // The old snapshot predates the install: the next enable retires it and writes nothing.
    const next = codexGateEnable({ configPath, now: at(6) });
    expect(next.mode).toBe("already-restored");
    expect(next.mode !== "no-snapshots" && next.retired?.why).toBe("superseded");
    expect(next.mode !== "no-snapshots" && next.remaining).toEqual([]);
    expect(read()).toBe(v2);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("a snapshot taken before a re-install is superseded: neutralising the re-rendered unit by hand never brings the old line back", () => {
    installConfig(configPath);
    // Installs from before the block generation marker: the backup files alone date the re-install,
    // even for a config that is exactly what the snapshot left behind.
    preMarker(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    reinstall(configPath, at(2), V2);
    const v2 = preMarker(configPath);
    const hand = neutraliseByHand(v2, SG);
    fs.writeFileSync(configPath, hand);
    const snap = readCodexSnapshot(s0);
    expect(snap.ok && snap.snapshot.configAfterSha256).toBe(sha(hand));
    const e = codexGateEnable({ configPath, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.stillDisabled).toEqual([SG]);
    expect(e.mode !== "no-snapshots" && e.retired).toEqual({
      from: s0,
      to: retired(s0, "superseded"),
      why: "superseded",
      installBackup: `${configPath}.harness-backup-2026-10-02T02-00-00-000Z`,
    });
    expect(read()).toBe(hand);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("--force on a snapshot superseded by a re-install retires it and never brings the old line back either", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    const v2 = reinstall(configPath, at(2), V2);
    const hand = neutraliseByHand(v2, SG);
    fs.writeFileSync(configPath, hand);
    const e = codexGateEnable({ configPath, force: true, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.stillDisabled).toEqual([SG]);
    expect(e.mode !== "no-snapshots" && e.retired?.why).toBe("superseded");
    expect(read()).toBe(hand);
    expect(read()).not.toContain(OLD_SG_LINE);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("retires a snapshot whose units were all enabled again by other means, instead of refusing over the edit", () => {
    const original = installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", T0);
    // The operator put the line back by hand, and the file was edited elsewhere too.
    const edited = `${original}\n[tui]\nnotifications = true\n`;
    fs.writeFileSync(configPath, edited);
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("already-restored");
    expect(e.stillDisabled).toEqual([]);
    expect(e.mode !== "no-snapshots" && e.retired).toEqual({ from: s0, to: retired(s0, "superseded"), why: "superseded" });
    expect(read()).toBe(edited);
  });

  it("retires a single snapshot whose units are all enabled again even while an unrelated unit is neutralised by hand, and names that unit", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "apply_patch", T0);
    // The snapshot's unit goes back by hand, and a unit the snapshot does not name is neutralised by hand.
    fs.writeFileSync(configPath, neutraliseByHand(putBack(BP), SG));
    const hand = read();
    const e = codexGateEnable({ configPath, now: T1 });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired).toEqual({ from: s0, to: retired(s0, "superseded"), why: "superseded" });
    expect(e.stillDisabled).toEqual([SG]);
    expect(read()).toBe(hand);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("a re-install through the symlink's target path still supersedes a snapshot taken through the link", () => {
    const real = path.join(tmp, "dotfiles", "config.toml");
    installConfig(real);
    const linkDir = path.join(tmp, "codex-home");
    fs.mkdirSync(linkDir);
    const link = path.join(linkDir, "config.toml");
    fs.symlinkSync(real, link);
    const s0 = disableAt(link, "Bash", at(1));
    // The installer ran on the target's own path: its backup sits beside the target, not the link.
    const v2 = reinstall(real, at(2), V2);
    expect(fs.readdirSync(linkDir).filter((n) => n.includes("harness-backup"))).toEqual([]);
    const hand = neutraliseByHand(v2, SG);
    fs.writeFileSync(real, hand);
    const e = codexGateEnable({ configPath: link, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.stillDisabled).toEqual([SG]);
    expect(e.mode !== "no-snapshots" && [e.retired?.from, e.retired?.why]).toEqual([s0, "superseded"]);
    expect(fs.readFileSync(real, "utf8")).toBe(hand);
    expect(fs.readFileSync(real, "utf8")).not.toContain(OLD_SG_LINE);
  });

  it("fails to retire an applied snapshot after the write: says the units are restored, and the config is", () => {
    const original = installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    fs.mkdirSync(retired(s0));
    fs.writeFileSync(path.join(retired(s0), "keep"), "");
    expect(() => codexGateEnable({ configPath, now: at(2) })).toThrow(
      /restored 1 hook unit\(s\) into .*config\.toml, but cannot retire the snapshot/,
    );
    expect(read()).toBe(original);
    expect(fs.existsSync(s0)).toBe(true);
  });

  it("keeps a snapshot live and names the unit when a unit it names was deleted from the block by hand", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    const units = readCodexManagedHookUnits(read(), configPath)!.units;
    const sgIndex = units.findIndex((u) => u.id === SG);
    const gone = `${read().slice(0, units[sgIndex]!.start)}${read().slice(units[sgIndex + 1]!.start)}`;
    fs.writeFileSync(configPath, gone);
    const e = codexGateEnable({ configPath, now: at(2) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.missing).toEqual([SG]);
    expect(e.mode !== "no-snapshots" && e.retired).toBeNull();
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([s0]);
    expect(read()).toBe(gone);
  });

  it("retires a snapshot as superseded only when every unit it names is in the block: one enabled, one deleted keeps it live", () => {
    installConfig(configPath);
    // Two units of one snapshot: neutralise both through one disable (both match "e").
    const d = codexGateDisable({ configPath, matcher: "a", now: at(1) });
    if (d.mode !== "remove") throw new Error("expected remove");
    const snap = readCodexSnapshot(d.snapshotPath);
    if (!snap.ok) throw new Error("snapshot unreadable");
    expect(snap.snapshot.neutralised.map((u) => u.id).sort()).toEqual([BP, SG].sort());
    // BP's line goes back by hand, SG's unit is deleted: nothing is disabled, one unit is gone.
    let text = read();
    const bp = readCodexManagedHookUnits(text, configPath)!.units.find((u) => u.id === BP)!;
    text = `${text.slice(0, bp.hooksStart)}${snap.snapshot.neutralised.find((u) => u.id === BP)!.hooksText}${text.slice(bp.hooksEnd)}`;
    const units = readCodexManagedHookUnits(text, configPath)!.units;
    const sgIndex = units.findIndex((u) => u.id === SG);
    text = `${text.slice(0, units[sgIndex]!.start)}${text.slice(units[sgIndex + 1]!.start)}`;
    fs.writeFileSync(configPath, text);
    const e = codexGateEnable({ configPath, now: at(2) });
    expect(e.mode !== "no-snapshots" && e.missing).toEqual([SG]);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([d.snapshotPath]);
    expect(read()).toBe(text);
  });
});

/** The state an earlier build left: one live snapshot per disable. The first covers apply_patch (T0), the second Bash (T1). */
function legacyPair(): { original: string; first: string; second: string; afterFirst: string } {
  const original = installConfig(configPath);
  const first = disableAt(configPath, "apply_patch", T0);
  const afterFirst = read();
  const firstBody = fs.readFileSync(first, "utf8");
  disableAt(configPath, "Bash", T1);
  const merged = JSON.parse(fs.readFileSync(first, "utf8"));
  const second = codexSnapshotPath(configPath, T1);
  fs.writeFileSync(first, firstBody);
  fs.writeFileSync(
    second,
    JSON.stringify({
      ...merged,
      createdAt: T1.toISOString(),
      configBeforeSha256: sha(afterFirst),
      neutralised: merged.neutralised.filter((u: { id: string }) => u.id === SG),
    }),
  );
  return { original, first, second, afterFirst };
}

describe("codexGateEnable: several live snapshots left by an earlier build", () => {
  it("handles the newest by its recorded time per run, never by file mtime, and names the rest until none is left", () => {
    const { original, first, second, afterFirst } = legacyPair();
    touch(first, at(23));
    touch(second, at(1));
    const e = codexGateEnable({ configPath, now: at(12) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.snapshotPath).toBe(retired(second));
    expect(e.restoredCount).toBe(1);
    expect(e.remaining).toEqual([first]);
    expect(e.stillDisabled).toEqual([BP]);
    expect(read()).toBe(afterFirst);
    const f = codexGateEnable({ configPath, now: at(13) });
    if (f.mode !== "restored") throw new Error("expected restored");
    expect(f.snapshotPath).toBe(retired(first));
    expect(f.remaining).toEqual([]);
    expect(f.stillDisabled).toEqual([]);
    expect(read()).toBe(original);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("orders snapshots with the same recorded time by file name, newest name first", () => {
    const { first, second } = legacyPair();
    for (const file of [first, second]) {
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      body.createdAt = T0.toISOString();
      fs.writeFileSync(file, JSON.stringify(body));
    }
    expect(first < second).toBe(true);
    const e = codexGateEnable({ configPath, now: at(12) });
    expect(e.mode === "restored" && e.snapshotPath).toBe(retired(second));
    expect(e.mode === "restored" && e.remaining).toEqual([first]);
  });

  it("a disable among several legacy live snapshots joins the newest, leaves the older byte for byte, and two enables restore the original", () => {
    const original = installConfig(configPath, { withEditGuard: true });
    const first = disableAt(configPath, "apply_patch", at(1));
    const afterFirst = read();
    const firstBody = fs.readFileSync(first, "utf8");
    // Rebuild what an earlier build left: the Bash disable as a second live snapshot of its own.
    disableAt(configPath, "Bash", at(2));
    const merged = JSON.parse(fs.readFileSync(first, "utf8"));
    const second = codexSnapshotPath(configPath, at(2));
    fs.writeFileSync(first, firstBody);
    fs.writeFileSync(
      second,
      JSON.stringify({
        ...merged,
        createdAt: at(2).toISOString(),
        configBeforeSha256: sha(afterFirst),
        neutralised: merged.neutralised.filter((u: { id: string }) => u.id === SG),
        merges: undefined,
      }),
    );
    // Make the older snapshot the first one the file system lists and the newest by mtime, so only createdAt tells them apart.
    touch(first, at(23));
    touch(second, at(1));
    const joined = disableAt(configPath, "Edit", at(3));
    expect(joined).toBe(second);
    expect(fs.readFileSync(first, "utf8")).toBe(firstBody);
    const snap = readCodexSnapshot(second);
    if (!snap.ok) throw new Error("snapshot unreadable");
    expect(snap.snapshot.neutralised.map((u) => u.id).sort()).toEqual([SG, "hand-edit-guard"].sort());
    const ordinals = snap.snapshot.neutralised.map((u) => u.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((x, y) => x - y));
    expect(snap.snapshot.configBeforeSha256).toBe(sha(afterFirst));
    expect(snap.snapshot.configAfterSha256).toBe(sha(read()));
    expect(snap.snapshot.merges?.map((m) => m.matcher)).toEqual(["Edit"]);
    expect(listCodexSnapshots(path.dirname(configPath)).sort()).toEqual([first, second].sort());

    const one = codexGateEnable({ configPath, now: at(4) });
    if (one.mode !== "restored") throw new Error("expected restored");
    expect(one.snapshotPath).toBe(retired(second));
    expect(one.restoredCount).toBe(2);
    expect(one.remaining).toEqual([first]);
    expect(read()).toBe(afterFirst);
    const two = codexGateEnable({ configPath, now: at(5) });
    if (two.mode !== "restored") throw new Error("expected restored");
    expect(two.snapshotPath).toBe(retired(first));
    expect(two.remaining).toEqual([]);
    expect(read()).toBe(original);
  });

  it("does not chain: an edit since makes the newest refuse, and --force applies only that one and keeps the edit", () => {
    const { original, first, second } = legacyPair();
    const edit = "\n[tui]\nnotifications = true\n";
    fs.appendFileSync(configPath, edit);
    expect(() => codexGateEnable({ configPath, now: at(12) })).toThrow(/edited since the snapshot was taken/);
    const f = codexGateEnable({ configPath, force: true, now: at(13) });
    if (f.mode !== "restored") throw new Error("expected restored");
    expect(f.snapshotPath).toBe(retired(second));
    expect(f.remaining).toEqual([first]);
    expect(f.stillDisabled).toEqual([BP]);
    const g = codexGateEnable({ configPath, force: true, now: at(14) });
    expect(g.mode === "restored" && g.snapshotPath).toBe(retired(first));
    expect(read()).toBe(`${original}${edit}`);
  });

  it("each config's enable restores its own units when two configs share the directory and their disables interleave", () => {
    const dir = path.dirname(configPath);
    const other = path.join(dir, "b.toml");
    const originalA = installConfig(configPath);
    const originalB = installConfig(other);
    disableAt(configPath, "apply_patch", at(1));
    const b1 = disableAt(other, "apply_patch", at(2));
    disableAt(configPath, "Bash", at(3));

    const ea = codexGateEnable({ configPath, now: at(4) });
    if (ea.mode !== "restored") throw new Error("expected restored");
    expect(ea.restoredCount).toBe(2);
    expect(ea.skippedForeign.map((f) => f.path)).toEqual([b1]);
    expect(read()).toBe(originalA);
    expect(listCodexSnapshots(dir)).toEqual([b1]);

    const eb = codexGateEnable({ configPath: other, now: at(5) });
    if (eb.mode !== "restored") throw new Error("expected restored");
    expect(eb.skippedForeign).toEqual([]);
    expect(fs.readFileSync(other, "utf8")).toBe(originalB);
  });
});

describe("latestCodexInstallBackupMs", () => {
  it("reads the newest install write from the installer's backup names, and null when there is none", () => {
    expect(latestCodexInstallBackupMs(configPath)).toBeNull();
    installConfig(configPath);
    reinstall(configPath, at(7), V2);
    const dir = path.dirname(configPath);
    fs.writeFileSync(`${configPath}.harness-backup-not-a-time`, "");
    fs.writeFileSync(path.join(dir, "other.toml.harness-backup-2026-12-01T00-00-00-000Z"), "");
    expect(latestCodexInstallBackupMs(configPath)).toBe(at(7).getTime());
  });
});

describe("codex gate: symlinked config", () => {
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
    expect(fs.readFileSync(real, "utf8")).not.toContain("harness pack hook branch-protection");
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

  it("refuses a dangling symlink in the gate's own wording", () => {
    const link = path.join(tmp, "config.toml");
    fs.symlinkSync(path.join(tmp, "missing.toml"), link);
    expect(() => codexGateDisable({ configPath: link, matcher: "x" })).toThrow(GateDisableError);
    expect(() => codexGateDisable({ configPath: link, matcher: "x" })).toThrow(
      /dangling symlink.*refusing to edit, nothing was written/,
    );
    expect(() => codexGateEnable({ configPath: link })).toThrow(/dangling symlink/);
    expect(() => codexGateEnable({ configPath: link })).not.toThrow(/refusing to install/);
  });
});

describe("codex gate: file mode", () => {
  it("keeps mode 0600 on the rewritten config, the backup and the snapshot, on disable and on enable", () => {
    installConfig(configPath, { mode: 0o600 });
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    for (const file of [configPath, d.backupPath, d.snapshotPath]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // A second disable joins the snapshot and keeps the mode of the rewritten snapshot and the new backup.
    const d2 = codexGateDisable({ configPath, matcher: "Bash", now: at(11) });
    if (d2.mode !== "remove") throw new Error("expected remove");
    expect(d2.snapshotPath).toBe(d.snapshotPath);
    for (const file of [configPath, d2.backupPath, d2.snapshotPath]) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const e = codexGateEnable({ configPath, now: T1 });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(e.backupPath).mode & 0o777).toBe(0o600);
  });

  it("a failed config write on the merge path rolls the snapshot back to its pre-merge body, keeps the backup, and a retry then works", () => {
    const real = path.join(tmp, "dotfiles", "config.toml");
    const original = installConfig(real);
    const linkDir = path.join(tmp, "codex-home");
    fs.mkdirSync(linkDir);
    const link = path.join(linkDir, "config.toml");
    fs.symlinkSync(real, link);
    const first = disableAt(link, "apply_patch", at(1));
    const afterFirst = fs.readFileSync(real, "utf8");
    const bodyBefore = fs.readFileSync(first, "utf8");
    // The config lives in a directory the write cannot create its temp file in; backup and snapshot sit beside the link.
    fs.chmodSync(path.dirname(real), 0o500);
    try {
      expect(() => codexGateDisable({ configPath: link, matcher: "Bash", now: at(2) })).toThrow();
    } finally {
      fs.chmodSync(path.dirname(real), 0o700);
    }
    expect(fs.readFileSync(real, "utf8")).toBe(afterFirst);
    // The snapshot names only the unit that is really off, byte for byte as before the merge.
    expect(fs.readFileSync(first, "utf8")).toBe(bodyBefore);
    expect(fs.readdirSync(linkDir).filter((n) => n.startsWith("config.toml.bak."))).toHaveLength(2);
    expect(listCodexSnapshots(linkDir)).toEqual([first]);
    // Not stuck: the retry joins the snapshot, and one enable restores everything.
    expect(disableAt(link, "Bash", at(3))).toBe(first);
    expect(codexGateEnable({ configPath: link, now: at(4) }).mode).toBe("restored");
    expect(fs.readFileSync(real, "utf8")).toBe(original);
  });
});

describe("codexGateEnable: a merged snapshot the config no longer matches", () => {
  /** Two disables merged into one snapshot; returns the pre-disable text, the state after the first and the merged snapshot. */
  function merged(): { original: string; afterFirst: string; afterBoth: string; snapshotPath: string } {
    const original = installConfig(configPath);
    const snapshotPath = disableAt(configPath, "apply_patch", at(1));
    const afterFirst = read();
    expect(disableAt(configPath, "Bash", at(2))).toBe(snapshotPath);
    return { original, afterFirst, afterBoth: read(), snapshotPath };
  }

  it("a crash after the merged snapshot was written but before the config was (residue): enable restores what is still off without --force", () => {
    const { original, afterFirst, snapshotPath } = merged();
    fs.writeFileSync(configPath, afterFirst);
    // disable cannot join a snapshot that names a unit the file still has enabled, and names the way out
    expect(thrownMessage(() => codexGateDisable({ configPath, matcher: "Bash", now: at(3) }))).toContain(
      `enable --runtime codex --config ${configPath} --force`,
    );
    const e = codexGateEnable({ configPath, now: at(4) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.restoredCount).toBe(1);
    expect(e.skippedEnabled).toEqual([SG]);
    expect(e.snapshotPath).toBe(retired(snapshotPath));
    expect(e.stillDisabled).toEqual([]);
    expect(read()).toBe(original);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("the same residue is also restored by enable --force, which reports the unit it skipped", () => {
    const { original, afterFirst } = merged();
    fs.writeFileSync(configPath, afterFirst);
    const e = codexGateEnable({ configPath, force: true, now: at(4) });
    expect(e.mode === "restored" && [e.restoredCount, e.skippedEnabled]).toEqual([1, [SG]]);
    expect(read()).toBe(original);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("one unit of a merged snapshot put back by hand with its original line: enable restores the other without --force", () => {
    const { original, snapshotPath } = merged();
    fs.writeFileSync(configPath, putBack(BP));
    const e = codexGateEnable({ configPath, now: at(3) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.restoredCount).toBe(1);
    expect(e.skippedEnabled).toEqual([BP]);
    expect(e.snapshotPath).toBe(retired(snapshotPath));
    expect(read()).toBe(original);
  });

  it("with another edit in the file the same state refuses without --force; --force restores the unit still off and keeps the edit", () => {
    const { original } = merged();
    const edited = `${putBack(BP)}\n[tui]\nnotifications = true\n`;
    fs.writeFileSync(configPath, edited);
    expect(() => codexGateEnable({ configPath, now: at(3) })).toThrow(/edited since the snapshot was taken/);
    expect(read()).toBe(edited);
    const e = codexGateEnable({ configPath, force: true, now: at(4) });
    expect(e.mode === "restored" && e.skippedEnabled).toEqual([BP]);
    expect(read()).toBe(`${original}\n[tui]\nnotifications = true\n`);
  });

  it("a hand-put-back line that differs from the recorded one is not proven to rebuild the pre-disable bytes: it refuses without --force", () => {
    merged();
    const changed = putBack(BP, 'hooks = [{ type = "command", command = "my-own-guard", timeout = 3 }]');
    fs.writeFileSync(configPath, changed);
    expect(() => codexGateEnable({ configPath, now: at(3) })).toThrow(/edited since the snapshot was taken/);
    expect(read()).toBe(changed);
  });

  it("a restore that cannot be proven also refuses when a unit it names is missing from the block, and writes nothing", () => {
    merged();
    const units = readCodexManagedHookUnits(read(), configPath)!.units;
    const gone = `${read().slice(0, units[0]!.start)}${read().slice(units[1]!.start)}`;
    fs.writeFileSync(configPath, gone);
    expect(() => codexGateEnable({ configPath, force: true, now: at(3) })).toThrow(/is not in the block of .* as it was/);
    // Without --force the first message is the same one, not the edited-since refusal that would name --force.
    expect(() => codexGateEnable({ configPath, now: at(3) })).toThrow(/is not in the block of .* as it was/);
    expect(read()).toBe(gone);
  });
});

/** The config with one unit's comment, header, matcher and hooks lines deleted by hand. */
function deleteUnit(text: string, id: string): string {
  const unit = readCodexManagedHookUnits(text, configPath)!.units.find((u) => u.id === id)!;
  return `${text.slice(0, unit.start)}${text.slice(text.indexOf("\n", unit.hooksEnd) + 1)}`;
}

describe("codex gate: a snapshot unit no gate command can restore", () => {
  /** Two disables merged (branch-protection, shell guard), then the shell guard's whole unit deleted by hand while
   * branch-protection is still off. */
  function unitDeleted(): { original: string; snapshotPath: string; state: string; backup: string } {
    const original = installConfig(configPath, { withEditGuard: true });
    const snapshotPath = disableAt(configPath, "apply_patch", at(1));
    expect(disableAt(configPath, "Bash", at(2))).toBe(snapshotPath);
    const state = deleteUnit(read(), SG);
    fs.writeFileSync(configPath, state);
    const snap = readCodexSnapshot(snapshotPath);
    if (!snap.ok) throw new Error("snapshot unreadable");
    return { original, snapshotPath, state, backup: snap.snapshot.configBackupPath };
  }

  it("refuses disable, enable and enable --force alike with the ways out, never --force, and writes nothing", () => {
    const { snapshotPath, state, backup } = unitDeleted();
    const dir = path.dirname(configPath);
    const body = fs.readFileSync(snapshotPath, "utf8");
    const entries = fs.readdirSync(dir).sort();
    for (const call of [
      () => codexGateDisable({ configPath, matcher: "Edit", now: at(3) }),
      () => codexGateEnable({ configPath, now: at(4) }),
      () => codexGateEnable({ configPath, force: true, now: at(5) }),
    ]) {
      const message = thrownMessage(call);
      expect(message).toContain(`the hook unit ${JSON.stringify(SG)} of the snapshot ${snapshotPath} is not in the block`);
      expect(message).toContain(`Ways out: run \`harness apply --runtime codex --install --codex-config ${configPath}\``);
      expect(message).toContain(`restore the config from ${backup}`);
      expect(message).toContain(`move ${snapshotPath} out of this directory`);
      expect(message).not.toContain("--force");
      expect(read()).toBe(state);
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe(body);
      expect(fs.readdirSync(dir).sort()).toEqual(entries);
    }
  });

  it("way out 1: a re-install supersedes the snapshot, and the refused disable then works", () => {
    unitDeleted();
    const snapshotPath = listCodexSnapshots(path.dirname(configPath))[0]!;
    const v2 = reinstall(configPath, at(3));
    const d = codexGateDisable({ configPath, matcher: "Bash", now: at(4) });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.retired?.from).toBe(snapshotPath);
    expect(d.retired?.why).toBe("superseded");
    const e = codexGateEnable({ configPath, now: at(5) });
    expect(e.mode).toBe("restored");
    expect(e.stillDisabled).toEqual([]);
    expect(read()).toBe(v2);
  });

  it("way out 2: the backup the refusal names puts the config back, and enable retires the snapshot with nothing left off", () => {
    const { original, snapshotPath, backup } = unitDeleted();
    fs.copyFileSync(backup, configPath);
    const e = codexGateEnable({ configPath, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && [e.retired?.from, e.retired?.why, e.missing]).toEqual([snapshotPath, "restored", []]);
    expect(e.stillDisabled).toEqual([]);
    expect(read()).toBe(original);
  });

  it("way out 3: with the snapshot moved aside the refused disable works, and enable names the unit still off", () => {
    const { snapshotPath } = unitDeleted();
    fs.renameSync(snapshotPath, path.join(tmp, "aside.json"));
    const d = codexGateDisable({ configPath, matcher: "Edit", now: at(3) });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.retired).toBeNull();
    const e = codexGateEnable({ configPath, now: at(4) });
    expect(e.mode).toBe("restored");
    expect(e.stillDisabled).toEqual([BP]);
  });

  it("a unit put back live with a changed matcher counts as enabled: --force restores the rest and keeps that line, and each refusal before it names --force", () => {
    const original = installConfig(configPath, { withEditGuard: true });
    const snapshotPath = disableAt(configPath, "apply_patch", at(1));
    disableAt(configPath, "Bash", at(2));
    const changed = putBack(SG).replace('matcher = "Bash|shell', 'matcher = "Bash|Shell|shell');
    const sg = readCodexManagedHookUnits(changed, configPath)!.units.find((u) => u.id === SG)!;
    expect([sg.matcher?.startsWith("Bash|Shell|"), sg.disabled]).toEqual([true, false]);
    fs.writeFileSync(configPath, changed);
    expect(thrownMessage(() => codexGateDisable({ configPath, matcher: "Edit", now: at(3) }))).toContain(
      `cannot join it. Run \`harness gate enable --runtime codex --config ${configPath} --force\``,
    );
    expect(thrownMessage(() => codexGateEnable({ configPath, now: at(4) }))).toMatch(/edited since the snapshot was taken.*--force/);
    expect(read()).toBe(changed);
    const e = codexGateEnable({ configPath, force: true, now: at(5) });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect([e.restoredCount, e.skippedEnabled, e.stillDisabled]).toEqual([1, [SG], []]);
    expect(e.snapshotPath).toBe(retired(snapshotPath));
    expect(read()).toBe(original.replace('matcher = "Bash|shell', 'matcher = "Bash|Shell|shell'));
    // The disable the first refusal stopped now starts a fresh snapshot.
    expect(disableAt(configPath, "Edit", at(6))).not.toBe(snapshotPath);
  });
});

describe("codexGateEnable: integrity", () => {
  it("refuses when the config was edited since the disable, leaving it untouched", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.appendFileSync(configPath, "\n[tui]\nnotifications = true\n");
    const edited = fs.readFileSync(configPath, "utf8");
    const entries = fs.readdirSync(path.dirname(configPath)).sort();
    expect(() => codexGateEnable({ configPath, now: T1 })).toThrow(/edited since the snapshot was taken/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual(entries);
  });

  it("--force restores the unit at its place and keeps the edit", () => {
    const original = installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.appendFileSync(configPath, "\n[tui]\nnotifications = true\n");
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${original}\n[tui]\nnotifications = true\n`);
    // The forced restore retires the snapshot, so a second forced run cannot splice the unit in again.
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
    expect(codexGateEnable({ configPath, force: true, now: T1 }).mode).toBe("no-snapshots");
  });

  it("--force restores several units, found by id", () => {
    const original = installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "a", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.neutralised.map((u) => u.ordinal)).toEqual([0, 1]);
    fs.appendFileSync(configPath, "\n[tui]\nnotifications = true\n");
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode === "restored" && e.restoredCount).toBe(2);
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${original}\n[tui]\nnotifications = true\n`);
  });

  it("--force still finds the unit when the operator removed another unit of the block by hand", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const text = fs.readFileSync(configPath, "utf8");
    const edited = text.replace(
      /# harness hook: hand-user-prompt-submit[^\n]*\n\[\[hooks\.UserPromptSubmit\]\]\nhooks = [^\n]*\n/,
      "",
    );
    expect(edited).not.toBe(text);
    fs.writeFileSync(configPath, edited);
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode).toBe("restored");
    const units = readCodexManagedHookUnits(fs.readFileSync(configPath, "utf8"), configPath)!.units;
    expect(units.map((u) => [u.id, u.disabled])).toEqual([
      [BP, false],
      ["hand-shell-guard", false],
    ]);
  });

  it("--force into a block that was re-rendered by an install adds nothing: no unit is disabled, no duplicate", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    // A fresh install re-renders the whole block, every unit enabled again.
    const generated = generateCodexConfig(manifest());
    asLegacyInstall(path.dirname(configPath), () =>
      writeCodexConfigInstall(
        planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
        { now: new Date("2026-10-02T09:00:00.000Z") },
      ),
    );
    const reinstalled = fs.readFileSync(configPath, "utf8");
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode).toBe("already-restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(reinstalled);
    expect(reinstalled.split("harness pack hook branch-protection").length - 1).toBe(1);
  });

  it("--force restores only the units that are still disabled: a unit put back by hand is skipped and named, never added twice", () => {
    const original = installConfig(configPath);
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    // The operator put the branch-protection hooks line back by hand and edited elsewhere; the shell guard stays disabled.
    const handFixed = `${putBack(BP)}\n[tui]\nx = 1\n`;
    fs.writeFileSync(configPath, handFixed);
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.restoredCount).toBe(1);
    expect(e.skippedEnabled).toEqual([BP]);
    expect(e.stillDisabled).toEqual([]);
    expect(read()).toBe(`${original}\n[tui]\nx = 1\n`);
    expect(read().split("harness pack hook branch-protection").length - 1).toBe(1);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("--force never overwrites a line that is live again, even one the operator changed", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    const handChanged = putBack(BP, 'hooks = [{ type = "command", command = "my-own-guard", timeout = 3 }]');
    fs.writeFileSync(configPath, handChanged);
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.skippedEnabled).toEqual([BP]);
    expect(read()).toContain("my-own-guard");
    expect(read()).not.toContain("harness pack hook branch-protection --runtime codex");
    expect(read()).toContain("harness pack hook shell-guard --runtime codex");
  });

  it("--force refuses a unit that is missing from the block, or whose matcher changed", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    const current = fs.readFileSync(configPath, "utf8");

    const renamed = current.replace(`# harness hook: ${BP}`, "# harness hook: policy-pack:renamed");
    fs.writeFileSync(configPath, renamed);
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(/is not in the block of .* as it was/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(renamed);

    const rematched = current.replace('matcher = "apply_patch"', 'matcher = "apply_patch|extra"');
    fs.writeFileSync(configPath, rematched);
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(/changed event or matcher/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(rematched);
  });

  it("--force refuses a unit whose id is now neutralised under another event with the same matcher, and writes nothing", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "Bash", now: T0 });
    // By hand: the shell guard's unit moves to PostToolUse, matcher unchanged, still neutralised.
    const moved = read().replace(
      /(# harness hook: hand-shell-guard[^\n]*\n)\[\[hooks\.PreToolUse\]\]/,
      "$1[[hooks.PostToolUse]]",
    );
    expect(moved).not.toBe(read());
    fs.writeFileSync(configPath, moved);
    const unit = readCodexManagedHookUnits(moved, configPath)!.units.find((u) => u.id === "hand-shell-guard")!;
    const snap = readCodexSnapshot(listCodexSnapshots(path.dirname(configPath))[0]!);
    if (!snap.ok) throw new Error("snapshot unreadable");
    expect([unit.event, unit.matcher, unit.disabled]).toEqual(["PostToolUse", snap.snapshot.neutralised[0]!.matcher, true]);
    expect(snap.snapshot.neutralised[0]!.event).toBe("PreToolUse");
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(/changed event or matcher/);
    expect(read()).toBe(moved);
  });

  it("--force refuses a restore whose result the post-edit guard cannot read (the guard runs on enable)", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    // The operator made hooks.PreToolUse a plain table, which the [[hooks.PreToolUse]] units above contradict.
    fs.appendFileSync(configPath, '\n[hooks.PreToolUse]\nnote = "x"\n');
    const edited = fs.readFileSync(configPath, "utf8");
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(
      /could not read this file|would not parse/,
    );
    // Without --force the guard's refusal comes first too, instead of an edited-since refusal pointing at --force.
    const plain = thrownMessage(() => codexGateEnable({ configPath, now: T1 }));
    expect(plain).toMatch(/could not read this file|would not parse/);
    expect(plain).not.toContain("--force");
    expect(fs.readFileSync(configPath, "utf8")).toBe(edited);
  });

  it("--force refuses when the harness block is gone from the config", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.writeFileSync(configPath, OPERATOR_BEFORE);
    const message = thrownMessage(() => codexGateEnable({ configPath, force: true }));
    expect(message).toMatch(/no harness-managed Codex hook block/);
    expect(message).toContain(`Ways out: run \`harness apply --runtime codex --install --codex-config ${configPath}\``);
    expect(message).toContain(`the next \`harness gate enable --runtime codex --config ${configPath}\` (or disable) retires`);
    expect(fs.readFileSync(configPath, "utf8")).toBe(OPERATOR_BEFORE);
  });

  it("refuses a snapshot whose text does not rebuild the recorded config", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const disabled = fs.readFileSync(configPath, "utf8");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    snap.neutralised[0].hooksText = snap.neutralised[0].hooksText.replace("branch-protection", "branch-protectiOn");
    fs.writeFileSync(d.snapshotPath, JSON.stringify(snap));
    expect(() => codexGateEnable({ configPath, now: T1 })).toThrow(/does not rebuild the config/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
    // --force does not bypass it: the snapshot's lines are wrong, not the config, and the message names the ways out.
    const forced = thrownMessage(() => codexGateEnable({ configPath, force: true, now: T1 }));
    expect(forced).toMatch(/does not rebuild the config/);
    expect(forced).toContain(`restore the config from ${d.backupPath}`);
    expect(forced).toContain(`Ways out: run \`harness apply --runtime codex --install --codex-config ${configPath}\``);
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([d.snapshotPath]);
  });

  it("skips a snapshot taken for another config, names it and leaves it live", () => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    const disabled = fs.readFileSync(configPath, "utf8");
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    snap.configPath = path.join(tmp, "elsewhere.toml");
    fs.writeFileSync(d.snapshotPath, JSON.stringify(snap));
    const e = codexGateEnable({ configPath });
    expect(e.mode).toBe("no-snapshots");
    expect(e.skippedForeign).toEqual([
      {
        path: d.snapshotPath,
        configPath: path.join(path.dirname(configPath), "elsewhere.toml"),
        configExists: false,
        configBackupPath: d.backupPath,
      },
    ]);
    expect(e.stillDisabled).toEqual([BP]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([d.snapshotPath]);
  });

  it("refuses when the config is gone", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.rmSync(configPath);
    const message = thrownMessage(() => codexGateEnable({ configPath }));
    expect(message).toMatch(/Codex config not found/);
    expect(message).toContain(`Ways out: run \`harness apply --runtime codex --install --codex-config ${configPath}\``);
  });
});

describe("readCodexSnapshot", () => {
  let snapshotPath: string;
  let snap: Record<string, unknown> & { neutralised: Array<Record<string, unknown>> };

  beforeEach(() => {
    installConfig(configPath);
    const d = codexGateDisable({ configPath, matcher: "a", now: T0 });
    if (d.mode !== "remove") throw new Error("expected remove");
    snapshotPath = d.snapshotPath;
    snap = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  });

  function readWith(change: (copy: typeof snap) => void): ReturnType<typeof readCodexSnapshot> {
    const copy = JSON.parse(JSON.stringify(snap)) as typeof snap;
    change(copy);
    fs.writeFileSync(snapshotPath, JSON.stringify(copy));
    return readCodexSnapshot(snapshotPath);
  }

  it("accepts the snapshot the gate wrote", () => {
    expect(readCodexSnapshot(snapshotPath).ok).toBe(true);
  });

  it("refuses a foreign version, a foreign target, a missing field and a null filter", () => {
    for (const change of [
      (c: typeof snap) => void (c["version"] = 1),
      (c: typeof snap) => void (c["target"] = "claude"),
      (c: typeof snap) => void delete c["target"],
      (c: typeof snap) => void delete c["configAfterSha256"],
      (c: typeof snap) => void (c["filter"] = null),
    ]) {
      expect(readWith(change).ok).toBe(false);
    }
  });

  it("refuses a createdAt that is not a timestamp (the walk orders by it)", () => {
    const r = readWith((c) => void (c["createdAt"] = "yesterday"));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/"createdAt" that is not a timestamp/) });
  });

  it("refuses a version 2 Codex snapshot with a message that says what to do", () => {
    const r = readWith((c) => void (c["version"] = 2));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/version 2 Codex gate snapshot.*cannot be restored/) });
  });

  it("refuses an empty or malformed neutralised list", () => {
    for (const change of [
      (c: typeof snap) => void (c.neutralised = []),
      (c: typeof snap) => void ((c as Record<string, unknown>)["neutralised"] = "x"),
      (c: typeof snap) => void (c.neutralised[0]!["ordinal"] = -1),
      (c: typeof snap) => void (c.neutralised[0]!["eventIndex"] = -1),
      (c: typeof snap) => void (c.neutralised[0]!["ordinal"] = 1.5),
      (c: typeof snap) => void (c.neutralised[0]!["hooksText"] = "model = 1"),
      (c: typeof snap) => void (c.neutralised[0]!["hooksText"] = "hooks = []\nmodel = 1"),
      (c: typeof snap) => void (c.neutralised[0]!["matcher"] = 7),
    ]) {
      const r = readWith(change);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/malformed "neutralised" list/);
    }
  });

  it("refuses the same hook unit id or block position listed twice", () => {
    const sameId = readWith((c) => void (c.neutralised[1]!["id"] = c.neutralised[0]!["id"]));
    expect(sameId.ok).toBe(false);
    expect(!sameId.ok && sameId.reason).toMatch(/twice/);
    const sameOrdinal = readWith((c) => void (c.neutralised[1]!["ordinal"] = c.neutralised[0]!["ordinal"]));
    expect(sameOrdinal.ok).toBe(false);
    expect(!sameOrdinal.ok && sameOrdinal.reason).toMatch(/twice/);
  });

  it("refuses a malformed merges list and accepts an empty one", () => {
    for (const merges of ["x", [{ createdAt: "t", matcher: 1, configBackupPath: "p" }], [null]]) {
      const r = readWith((c) => void (c["merges"] = merges));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/malformed "merges" list/);
    }
    expect(readWith((c) => void (c["merges"] = [])).ok).toBe(true);
  });

  it("makes enable refuse a tampered snapshot without writing, naming the file and how to get unstuck", () => {
    const disabled = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(snapshotPath, JSON.stringify({ ...snap, neutralised: [] }));
    expect(() => codexGateEnable({ configPath })).toThrow(GateEnableError);
    expect(thrownMessage(() => codexGateEnable({ configPath }))).toContain(`move ${snapshotPath} aside`);
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
  });
});

describe("codexGateDisable: refusals leave the file byte-identical", () => {
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

  it("a missing END marker, with the way out in the message", () => {
    const text = installConfig(configPath, { after: "" }).replace(CODEX_MANAGED_END, "# not the end");
    expectRefusal(text, "apply_patch", /not closed by a '# END harness-managed codex hooks' marker/);
    // The call named its config, so the way out names it too.
    expect(() => codexGateDisable({ configPath, matcher: "apply_patch" })).toThrow(
      new RegExp(
        "move any table .* below the END marker, or re-run `harness apply --runtime codex --install " +
          `--codex-config ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``,
      ),
    );
  });

  it("a drifted END marker (a foreign table between the last unit and the END line)", () => {
    const text = installConfig(configPath, { after: "" });
    const drifted = text.replace(CODEX_MANAGED_END, `[wedge]\nkey = "v"\n${CODEX_MANAGED_END}`);
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

  it("a hand-written comment between two hook units", () => {
    const text = installConfig(configPath);
    const noted = text.replace(
      "# harness hook: hand-shell-guard",
      "# operator note about the next hook\n# harness hook: hand-shell-guard",
    );
    expectRefusal(noted, "apply_patch", /comment between hook units/);
  });

  it("two units that share one id", () => {
    const text = installConfig(configPath);
    const twins = text.replace("# harness hook: hand-shell-guard", `# harness hook: ${BP}`);
    expectRefusal(twins, "apply_patch", /carry the same id/);
  });

  it("a config the post-edit guard cannot read (an operator syntax error outside the block), in the gate's wording", () => {
    const text = installConfig(configPath, { after: "\nthis is = = not toml\n" });
    expectRefusal(text, "apply_patch", /refusing to edit, because without parsing it/);
    expect(() => codexGateDisable({ configPath, matcher: "apply_patch" })).not.toThrow(/refusing to install/);
  });

  it("a hook comment outside the block that harness cannot tell from a stray unit", () => {
    const text = installConfig(configPath, {
      after:
        '\n# harness hook: stray (budget_ms=5000)\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "x", timeout = 1 }]\n',
    });
    expectRefusal(text, "apply_patch", /no harness block marker/);
  });
});

describe("codex gate: snapshot isolation from the Claude gate", () => {
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
    const again = codexGateDisable({ configPath, matcher: "apply_patch", now: new Date("2026-10-02T12:00:00.000Z") });
    if (again.mode !== "remove") throw new Error("expected remove");
    touch(again.snapshotPath, new Date("2026-10-02T13:00:00.000Z"));
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
    downgradeToVersion1(d.snapshotPath);
    const snap = JSON.parse(fs.readFileSync(d.snapshotPath, "utf8"));
    expect(snap.version).toBe(1);
    expect(snap.target).toBeUndefined();
    expect(gateEnable({ settingsPath }).mode).toBe("restored");
  });
});

/** The real installer over `target` (no legacy simulation): returns its result. */
function installOver(target: string, now: Date, shellGuardCommand = V2): ReturnType<typeof writeCodexConfigInstall> {
  const generated = generateCodexConfig(manifest(shellGuardCommand));
  return writeCodexConfigInstall(
    planCodexConfigInstall({ configPath: target, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
    { now },
  );
}

describe("the installer retires live gate snapshots of the block it rewrites", () => {
  it("renames the live snapshot of a direct config to *.superseded.json, whatever backup files exist", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    const body = fs.readFileSync(s0, "utf8");
    const result = installOver(configPath, at(2));
    expect(result.supersededSnapshots).toEqual([retired(s0, "superseded")]);
    expect(result.snapshotWarnings).toBeUndefined();
    expect(fs.existsSync(s0)).toBe(false);
    expect(fs.readFileSync(retired(s0, "superseded"), "utf8")).toBe(body);
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([]);
  });

  it("an install that changes nothing leaves the live snapshot alone", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    // The block is neutralised in place, so re-rendering the unchanged manifest rewrites it: use the
    // plan's own no-op case instead, where the generated block equals the current one.
    const plan = planCodexConfigInstall({
      configPath,
      generatedPath: "/gen/codex/config.toml",
      generatedContent: generateCodexConfig(manifest(V2)).content,
    });
    writeCodexConfigInstall({ ...plan, changed: false }, { now: at(2) });
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([s0]);
  });

  it("retires a snapshot taken through a symlink when the install runs on the link, beside the link", () => {
    const real = path.join(tmp, "dotfiles", "config.toml");
    installConfig(real);
    const linkDir = path.join(tmp, "codex-home");
    fs.mkdirSync(linkDir);
    const link = path.join(linkDir, "config.toml");
    fs.symlinkSync(real, link);
    const s0 = disableAt(link, "Bash", at(1));
    expect(path.dirname(s0)).toBe(linkDir);
    const result = installOver(link, at(2));
    expect(result.supersededSnapshots).toEqual([retired(s0, "superseded")]);
    expect(listCodexSnapshots(linkDir)).toEqual([]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("an install run on the link also retires a snapshot taken on the target's own path, which sits beside the target", () => {
    const real = path.join(tmp, "dotfiles", "config.toml");
    installConfig(real);
    const linkDir = path.join(tmp, "codex-home");
    fs.mkdirSync(linkDir);
    const link = path.join(linkDir, "config.toml");
    fs.symlinkSync(real, link);
    const s0 = disableAt(real, "Bash", at(1));
    expect(path.dirname(s0)).toBe(path.dirname(real));
    const result = installOver(link, at(2));
    expect(result.supersededSnapshots).toEqual([retired(s0, "superseded")]);
    expect(listCodexSnapshots(path.dirname(real))).toEqual([]);
  });

  it("retires a snapshot of the target that sits beside the target, and one recorded under another name of the same file", () => {
    installConfig(configPath);
    const dir = path.dirname(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    // A snapshot whose recorded path is a hard link to the config: same file, different spelling.
    const alias = path.join(dir, "alias.toml");
    fs.linkSync(configPath, alias);
    const body = JSON.parse(fs.readFileSync(s0, "utf8"));
    body.configPath = alias;
    const s1 = path.join(dir, `${CODEX_SNAPSHOT_BASENAME_PREFIX}2026-10-02T05-00-00.000Z.json`);
    fs.writeFileSync(s1, JSON.stringify(body));
    const result = installOver(configPath, at(6));
    expect([...(result.supersededSnapshots ?? [])].sort()).toEqual([retired(s0, "superseded"), retired(s1, "superseded")].sort());
    expect(listCodexSnapshots(dir)).toEqual([]);
  });

  it("a stale snapshot with every install backup deleted no longer restores an outdated hooks line", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    const v2 = installOver(configPath, at(2)) && read();
    for (const name of fs.readdirSync(path.dirname(configPath))) {
      if (name.includes(".harness-backup-")) fs.rmSync(path.join(path.dirname(configPath), name));
    }
    expect(fs.readdirSync(path.dirname(configPath)).some((n) => n.includes("harness-backup"))).toBe(false);
    const hand = neutraliseByHand(v2, SG);
    fs.writeFileSync(configPath, hand);
    const e = codexGateEnable({ configPath, now: at(3) });
    expect(e.mode).toBe("no-snapshots");
    expect(read()).toBe(hand);
    expect(read()).not.toContain(OLD_SG_LINE);
    expect(fs.existsSync(s0)).toBe(false);
  });

  it("leaves the live snapshot of another config in the same directory alone", () => {
    installConfig(configPath);
    const dir = path.dirname(configPath);
    const other = path.join(dir, "other.toml");
    installConfig(other);
    const a = disableAt(configPath, "Bash", at(1));
    const b = disableAt(other, "Bash", at(2));
    const result = installOver(configPath, at(3));
    expect(result.supersededSnapshots).toEqual([retired(a, "superseded")]);
    expect(listCodexSnapshots(dir)).toEqual([b]);
  });

  it("a rename that fails never fails the install: it warns, names the snapshot and the move-aside step, and keeps the snapshot", () => {
    installConfig(configPath);
    const s0 = disableAt(configPath, "Bash", at(1));
    // A directory sits where the retired name would go, so the rename fails.
    fs.mkdirSync(path.join(retired(s0, "superseded"), "blocker"), { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = installOver(configPath, at(2));
      expect(result.written).toBe(true);
      expect(read()).toContain(V2);
      expect(result.supersededSnapshots).toBeUndefined();
      expect(result.snapshotWarnings).toHaveLength(1);
      expect(result.snapshotWarnings![0]).toContain(s0);
      expect(result.snapshotWarnings![0]).toMatch(/move it out of this directory/);
      // The installer reports through its result; the callers print it through their io.
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(listCodexSnapshots(path.dirname(configPath))).toEqual([s0]);
  });

  it("an unreadable live snapshot is left in place and reported, and the install still succeeds", () => {
    installConfig(configPath);
    const junk = path.join(path.dirname(configPath), `${CODEX_SNAPSHOT_BASENAME_PREFIX}2026-10-02T00-30-00.000Z.json`);
    fs.writeFileSync(junk, "{ not json");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = installOver(configPath, at(2));
      expect(result.written).toBe(true);
      expect(result.snapshotWarnings).toHaveLength(1);
      expect(result.snapshotWarnings![0]).toContain(junk);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(fs.existsSync(junk)).toBe(true);
  });
});


/** Runs the real installer (it supersedes the gate snapshots it can find) over `target`. */
function installThrough(target: string, now: Date, shellGuardCommand?: string): ReturnType<typeof writeCodexConfigInstall> {
  const generated = generateCodexConfig(manifest(shellGuardCommand));
  return writeCodexConfigInstall(
    planCodexConfigInstall({ configPath: target, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
    { now },
  );
}

describe("codex gate: one config reached through several names", () => {
  let real: string;
  let dirA: string;
  let dirB: string;
  let l1: string;
  let l2: string;

  /** l1 (a/config.toml) -> l2 (b/config.toml) -> real (dotfiles/config.toml): a chain of two links. */
  function chain(): string {
    real = path.join(tmp, "dotfiles", "config.toml");
    const original = installConfig(real);
    dirA = path.join(tmp, "a");
    dirB = path.join(tmp, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    l1 = path.join(dirA, "config.toml");
    l2 = path.join(dirB, "config.toml");
    fs.symlinkSync(l2, l1);
    fs.symlinkSync(real, l2);
    return original;
  }

  it("an install through the top link retires a snapshot taken beside an intermediate link of the chain, and enable never restores its line", () => {
    chain();
    const s0 = disableAt(l2, "Bash", at(1));
    expect(path.dirname(s0)).toBe(dirB);
    const result = installThrough(l1, at(2), V2);
    expect(result.supersededSnapshots).toEqual([retired(s0, "superseded")]);
    expect(listCodexSnapshots(dirB)).toEqual([]);
    // The unit is neutralised again by hand: nothing offers the old line back.
    const hand = neutraliseByHand(fs.readFileSync(real, "utf8"), SG);
    fs.writeFileSync(real, hand);
    for (const via of [l1, l2]) {
      const e = codexGateEnable({ configPath: via, now: at(3) });
      expect(e.mode).toBe("no-snapshots");
      expect(e.stillDisabled).toEqual([SG]);
    }
    expect(fs.readFileSync(real, "utf8")).toBe(hand);
    expect(fs.readFileSync(real, "utf8")).not.toContain(OLD_SG_LINE);
  });

  it("an install through the target itself cannot find a snapshot beside a link; enable through the link dates that install by its backup beside the target", () => {
    chain();
    const s0 = disableAt(l1, "Bash", at(1));
    const s1 = disableAt(l2, "apply_patch", at(2));
    const result = installThrough(real, at(3), V2);
    expect(result.supersededSnapshots).toBeUndefined();
    expect(listCodexSnapshots(dirA)).toEqual([s0]);
    expect(listCodexSnapshots(dirB)).toEqual([s1]);
    for (const [via, snap] of [
      [l1, s0],
      [l2, s1],
    ] as const) {
      const e = codexGateEnable({ configPath: via, now: at(4) });
      expect(e.mode !== "no-snapshots" && [e.retired?.from, e.retired?.why]).toEqual([snap, "superseded"]);
    }
    expect(fs.readFileSync(real, "utf8")).toContain(V2);
  });

  it("an install through an intermediate link retires a snapshot taken beside the target's directory, not one of a link above it", () => {
    chain();
    const s0 = disableAt(l1, "Bash", at(1));
    const beside = disableAt(real, "apply_patch", at(2));
    expect(path.dirname(beside)).toBe(path.dirname(real));
    const result = installThrough(l2, at(3), V2);
    // The installer cannot know the link above the one it was run through: only the enable-side dating covers that.
    expect(result.supersededSnapshots).toEqual([retired(beside, "superseded")]);
    expect(result.snapshotWarnings).toBeUndefined();
    expect(listCodexSnapshots(path.dirname(real))).toEqual([]);
    expect(listCodexSnapshots(dirA)).toEqual([s0]);
  });

  it("a target whose directory is also reached through a directory symlink is looked at once: its snapshot is retired with no warning", () => {
    const d = path.join(tmp, "d");
    fs.mkdirSync(d);
    fs.symlinkSync(d, path.join(tmp, "dl"));
    real = path.join(d, "real.toml");
    installConfig(real);
    const link = path.join(tmp, "a", "config.toml");
    fs.mkdirSync(path.dirname(link));
    // Resolved against the physical directory of the link, this text leads through the symlinked directory `dl`.
    fs.symlinkSync(path.join("..", "dl", "real.toml"), link);
    const snap = disableAt(real, "Bash", at(1));
    const result = installThrough(link, at(2), V2);
    // Retired once, under the first spelling of the directory that reached it; found a second time under `d` it would not rename.
    expect(result.supersededSnapshots?.map((p) => fs.realpathSync(p))).toEqual([fs.realpathSync(retired(snap, "superseded"))]);
    expect(result.snapshotWarnings).toBeUndefined();
    expect(listCodexSnapshots(d)).toEqual([]);
  });

  it("a snapshot beside the top link, an install through an intermediate link, then enable through the top link: the install is dated by its backup, the old line stays out", () => {
    chain();
    // Installs from before the block generation marker, as in the snapshot dating test above.
    preMarker(real);
    const s0 = disableAt(l1, "Bash", at(1));
    reinstallThrough(l2, at(2), V2, dirA);
    const v2 = preMarker(real);
    const hand = neutraliseByHand(v2, SG);
    fs.writeFileSync(real, hand);
    const snap = readCodexSnapshot(s0);
    expect(snap.ok && snap.snapshot.configAfterSha256).toBe(sha(hand));
    // The installer left its backup beside the link it ran through, which is neither the gate's link nor the target.
    const backup = `${l2}.harness-backup-2026-10-02T02-00-00-000Z`;
    expect(fs.existsSync(backup)).toBe(true);
    const e = codexGateEnable({ configPath: l1, now: at(3) });
    expect(e.mode).toBe("already-restored");
    expect(e.mode !== "no-snapshots" && e.retired).toEqual({
      from: s0,
      to: retired(s0, "superseded"),
      why: "superseded",
      installBackup: backup,
    });
    expect(fs.readFileSync(real, "utf8")).toBe(hand);
    expect(fs.readFileSync(real, "utf8")).not.toContain(OLD_SG_LINE);
  });

  it("disable through the same top link retires such a snapshot too, instead of joining it", () => {
    chain();
    const s0 = disableAt(l1, "Bash", at(1));
    reinstallThrough(l2, at(2), V2, dirA);
    const s1 = disableAt(l1, "apply_patch", at(3));
    expect(s1).not.toBe(s0);
    expect(listCodexSnapshots(dirA)).toEqual([s1]);
    expect(fs.existsSync(retired(s0, "superseded"))).toBe(true);
  });

  it("a second link to the config outside the chain the install ran through is not found: the snapshot beside it stays live (the documented residual)", () => {
    real = path.join(tmp, "dotfiles", "config.toml");
    installConfig(real);
    const other = path.join(tmp, "other-home");
    fs.mkdirSync(other);
    const second = path.join(other, "config.toml");
    const first = path.join(tmp, "codex-home", "config.toml");
    fs.mkdirSync(path.dirname(first));
    fs.symlinkSync(real, first);
    fs.symlinkSync(real, second);
    const s0 = disableAt(second, "Bash", at(1));
    const result = installThrough(first, at(2), V2);
    expect(result.supersededSnapshots).toBeUndefined();
    expect(listCodexSnapshots(other)).toEqual([s0]);
    // Enable run with the link the disable used finds its own snapshot; run through the other link it finds none.
    expect(codexGateEnable({ configPath: first, now: at(3) }).mode).toBe("no-snapshots");
  });

  it.skipIf(!foldsCase())(
    "a case variant of the config's name is the same entry: disable through either spelling, enable through the other (skipped on a case-sensitive volume)",
    () => {
      const original = installConfig(configPath);
      const variant = path.join(path.dirname(configPath), "Config.toml");
      const s0 = disableAt(variant, "Bash", at(1));
      const e = codexGateEnable({ configPath, now: at(2) });
      expect(e.mode).toBe("restored");
      expect(e.skippedForeign).toEqual([]);
      expect(e.mode === "restored" && e.snapshotPath).toBe(retired(s0));
      expect(read()).toBe(original);
      const s1 = disableAt(configPath, "Bash", at(3));
      const back = codexGateEnable({ configPath: variant, now: at(4) });
      expect(back.mode).toBe("restored");
      expect(back.skippedForeign).toEqual([]);
      expect(back.mode === "restored" && back.snapshotPath).toBe(retired(s1));
      expect(read()).toBe(original);
    },
  );

  it.skipIf(!foldsCase())(
    "a disable through a case variant joins the live snapshot taken through the exact name (skipped on a case-sensitive volume)",
    () => {
      installConfig(configPath);
      const variant = path.join(path.dirname(configPath), "CONFIG.TOML");
      const s0 = disableAt(configPath, "apply_patch", at(1));
      expect(disableAt(variant, "Bash", at(2))).toBe(s0);
      expect(listCodexSnapshots(path.dirname(configPath))).toEqual([s0]);
    },
  );

  it.skipIf(!foldsCase())(
    "the install's backup is dated through a case variant of the name: a snapshot taken through one spelling is superseded by an install through the other (skipped on a case-sensitive volume)",
    () => {
      installConfig(configPath);
      const variant = path.join(path.dirname(configPath), "Config.toml");
      const s0 = disableAt(variant, "Bash", at(1));
      const v2 = reinstall(configPath, at(2), V2);
      fs.writeFileSync(configPath, neutraliseByHand(v2, SG));
      const e = codexGateEnable({ configPath: variant, now: at(3) });
      expect(e.mode).toBe("already-restored");
      expect(e.mode !== "no-snapshots" && e.retired?.why).toBe("superseded");
      expect(e.mode !== "no-snapshots" && e.retired?.from).toBe(s0);
      expect(read()).not.toContain(OLD_SG_LINE);
    },
  );

  it.skipIf(!foldsCase())(
    "a case variant of a config with a second name stays foreign, and the foreign entry carries the recorded path (skipped on a case-sensitive volume)",
    () => {
      installConfig(configPath);
      const s0 = disableAt(configPath, "Bash", at(1));
      fs.linkSync(configPath, path.join(path.dirname(configPath), "second-name.toml"));
      const variant = path.join(path.dirname(configPath), "Config.toml");
      const e = codexGateEnable({ configPath: variant, now: at(2) });
      expect(e.mode).toBe("no-snapshots");
      expect(e.skippedForeign.map((f) => [f.path, f.configPath, f.configExists])).toEqual([[s0, configPath, true]]);
      expect(e.stillDisabled).toEqual([SG]);
    },
  );
});

/** Re-runs the installer through `target` the way an installer without the install-time supersede does:
 * the gate snapshots beside `snapshotDir` are put back live. */
function reinstallThrough(target: string, now: Date, shellGuardCommand: string, snapshotDir: string): string {
  const generated = generateCodexConfig(manifest(shellGuardCommand));
  asLegacyInstall(snapshotDir, () =>
    writeCodexConfigInstall(
      planCodexConfigInstall({ configPath: target, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
      { now },
    ),
  );
  return fs.readFileSync(fs.realpathSync(target), "utf8");
}
