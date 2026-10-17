import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultCodexConfigPath,
  planCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { codexGateDisable } from "../../../src/cli/gate/codex-disable.js";
import { codexGateEnable } from "../../../src/cli/gate/codex-enable.js";
import { gateDisable } from "../../../src/cli/gate/disable.js";
import { gateEnable } from "../../../src/cli/gate/enable.js";

// The default Codex config (`<home>/.codex/config.toml`) and the default Claude settings
// (`<home>/.claude/settings.json`) are built by folding the home spelling lexically. A home
// spelled `<dir>/home/in/..`, where `in` is a link to a directory elsewhere, therefore names
// `<dir>/home`, not the parent of the link's target. Codex and Claude Code both read the lexical
// location, so a default that resolved `..` through the link would write to a different file.

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

  it("codex gate disable and enable name the lexical config", () => {
    // The config holds no managed block, so both refuse; the refusal names the config they resolved.
    const lexical = path.join(lexicalHome, ".codex", "config.toml");
    for (const call of [() => codexGateDisable({ homeDir: spelledHome }), () => codexGateEnable({ homeDir: spelledHome })]) {
      let named = "";
      try {
        named = call().configPath;
      } catch (err) {
        named = (err as Error).message;
      }
      expect(named).toContain(lexical);
      expect(named).not.toContain(kernelHome);
    }
  });

  it("claude gate disable lists the lexical settings.json", () => {
    const r = gateDisable({ homeDir: spelledHome });
    expect(r.settingsPath).toBe(path.join(lexicalHome, ".claude", "settings.json"));
  });

  it("claude gate enable resolves the lexical settings.json", () => {
    let reported = "";
    try {
      const r = gateEnable({ homeDir: spelledHome });
      reported = r.settingsPath;
    } catch (err) {
      reported = (err as Error).message;
    }
    expect(reported).toContain(path.join(lexicalHome, ".claude", "settings.json"));
    expect(reported).not.toContain(kernelHome);
  });
});
