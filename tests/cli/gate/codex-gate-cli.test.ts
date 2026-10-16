import * as crypto from "node:crypto";
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

/** Re-installs the block with two units (branch-protection on apply_patch, a shell guard on Bash). */
function installTwoUnits(): string {
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
        {
          name: "shell-guard",
          event: "PreToolUse",
          match: "Bash",
          command: "harness pack hook shell-guard --runtime codex",
          blocking: "hard",
          budget_ms: 5000,
        },
      ],
    }),
  );
  writeCodexConfigInstall(
    planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
    { now: new Date("2026-10-01T01:00:00.000Z") },
  );
  return fs.readFileSync(configPath, "utf8");
}

describe("harness gate --runtime codex", () => {
  it("lists, disables and re-enables the Codex block through the CLI", async () => {
    const original = fs.readFileSync(configPath, "utf8");

    const list = await gate("disable", "--runtime", "codex", "--config", configPath);
    expect(list.code).toBe(EX_OK);
    expect(list.stdout).toContain(`candidate hook units in ${configPath}:`);
    expect(list.stdout).toContain('PreToolUse[0] matcher="apply_patch": harness pack hook branch-protection --runtime codex');
    expect(list.stdout).toContain("harness gate enable --runtime codex");
    // Codex units are neutralised in place, so the footer never speaks of removal.
    expect(list.stdout).toContain("Pass --matcher <substring> to disable a unit (its `hooks` array is emptied in place");
    expect(list.stdout).not.toMatch(/to remove a|Removal is/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    const off = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    expect(off.code).toBe(EX_OK);
    expect(off.stdout).toContain(`disabled 1 hook unit(s) in ${configPath}:`);
    expect(off.stdout).toContain('PreToolUse[0] matcher="apply_patch"');
    expect(off.stdout).toContain("harness gate enable --runtime codex");
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("harness pack hook branch-protection");

    const on = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain(`restored 1 hook unit(s) into ${configPath}`);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    // The applied snapshot was retired, so a second enable has nothing to walk.
    const again = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(again.code).toBe(EX_OK);
    expect(again.stdout).toContain("nothing to restore");
    expect(again.stderr).toBe("");
  });

  it("lists a neutralised unit as disabled", async () => {
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const list = await gate("disable", "--runtime", "codex", "--config", configPath);
    expect(list.code).toBe(EX_OK);
    expect(list.stdout).toContain("PreToolUse[0] matcher=\"apply_patch\": policy-pack:branch-protection:pre-tool-use [disabled]");
  });

  it("refuses a second disable of the same unit with a non-zero exit and writes nothing", async () => {
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const disabled = fs.readFileSync(configPath, "utf8");
    const again = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    expect(again.code).toBe(EX_FAIL);
    expect(again.stderr).toContain("already disabled");
    expect(fs.readFileSync(configPath, "utf8")).toBe(disabled);
  });

  it("one enable restores two disables through one merged snapshot; a unit no snapshot covers exits non-zero and is named", async () => {
    const original = fs.readFileSync(configPath, "utf8");
    const installed = installTwoUnits();
    expect(installed).not.toBe(original);

    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const second = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    expect(second.code).toBe(EX_OK);
    const snaps = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    expect(snaps).toHaveLength(1);
    expect(second.stdout).toContain(`snapshot: ${path.join(tmp, snaps[0]!)}`);
    const on = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("restored 2 hook unit(s)");
    expect(fs.readFileSync(configPath, "utf8")).toBe(installed);
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex.") && !n.includes(".restored."))).toEqual([]);

    // A unit neutralised by hand beyond the snapshot: enable restores the snapshot's unit and says the other stays off.
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace(/^hooks = \[\{.*shell-guard.*\}\]$/m, "hooks = []"));
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const partial = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(partial.code).toBe(EX_FAIL);
    expect(partial.stdout).toContain("restored 1 hook unit(s)");
    expect(partial.stderr).toContain("1 hook unit(s)");
    expect(partial.stderr).toContain("are still disabled: shell-guard");
    expect(partial.stderr).toContain("No Codex gate snapshot restores them.");
    expect(partial.stderr).not.toContain("--force");
    const stuck = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(stuck.code).toBe(EX_FAIL);
    expect(stuck.stdout).not.toContain("no write needed");
    expect(stuck.stderr).toContain("are still disabled");
  });

  it("says what --force does: the edited-since refusal, and that a forced restore keeps the edit and retires the snapshot", async () => {
    const installed = installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const edit = "\n[tui]\nnotifications = true\n";
    fs.appendFileSync(configPath, edit);

    const refused = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(refused.code).toBe(EX_FAIL);
    expect(refused.stderr).toContain("edited since the snapshot was taken");
    expect(refused.stderr).toContain(
      "--force restores every unit the snapshot names that is still neutralised (found by id), leaves a unit that is enabled again as it is, keeps every other edit and retires the snapshot",
    );
    expect(refused.stderr).not.toContain("overwrite");

    // A second disable cannot join a snapshot the file no longer matches.
    const blocked = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    expect(blocked.code).toBe(EX_FAIL);
    expect(blocked.stderr).toContain("cannot join it");
    expect(blocked.stderr).toContain("harness gate enable --runtime codex --force");

    const forced = await gate("enable", "--runtime", "codex", "--config", configPath, "--force");
    expect(forced.code).toBe(EX_OK);
    expect(forced.stdout).toContain("restored 1 hook unit(s)");
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${installed}${edit}`);
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex.") && !n.includes(".restored."))).toEqual([]);
  });

  /** Rebuilds what an earlier build wrote for two disables: one live snapshot each (apply_patch first, then Bash). */
  async function legacyPair(): Promise<{ installed: string; first: string }> {
    const installed = installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const [first] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    const afterFirst = fs.readFileSync(configPath, "utf8");
    const firstBody = fs.readFileSync(path.join(tmp, first!), "utf8");
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    const merged = JSON.parse(fs.readFileSync(path.join(tmp, first!), "utf8"));
    fs.writeFileSync(path.join(tmp, first!), firstBody);
    fs.writeFileSync(
      path.join(tmp, first!.replace(/\d{4}-\d\d-\d\dT[\d.-]+Z/, "2999-01-01T00-00-00.000Z")),
      JSON.stringify({
        ...merged,
        createdAt: "2999-01-01T00:00:00.000Z",
        configBeforeSha256: crypto.createHash("sha256").update(afterFirst).digest("hex"),
        neutralised: merged.neutralised.slice(1),
      }),
    );
    return { installed, first: path.join(tmp, first!) };
  }

  it("exits non-zero and names how many live snapshots remain when an earlier build left several", async () => {
    const { installed, first } = await legacyPair();
    const one = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(one.code).toBe(EX_FAIL);
    expect(one.stdout).toContain("restored 1 hook unit(s)");
    expect(one.stderr).toContain("are still disabled: policy-pack:branch-protection:pre-tool-use");
    expect(one.stderr).toContain("1 more live Codex gate snapshot(s) remain");
    expect(one.stderr).toContain(first);
    expect(one.stderr).not.toContain("No Codex gate snapshot restores them");
    const two = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(two.code).toBe(EX_OK);
    expect(fs.readFileSync(configPath, "utf8")).toBe(installed);
  });

  it("still exits non-zero for a remaining live snapshot when no unit is disabled any more", async () => {
    const { installed, first } = await legacyPair();
    fs.writeFileSync(configPath, installed);
    const one = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(one.code).toBe(EX_FAIL);
    expect(one.stderr).toContain("1 more live Codex gate snapshot(s) remain");
    expect(one.stderr).toContain(first);
    expect(one.stderr).not.toContain("still disabled");
    const two = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(two.code).toBe(EX_OK);
    expect(fs.readFileSync(configPath, "utf8")).toBe(installed);
  });

  /** The branch-protection unit's own `hooks = [...]` line replaced by the neutralised one, as a hand edit would. */
  function neutraliseFirstUnit(): void {
    const text = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(configPath, text.replace(/^hooks = \[\{.*\}\]$/m, "hooks = []"));
  }

  function reinstallAt(now: Date): void {
    const generated = generateCodexConfig(
      parseManifest({
        version: 1,
        hooks: [
          {
            name: "policy-pack:branch-protection:pre-tool-use",
            event: "PreToolUse",
            match: "apply_patch",
            command: "harness pack hook branch-protection --runtime codex --v2",
            blocking: "hard",
            budget_ms: 5000,
          },
        ],
      }),
    );
    writeCodexConfigInstall(
      planCodexConfigInstall({ configPath, generatedPath: "/gen/codex/config.toml", generatedContent: generated.content }),
      { now },
    );
  }

  it("prints the retired-as-superseded line naming the install backup, and exits non-zero while the unit stays off", async () => {
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const [snap] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    reinstallAt(new Date("2099-01-01T00:00:00.000Z"));
    neutraliseFirstUnit();
    const r = await gate("enable", "--runtime", "codex", "--config", configPath);
    const backup = `${configPath}.harness-backup-2099-01-01T00-00-00-000Z`;
    expect(r.code).toBe(EX_FAIL);
    expect(r.stdout).toContain(
      `retired ${path.join(tmp, snap!)} as ${path.join(tmp, snap!.replace(/\.json$/, ".superseded.json"))}: ` +
        `a later install (${backup}) re-rendered its units.`,
    );
    expect(r.stderr).toContain("are still disabled: policy-pack:branch-protection:pre-tool-use");
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("harness pack hook branch-protection --runtime codex\"");
    expect(fs.readdirSync(tmp)).toContain(snap!.replace(/\.json$/, ".superseded.json"));
  });

  it("recovers a merged snapshot whose config lost one unit's neutralisation by hand: enable restores the other and says which it left alone", async () => {
    const installed = installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const afterFirst = fs.readFileSync(configPath, "utf8");
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    // The config is back at the state after the first disable (a crash before the second rewrite).
    fs.writeFileSync(configPath, afterFirst);
    const blocked = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    expect(blocked.code).toBe(EX_FAIL);
    expect(blocked.stderr).toContain("harness gate enable --runtime codex --force");
    const on = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("restored 1 hook unit(s)");
    expect(on.stdout).toContain("left as they are: shell-guard (already enabled again).");
    expect(fs.readFileSync(configPath, "utf8")).toBe(installed);
  });

  it("exits non-zero and names the unit that stays off when the snapshot's own unit is back and another was neutralised by hand", async () => {
    installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const [snap] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    const body = JSON.parse(fs.readFileSync(path.join(tmp, snap!), "utf8"));
    // The snapshot's unit goes back by hand; the shell guard, which no snapshot names, is neutralised by hand.
    let text = fs.readFileSync(configPath, "utf8").replace("hooks = []", body.neutralised[0].hooksText);
    text = text.replace(/^hooks = \[\{.*shell-guard.*\}\]$/m, "hooks = []");
    fs.writeFileSync(configPath, text);
    const r = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(r.code).toBe(EX_FAIL);
    expect(r.stdout).toContain("its units were enabled again.");
    expect(r.stderr).toContain("are still disabled: shell-guard");
    expect(fs.readFileSync(configPath, "utf8")).toBe(text);
    expect(fs.readdirSync(tmp)).toContain(snap!.replace(/\.json$/, ".superseded.json"));
  });

  it("a disable that retires a spent snapshot says so and starts a fresh one", async () => {
    installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const [snap] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    reinstallAt(new Date("2099-01-01T00:00:00.000Z"));
    const r = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    expect(r.code).toBe(EX_OK);
    expect(r.stdout).toContain(
      `retired ${path.join(tmp, snap!)} as ${path.join(tmp, snap!.replace(/\.json$/, ".superseded.json"))}: a later install ` +
        `(${configPath}.harness-backup-2099-01-01T00-00-00-000Z) re-rendered its units; this disable starts a fresh snapshot.`,
    );
    const live = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex.") && !n.includes(".superseded."));
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(snap);
  });

  it("a disable that retires a snapshot with nothing left to restore names no install", async () => {
    const installed = installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    fs.writeFileSync(configPath, installed);
    const r = await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    expect(r.code).toBe(EX_OK);
    expect(r.stdout).toContain(": it had nothing left to restore; this disable starts a fresh snapshot.");
    expect(r.stdout).not.toContain("a later install");
  });

  it("exits non-zero and names a unit that was deleted from the block, keeping its snapshot live", async () => {
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const [snap] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    const text = fs.readFileSync(configPath, "utf8");
    const begin = text.indexOf("# harness hook:");
    const end = text.indexOf("# END harness-managed codex hooks");
    fs.writeFileSync(configPath, `${text.slice(0, begin)}${text.slice(end)}`);
    const r = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(r.code).toBe(EX_FAIL);
    expect(r.stdout).not.toContain("no write needed");
    expect(r.stderr).toContain("missing from the harness-managed block");
    expect(r.stderr).toContain("policy-pack:branch-protection:pre-tool-use");
    expect(r.stderr).toContain(`The snapshot ${path.join(tmp, snap!)} stays live`);
    expect(fs.readdirSync(tmp)).toContain(snap);
  });

  it("names the ways out, never --force, when a merged snapshot's unit was deleted while another is still off; a re-install then clears it", async () => {
    installTwoUnits();
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "Bash");
    const text = fs.readFileSync(configPath, "utf8");
    const begin = text.indexOf("# harness hook: shell-guard");
    fs.writeFileSync(configPath, `${text.slice(0, begin)}${text.slice(text.indexOf("# END harness-managed codex hooks"))}`);
    for (const extra of [[], ["--force"]]) {
      const r = await gate("enable", "--runtime", "codex", "--config", configPath, ...extra);
      expect(r.code).toBe(EX_FAIL);
      expect(r.stderr).toContain('the hook unit "shell-guard" of the snapshot');
      expect(r.stderr).toContain("Ways out: run `harness apply --runtime codex --install`");
      expect(r.stderr).not.toContain("--force");
    }
    reinstallAt(new Date("2099-01-01T00:00:00.000Z"));
    const on = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("re-rendered its units.");
  });

  it("exits non-zero with the restored-but-cannot-retire message when the retired name is taken by a directory", async () => {
    const original = fs.readFileSync(configPath, "utf8");
    await gate("disable", "--runtime", "codex", "--config", configPath, "--matcher", "apply_patch");
    const [snap] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    const taken = path.join(tmp, snap!.replace(/\.json$/, ".restored.json"));
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, "keep"), "");
    const r = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(r.code).toBe(EX_FAIL);
    expect(r.stderr).toContain("restored 1 hook unit(s) into");
    expect(r.stderr).toContain("but cannot retire the snapshot");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("names a snapshot taken for another config in the same directory and skips it", async () => {
    const other = path.join(tmp, "other.toml");
    fs.copyFileSync(configPath, other);
    await gate("disable", "--runtime", "codex", "--config", other, "--matcher", "apply_patch");
    const [foreign] = fs.readdirSync(tmp).filter((n) => n.startsWith("harness.gate-disable-codex."));
    const r = await gate("enable", "--runtime", "codex", "--config", configPath);
    expect(r.code).toBe(EX_OK);
    expect(r.stdout).toContain(`skipped ${path.join(tmp, foreign!)}: taken for another config.`);
    expect(fs.readdirSync(tmp)).toContain(foreign);
  });

  it("exits non-zero for a missing config, a config without a block and a duplicate BEGIN marker", async () => {
    const missing = await gate("disable", "--runtime", "codex", "--config", path.join(tmp, "absent.toml"), "--matcher", "x");
    expect(missing.code).toBe(EX_FAIL);
    expect(missing.stderr).toContain("Codex config not found");

    const plain = path.join(tmp, "plain.toml");
    fs.writeFileSync(plain, 'model = "gpt-5.5"\n');
    const noBlock = await gate("disable", "--runtime", "codex", "--config", plain, "--matcher", "x");
    expect(noBlock.code).toBe(EX_FAIL);
    expect(noBlock.stderr).toContain("no harness-managed Codex hook block");
    expect(fs.readFileSync(plain, "utf8")).toBe('model = "gpt-5.5"\n');

    const twice = path.join(tmp, "twice.toml");
    fs.writeFileSync(twice, `${fs.readFileSync(configPath, "utf8")}\n# BEGIN harness-managed codex hooks\n`);
    const before = fs.readFileSync(twice, "utf8");
    const dup = await gate("disable", "--runtime", "codex", "--config", twice, "--matcher", "apply_patch");
    expect(dup.code).toBe(EX_FAIL);
    expect(dup.stderr).toContain("more than one");
    expect(fs.readFileSync(twice, "utf8")).toBe(before);
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
