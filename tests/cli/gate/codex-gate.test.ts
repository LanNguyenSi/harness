import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseTomlForTest } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  assertCodexHookEditInvariant,
  assertConfigSemanticInvariant,
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
  CODEX_NEUTRALISED_HOOKS,
  CODEX_SNAPSHOT_BASENAME_PREFIX,
  CODEX_SNAPSHOT_TARGET,
  CODEX_SNAPSHOT_VERSION,
  gateWording,
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

function touch(file: string, when: Date): void {
  fs.utimesSync(file, when, when);
}

const BP = "policy-pack:branch-protection:pre-tool-use";

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
    const again = codexGateEnable({ configPath, now: new Date("2026-10-02T12:00:00.000Z") });
    expect(again.mode).toBe("already-restored");
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

  it("neutralises only the units that are still enabled when a wider matcher follows", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const d = codexGateDisable({ configPath, matcher: "a", now: T1 });
    if (d.mode !== "remove") throw new Error("expected remove");
    expect(d.neutralised.map((u) => u.id)).toEqual(["hand-shell-guard"]);
    const snap = readCodexSnapshot(d.snapshotPath);
    expect(snap.ok && snap.snapshot.neutralised.map((u) => u.id)).toEqual(["hand-shell-guard"]);
  });
});

describe("codexGateEnable: more than one disable", () => {
  function twoDisables(): { original: string; first: string; second: string } {
    const original = installConfig(configPath);
    const a = codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    const b = codexGateDisable({ configPath, matcher: "Bash", now: T1 });
    if (a.mode !== "remove" || b.mode !== "remove") throw new Error("expected remove");
    touch(a.snapshotPath, T0);
    touch(b.snapshotPath, T1);
    return { original, first: a.snapshotPath, second: b.snapshotPath };
  }

  it("one enable restores every disable, newest first, and a second enable is a clean no-op", () => {
    const { original, first, second } = twoDisables();
    const e = codexGateEnable({ configPath, now: new Date("2026-10-02T12:00:00.000Z") });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.snapshotPaths).toEqual([second, first]);
    expect(e.restoredCount).toBe(2);
    expect(e.stillDisabled).toEqual([]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    const again = codexGateEnable({ configPath, now: new Date("2026-10-02T13:00:00.000Z") });
    expect(again.mode).toBe("already-restored");
    expect(again.stillDisabled).toEqual([]);
  });

  it("names the unit that stays disabled when the older snapshot is gone, and never reports an all-clear", () => {
    const { original, first } = twoDisables();
    fs.rmSync(first);
    const e = codexGateEnable({ configPath, now: new Date("2026-10-02T12:00:00.000Z") });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.stillDisabled).toEqual([BP]);
    expect(fs.readFileSync(configPath, "utf8")).not.toBe(original);
    // The call after it finds the newest snapshot already restored, yet the unit is still off.
    const again = codexGateEnable({ configPath, now: new Date("2026-10-02T13:00:00.000Z") });
    expect(again.mode).toBe("already-restored");
    expect(again.stillDisabled).toEqual([BP]);
  });

  it("reports a hand-neutralised unit that no snapshot covers instead of 'no snapshots'", () => {
    const text = installConfig(configPath);
    fs.writeFileSync(configPath, neutraliseByHand(text, "hand-shell-guard"));
    const r = codexGateEnable({ configPath });
    expect(r.mode).toBe("no-snapshots");
    expect(r.stillDisabled).toEqual(["hand-shell-guard"]);
  });

  it("stops at an older snapshot that no longer applies and says which unit is left", () => {
    const { first } = twoDisables();
    // The older snapshot's recorded shas no longer fit the chain.
    const snap = JSON.parse(fs.readFileSync(first, "utf8"));
    snap.configAfterSha256 = sha("something else");
    fs.writeFileSync(first, JSON.stringify(snap));
    touch(first, T0);
    const e = codexGateEnable({ configPath, now: new Date("2026-10-02T12:00:00.000Z") });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(e.snapshotPaths).toHaveLength(1);
    expect(e.stillDisabled).toEqual([BP]);
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
    const e = codexGateEnable({ configPath, now: T1 });
    if (e.mode !== "restored") throw new Error("expected restored");
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(e.backupPath).mode & 0o777).toBe(0o600);
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
    writeCodexConfigInstall(
      planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
      { now: new Date("2026-10-02T09:00:00.000Z") },
    );
    const reinstalled = fs.readFileSync(configPath, "utf8");
    const e = codexGateEnable({ configPath, force: true, now: T1 });
    expect(e.mode).toBe("already-restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe(reinstalled);
    expect(reinstalled.split("harness pack hook branch-protection").length - 1).toBe(1);
  });

  it("--force refuses a unit of the snapshot that is already enabled while another unit is still disabled", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "a", now: T0 });
    // The operator put the branch-protection hooks line back by hand; the shell guard stays disabled.
    const current = fs.readFileSync(configPath, "utf8");
    const snap = readCodexSnapshot(listSnapshots(path.dirname(configPath), CODEX_SNAPSHOT_BASENAME_PREFIX)[0]!);
    if (!snap.ok) throw new Error("snapshot unreadable");
    const bp = readCodexManagedHookUnits(current, configPath)!.units[0]!;
    const handFixed = `${current.slice(0, bp.hooksStart)}${snap.snapshot.neutralised[0]!.hooksText}${current.slice(bp.hooksEnd)}\n[tui]\nx = 1\n`;
    fs.writeFileSync(configPath, handFixed);
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(/is not disabled in the block/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(handFixed);
    expect(handFixed.split("harness pack hook branch-protection").length - 1).toBe(1);
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

  it("--force refuses a restore whose result the post-edit guard cannot read (the guard runs on enable)", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    // The operator made hooks.PreToolUse a plain table, which the [[hooks.PreToolUse]] units above contradict.
    fs.appendFileSync(configPath, '\n[hooks.PreToolUse]\nnote = "x"\n');
    const edited = fs.readFileSync(configPath, "utf8");
    expect(() => codexGateEnable({ configPath, force: true, now: T1 })).toThrow(
      /could not read this file|would not parse/,
    );
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
    snap.neutralised[0].hooksText = snap.neutralised[0].hooksText.replace("branch-protection", "branch-protectiOn");
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

  it("refuses when the config is gone", () => {
    installConfig(configPath);
    codexGateDisable({ configPath, matcher: "apply_patch", now: T0 });
    fs.rmSync(configPath);
    expect(() => codexGateEnable({ configPath })).toThrow(/Codex config not found/);
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

  it("makes enable refuse a tampered snapshot without writing", () => {
    const disabled = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(snapshotPath, JSON.stringify({ ...snap, neutralised: [] }));
    expect(() => codexGateEnable({ configPath })).toThrow(GateEnableError);
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
    expect(() => codexGateDisable({ configPath, matcher: "apply_patch" })).toThrow(
      /move any table .* below the END marker, or re-run `harness apply --runtime codex --install`/,
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
