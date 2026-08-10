import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { add } from "../../src/cli/add/index.js";
import { applyAdd } from "../../src/cli/add/mutate.js";
import { init } from "../../src/cli/init/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN as STUB_NPM_BIN_EXEC } from "../_helpers/npm-bin-exec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpHome: string;
let manifestPath: string;
let hooksDir: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-add-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
  hooksDir = path.join(tmpHome, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  await init({ homeDir: tmpHome, npmBinExec: STUB_NPM_BIN_EXEC });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readManifest(): unknown {
  return parseYaml(fs.readFileSync(manifestPath, "utf8"));
}

describe("add mcp", () => {
  it("appends a new entry under tools.mcp[]", async () => {
    const r = await add(
      {
        type: "mcp",
        entry: {
          name: "codebase-oracle",
          command: "node /tmp/server.js",
          health: { verb: "oracle_list_repos", timeout_ms: 5000 },
        },
      },
      { configPath: manifestPath },
    );
    expect(r.applied).toBe(true);
    const m = readManifest() as { tools?: { mcp?: { name: string }[] } };
    expect(m.tools?.mcp?.[0]?.name).toBe("codebase-oracle");
  });

  it("defaults health.timeout_ms to 5000 when --health-verb is set without an explicit timeout", async () => {
    await add(
      {
        type: "mcp",
        entry: {
          name: "implicit-timeout",
          command: "/usr/bin/true",
          health: { verb: "v", timeout_ms: 5000 },
        },
      },
      { configPath: manifestPath },
    );
    const m = readManifest() as {
      tools?: { mcp?: { name: string; health?: { timeout_ms?: number } }[] };
    };
    const entry = m.tools?.mcp?.find((e) => e.name === "implicit-timeout");
    expect(entry?.health?.timeout_ms).toBe(5000);
  });

  it("rejects a duplicate name in tools.mcp[]", async () => {
    await add(
      {
        type: "mcp",
        entry: { name: "x", command: "/usr/bin/true", health: { verb: "v" } },
      },
      { configPath: manifestPath },
    );
    await expect(
      add(
        {
          type: "mcp",
          entry: { name: "x", command: "/usr/bin/true", health: { verb: "v" } },
        },
        { configPath: manifestPath },
      ),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 1 });
  });

  it("--dry-run prints a unified diff and does not write", async () => {
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await add(
      {
        type: "mcp",
        entry: { name: "x", command: "/usr/bin/true", health: { verb: "v" } },
      },
      { configPath: manifestPath, dryRun: true },
    );
    expect(r.applied).toBe(false);
    expect(r.diff).toContain("+");
    expect(r.diff).toContain("--- harness.yaml");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("add cli", () => {
  it("appends a CLI entry", async () => {
    await add(
      { type: "cli", entry: { name: "git-batch", binary: "git-batch" } },
      { configPath: manifestPath },
    );
    const m = readManifest() as { tools?: { cli?: { name: string }[] } };
    expect(m.tools?.cli?.[0]?.name).toBe("git-batch");
  });

  it("rejects a CLI marked --required when the binary is missing", async () => {
    await expect(
      add(
        {
          type: "cli",
          entry: { name: "definitely-not-installed-xyz", binary: "definitely-not-installed-xyz", required: true },
        },
        { configPath: manifestPath, homeDir: tmpHome },
      ),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 1 });
  });
});

describe("add skill", () => {
  it("appends a skill name to tools.skills.enabled[]", async () => {
    await add({ type: "skill", entry: "review" }, { configPath: manifestPath });
    const m = readManifest() as { tools?: { skills?: { enabled?: string[] } } };
    expect(m.tools?.skills?.enabled).toContain("review");
  });
});

describe("add hook — +x gate", () => {
  it("accepts a hook whose script is +x", async () => {
    const script = path.join(hooksDir, "ok.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(script, 0o755);
    await add(
      {
        type: "hook",
        entry: { name: "ok", event: "SessionStart", command: script, blocking: false },
      },
      { configPath: manifestPath, homeDir: tmpHome },
    );
    const m = readManifest() as { hooks?: { name: string }[] };
    expect(m.hooks?.[0]?.name).toBe("ok");
  });

  it("rejects a hook whose script lacks +x", async () => {
    const script = path.join(hooksDir, "no-x.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(script, 0o644);
    await expect(
      add(
        {
          type: "hook",
          entry: { name: "no-x", event: "SessionStart", command: script, blocking: false },
        },
        { configPath: manifestPath, homeDir: tmpHome },
      ),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/not executable/),
    });
    // file untouched after rejection
    const m = readManifest() as { hooks?: unknown[] };
    expect(m.hooks ?? []).toEqual([]);
  });

  it("rejects a hook whose script does not exist", async () => {
    await expect(
      add(
        {
          type: "hook",
          entry: { name: "missing", event: "SessionStart", command: "/nonexistent/path.sh", blocking: false },
        },
        { configPath: manifestPath, homeDir: tmpHome },
      ),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      message: expect.stringMatching(/path does not exist/),
    });
  });
});

describe("add — asset gate baseline diff", () => {
  it("Scenario A: pre-existing required-binary error does not block an unrelated hook add", async () => {
    // Write a manifest that already has a pre-existing required-binary error.
    fs.writeFileSync(
      manifestPath,
      [
        "version: 1",
        "tools:",
        "  cli:",
        "    - name: definitely-not-installed-xyz",
        "      binary: definitely-not-installed-xyz",
        "      required: true",
      ].join("\n") + "\n",
    );

    const script = path.join(hooksDir, "clean-hook.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(script, 0o755);

    const result = await add(
      {
        type: "hook",
        entry: { name: "clean-hook", event: "SessionStart", command: script, blocking: false },
      },
      { configPath: manifestPath, homeDir: tmpHome },
    );

    expect(result.applied).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("1 pre-existing asset error");
    expect(result.warnings[0]).toContain("definitely-not-installed-xyz");
    expect(result.warnings[0]).toContain("harness validate");
  });

  it("Scenario B: a new asset error introduced by the add still blocks", async () => {
    await expect(
      add(
        {
          type: "hook",
          entry: {
            name: "bad-hook",
            event: "SessionStart",
            command: "/nonexistent/completely-missing-hook.sh",
            blocking: false,
          },
        },
        { configPath: manifestPath, homeDir: tmpHome },
      ),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/proposed manifest fails asset validation/),
    });
  });

  it("mixed: a co-occurring pre-existing error does not grandfather a new one", async () => {
    // Base already has the required-binary error AND the add introduces its own
    // asset error. The new error must still block, and the thrown message must
    // name only the new entry, not the grandfathered pre-existing one.
    fs.writeFileSync(
      manifestPath,
      [
        "version: 1",
        "tools:",
        "  cli:",
        "    - name: definitely-not-installed-xyz",
        "      binary: definitely-not-installed-xyz",
        "      required: true",
      ].join("\n") + "\n",
    );

    const err = await add(
      {
        type: "hook",
        entry: {
          name: "bad-hook",
          event: "SessionStart",
          command: "/nonexistent/completely-missing-hook.sh",
          blocking: false,
        },
      },
      { configPath: manifestPath, homeDir: tmpHome },
    ).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toMatchObject({
      name: "HarnessExitError",
      message: expect.stringMatching(/proposed manifest fails asset validation/),
    });
    expect(err?.message).toContain("bad-hook");
    expect(err?.message).not.toContain("definitely-not-installed-xyz");
  });

  it("control: clean add to a clean manifest produces no warnings", async () => {
    const result = await add(
      { type: "skill", entry: "review" },
      { configPath: manifestPath, homeDir: tmpHome },
    );
    expect(result.applied).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("add — manifest must exist", () => {
  it("EX_NOINPUT (66) when target is missing", async () => {
    fs.unlinkSync(manifestPath);
    await expect(
      add(
        {
          type: "cli",
          entry: { name: "foo", binary: "foo" },
        },
        { configPath: manifestPath },
      ),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 66 });
  });
});

describe("applyAdd — defensive errors", () => {
  it("throws when the target path is not a sequence", () => {
    const yaml = "version: 1\ntools:\n  mcp: not-a-list\n";
    expect(() =>
      applyAdd(yaml, {
        type: "mcp",
        entry: { name: "x", command: "/usr/bin/true", health: { verb: "v" } },
      }),
    ).toThrow(/expected a YAML sequence/);
  });
});

describe("add — comment preservation", () => {
  it("leaves user comments intact across the round-trip", async () => {
    const yaml = [
      "# user-authored manifest",
      "version: 1",
      "tools:",
      "  cli:",
      "    - name: gh # github cli",
      "      binary: gh",
      "# trailing comment",
      "",
    ].join("\n");
    const out = applyAdd(yaml, {
      type: "cli",
      entry: { name: "git-batch", binary: "git-batch" },
    });
    expect(out).toContain("# user-authored manifest");
    expect(out).toContain("# github cli");
    expect(out).toContain("# trailing comment");
    expect(out).toContain("git-batch");
  });
});

describe("add — concurrency via fork", () => {
  it("two concurrent invocations both succeed; both entries land", async () => {
    const workerPath = path.resolve(__dirname, "fixtures/add-worker.cjs");
    const a = forkAddWorker(workerPath, { manifestPath, homeDir: tmpHome, suffix: "A" });
    const b = forkAddWorker(workerPath, { manifestPath, homeDir: tmpHome, suffix: "B" });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.exitCode).toBe(0);
    expect(rb.exitCode).toBe(0);
    const m = readManifest() as { tools?: { cli?: { name: string }[] } };
    const names = (m.tools?.cli ?? []).map((c) => c.name).sort();
    expect(names).toEqual(["cli-A", "cli-B"]);
  }, 15_000);
});

interface AddWorkerArgs {
  manifestPath: string;
  homeDir: string;
  suffix: string;
}

interface AddWorkerResult {
  exitCode: number;
  stderr: string;
}

function forkAddWorker(workerPath: string, args: AddWorkerArgs): Promise<AddWorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [JSON.stringify(args)], { silent: true });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? -1, stderr });
    });
    child.on("error", reject);
  });
}
