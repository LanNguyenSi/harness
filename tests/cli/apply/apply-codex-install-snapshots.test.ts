import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import { run } from "../../../src/cli/index.js";
import { CODEX_SNAPSHOT_BASENAME_PREFIX, listCodexSnapshots } from "../../../src/cli/gate/codex-snapshot.js";

// The install retires the live gate snapshots of the block it rewrites; the
// CLI reports that through its own io (not process.stderr) and --json.

let home: string;
let manifestPath: string;
let codexConfig: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-apply-snap-"));
  manifestPath = path.join(home, "harness.yaml");
  codexConfig = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  fs.writeFileSync(codexConfig, 'model = "gpt-5.5"\n');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeManifest(command: string): void {
  fs.writeFileSync(
    manifestPath,
    yamlStringify({
      version: 1,
      tools: { mcp: [], cli: [], skills: { enabled: [], source_dirs: [] }, builtin: { known: [] } },
      memory: { directories: [] },
      hooks: [{ name: "shell-guard", event: "PreToolUse", match: "Bash", command, blocking: "hard", budget_ms: 2000 }],
      policies: [],
      policy_packs: [],
    }),
  );
}

async function cli(...argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  const code = await run({
    argv,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { stdout, stderr, code };
}

const installArgs = (...extra: string[]): string[] => [
  "apply",
  "--config",
  manifestPath,
  "--runtime",
  "codex",
  "--install",
  "--codex-config",
  codexConfig,
  ...extra,
];

async function installThenDisable(): Promise<string> {
  writeManifest("/usr/bin/true one");
  expect((await cli(...installArgs())).code).toBe(0);
  const d = await cli("gate", "disable", "--runtime", "codex", "--config", codexConfig, "--matcher", "Bash");
  expect(d.code).toBe(0);
  const live = listCodexSnapshots(path.dirname(codexConfig));
  expect(live).toHaveLength(1);
  writeManifest("/usr/bin/true two");
  return live[0]!;
}

describe("apply --install reports the gate snapshots it retires through its own io", () => {
  it("prints one retire line per retired snapshot and keeps process.stderr out of it", async () => {
    const snap = await installThenDisable();
    const r = await cli(...installArgs());
    expect(r.code).toBe(0);
    const retired = snap.replace(/\.json$/, ".superseded.json");
    expect(r.stdout).toContain(
      `retired gate snapshot as ${retired}: the install replaced the hooks block it was taken from\n`,
    );
    expect(r.stdout.match(/retired gate snapshot/g)).toHaveLength(1);
    expect(r.stderr).not.toContain("warning");
    expect(fs.existsSync(retired)).toBe(true);
    expect(listCodexSnapshots(path.dirname(codexConfig))).toEqual([]);
  });

  it("prints one warning line per snapshot warning on stderr, and the install still succeeds", async () => {
    await installThenDisable();
    const junk = path.join(path.dirname(codexConfig), `${CODEX_SNAPSHOT_BASENAME_PREFIX}2026-10-02T00-30-00.000Z.json`);
    fs.writeFileSync(junk, "{ not json");
    const r = await cli(...installArgs());
    expect(r.code).toBe(0);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("warning: ") && l.includes(junk));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/move it out of this directory/);
    expect(fs.readFileSync(codexConfig, "utf8")).toContain("/usr/bin/true two");
  });

  it("--json carries supersededSnapshots and snapshotWarnings and stays one well-formed object", async () => {
    const snap = await installThenDisable();
    const junk = path.join(path.dirname(codexConfig), `${CODEX_SNAPSHOT_BASENAME_PREFIX}2026-10-02T00-30-00.000Z.json`);
    fs.writeFileSync(junk, "{ not json");
    const r = await cli(...installArgs("--json"));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      codexConfigInstall: { supersededSnapshots?: string[]; snapshotWarnings?: string[] };
    };
    expect(parsed.codexConfigInstall.supersededSnapshots).toEqual([snap.replace(/\.json$/, ".superseded.json")]);
    expect(parsed.codexConfigInstall.snapshotWarnings).toHaveLength(1);
    expect(parsed.codexConfigInstall.snapshotWarnings![0]).toContain(junk);
  });
});
