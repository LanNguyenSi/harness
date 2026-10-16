import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCodexConfig } from "../../../src/cli/apply/generate-codex-config.js";
import {
  planCodexConfigInstall,
  writeCodexConfigInstall,
} from "../../../src/cli/apply/install-codex-config.js";
import { EX_FAIL, EX_OK, EX_USAGE } from "../../../src/cli/exit-codes.js";
import { run } from "../../../src/cli/index.js";
import { parseManifest } from "../../../src/schema/index.js";

let tmp: string;
let configPath: string;
let settingsPath: string;

async function gate(...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv: ["gate", ...argv],
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, code };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-codex-gate-cli-"));
  configPath = path.join(tmp, "config.toml");
  settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(configPath, 'model = "gpt-5.5"\n');
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
  writeCodexConfigInstall(
    planCodexConfigInstall({
      configPath,
      generatedPath: "/gen/codex/config.toml",
      generatedContent: generated.content,
    }),
    { now: new Date("2026-10-01T00:00:00.000Z") },
  );
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "claude-gate" }] }] } }, null, 2)}\n`,
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("harness gate --runtime codex", () => {
  it("lists, disables and re-enables the Codex block through the CLI", async () => {
    const original = fs.readFileSync(configPath, "utf8");

    const list = await gate("disable", "--runtime", "codex", "--config", configPath);
    expect(list.code).toBe(EX_OK);
    expect(list.stdout).toContain(`candidate hook units in ${configPath}:`);
    expect(list.stdout).toContain('PreToolUse[0] matcher="apply_patch": harness pack hook branch-protection --runtime codex');
    expect(list.stdout).toContain("harness gate enable --runtime codex");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    const off = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    expect(off.code).toBe(EX_OK);
    expect(off.stdout).toContain(`disabled 1 hook unit(s) in ${configPath}:`);
    expect(off.stdout).toContain('PreToolUse[0] matcher="apply_patch"');
    expect(off.stdout).toContain("harness gate enable --runtime codex");
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("branch-protection");

    const on = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain(`restored 1 hook unit(s) into ${configPath}`);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    const again = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(again.code).toBe(EX_OK);
    expect(again.stdout).toContain("Codex config already matches the pre-disable state");
  });

  it("exits non-zero with the reason and writes nothing when no unit matches", async () => {
    const original = fs.readFileSync(configPath, "utf8");
    const r = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "nope");
    expect(r.code).toBe(EX_FAIL);
    expect(r.stderr).toContain("no hook units matched");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.readdirSync(tmp).sort()).toEqual(
      ["config.toml", "config.toml.harness-backup-2026-10-01T00-00-00-000Z", "settings.json"].sort(),
    );
  });

  it("reports nothing to restore when no Codex snapshot exists", async () => {
    const missing = path.join(tmp, "absent.toml");
    const none = await gate("enable", "--runtime", "codex", "--config", missing);
    expect(none.code).toBe(EX_OK);
    expect(none.stdout).toContain("nothing to restore");
  });

  it("rejects an unknown runtime and a path flag that belongs to the other runtime", async () => {
    const unknown = await gate("disable", "--runtime", "opencode");
    expect(unknown.code).toBe(EX_USAGE);
    expect(unknown.stderr).toContain('unknown --runtime "opencode"; expected claude or codex');

    const wrongSettings = await gate("disable", "--runtime", "codex", "--settings", settingsPath);
    expect(wrongSettings.code).toBe(EX_USAGE);
    expect(wrongSettings.stderr).toContain("--settings only applies to --runtime claude");

    const wrongConfig = await gate("enable", "--config", configPath);
    expect(wrongConfig.code).toBe(EX_USAGE);
    expect(wrongConfig.stderr).toContain("--config only applies to --runtime codex");
  });
});

describe("harness gate without --runtime, and with --runtime claude, behave as before", () => {
  for (const flags of [[], ["--runtime", "claude"]]) {
    it(`edits settings.json (${flags.join(" ") || "no flag"}) and never touches the Codex config`, async () => {
      const codexBefore = fs.readFileSync(configPath, "utf8");
      const list = await gate("disable", ...flags, "--settings", settingsPath);
      expect(list.code).toBe(EX_OK);
      expect(list.stdout).toContain(`candidate hook groups in ${settingsPath}:`);
      expect(list.stdout).toContain('PreToolUse[0] matcher="Edit|Write": claude-gate');
      expect(list.stdout).toContain(
        "Pass --matcher <substring> to remove a group. Removal is reversible via `harness gate enable`.",
      );

      const off = await gate("disable", ...flags, "--settings", settingsPath, "--matcher", "Edit");
      expect(off.code).toBe(EX_OK);
      expect(off.stdout).toContain(`disabled 1 hook group(s) in ${settingsPath}:`);
      expect(off.stdout).toContain('PreToolUse[0] matcher="Edit|Write"');
      expect(off.stdout).toContain("This is reversible: run `harness gate enable` to restore.");
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({});

      const on = await gate("enable", ...flags, "--settings", settingsPath);
      expect(on.code).toBe(EX_OK);
      expect(on.stdout).toContain(`restored 1 hook group(s) into ${settingsPath} from `);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.PreToolUse).toHaveLength(1);
      expect(fs.readFileSync(configPath, "utf8")).toBe(codexBefore);
    });
  }
});
