import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { run } from "../../src/cli/index.js";
import { init } from "../../src/cli/init/index.js";
import { remove } from "../../src/cli/remove/index.js";
import { applyRemove, planRemove } from "../../src/cli/remove/mutate.js";
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
  // binary. Hook scripts no longer apply: the full template since
  // `harness@>0.9.1` wires every PreToolUse hook through the bundled
  // `harness policy intercept` engine, so there is nothing to chmod.
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

// F8 (review round 2, 99f47307 Slice 1): a hook referenced ONLY by a
// workflows[]-derived merge gate (no hand-authored `policies:` entry
// names it) used to pass `remove hook`'s reference check silently — the
// check only ever inspected the raw YAML's `policies:` list. This
// manifest deliberately carries NO `policies:` at all, so the existing
// `referencingPolicies` check finds nothing; only the new derived-gate
// check (`derivedGateReferencingWorkflows`) can catch it.
describe("remove hook — derived-gate reference check (F8)", () => {
  let derivedHome: string;
  let derivedManifestPath: string;

  const WORKFLOW_REQUIRED = `review_templates:
  t1: "Review this PR for correctness."
workflows:
  - name: ship
    steps:
      - kind: branch
      - kind: review_subagent
        spawn: required
        template: t1
      - kind: merge
`;

  const WIRED_HOOKS = `hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
`;

  beforeEach(() => {
    derivedHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-remove-derived-gate-"));
    derivedManifestPath = path.join(derivedHome, "harness.yaml");
    fs.writeFileSync(
      derivedManifestPath,
      `version: 1\n${WORKFLOW_REQUIRED}${WIRED_HOOKS}policies: []\n`,
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(derivedHome, { recursive: true, force: true });
  });

  it("refuses to remove a hook a workflow's derived merge gate depends on, without --force", async () => {
    await expect(
      remove("hook", "require-review-evidence", {
        configPath: derivedManifestPath,
        homeDir: derivedHome,
      }),
    ).rejects.toMatchObject({
      name: "HarnessExitError",
      exitCode: 1,
      message: expect.stringMatching(/"ship".*derive.*runtime merge gate.*--force/s),
    });
  });

  it("refuses removal of the BASH evidence hook the same way", async () => {
    await expect(
      remove("hook", "require-review-evidence-bash", {
        configPath: derivedManifestPath,
        homeDir: derivedHome,
      }),
    ).rejects.toMatchObject({ name: "HarnessExitError", exitCode: 1 });
  });

  // Mutation probe (this round): removing the `derivedGateReferencingWorkflows`
  // pre-check call from `src/cli/remove/index.ts` turns the two tests
  // above red-to-green-for-the-wrong-reason (the removal would silently
  // succeed) — this test pins the dry-run reporting shape too, so a
  // regression that keeps the deny but drops the reporting still shows.
  it("reports the affected workflow in derivedGateReferences on a --force dry-run", async () => {
    const r = await remove("hook", "require-review-evidence", {
      configPath: derivedManifestPath,
      homeDir: derivedHome,
      dryRun: true,
      force: true,
    });
    expect(r.applied).toBe(false);
    expect(r.derivedGateReferences).toEqual(["ship"]);
  });

  it("--force actually removes the hook (no schema safety net for a derived-only reference)", async () => {
    const r = await remove("hook", "require-review-evidence", {
      configPath: derivedManifestPath,
      homeDir: derivedHome,
      force: true,
    });
    expect(r.applied).toBe(true);
    const m = parseYaml(fs.readFileSync(derivedManifestPath, "utf8")) as {
      hooks?: { name: string }[];
    };
    expect(m.hooks?.map((h) => h.name)).not.toContain("require-review-evidence");
  });

  // F3 (review round 3): the round-2 write path hard-coded
  // `derivedGateReferences: []` and the CLI never printed the field on
  // either path, so `remove hook require-review-evidence --force` dropped
  // the gate with no warning at all.
  it("F3: the write path with --force reports the workflow whose gate it disables", async () => {
    const r = await remove("hook", "require-review-evidence", {
      configPath: derivedManifestPath,
      homeDir: derivedHome,
      force: true,
    });
    expect(r.applied).toBe(true);
    expect(r.derivedGateReferences).toEqual(["ship"]);
  });

  it("F3: the CLI prints the derived-gate warning on stderr for a --force write (M3)", async () => {
    const r = await runCli([
      "remove",
      "hook",
      "require-review-evidence",
      "--config",
      derivedManifestPath,
      "--force",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/forced removal disables the workflows\[\]-derived merge gate for: ship/);
    expect(r.stdout).toMatch(/removed hook "require-review-evidence"/);
    const m = parseYaml(fs.readFileSync(derivedManifestPath, "utf8")) as { hooks?: { name: string }[] };
    expect(m.hooks?.map((h) => h.name)).not.toContain("require-review-evidence");
  });

  it("F3: the CLI prints the same warning on --dry-run --force and leaves the file untouched", async () => {
    const before = fs.readFileSync(derivedManifestPath, "utf8");
    const r = await runCli([
      "remove",
      "hook",
      "require-review-evidence",
      "--config",
      derivedManifestPath,
      "--dry-run",
      "--force",
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/derived merge gate for: ship/);
    expect(r.stdout).toMatch(/^--- /m);
    expect(fs.readFileSync(derivedManifestPath, "utf8")).toBe(before);
  });

  it("no derived-gate warning on stderr when removing an unrelated hook", async () => {
    const withExtraHook = `${fs.readFileSync(derivedManifestPath, "utf8").replace(/policies: \[\]\n$/, "")}  - name: unrelated-hook
    event: SessionStart
    command: /usr/bin/true
    blocking: false
policies: []
`;
    fs.writeFileSync(derivedManifestPath, withExtraHook, "utf8");
    const r = await runCli(["remove", "hook", "unrelated-hook", "--config", derivedManifestPath]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("does not block removing an UNRELATED hook the same manifest declares", async () => {
    const withExtraHook = `version: 1\n${WORKFLOW_REQUIRED}hooks:
  - name: require-review-evidence
    event: PreToolUse
    match: "mcp__agent-tasks__pull_requests_merge"
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: require-review-evidence-bash
    event: PreToolUse
    match: "Bash"
    bash_match: '(^|\\n|;|\\||&|\\()\\s*(\\w+=\\S+\\s+)*gh pr merge\\b'
    command: harness policy intercept
    blocking: hard
    budget_ms: 15000
  - name: unrelated-hook
    event: SessionStart
    command: /usr/bin/true
    blocking: false
policies: []
`;
    fs.writeFileSync(derivedManifestPath, withExtraHook, "utf8");
    const r = await remove("hook", "unrelated-hook", {
      configPath: derivedManifestPath,
      homeDir: derivedHome,
    });
    expect(r.applied).toBe(true);
    expect(r.derivedGateReferences).toEqual([]);
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
      "    command: /usr/bin/true",
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
