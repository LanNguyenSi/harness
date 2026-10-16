import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EX_FAIL, EX_OK } from "../../../src/cli/exit-codes.js";
import { run } from "../../../src/cli/index.js";
import {
  liveSnapshotNames,
  retiredSnapshotNames,
  writeLegacyChain,
} from "../../_helpers/claude-gate-legacy.js";

let tmp: string;
let settingsPath: string;

/** Whether the temp directory's filesystem folds the case of names (APFS and HFS+ by default). */
function caseInsensitiveFs(): boolean {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-claude-gate-case-"));
  try {
    fs.writeFileSync(path.join(dir, "probe.json"), "{}");
    return fs.existsSync(path.join(dir, "PROBE.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function gate(...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return gateOn(settingsPath, ...argv);
}

/** Runs a gate verb with `--settings file`. */
async function gateOn(file: string, ...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv: ["gate", ...argv, "--settings", file],
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, code };
}

function groups(): string[] {
  const hooks = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, Array<{ matcher: string }>> }).hooks;
  return (hooks?.["PreToolUse"] ?? []).map((g) => g.matcher);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-claude-gate-cli-"));
  settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] },
            { matcher: "Bash", hooks: [{ command: "bash-hook" }] },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("harness gate (claude): one live snapshot", () => {
  it("two disables are merged into one snapshot and one enable restores both and exits 0", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    const a = await gate("disable", "--matcher", "Write|Edit");
    expect(a.code).toBe(EX_OK);
    expect(a.stdout).not.toContain("merged into");
    const b = await gate("disable", "--matcher", "Bash");
    expect(b.code).toBe(EX_OK);
    expect(b.stdout).toContain("merged into the snapshot that was already live");
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);

    const on = await gate("enable");
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("restored 2 hook group(s)");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(retiredSnapshotNames(settingsPath)).toHaveLength(1);

    const again = await gate("enable");
    expect(again.code).toBe(EX_OK);
    expect(again.stdout).toContain("nothing to restore");
  });

  it("exits non-zero while a version 1 snapshot is still live and names how many remain", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    writeLegacyChain(
      settingsPath,
      { matcher: "Write|Edit", now: new Date("2026-01-01T00:00:01.000Z") },
      { matcher: "Bash", now: new Date("2026-01-01T00:00:02.000Z") },
    );
    const one = await gate("enable");
    expect(one.code).toBe(EX_FAIL);
    expect(one.stdout).toContain("restored 1 hook group(s)");
    expect(one.stderr).toContain("1 more gate snapshot(s) are still live");
    expect(one.stderr).toContain("run `harness gate enable` again");
    expect(groups()).toEqual(["Bash"]);

    const two = await gate("enable");
    expect(two.code).toBe(EX_OK);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("exits non-zero and names the leftover when the newest snapshot only needed retiring", async () => {
    writeLegacyChain(
      settingsPath,
      { matcher: "Write|Edit", now: new Date("2026-01-01T00:00:01.000Z") },
      { matcher: "Bash", now: new Date("2026-01-01T00:00:02.000Z") },
    );
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "bash-hook" }] }] } }, null, 2)}\n`,
    );
    const one = await gate("enable");
    expect(one.code).toBe(EX_FAIL);
    expect(one.stdout).toContain("already matches the pre-disable state");
    expect(one.stderr).toContain("1 more gate snapshot(s) are still live");
  });
});

describe("harness gate (claude): which file a snapshot belongs to", () => {
  async function runIn(cwd: string, ...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const before = process.cwd();
    let stdout = "";
    let stderr = "";
    try {
      process.chdir(cwd);
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
    } finally {
      process.chdir(before);
    }
  }

  it("a disable with a relative --settings is restored by an enable from another directory", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-claude-gate-cwd-"));
    try {
      const off = await runIn(tmp, "disable", "--matcher", "Write|Edit", "--settings", "settings.json");
      expect(off.code).toBe(EX_OK);
      expect(groups()).toEqual(["Bash"]);

      const on = await runIn(other, "enable", "--settings", settingsPath);
      expect(on.code).toBe(EX_OK);
      expect(on.stdout).toContain("restored 1 hook group(s)");
      expect(on.stdout).not.toContain("nothing to restore");
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
      expect(liveSnapshotNames(settingsPath)).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("a disable through a symlinked settings directory is restored through the real path", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    const linkParent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-claude-gate-link-"));
    const link = path.join(linkParent, "claude");
    try {
      fs.symlinkSync(tmp, link);
      const off = await runIn(linkParent, "disable", "--matcher", "Write|Edit", "--settings", path.join(link, "settings.json"));
      expect(off.code).toBe(EX_OK);
      const on = await gate("enable");
      expect(on.code).toBe(EX_OK);
      expect(on.stdout).toContain("restored 1 hook group(s)");
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("exits non-zero while a snapshot taken for another settings file beside it is live, naming the --settings that restores it", async () => {
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, null, 2)}\n`);
    const off = await gateOn(other, "disable", "--matcher", "Bash");
    expect(off.code).toBe(EX_OK);
    const [snap] = liveSnapshotNames(settingsPath);
    const on = await gate("enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stdout).not.toContain("nothing to restore");
    expect(on.stderr).toContain(`${path.join(tmp, snap ?? "")}: run \`harness gate enable --settings ${other}\``);
    expect(on.stderr).toContain("taken for another settings file");
    expect(on.stderr).not.toContain("rename it back");

    // The way out named there works, and then the directory is clean.
    expect((await gateOn(other, "enable")).code).toBe(EX_OK);
    const clean = await gate("enable");
    expect(clean.code).toBe(EX_OK);
    expect(clean.stdout).toContain("nothing to restore");
  });

  it("restores its own snapshot and still exits non-zero while another file's snapshot beside it is live", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, null, 2)}\n`);
    expect((await gateOn(other, "disable", "--matcher", "Bash")).code).toBe(EX_OK);
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    const on = await gate("enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stdout).toContain("restored 1 hook group(s)");
    expect(on.stderr).toContain(`harness gate enable --settings ${other}`);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("names another file's live snapshot also when its own older snapshots are still live", async () => {
    writeLegacyChain(
      settingsPath,
      { matcher: "Write|Edit", now: new Date("2026-01-01T00:00:01.000Z") },
      { matcher: "Bash", now: new Date("2026-01-01T00:00:02.000Z") },
    );
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Task", hooks: [{ command: "t" }] }] } }, null, 2)}\n`);
    expect((await gateOn(other, "disable", "--matcher", "Task")).code).toBe(EX_OK);
    const one = await gate("enable");
    expect(one.code).toBe(EX_FAIL);
    expect(one.stderr).toContain("run `harness gate enable` again.");
    expect(one.stderr).toContain(`harness gate enable --settings ${other}`);
  });

  it("an enable for a file of another name exits non-zero and names the --settings of the file the snapshot was taken for", async () => {
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    const on = await gateOn(path.join(tmp, "settings.local.json"), "enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stdout).not.toContain("nothing to restore");
    expect(on.stderr).toContain(`harness gate enable --settings ${settingsPath}`);
    expect((await gate("enable")).code).toBe(EX_OK);
    expect(groups()).toEqual(["Write|Edit", "Bash"]);
  });

  it("a settings file renamed after the disable: enable names the recorded name and says to rename it back", async () => {
    const original = fs.readFileSync(settingsPath, "utf8");
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    const renamed = path.join(tmp, "settings.renamed.json");
    fs.renameSync(settingsPath, renamed);
    const on = await gateOn(renamed, "enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stdout).not.toContain("nothing to restore");
    expect(on.stderr).toContain(`harness gate enable --settings ${settingsPath}`);
    expect(on.stderr).toContain("if the settings file was renamed after the disable, rename it back first");
    // When the file is gone for good: the backup is the file before the disable, and the snapshot can be moved aside.
    expect(on.stderr).toContain(`if it is gone, restore it from ${settingsPath}.bak.`);
    expect(on.stderr).toContain("then run that command, which retires the snapshot; or move the snapshot out of the directory by hand");
    fs.renameSync(renamed, settingsPath);
    expect((await gate("enable")).code).toBe(EX_OK);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  /**
   * The harmful direction: a restore through another name of the file would
   * write a new file at that name (the atomic write renames a temp file into
   * place, which detaches a hard link and replaces a symlink), retire the
   * snapshot and exit 0, while the recorded file keeps the group removed.
   */
  async function enableThroughAliasRefuses(alias: string, makeAlias: () => void): Promise<void> {
    const original = fs.readFileSync(settingsPath, "utf8");
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    const disabled = fs.readFileSync(settingsPath, "utf8");
    const [snap] = liveSnapshotNames(settingsPath);
    // The alias is made after the disable: the disable's own atomic write would detach an earlier hard link.
    makeAlias();

    const viaAlias = await gateOn(alias, "enable");
    expect(viaAlias.code).toBe(EX_FAIL);
    expect(viaAlias.stdout).toBe("");
    expect(viaAlias.stderr).toContain(`${path.join(tmp, snap ?? "")}: run \`harness gate enable --settings ${settingsPath}\``);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(disabled);
    expect(fs.readFileSync(alias, "utf8")).toBe(disabled);
    expect(liveSnapshotNames(settingsPath)).toEqual([snap]);
    expect(retiredSnapshotNames(settingsPath)).toEqual([]);
    // --force does not get past identity either.
    expect((await gateOn(alias, "enable", "--force")).code).toBe(EX_FAIL);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(disabled);

    // The named command restores the recorded file, and only then does anything exit 0.
    const on = await gate("enable");
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("restored 1 hook group(s)");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  }

  it("an enable through a hard link to the settings file refuses and names the recorded file; nothing exits 0 while it lacks the group", async () => {
    const alias = path.join(tmp, "alias.json");
    await enableThroughAliasRefuses(alias, () => fs.linkSync(settingsPath, alias));
  });

  it("an enable through a symlink to the settings file refuses and names the recorded file; nothing exits 0 while it lacks the group", async () => {
    const alias = path.join(tmp, "alias.json");
    await enableThroughAliasRefuses(alias, () => fs.symlinkSync(settingsPath, alias));
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it("a snapshot recorded under a hard link's name is the link's: the file's enable refuses, the link's restores it", async () => {
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    const [name] = liveSnapshotNames(settingsPath);
    const snapFile = path.join(tmp, name ?? "");
    const snap = JSON.parse(fs.readFileSync(snapFile, "utf8")) as Record<string, unknown>;
    const alias = path.join(tmp, "alias.json");
    snap["settingsPath"] = alias;
    fs.writeFileSync(snapFile, `${JSON.stringify(snap, null, 2)}\n`);
    fs.linkSync(settingsPath, alias);
    const on = await gate("enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stdout).not.toContain("nothing to restore");
    expect(on.stderr).toContain(`run \`harness gate enable --settings ${alias}\``);
    expect(groups()).toEqual(["Bash"]);
    const viaAlias = await gateOn(alias, "enable");
    expect(viaAlias.code).toBe(EX_OK);
    expect(viaAlias.stdout).toContain("restored 1 hook group(s)");
    expect((JSON.parse(fs.readFileSync(alias, "utf8")) as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks.PreToolUse.map((g) => g.matcher)).toEqual(["Write|Edit", "Bash"]);
  });

  it.skipIf(!caseInsensitiveFs())(
    "a disable through another spelling of the name on a case-insensitive filesystem is restored by the usual spelling",
    async () => {
      const original = fs.readFileSync(settingsPath, "utf8");
      expect((await gateOn(path.join(tmp, "Settings.json"), "disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
      const on = await gate("enable");
      expect(on.code).toBe(EX_OK);
      expect(on.stdout).toContain("restored 1 hook group(s)");
      expect(on.stdout).not.toContain("nothing to restore");
      expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
      expect(liveSnapshotNames(settingsPath)).toEqual([]);
    },
  );
});

describe("harness gate (claude): spent and stale snapshots", () => {
  it("a disable refuses with a non-zero exit and names enable --force while a removed group is still missing", async () => {
    await gate("disable", "--matcher", "Write|Edit");
    await gate("disable", "--matcher", "Bash");
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "by-hand" }] }, { matcher: "Task", hooks: [{ command: "t" }] }] } }, null, 2)}\n`,
    );
    const before = fs.readFileSync(settingsPath, "utf8");
    const refused = await gate("disable", "--matcher", "Task");
    expect(refused.code).toBe(EX_FAIL);
    expect(refused.stderr).toContain("harness gate enable --force");
    expect(refused.stderr).toContain('still missing (PreToolUse matcher="Write|Edit" running `branch-protection`)');
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);

    const forced = await gate("enable", "--force");
    expect(forced.code).toBe(EX_OK);
    expect(forced.stdout).toContain("restored 1 hook group(s)");
    expect(forced.stdout).toContain(
      'taken as back under --force, not put back (same event and matcher, other content): PreToolUse matcher="Bash": ' +
        "the snapshot's group runs `bash-hook`, the file's group runs `by-hand`.",
    );
    expect(groups()).toEqual(["Write|Edit", "Bash", "Task"]);
    const again = await gate("enable", "--force");
    expect(again.code).toBe(EX_OK);
    expect(again.stdout).toContain("nothing to restore");
    expect(groups()).toEqual(["Write|Edit", "Bash", "Task"]);
  });

  it("a disable that finds the live snapshot spent says it retired it", async () => {
    await gate("disable", "--matcher", "Write|Edit");
    const [snap] = liveSnapshotNames(settingsPath);
    const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] }; model?: string };
    edited.hooks.PreToolUse.unshift({ matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] });
    edited.model = "x";
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const off = await gate("disable", "--matcher", "Bash");
    expect(off.code).toBe(EX_OK);
    expect(off.stdout).toContain(`retired a spent snapshot as ${path.join(tmp, (snap ?? "").replace(/\.json$/, ".restored.json"))}`);
    expect(off.stdout).not.toContain("merged into");
  });

  it("an enable that finds every group already back retires the snapshot and says so", async () => {
    await gate("disable", "--matcher", "Write|Edit");
    const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] }; model?: string };
    edited.hooks.PreToolUse.unshift({ matcher: "Write|Edit", hooks: [{ command: "branch-protection" }] });
    edited.model = "x";
    fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const on = await gate("enable");
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("already holds every hook group the snapshot removed; no write needed");
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("an unreadable live snapshot makes enable fail with a way forward", async () => {
    const bad = path.join(tmp, "harness.gate-disable.2026-01-01T00-00-00.000Z.json");
    fs.writeFileSync(bad, "{ broken");
    const on = await gate("enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stderr).toContain(`Move ${bad} aside`);
  });
});

describe("harness gate (claude): a group that only shares the gate's event and matcher", () => {
  const command = (c: string) => ({ type: "command", command: c });
  const gateGroup = { matcher: "Write|Edit", hooks: [command("harness pack hook branch-protection")] };
  const logger = { matcher: "Bash", hooks: [command("logger")] };
  const formatter = { matcher: "Write|Edit", hooks: [command("some-formatter-guard")] };
  const own = { matcher: "Write|Edit", hooks: [command("my-secret-guard")] };

  function write(obj: Record<string, unknown>): string {
    fs.writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
    return fs.readFileSync(settingsPath, "utf8");
  }

  function addGroup(group: unknown): string {
    const obj = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks: { PreToolUse: unknown[] } };
    obj.hooks.PreToolUse.push(group);
    return write(obj);
  }

  function commands(): string[] {
    const hooks = (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks;
    return (hooks?.["PreToolUse"] ?? []).map((g) => g.hooks[0]?.command ?? "");
  }

  it("plain enable refuses, names both groups' commands and --force, and keeps the snapshot live; --force takes the file's group as back", async () => {
    write({ hooks: { PreToolUse: [logger, gateGroup] } });
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    // Another hook with the gate's matcher is added while the gate is off.
    const before = addGroup(formatter);

    const on = await gate("enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stdout).toBe("");
    expect(on.stderr).toContain('PreToolUse matcher="Write|Edit"');
    expect(on.stderr).toContain("`harness pack hook branch-protection`");
    expect(on.stderr).toContain("`some-formatter-guard`");
    expect(on.stderr).toContain("harness gate enable --force");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(liveSnapshotNames(settingsPath)).toHaveLength(1);
    expect(retiredSnapshotNames(settingsPath)).toEqual([]);

    // --force is the operator's call: it takes the file's group as back, prints both commands, writes nothing and retires.
    const forced = await gate("enable", "--force");
    expect(forced.code).toBe(EX_OK);
    // The header does not claim the file holds every removed group: one of them was only taken as back.
    expect(forced.stdout).toContain(
      `nothing to put back into ${settingsPath}: each hook group the snapshot removed is there unchanged or taken as back under --force (below); no write needed.`,
    );
    expect(forced.stdout).not.toContain("already holds every hook group");
    expect(forced.stdout).toContain(
      'taken as back under --force, not put back (same event and matcher, other content): PreToolUse matcher="Write|Edit": ' +
        "the snapshot's group runs `harness pack hook branch-protection`, the file's group runs `some-formatter-guard`.",
    );
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(liveSnapshotNames(settingsPath)).toEqual([]);
  });

  it("a second disable does not retire the snapshot as spent: it refuses naming both commands, and enable --force then the disable is the way out", async () => {
    write({ hooks: { PreToolUse: [logger, gateGroup] } });
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    const snap = liveSnapshotNames(settingsPath);
    const before = addGroup(formatter);

    const off = await gate("disable", "--matcher", "Bash");
    expect(off.code).toBe(EX_FAIL);
    expect(off.stdout).toBe("");
    expect(off.stderr).toContain("`harness pack hook branch-protection`");
    expect(off.stderr).toContain("`some-formatter-guard`");
    expect(off.stderr).toContain("If the file's group stands in for the snapshot's, run `harness gate enable --force`");
    // Following --force here would leave the gate's group out, so the refusal names the other way too.
    expect(off.stderr).toContain(`Otherwise make the file hold the snapshot's group (${settingsPath}.bak.`);
    expect(off.stderr).toContain("has it) and run `harness gate enable`. Then run this again.");
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    expect(liveSnapshotNames(settingsPath)).toEqual(snap);
    expect(retiredSnapshotNames(settingsPath)).toEqual([]);

    expect((await gate("enable", "--force")).code).toBe(EX_OK);
    expect((await gate("disable", "--matcher", "Bash")).code).toBe(EX_OK);
  });

  it("a refusal names the commands of a group still missing, so it can be told from the one that shares its matcher", async () => {
    write({ hooks: { PreToolUse: [gateGroup, own] } });
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    // The operator's own group comes back in a changed form while the gate is off.
    write({ hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [command("my-secret-guard v2")] }] } });
    const on = await gate("enable");
    expect(on.code).toBe(EX_FAIL);
    expect(on.stderr).toContain(
      '1 more hook group(s) it removed are missing (PreToolUse matcher="Write|Edit" running `my-secret-guard`)',
    );
    // The same group named by a disable that refuses, and by the edited-since refusal.
    addGroup({ matcher: "Task", hooks: [command("task-hook")] });
    const off = await gate("disable", "--matcher", "Task");
    expect(off.code).toBe(EX_FAIL);
    expect(off.stderr).toContain('still missing (PreToolUse matcher="Write|Edit" running `my-secret-guard`)');
    write({ model: "x", hooks: { PreToolUse: [] } });
    const edited = await gate("enable");
    expect(edited.code).toBe(EX_FAIL);
    expect(edited.stderr).toContain(
      'are still missing (PreToolUse matcher="Write|Edit" running `harness pack hook branch-protection`; ' +
        'PreToolUse matcher="Write|Edit" running `my-secret-guard`)',
    );
  });

  it("restores the gate's group without --force when only the operator's own group with the same matcher came back", async () => {
    const original = write({ hooks: { PreToolUse: [gateGroup, own] } });
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    write({ hooks: { PreToolUse: [own] } });
    const on = await gate("enable");
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("restored 1 hook group(s)");
    expect(on.stdout).toContain('left alone, already in');
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("--force restores the gate's group and never duplicates the operator's own group with the same matcher", async () => {
    write({ hooks: { PreToolUse: [gateGroup, own] } });
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    write({ model: "x", hooks: { PreToolUse: [own] } });
    expect((await gate("enable")).code).toBe(EX_FAIL);
    const forced = await gate("enable", "--force");
    expect(forced.code).toBe(EX_OK);
    expect(forced.stdout).not.toContain("taken as back");
    expect(commands()).toEqual(["harness pack hook branch-protection", "my-secret-guard"]);
    expect((await gate("enable", "--force")).code).toBe(EX_OK);
    expect(commands()).toEqual(["harness pack hook branch-protection", "my-secret-guard"]);
  });

  it("--force with the operator's own group first restores the gate's group behind it", async () => {
    write({ hooks: { PreToolUse: [own, gateGroup] } });
    expect((await gate("disable", "--matcher", "Write|Edit")).code).toBe(EX_OK);
    write({ hooks: { PreToolUse: [own] } });
    expect((await gate("enable", "--force")).code).toBe(EX_OK);
    expect(commands()).toEqual(["my-secret-guard", "harness pack hook branch-protection"]);
  });
});

describe("harness gate (claude): several live snapshots left by an earlier release", () => {
  it("a disable refusal retires the spent snapshots it walked past, so enable --force and the disable again are the way out", async () => {
    const group = (m: string, c: string) => ({ matcher: m, hooks: [{ command: c }] });
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({ hooks: { PreToolUse: [group("Write|Edit", "branch-protection"), group("Bash", "bash-hook"), group("Task", "task-hook")] } }, null, 2)}\n`,
    );
    const [older, newest] = writeLegacyChain(
      settingsPath,
      { matcher: "Write|Edit", now: new Date("2026-01-01T00:00:01.000Z") },
      { matcher: "Bash", now: new Date("2026-01-01T00:00:02.000Z") },
    );
    // A released enable put the newest snapshot's group back and left it live; then the file was edited.
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify({ model: "x", hooks: { PreToolUse: [group("Task", "task-hook"), group("Bash", "bash-hook")] } }, null, 2)}\n`,
    );

    const off = await gate("disable", "--matcher", "Task");
    expect(off.code).toBe(EX_FAIL);
    expect(off.stderr).toContain(older);
    expect(off.stderr).toContain(`Retired the spent snapshot(s) walked past first (${newest.replace(/\.json$/, ".restored.json")})`);
    expect(off.stderr).toContain("harness gate enable --force");
    expect(liveSnapshotNames(settingsPath)).toEqual([path.basename(older)]);

    const forced = await gate("enable", "--force");
    expect(forced.code).toBe(EX_OK);
    expect(forced.stderr).toBe("");
    const again = await gate("disable", "--matcher", "Task");
    expect(again.code).toBe(EX_OK);
    expect(groups()).toEqual(["Write|Edit", "Bash"]);
  });
});
