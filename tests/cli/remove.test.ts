import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { run } from "../../src/cli/index.js";
import { init } from "../../src/cli/init/index.js";
import { remove } from "../../src/cli/remove/index.js";
import { applyRemove, planRemove } from "../../src/cli/remove/mutate.js";
import { parseManifest } from "../../src/schema/index.js";
import { STUB_NPM_BIN_EXEC_UNKNOWN as STUB_NPM_BIN_EXEC } from "../_helpers/npm-bin-exec.js";

let tmpHome: string;
let manifestPath: string;
let hooksDir: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-remove-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
  hooksDir = path.join(tmpHome, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  await init({ homeDir: tmpHome, template: "full", npmBinExec: STUB_NPM_BIN_EXEC });
  // Drop `required: true` from the full template's CLI entries (`gh`) so
  // the post-mutate asset check does not trip on CI hosts that lack the
  // binary. The full template ships no hooks, so there is nothing to chmod.
  const yaml = fs
    .readFileSync(manifestPath, "utf8")
    .replace(/required: true\n/g, "required: false\n");
  fs.writeFileSync(manifestPath, yaml);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readManifest(): unknown {
  return parseYaml(fs.readFileSync(manifestPath, "utf8"));
}

/** In-process CLI run with captured streams (same shape as tests/cli/program.test.ts). */
async function runCli(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

describe("remove mcp / cli / skill", () => {
  it("removes an mcp entry by name", async () => {
    const r = await remove("mcp", "agent-tasks", { configPath: manifestPath, homeDir: tmpHome });
    expect(r.applied).toBe(true);
    const m = readManifest() as { tools?: { mcp?: { name: string }[] } };
    expect(m.tools?.mcp?.map((e) => e.name)).not.toContain("agent-tasks");
  });

  it("removes a cli entry by name", async () => {
    // The full template ships a single `gh` cli entry post-refactor;
    // exercising the remove verb on it is sufficient to lock the
    // contract.
    await remove("cli", "gh", { configPath: manifestPath, homeDir: tmpHome });
    const m = readManifest() as { tools?: { cli?: { name: string }[] } };
    expect(m.tools?.cli?.map((e) => e.name) ?? []).not.toContain("gh");
  });

  it("removes a skill name from tools.skills.enabled[]", async () => {
    await remove("skill", "review", { configPath: manifestPath, homeDir: tmpHome });
    const m = readManifest() as { tools?: { skills?: { enabled?: string[] } } };
    expect(m.tools?.skills?.enabled).not.toContain("review");
  });
});

// The full template ships no hooks or policies any more (task bcdcde36), so
// the hook tests add their own hooks.
function addHook(name: string, extra = ""): void {
  const script = path.join(hooksDir, `${name}.sh`);
  fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(script, 0o755);
  fs.appendFileSync(
    manifestPath,
    `
hooks:
  - name: ${name}
    event: PreToolUse
    match: "Bash"
    command: ${script}
    blocking: hard
${extra}`,
  );
}

describe("remove hook", () => {
  it("removes a hook", async () => {
    addHook("sacrificial");
    const r = await remove("hook", "sacrificial", { configPath: manifestPath, homeDir: tmpHome });
    expect(r.applied).toBe(true);
    expect(readManifest()).not.toHaveProperty("hooks.0");
  });

  it("is not blocked by a stale policies: entry that names the hook (the key is removed, task 10e2ff0a)", async () => {
    addHook(
      "require-review-evidence",
      `policies:
  - name: review-before-merge
    description: test
    trigger: { event: PreToolUse, match: "Bash" }
    requires: { ledger_tag: "review:\${SESSION_ID}" }
    hook: require-review-evidence
    enforcement: block
`,
    );
    const r = await remove("hook", "require-review-evidence", { configPath: manifestPath, homeDir: tmpHome });
    expect(r.applied).toBe(true);
    // The dangling policy is left for `harness validate` to report as the
    // removed key it is; it does not stop the load.
    const written = fs.readFileSync(manifestPath, "utf8");
    expect(written).toContain("review-before-merge");
    expect(() => parseManifest(parseYaml(written))).not.toThrow();
  });

  it("has no --force option any more: it only existed to override the policy reference check", async () => {
    addHook("sacrificial");
    const r = await runCli(["remove", "hook", "sacrificial", "--force", "--config", manifestPath]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown option '--force'/);
    expect(fs.readFileSync(manifestPath, "utf8")).toContain("sacrificial");
  });
});

describe("remove — unknown name", () => {
  it("exits 1 with the available-name list", async () => {
    await expect(
      remove("mcp", "no-such-mcp", { configPath: manifestPath, homeDir: tmpHome }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      // Any of the MCP entries the full template declares is fine; we
      // just need the error to surface an available-name suggestion.
      message: expect.stringMatching(/agent-tasks|grounding-mcp/),
    });
  });
});

describe("remove --dry-run", () => {
  it("prints the unified diff with - lines for the removed entry; file unchanged", async () => {
    const before = fs.readFileSync(manifestPath, "utf8");
    const r = await remove("mcp", "agent-tasks", {
      configPath: manifestPath,
      homeDir: tmpHome,
      dryRun: true,
    });
    expect(r.applied).toBe(false);
    expect(r.diff).toMatch(/^-/m);
    expect(r.diff).toContain("agent-tasks");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("remove — manifest must exist", () => {
  it("EX_NOINPUT (66) when target is missing", async () => {
    fs.unlinkSync(manifestPath);
    await expect(
      remove("mcp", "anything", { configPath: manifestPath, homeDir: tmpHome }),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 66 });
  });
});

describe("planRemove — pure", () => {
  it("returns the available names and a found:false flag for missing entries", () => {
    const yaml = "version: 1\ntools:\n  mcp:\n    - name: a\n    - name: b\n";
    const plan = planRemove(yaml, "mcp", "c");
    expect(plan.found).toBe(false);
    expect(plan.availableNames).toEqual(["a", "b"]);
  });
});

describe("applyRemove — defensive errors", () => {
  it("throws when the target sequence is absent (corrupted manifest path)", () => {
    const yaml = "version: 1\n";
    expect(() => applyRemove(yaml, "mcp", "x")).toThrow(/expected a YAML sequence/);
  });

  it("throws when the named entry is not in the list", () => {
    const yaml = "version: 1\ntools:\n  mcp:\n    - name: a\n";
    expect(() => applyRemove(yaml, "mcp", "missing")).toThrow(/not found/);
  });
});

describe("planRemove — entry shapes", () => {
  it("handles skill list entries (scalar strings)", () => {
    const yaml = "version: 1\ntools:\n  skills:\n    enabled:\n      - simplify\n      - review\n";
    const plan = planRemove(yaml, "skill", "review");
    expect(plan.found).toBe(true);
    expect(plan.availableNames.sort()).toEqual(["review", "simplify"]);
  });
});

describe("applyRemove — comment preservation", () => {
  it("preserves user comments when removing an entry", () => {
    const yaml = [
      "# top-level comment",
      "version: 1",
      "tools:",
      "  cli:",
      "    - name: gh # github cli",
      "      binary: gh",
      "    - name: ledger",
      "      binary: ledger",
      "# trailing",
      "",
    ].join("\n");
    const out = applyRemove(yaml, "cli", "ledger");
    expect(out).toContain("# top-level comment");
    expect(out).toContain("# github cli");
    expect(out).toContain("# trailing");
    expect(out).not.toMatch(/name: ledger/);
  });
});
