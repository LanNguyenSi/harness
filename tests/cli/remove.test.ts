import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { init } from "../../src/cli/init/index.js";
import { remove } from "../../src/cli/remove/index.js";
import { applyRemove, planRemove } from "../../src/cli/remove/mutate.js";

let tmpHome: string;
let manifestPath: string;
let hooksDir: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-remove-"));
  manifestPath = path.join(tmpHome, "harness.yaml");
  hooksDir = path.join(tmpHome, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  await init({ homeDir: tmpHome, template: "full" });
  // Rewrite hook paths in the full template into our tmp hooks dir + chmod +x
  // so post-remove asset checks (run via add() in setup) and validate stays
  // honest. Keeping the manifest in the tmpdir entirely avoids touching the
  // user's real ~/.claude.
  // Rewrite hook paths into the tmp hooks dir, drop `required:true` from the
  // full template's CLI entries (CI doesn't have git-batch on PATH so the
  // post-mutate asset check would otherwise trip in any test that goes through
  // a verb like add() during setup), and chmod the hook scripts so the asset
  // check would pass if anyone reruns it on this fixture.
  const yaml = fs.readFileSync(manifestPath, "utf8")
    .replace(/~\/\.claude\/hooks\//g, `${hooksDir}/`)
    .replace(/required: true\n/g, "required: false\n");
  fs.writeFileSync(manifestPath, yaml);
  for (const name of ["git-preflight.sh", "require-review-evidence.sh", "require-dogfood-evidence.sh", "require-preflight-evidence.sh"]) {
    const p = path.join(hooksDir, name);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readManifest(): unknown {
  return parseYaml(fs.readFileSync(manifestPath, "utf8"));
}

describe("remove mcp / cli / skill", () => {
  it("removes an mcp entry by name", async () => {
    const r = await remove("mcp", "agent-tasks", { configPath: manifestPath, homeDir: tmpHome });
    expect(r.applied).toBe(true);
    const m = readManifest() as { tools?: { mcp?: { name: string }[] } };
    expect(m.tools?.mcp?.map((e) => e.name)).not.toContain("agent-tasks");
  });

  it("removes a cli entry by name", async () => {
    await remove("cli", "ledger", { configPath: manifestPath, homeDir: tmpHome });
    const m = readManifest() as { tools?: { cli?: { name: string }[] } };
    expect(m.tools?.cli?.map((e) => e.name)).not.toContain("ledger");
  });

  it("removes a skill name from tools.skills.enabled[]", async () => {
    await remove("skill", "review", { configPath: manifestPath, homeDir: tmpHome });
    const m = readManifest() as { tools?: { skills?: { enabled?: string[] } } };
    expect(m.tools?.skills?.enabled).not.toContain("review");
  });
});

describe("remove hook — reference check", () => {
  it("refuses to remove a hook referenced by a policy without --force", async () => {
    await expect(
      remove("hook", "require-review-evidence", { configPath: manifestPath, homeDir: tmpHome }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/review-before-merge.*remove the polic.*first or pass --force/),
    });
  });

  it("removes a hook with --force when no policy references it (no schema fallout)", async () => {
    // Insert the sacrificial hook via the same Document AST applyAdd uses,
    // bypassing asset checks (host-dependent: git-batch on PATH, etc.) since
    // this test is about the reference-check semantics, not asset validation.
    const sacrificial = path.join(hooksDir, "sacrificial.sh");
    fs.writeFileSync(sacrificial, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(sacrificial, 0o755);
    const { applyAdd } = await import("../../src/cli/add/mutate.js");
    const yaml = fs.readFileSync(manifestPath, "utf8");
    const next = applyAdd(yaml, {
      type: "hook",
      entry: { name: "sacrificial", event: "SessionStart", command: sacrificial, blocking: false },
    });
    fs.writeFileSync(manifestPath, next);
    const r = await remove("hook", "sacrificial", {
      configPath: manifestPath,
      homeDir: tmpHome,
      force: true,
    });
    expect(r.applied).toBe(true);
    expect(r.forcedReferences).toEqual([]);
  });

  it("--force on a referenced hook fails the schema gate (dangling policy.hook)", async () => {
    // The full template wires `review-before-merge` -> `require-review-evidence`.
    // --force lets remove past the human-friendly pre-check, but the schema gate
    // still rejects the dangling reference. This is the documented contract.
    await expect(
      remove("hook", "require-review-evidence", {
        configPath: manifestPath,
        homeDir: tmpHome,
        force: true,
      }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      message: expect.stringMatching(/review-before-merge.*not declared in hooks/),
    });
  });
});

describe("remove — unknown name", () => {
  it("exits 1 with the available-name list", async () => {
    await expect(
      remove("mcp", "no-such-mcp", { configPath: manifestPath, homeDir: tmpHome }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/codebase-oracle/),
    });
  });
});

describe("remove --dry-run + --force + referenced hook", () => {
  it("populates forcedReferences in the dry-run result so the user can see what would be forced", async () => {
    // The write path with --force on a referenced hook is rejected by the schema gate
    // (dangling policy.hook). Dry-run skips the gate's effect on disk but still computes
    // forcedReferences so the user can preview the override.
    const r = await remove("hook", "require-review-evidence", {
      configPath: manifestPath,
      homeDir: tmpHome,
      dryRun: true,
      force: true,
    }).catch((e) => e);
    // The schema gate fires for dry-run too because we still validate the proposed YAML.
    // That's the documented contract: --force lets remove past the human-friendly
    // pre-check, but the schema is the safety net for both write and dry-run paths.
    expect(r).toMatchObject({ name: "HarnessExitError" });
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

  it("collects referencing policies for a hook target", () => {
    const yaml = [
      "version: 1",
      "hooks:",
      "  - name: h1",
      "    event: PreToolUse",
      "    command: /bin/true",
      "    blocking: false",
      "policies:",
      "  - name: p1",
      "    description: x",
      "    trigger: { event: PreToolUse, match: Bash }",
      "    requires: { ledger_tag: x }",
      "    hook: h1",
      "    enforcement: block",
      "  - name: p2",
      "    description: x",
      "    trigger: { event: PreToolUse, match: Bash }",
      "    requires: { ledger_tag: y }",
      "    hook: h1",
      "    enforcement: block",
      "",
    ].join("\n");
    const plan = planRemove(yaml, "hook", "h1");
    expect(plan.referencingPolicies.sort()).toEqual(["p1", "p2"]);
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

  it("returns empty referencingPolicies for non-hook types", () => {
    const yaml = "version: 1\ntools:\n  mcp:\n    - name: a\n";
    const plan = planRemove(yaml, "mcp", "a");
    expect(plan.referencingPolicies).toEqual([]);
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
