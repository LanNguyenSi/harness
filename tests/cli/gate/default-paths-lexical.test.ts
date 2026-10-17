import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  defaultCodexConfigPath,
  planCodexConfigInstall,
  writeCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { parseManifest } from "../../../src/schema/index.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import { gateDisable } from "../../../src/cli/gate/disable.js";
import { gateEnable } from "../../../src/cli/gate/enable.js";

// The default Codex config (`<home>/.codex/config.toml`) and the default Claude settings
// (`<home>/.claude/settings.json`) are built by folding the home spelling lexically. A home
// spelled `<dir>/home/in/..`, where `in` is a link to a directory elsewhere, therefore names
// `<dir>/home`, not the parent of the link's target. Codex 0.162.1 (tested end to end with
// HOME=<dir>/home/in/..) reads <dir>/home/.codex/config.toml; Claude Code 2.1.302 computes its
// config home as path.join(os.homedir(), ".claude") (read from its bundle). Re-check after
// upgrading either runtime. A default that resolved `..` through the link would write to a
// different file.

let root: string;
let spelledHome: string;
let lexicalHome: string;
let kernelHome: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lexical-default-")));
  lexicalHome = path.join(root, "home");
  kernelHome = path.join(root, "elsewhere");
  const target = path.join(kernelHome, "deep");
  fs.mkdirSync(path.join(lexicalHome, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(lexicalHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(kernelHome, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(kernelHome, ".claude"), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, path.join(lexicalHome, "in"), "dir");
  // path.join would fold the `..`, so the spelling is built by hand.
  spelledHome = `${path.join(lexicalHome, "in")}${path.sep}..`;
  fs.writeFileSync(path.join(lexicalHome, ".codex", "config.toml"), 'model = "gpt-5.5"\n');
  fs.writeFileSync(path.join(kernelHome, ".codex", "config.toml"), 'model = "decoy"\n');
  fs.writeFileSync(path.join(lexicalHome, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(kernelHome, ".claude", "settings.json"), "{}\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("default config paths fold the home spelling lexically", () => {
  it("defaultCodexConfigPath names the lexical home, not the link target's parent", () => {
    expect(defaultCodexConfigPath(spelledHome)).toBe(path.join(lexicalHome, ".codex", "config.toml"));
  });

  it("the Codex install plan targets the lexical config", () => {
    const plan = planCodexConfigInstall({
      homeDir: spelledHome,
      generatedPath: path.join(root, "generated.toml"),
      generatedContent: "# generated\n",
    });
    expect(plan.configPath).toBe(path.join(lexicalHome, ".codex", "config.toml"));
    expect(plan.currentContent).toBe('model = "gpt-5.5"\n');
  });

  it("codex gate disable and enable act on the lexical config and leave the decoy alone", () => {
    const lexical = path.join(lexicalHome, ".codex", "config.toml");
    const decoy = path.join(kernelHome, ".codex", "config.toml");
    // Only the lexical config holds a harness-managed hook block.
    const generated = generateCodexConfig(
      parseManifest({
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
        ],
      }),
    );
    const plan = planCodexConfigInstall({
      homeDir: spelledHome,
      generatedPath: path.join(root, "generated.toml"),
      generatedContent: generated.content,
    });
    writeCodexConfigInstall(plan, { now: new Date("2026-10-01T00:00:00.000Z") });
    const installed = fs.readFileSync(lexical, "utf8");
    expect(installed).toContain("harness-managed codex hooks");
    const decoyText = fs.readFileSync(decoy, "utf8");
    const decoyDir = fs.readdirSync(path.dirname(decoy)).sort();

    const listed = codexGateDisable({ homeDir: spelledHome });
    expect(listed.mode).toBe("list");
    expect(listed.configPath).toBe(lexical);
    if (listed.mode !== "list") return;
    expect(listed.candidates.length).toBeGreaterThan(0);

    const off = codexGateDisable({ homeDir: spelledHome, matcher: "apply_patch", now: new Date("2026-10-02T00:00:00.000Z") });
    if (off.mode !== "remove") throw new Error("expected a disable");
    expect(off.configPath).toBe(lexical);
    expect(path.dirname(off.snapshotPath)).toBe(path.dirname(lexical));
    expect(fs.readFileSync(lexical, "utf8")).not.toBe(installed);

    const on = codexGateEnable({ homeDir: spelledHome, now: new Date("2026-10-03T00:00:00.000Z") });
    expect(on.mode).toBe("restored");
    expect(on.configPath).toBe(lexical);
    expect(fs.readFileSync(lexical, "utf8")).toBe(installed);

    expect(fs.readFileSync(decoy, "utf8")).toBe(decoyText);
    expect(fs.readdirSync(path.dirname(decoy)).sort()).toEqual(decoyDir);
  });

  it("claude gate disable and enable act on the lexical settings.json and leave the decoy alone", () => {
    const lexical = path.join(lexicalHome, ".claude", "settings.json");
    const decoy = path.join(kernelHome, ".claude", "settings.json");
    // Only the lexical settings hold hooks.
    const withHooks = `${JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "guard" }] }] } },
      null,
      2,
    )}\n`;
    fs.writeFileSync(lexical, withHooks);
    const decoyDir = fs.readdirSync(path.dirname(decoy)).sort();

    const listed = gateDisable({ homeDir: spelledHome });
    expect(listed.mode).toBe("list");
    expect(listed.settingsPath).toBe(lexical);
    if (listed.mode !== "list") return;
    expect(listed.candidates.length).toBeGreaterThan(0);

    const off = gateDisable({ homeDir: spelledHome, matcher: "Bash" });
    if (off.mode !== "remove") throw new Error("expected a disable");
    expect(off.settingsPath).toBe(lexical);
    expect(path.dirname(off.snapshotPath)).toBe(path.dirname(lexical));
    expect(fs.readFileSync(lexical, "utf8")).not.toBe(withHooks);

    const on = gateEnable({ homeDir: spelledHome });
    expect(on.mode).toBe("restored");
    expect(on.settingsPath).toBe(lexical);
    expect(JSON.parse(fs.readFileSync(lexical, "utf8"))).toEqual(JSON.parse(withHooks));

    expect(fs.readFileSync(decoy, "utf8")).toBe("{}\n");
    expect(fs.readdirSync(path.dirname(decoy)).sort()).toEqual(decoyDir);
  });
});
