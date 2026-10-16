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

async function gate(...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv: ["gate", ...argv, "--settings", settingsPath],
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

  it("names a snapshot taken for another settings file instead of staying silent about it", async () => {
    const other = path.join(tmp, "settings.local.json");
    fs.writeFileSync(other, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }, null, 2)}\n`);
    const off = await run({
      argv: ["gate", "disable", "--matcher", "Bash", "--settings", other],
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(off).toBe(EX_OK);
    const on = await gate("enable");
    expect(on.code).toBe(EX_OK);
    expect(on.stdout).toContain("nothing to restore");
    expect(on.stdout).toMatch(/skipped .*harness\.gate-disable\..*\.json: taken for another settings file/);
  });
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
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);

    const forced = await gate("enable", "--force");
    expect(forced.code).toBe(EX_OK);
    expect(forced.stdout).toContain("restored 1 hook group(s)");
    expect(forced.stdout).toContain('left alone, already in');
    expect(forced.stdout).toContain('PreToolUse matcher="Bash"');
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
    edited.hooks.PreToolUse.unshift({ matcher: "Write|Edit", hooks: [{ command: "branch-protection --v2" }] });
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
    edited.hooks.PreToolUse.unshift({ matcher: "Write|Edit", hooks: [{ command: "branch-protection --v2" }] });
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
