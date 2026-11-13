// Upgrading from the bare `harness pack hook branch-protection` hook line to
// the guarded line (guarded-harness-command.ts): every place that recognises
// harness's own hook entries must see both spellings, so an upgrade rewrites
// the old entry instead of adding a second one and an uninstall removes
// either. Every path below is a temp dir; nothing reads the real HOME.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { apply } from "../../src/cli/apply/index.js";
import { CODEX_MANAGED_BEGIN, CODEX_MANAGED_END, CodexInstallRefusalError, planCodexConfigInstall } from "../../src/cli/apply/index.js";
import { gateDisable } from "../../src/cli/gate/disable.js";
import { GateEnableError, gateEnable } from "../../src/cli/gate/enable.js";
import { uninstall } from "../../src/cli/uninstall/index.js";
import { guardedHarnessCommand } from "../../src/policy-packs/builtin/guarded-harness-command.js";
import type { ClaudeMcpExec } from "../../src/io/claude-mcp.js";

const BARE = "harness pack hook branch-protection";
const BARE_CODEX = "harness pack hook branch-protection --runtime codex";
const GUARDED = guardedHarnessCommand("pack hook branch-protection");
const GUARDED_CODEX = guardedHarnessCommand("pack hook branch-protection --runtime codex");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-guard-upgrade-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(): void {
  fs.writeFileSync(
    path.join(tmp, "harness.yaml"),
    yamlStringify({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [],
      policies: [],
      policy_packs: [{ name: "branch-protection" }],
    }),
  );
}

interface Group {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

function claudeSettings(groups: Group[], extra: Record<string, unknown> = {}): string {
  const p = path.join(tmp, "settings.json");
  fs.writeFileSync(p, `${JSON.stringify({ hooks: { PreToolUse: groups }, ...extra }, null, 2)}\n`);
  return p;
}

function preToolUse(file: string): Group[] {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: { PreToolUse: Group[] } }).hooks.PreToolUse;
}

const commandsOf = (groups: Group[]): string[] => groups.flatMap((g) => g.hooks.map((h) => h.command));

describe("apply --target --merge over a settings file that holds the bare line", () => {
  it("leaves one branch-protection entry, in the guarded form, and keeps the operator's own hook and keys", async () => {
    writeManifest();
    const target = claudeSettings(
      [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: BARE, timeout: 5 }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/foreign-hook" }] },
      ],
      { theme: "dark" },
    );
    const r = await apply({ homeDir: tmp, target, merge: true });
    expect(r.outcome).toBe("applied");
    const after = preToolUse(target);
    const commands = commandsOf(after);
    expect(commands.filter((c) => c.includes("pack hook branch-protection"))).toEqual([GUARDED]);
    expect(commands).not.toContain(BARE);
    // The merge replaces the hooks key wholesale (docs/quickstart.md), so the
    // operator's Bash hook lives in the manifest, not in the target; the keys
    // outside `hooks` survive.
    expect(JSON.parse(fs.readFileSync(target, "utf8"))["theme"]).toBe("dark");
  });

  it("a second apply over the upgraded file changes nothing", async () => {
    writeManifest();
    const target = claudeSettings([{ matcher: "Write|Edit", hooks: [{ type: "command", command: BARE, timeout: 5 }] }]);
    await apply({ homeDir: tmp, target, merge: true });
    const once = fs.readFileSync(target, "utf8");
    const again = await apply({ homeDir: tmp, target, merge: true });
    expect(again.targetWritten).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(once);
  });
});

describe("apply --runtime codex --install over a block that holds the bare line", () => {
  const tomlString = (s: string): string => JSON.stringify(s);

  it("replaces the block: one branch-protection table, guarded, no bare line left", async () => {
    writeManifest();
    const codexConfig = path.join(tmp, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, 'model = "gpt-5.5"\n');
    const installOpts = { homeDir: tmp, runtime: "codex" as const, installCodex: true, codexConfigPath: codexConfig };
    await apply(installOpts);
    const installed = fs.readFileSync(codexConfig, "utf8");
    expect(installed).toContain(tomlString(GUARDED_CODEX));

    // What the previous release left in the block.
    const old = installed.split(tomlString(GUARDED_CODEX)).join(tomlString(BARE_CODEX));
    expect(old).not.toBe(installed);
    fs.writeFileSync(codexConfig, old);

    await apply(installOpts);
    const upgraded = fs.readFileSync(codexConfig, "utf8");
    expect(upgraded.split("pack hook branch-protection").length - 1).toBe(1);
    expect(upgraded).toContain(tomlString(GUARDED_CODEX));
    expect(upgraded).not.toContain(tomlString(BARE_CODEX));
    expect(upgraded.match(/^\[\[hooks\.PreToolUse\]\]$/gm)).toHaveLength(1);
    expect(upgraded).toContain('model = "gpt-5.5"');
  });

  it("an uncommented hook table next to the block that runs the guarded line is harness-shaped, as the bare line was", () => {
    const fresh = [
      "# Generated by harness apply --runtime codex.",
      "# harness hook: policy-pack:branch-protection:pre-tool-use (budget_ms=5000)",
      "[[hooks.PreToolUse]]",
      'matcher = "apply_patch"',
      `hooks = [{ type = "command", command = ${tomlString(GUARDED_CODEX)}, timeout = 5 }]`,
      "",
    ].join("\n");
    for (const command of [BARE_CODEX, GUARDED_CODEX, GUARDED]) {
      const config = [
        CODEX_MANAGED_BEGIN,
        ...fresh.split("\n").slice(0, -1),
        "[[ hooks.Stop ]]",
        `hooks = [{ type = "command", command = ${tomlString(command)}, timeout = 5 }]`,
        CODEX_MANAGED_END,
        "",
      ].join("\n");
      const codexConfig = path.join(tmp, "config.toml");
      fs.writeFileSync(codexConfig, config);
      let refusal: unknown;
      try {
        planCodexConfigInstall({ configPath: codexConfig, generatedPath: "/x/config.toml", generatedContent: fresh });
      } catch (err) {
        refusal = err;
      }
      expect(refusal, command).toBeInstanceOf(CodexInstallRefusalError);
      expect((refusal as Error).message, command).toContain("whose command is one harness itself writes");
    }
  });

  it("an uncommented hook table with an unrelated command is still kept, not refused", () => {
    const fresh = ["# Generated by harness apply --runtime codex.", ""].join("\n");
    const config = [
      CODEX_MANAGED_BEGIN,
      "# Generated by harness apply --runtime codex.",
      "[[ hooks.Stop ]]",
      `hooks = [{ type = "command", command = ${tomlString("/bin/sh -c 'echo operator'")}, timeout = 5 }]`,
      CODEX_MANAGED_END,
      "",
    ].join("\n");
    const codexConfig = path.join(tmp, "config.toml");
    fs.writeFileSync(codexConfig, config);
    expect(() => planCodexConfigInstall({ configPath: codexConfig, generatedPath: "/x/config.toml", generatedContent: fresh })).not.toThrow(
      CodexInstallRefusalError,
    );
  });
});

describe("harness uninstall --apply removes the bare line and the guarded line", () => {
  const execThrows: ClaudeMcpExec = async () => {
    throw new Error("claude mcp must not be spawned in this test");
  };

  async function uninstallWith(commands: string[]): Promise<{ left: string[] }> {
    const homeDir = path.join(tmp, ".claude");
    fs.mkdirSync(homeDir, { recursive: true });
    const settingsPath = path.join(homeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/foreign-hook" }] },
              ...commands.map((command) => ({ matcher: "Write|Edit", hooks: [{ type: "command", command }] })),
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const r = await uninstall({ homeDir, settingsPath, apply: true, now: new Date("2026-05-16T10:00:00Z"), mcpExec: execThrows });
    expect(r.mode).toBe("apply");
    return { left: commandsOf(preToolUse(settingsPath)) };
  }

  it("the bare line (a settings file an earlier release wrote)", async () => {
    expect((await uninstallWith([BARE])).left).toEqual(["/usr/local/bin/foreign-hook"]);
  });

  it("the guarded line (a settings file this release wrote)", async () => {
    expect((await uninstallWith([GUARDED])).left).toEqual(["/usr/local/bin/foreign-hook"]);
  });

  it("both at once, and the codex-flavoured spellings", async () => {
    expect((await uninstallWith([BARE, GUARDED, BARE_CODEX, GUARDED_CODEX])).left).toEqual(["/usr/local/bin/foreign-hook"]);
  });

  it("a line that only looks like the guard is foreign and stays", async () => {
    const lookalike = `${GUARDED}; echo extra`;
    expect((await uninstallWith([lookalike])).left).toEqual(["/usr/local/bin/foreign-hook", lookalike]);
  });
});

describe("harness gate enable after an apply upgraded the line while the gate was off", () => {
  function disableGate(settingsPath: string): void {
    const r = gateDisable({ settingsPath, matcher: "Write|Edit", now: new Date("2026-05-16T10:00:00Z") });
    expect(r.mode).toBe("remove");
  }

  it("takes the guarded group the apply wrote as the snapshot's bare group already back (no refusal, nothing spliced in twice)", () => {
    const settingsPath = claudeSettings([{ matcher: "Write|Edit", hooks: [{ type: "command", command: BARE, timeout: 5 }] }]);
    disableGate(settingsPath);
    // `harness apply --target --merge` while the gate is off.
    claudeSettings([{ matcher: "Write|Edit", hooks: [{ type: "command", command: GUARDED, timeout: 5 }] }]);
    const r = gateEnable({ settingsPath });
    expect(r.mode).toBe("already-restored");
    if (r.mode !== "already-restored") return;
    expect(r.alreadyBack).toHaveLength(1);
    expect(commandsOf(preToolUse(settingsPath))).toEqual([GUARDED]);
  });

  it("still refuses a group in the same slot that runs something else", () => {
    const settingsPath = claudeSettings([{ matcher: "Write|Edit", hooks: [{ type: "command", command: BARE, timeout: 5 }] }]);
    disableGate(settingsPath);
    claudeSettings([{ matcher: "Write|Edit", hooks: [{ type: "command", command: "/usr/local/bin/other-write-hook", timeout: 5 }] }]);
    expect(() => gateEnable({ settingsPath })).toThrow(GateEnableError);
  });
});
