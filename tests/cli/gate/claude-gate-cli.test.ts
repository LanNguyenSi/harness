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
